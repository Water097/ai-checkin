// 第一版只做三件事：每日签到、派 Buddy 旅行、回收到站积分。
// 每一步都必须可安全重入：一轮被掐死、下轮重跑，上游只会看到幂等应答。
import * as api from "./api.js";
import { scrub, truncate } from "../core/logs.js";

function guarded(ctx, guard) {
  if (guard && guard.error) {
    return { status: "login_required", message: guard.error, credits: 0 };
  }
  return null;
}

function warnOf(guard) {
  return guard && guard.warn ? `（${guard.warn}）` : "";
}

// ── 每日签到 ────────────────────────────────────────────────────────────
export async function runCheckin(ctx, day) {
  if (["claimed", "already", "inactive"].includes(day.checkin)) {
    return { status: "reused", message: "签到今日已处理", credits: 0 };
  }
  const guard = await api.ensureAuth(ctx);
  const blocked = guarded(ctx, guard);
  if (blocked) return blocked;

  const status = await api.readStatus(ctx);
  if (api.isAuthFail(status)) {
    return { status: "login_required", message: "签到状态被拒，凭据可能已失效", credits: 0 };
  }
  const judged = api.judgeStatus(status.payload);
  if (judged.verdict === "inactive" || judged.verdict === "already") {
    return { status: judged.verdict, message: judged.message, credits: 0 };
  }

  const verdict = api.judgeClaim(await api.submitCheckin(ctx));
  if (verdict.status !== "claimed") {
    return { status: verdict.status, message: verdict.message + warnOf(guard), credits: 0 };
  }
  // 领取接口只回积分，连签天数与累计要另问一次；也顺带确认真的签上了。
  const after = await api.readStatus(ctx);
  return {
    status: "claimed",
    message: truncate(scrub(`签到 +${verdict.credits}${api.streakFacts(after.payload)}${warnOf(guard)}`, ctx.secrets)),
    credits: verdict.credits,
  };
}

// ── 旅行：读到站状态 → 收礼 → 再派下一趟 ────────────────────────────────
// 不做阻塞等待：Worker 里阻塞等于烧子请求 + 撞超时。
// 改成每 30 分钟轻量轮询，服务端说 arrived 才 claim，说 traveling 就本轮收手。
export async function runTravel(ctx, day) {
  if (day.travel === "done") {
    return { status: "reused", message: "旅行今日已收工", credits: 0 };
  }
  const guard = await api.ensureAuth(ctx);
  const blocked = guarded(ctx, guard);
  if (blocked) return blocked;

  const first = await api.readTravelStatus(ctx);
  if (api.isAuthFail(first)) {
    return { status: "login_required", message: "旅行状态被拒，凭据可能已失效", credits: 0 };
  }
  const state = api.dig(first.payload, "state");
  const limit = api.dig(first.payload, "daily_limit_reached");
  const notes = [];
  let credits = 0;

  if (state === "arrived") {
    const claimed = await api.claimTravel(ctx);
    const reward = api.dig(claimed.payload, "reward_credit");
    if (claimed.status >= 400 || reward === null || reward === undefined) {
      // 领奖失败绝不派新行程：一失败就当 idle 去派，会把这次已到站的礼物顶掉。
      return { status: "error", message: `到站礼物领取失败（HTTP ${claimed.status}），本次不派新行程`, credits: 0 };
    }
    credits += api.num(reward);
    notes.push(`回收到站礼物 +${api.num(reward)}`);
    day.rounds = day.rounds || 0;
  } else if (state === "traveling") {
    const arriveAt = api.dig(first.payload, "arrive_at");
    const hint = arriveAt ? `（预计 ${String(arriveAt).slice(0, 16)}）` : "";
    return { status: "waiting", message: `旅行在途，到站后再收${hint}`, credits: 0 };
  }

  if (limit === true || limit === 1) {
    notes.push("今日旅行次数已用尽");
    return { status: "done", message: notes.join("，"), credits };
  }

  const config = await api.readTravelConfig(ctx);
  const places = api.pickLocations(api.dig(config.payload, "locations") || []);
  if (!places.length) {
    return { status: "error", message: `${notes.join("，")}但旅行配置里没有可选地点`.replace(/^，/, ""), credits };
  }

  // 第一个地点被下线就换下一个，固定只用第一个会每轮都失败。
  const rejected = [];
  for (const place of places.slice(0, 3)) {
    const depart = await api.departTravel(ctx, place.id);
    if (depart.status < 400) {
      const name = api.dig(depart.payload, "location")?.name || place.name || place.id;
      notes.push(`已派新行程 → ${name}`);
      return { status: "departed", message: truncate(scrub(notes.join("，") + warnOf(guard), ctx.secrets)), credits };
    }
    const why = api.classifyDepart(depart);
    if (why === "limit") {
      notes.push("今日旅行次数已用尽");
      return { status: "done", message: notes.join("，"), credits };
    }
    if (why === "traveling") {
      return { status: "waiting", message: [...notes, "已在旅途中，不重复出发"].join("，"), credits };
    }
    if (why === "location") { rejected.push(place.name || place.id); continue; }
    return { status: "error", message: [...notes, `派发失败 HTTP ${depart.status}`].join("，"), credits };
  }
  return { status: "error", message: [...notes, `可用地点都派不出去：${rejected.join("、")}`].join("，"), credits };
}
