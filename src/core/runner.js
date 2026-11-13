import { requireKv, keys, LOCK_TTL } from "./kv.js";
import { makeBudget, trackedFetch, budgetFrom } from "./budget.js";
import { listAccounts, getAccount, secretValuesOf } from "./accounts.js";
import { loadDay, saveDay, dayOf, isSettled } from "./state.js";
import { writeLog, scrub, truncate } from "./logs.js";
import { HOSTS } from "../wb/api.js";
import { runCheckin, runTravel } from "../wb/steps.js";

export const nowSec = () => Math.floor(Date.now() / 1000);

function makeCtx({ env, budget, account, day, now, trigger }) {
  return {
    account,
    kv: requireKv(env),
    budget,
    now,
    day: day.day,
    trigger,
    timeoutMs: 15000,
    fetch: trackedFetch(budget, HOSTS),
    secrets: secretValuesOf(account),
    renewAttempted: false,
  };
}

function applyResults(state, results, now) {
  for (const row of results) {
    if (row.id === "checkin") {
      if (["claimed", "already", "inactive"].includes(row.status)) state.checkin = row.status;
    } else if (row.id === "travel") {
      if (["done", "departed", "waiting"].includes(row.status)) state.travel = row.status;
      if (row.status === "departed") state.rounds = (state.rounds || 0) + 1;
    }
    state.credits = (state.credits || 0) + (Number(row.credits) || 0);
  }
  state.lastAt = now;
  // 首页直接显示人话（含到站时间），不用再点进诊断页才知道 Buddy 在哪一站。
  state.lastMessage = truncate(
    results.filter((r) => r.status !== "reused").map((r) => r.message).join("；") || "今日已处理",
    180,
  );
}

function aggregate(results) {
  const statuses = results.map((r) => r.status);
  if (statuses.includes("login_required")) return "login_required";
  if (statuses.every((s) => s === "reused")) return "already";
  if (statuses.includes("error")) {
    return results.some((r) => r.status === "claimed" || r.credits > 0) ? "partial" : "error";
  }
  if (statuses.includes("claimed") || results.some((r) => r.credits > 0)) return "claimed";
  if (statuses.includes("waiting") || statuses.includes("departed")) return "waiting";
  // travel=done 是「今日趟数用尽」，与签到已领合起来就是完整的今日已处理，不是部分完成
  if (statuses.every((s) => ["already", "inactive", "reused", "done"].includes(s))) return "already";
  return "partial";
}

// 单账号一轮。锁、日状态、凭据三次读放在同一个 try 里：
// KV 真不可用时只跳过这个账号，不让整轮炸掉。
export async function runAccount({ env, budget, account, now = nowSec(), trigger = "cron", force = false }) {
  const kv = requireKv(env);
  const uid = account.uid;
  const label = account.label || uid;
  const bare = (status, message, extra = {}) => ({ uid, label, status, message, credits: 0, http: 0, steps: [], ...extra });

  const lockKey = keys.lock(uid);
  try {
    if (await kv.get(lockKey)) return bare("skipped", "已有运行在途", { quiet: true });
    await kv.put(lockKey, String(now), { expirationTtl: LOCK_TTL });
  } catch (error) {
    return bare("deferred", `KV 暂不可用：${truncate(String((error && error.message) || error), 80)}`);
  }

  const release = () => kv.delete(lockKey).catch(() => {});
  const httpBefore = budget.used;
  const day = dayOf(now);

  try {
    let state;
    try { state = await loadDay(kv, uid, day); }
    catch (error) { await release(); return bare("deferred", `读取日状态失败：${String((error && error.message) || error)}`); }

    if (!force && isSettled(state)) {
      await release();
      return bare("already", `今日已收工（+${state.credits || 0}）`, { quiet: true, day: state });
    }

    const ctx = makeCtx({ env, budget, account, day: state, now, trigger });
    const secretsBefore = secretValuesOf(account);
    const results = [];
    for (const [id, run] of [["checkin", runCheckin], ["travel", runTravel]]) {
      // 步骤自己抛异常不能带走整轮，也不能让下一步失去执行机会
      try {
        const out = await run(ctx, state);
        results.push({ id, ...out });
      } catch (error) {
        results.push({ id, status: "error", message: String((error && error.message) || error), credits: 0 });
      }
      // 续期发生在步骤内部并会就地改写 cred，旧串必须一直留在脱敏集合里
      ctx.secrets = [...new Set([...secretsBefore, ...secretValuesOf(account)])];
    }

    const secrets = [...new Set([...secretsBefore, ...secretValuesOf(account)])];
    applyResults(state, results, now);
    const credits = results.reduce((sum, r) => sum + (Number(r.credits) || 0), 0);
    const status = aggregate(results);
    const message = truncate(scrub(
      results.filter((r) => r.status !== "reused").map((r) => `${r.id}：${r.message}`).join("；") || "无可执行步骤",
      secrets,
    ), 400);

    try { await saveDay(kv, uid, day, state); } catch { /* 进度写失败只会导致下轮多跑几步幂等请求 */ }
    try {
      await writeLog(kv, {
        atMs: Date.now(), uid, label, status, message, credits, trigger,
        secrets, http: budget.used - httpBefore,
      });
    } catch { /* 观测失败不该让本轮报错 */ }

    await release();
    return {
      uid, label, status, message, credits, day: state,
      http: budget.used - httpBefore,
      steps: results.map((r) => ({ id: r.id, status: r.status, message: truncate(scrub(r.message, secrets), 200) })),
    };
  } catch (error) {
    await release();
    return bare("error", truncate(scrub(String((error && error.message) || error), secretValuesOf(account)), 200));
  }
}

// 「测试」：只读登录态，不发领取。但 refresh 可能顺带续期，
// 新串必须写回，否则「点一下测试」会把一个好账号点成需重新登录。
export async function validateAccount({ env, account, now = nowSec() }) {
  const budget = makeBudget(budgetFrom(env));
  const ctx = makeCtx({ env, budget, account, day: { day: dayOf(now) }, now, trigger: "validate" });
  const before = secretValuesOf(account);
  try {
    const { ensureAuth, readStatus, judgeStatus, streakFacts, isAuthFail } = await import("../wb/api.js");
    const guard = await ensureAuth(ctx);
    if (guard.error) return { status: "login_required", message: guard.error };
    const status = await readStatus(ctx);
    if (isAuthFail(status)) return { status: "login_required", message: "登录态被拒（401/403），请更新凭据" };
    const judged = judgeStatus(status.payload);
    const changed = secretValuesOf(account).some((v) => !before.includes(v));
    return {
      status: "ok",
      message: `登录态有效，${judged.message}${streakFacts(status.payload)}`
        + (changed ? "（本次测试顺带续了期，新凭据已写回）" : "")
        + (guard.warn ? `（${guard.warn}）` : ""),
    };
  } catch (error) {
    return { status: "error", message: scrub(String((error && error.message) || error), before) };
  }
}

// 一轮调度。按「最久没被服务」排序，避免排在后面的账号永远吃不到预算。
export async function runTick({ env, now = nowSec(), trigger = "cron" }) {
  const budget = makeBudget(budgetFrom(env));
  const kv = requireKv(env);
  let accounts;
  try { accounts = await listAccounts(kv); }
  catch (error) { return { now, trigger, error: String((error && error.message) || error), accounts: [] }; }

  // 按「最久没被服务」排序，避免排在后面的账号永远吃不到预算。
  // 时刻存在独立键里，不写回账号记录（那会用旧快照覆盖用户刚提交的凭据）。
  const last = {};
  for (const account of accounts) {
    last[account.uid] = Number(await kv.get(keys.last(account.uid)).catch(() => null)) || 0;
  }
  accounts.sort((a, b) => (last[a.uid] || 0) - (last[b.uid] || 0));

  const results = [];
  for (const account of accounts) {
    if (account.enabled === false) {
      results.push({ uid: account.uid, label: account.label, status: "skipped", message: "账号已停用", credits: 0, http: 0, steps: [] });
      continue;
    }
    if (budget.left() <= 0) {
      results.push({ uid: account.uid, label: account.label, status: "deferred", message: "本轮外部请求额度已用尽，留到下一轮", credits: 0, http: 0, steps: [] });
      continue;
    }
    const result = await runAccount({ env, budget, account, now, trigger });
    if (!result.quiet) await kv.put(keys.last(account.uid), String(now)).catch(() => {});
    results.push(result);
  }
  return {
    now, trigger, ran: results.filter((r) => !r.quiet).length,
    credits: results.reduce((sum, r) => sum + (r.credits || 0), 0),
    budget: { used: budget.used, limit: budget.limit, left: budget.left() },
    accounts: results,
  };
}
