import test from "node:test";
import assert from "node:assert/strict";
import { makeBudget, trackedFetch } from "../src/core/budget.js";
import { makeKv } from "./kv.mock.js";
import { saveAccount, getAccount, secretValuesOf } from "../src/core/accounts.js";
import { newDay, loadDay } from "../src/core/state.js";
import { listLogs } from "../src/core/logs.js";
import { HOSTS, judgeStatus, judgeClaim, pickLocations, ensureAuth } from "../src/wb/api.js";
import { runCheckin, runTravel } from "../src/wb/steps.js";
import { runAccount, runTick } from "../src/core/runner.js";

const jwt = (payload) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
const NOW = Math.floor(Date.parse("2026-11-13T02:00:00Z") / 1000);
const ACCESS = jwt({ sub: "uid-test-001", exp: NOW + 30 * 86400 });
const REFRESH = "REFRESH_TOKEN_OLD_VALUE_LONG";

// 按路径分发响应；主站 200 时不会走备站。
function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(typeof input === "string" ? input : input.url);
    const path = new URL(url).pathname;
    calls.push({ path, init });
    const hit = routes[path];
    const out = typeof hit === "function" ? hit(calls.length, init) : (hit || {});
    return new Response(JSON.stringify(out.body ?? { code: 0, data: {} }), {
      status: out.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return calls;
}

function makeCtx(kv, account) {
  const budget = makeBudget(45);
  return {
    account, kv, budget, now: NOW, day: "2026-11-13", trigger: "test",
    timeoutMs: 1000, fetch: trackedFetch(budget, HOSTS),
    secrets: secretValuesOf(account), renewAttempted: false,
  };
}

async function fixture() {
  const kv = makeKv();
  const account = {
    uid: "uid-test-001", label: "主号", enabled: true,
    cred: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: String(NOW + 30 * 86400) },
  };
  await saveAccount(kv, account.uid, account);
  return { kv, account, env: { CHECKIN_KV: kv, PASSWORD: "pw" } };
}

test("签到判定：两种字段名都认，活动下线不报错", () => {
  assert.equal(judgeStatus({ data: { today_checked_in: true } }).verdict, "already");
  assert.equal(judgeStatus({ checked_in_today: true }).verdict, "already");
  assert.equal(judgeStatus({ code: 12302 }).verdict, "inactive");
  assert.equal(judgeStatus({ active: false }).verdict, "inactive");
  assert.equal(judgeStatus({ data: {} }).verdict, "claimable");
});

test("签到领取：code=10001 是已签，不是 HTTP 错误", () => {
  assert.equal(judgeClaim({ status: 200, payload: { code: 10001 } }).status, "already");
  assert.equal(judgeClaim({ status: 200, payload: { code: 0, data: { credit: 100 } } }).credits, 100);
  assert.equal(judgeClaim({ status: 401, payload: {} }).status, "error");
});

test("地点策略：按奖励上限降序", () => {
  const list = [{ id: 1, max_reward: 5 }, { id: 2, max_reward: 30 }, { id: 3, max_reward: 10 }];
  assert.equal(pickLocations(list)[0].id, 2);
});

test("签到：领完回读状态，同一日重跑不重复领取", async () => {
  const { kv, account } = await fixture();
  const calls = mockFetch({
    "/v2/billing/meter/checkin-activity-status": { body: { code: 0, data: { today_checked_in: false, streak_days: 7 } } },
    "/v2/billing/meter/daily-checkin": { body: { code: 0, data: { credit: 100 } } },
  });
  const ctx = makeCtx(kv, account);
  const day = newDay("2026-11-13");
  const first = await runCheckin(ctx, day);
  assert.equal(first.status, "claimed");
  assert.equal(first.credits, 100);
  assert.match(first.message, /连签 7 天/);
  const submitCount = calls.filter((c) => c.path === "/v2/billing/meter/daily-checkin").length;
  assert.equal(submitCount, 1);

  day.checkin = "claimed";
  const second = await runCheckin(ctx, day);
  assert.equal(second.status, "reused");
  assert.equal(calls.filter((c) => c.path === "/v2/billing/meter/daily-checkin").length, 1);
});

test("旅行：arrived 先收礼再派下一趟，depart 用 location_id", async () => {
  const { kv, account } = await fixture();
  const calls = mockFetch({
    "/v2/activity/growth/buddy/travel/status": { body: { code: 0, data: { state: "arrived" } } },
    "/v2/activity/growth/buddy/travel/claim": { body: { code: 0, data: { reward_credit: 20 } } },
    "/v2/activity/growth/buddy/travel/config": { body: { code: 0, data: { locations: [{ id: 1, max_reward: 5, name: "咖啡馆" }, { id: 2, max_reward: 30, name: "海边" }] } } },
    "/v2/activity/growth/buddy/travel/depart": { body: { code: 0, data: { location: { name: "海边" } } } },
  });
  const ctx = makeCtx(kv, account);
  const day = newDay("2026-11-13");
  const out = await runTravel(ctx, day);
  assert.equal(out.status, "departed");
  assert.equal(out.credits, 20);
  assert.match(out.message, /回收到站礼物 \+20/);
  const depart = calls.find((c) => c.path.endsWith("/travel/depart"));
  assert.deepEqual(JSON.parse(depart.init.body), { location_id: 2 });
  assert.equal(calls.filter((c) => c.path.endsWith("/travel/claim")).length, 1);
});

test("旅行：traveling 不重复出发", async () => {
  const { kv, account } = await fixture();
  const calls = mockFetch({
    "/v2/activity/growth/buddy/travel/status": { body: { code: 0, data: { state: "traveling", arrive_at: "2026-11-13 14:00:00" } } },
  });
  const out = await runTravel(makeCtx(kv, account), newDay("2026-11-13"));
  assert.equal(out.status, "waiting");
  assert.equal(calls.filter((c) => c.path.endsWith("/travel/depart")).length, 0);
});

test("旅行：daily_limit_reached 当日收工", async () => {
  const { kv, account } = await fixture();
  const calls = mockFetch({
    "/v2/activity/growth/buddy/travel/status": { body: { code: 0, data: { state: "idle", daily_limit_reached: true } } },
  });
  const out = await runTravel(makeCtx(kv, account), newDay("2026-11-13"));
  assert.equal(out.status, "done");
  assert.equal(calls.some((c) => c.path.endsWith("/travel/depart")), false);
});

test("续期：换出新双令牌后当场写回，旧串不会丢", async () => {
  const { kv, account } = await fixture();
  account.cred.expiresAt = String(NOW + 60);   // 逼出一次 refresh
  await saveAccount(kv, account.uid, account);
  const NEW = jwt({ sub: "uid-test-001", exp: NOW + 30 * 86400 });
  mockFetch({
    "/v2/plugin/auth/token/refresh": { body: { code: 0, data: { access_token: NEW, refresh_token: "REFRESH_TOKEN_NEW_VALUE_LONG", expires_in: 2592000 } } },
  });
  const ctx = makeCtx(kv, account);
  const out = await ensureAuth(ctx);
  assert.equal(out.rotated.accessToken, NEW);
  assert.equal(out.warn, "");
  const saved = await getAccount(kv, account.uid);
  assert.equal(saved.cred.accessToken, NEW);
  assert.equal(saved.cred.refreshToken, "REFRESH_TOKEN_NEW_VALUE_LONG");
});

test("端到端：一轮跑完签到+旅行，日志与 KV 都搜不到凭据", async () => {
  const { kv, account, env } = await fixture();
  mockFetch({
    "/v2/billing/meter/checkin-activity-status": { body: { code: 0, data: { today_checked_in: false } } },
    "/v2/billing/meter/daily-checkin": { body: { code: 0, data: { credit: 100 } } },
    "/v2/activity/growth/buddy/travel/status": { body: { code: 0, data: { state: "idle" } } },
    "/v2/activity/growth/buddy/travel/config": { body: { code: 0, data: { locations: [{ id: 9, name: "咖啡馆" }] } } },
    "/v2/activity/growth/buddy/travel/depart": { body: { code: 0, data: {} } },
  });
  const result = await runAccount({ env, budget: makeBudget(45), account, now: NOW, trigger: "cron" });
  assert.equal(result.status, "claimed");
  assert.equal(result.credits, 100);
  assert.equal(result.steps.length, 2);
  const day = await loadDay(kv, account.uid, "2026-11-13");
  assert.equal(day.checkin, "claimed");
  assert.equal(day.travel, "departed");
  const logs = await listLogs(kv);
  assert.equal(logs.length, 1);
  // KV 的账号记录里存凭据是预期行为；要看的是日志与响应这两个出口。
  const dump = JSON.stringify({ log: logs[0], result });
  assert.equal(dump.includes("REFRESH_TOKEN_OLD_VALUE_LONG"), false);
  // accessToken 存在 KV 账号记录里是预期行为，但绝不能出现在日志与响应消息中
  assert.equal(logs[0].message.includes(ACCESS), false);
  assert.equal(result.message.includes(ACCESS), false);
});

test("整轮调度：账号异常隔离，一个号失败不影响另一个", async () => {
  const { kv, account, env } = await fixture();
  await saveAccount(kv, "bad-uid", {
    uid: "bad-uid", label: "坏号", enabled: true,
    cred: { accessToken: "NOT_A_JWT", refreshToken: "", expiresAt: "" },
  });
  mockFetch({
    "/v2/billing/meter/checkin-activity-status": { body: { code: 0, data: { today_checked_in: false } } },
    "/v2/billing/meter/daily-checkin": { body: { code: 0, data: { credit: 100 } } },
    "/v2/activity/growth/buddy/travel/status": { body: { code: 0, data: { state: "idle", daily_limit_reached: true } } },
  });
  const summary = await runTick({ env, now: NOW, trigger: "cron" });
  assert.equal(summary.accounts.length, 2);
  assert.equal(summary.accounts.some((r) => r.status === "claimed"), true);
  assert.equal(summary.accounts.some((r) => r.status === "login_required"), true);
});
