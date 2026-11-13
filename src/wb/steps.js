// 第一版只做三件事：每日签到、派 Buddy 旅行、回收到站积分。
// 每一步都必须可安全重入：一轮被掐死、下轮重跑，上游只会看到幂等应答。
import * as api from "./api.js";
import { scrub, truncate } from "../core/logs.js";
import { fmtCSTSec, humanGap } from "../core/time.js";

function guarded(guard) {
  if (guard && guard.error) return { status: "login_required", message: guard.error, credits: 0 };
  return null;
}

function warnOf(guard) {
  return guard && guard.warn ? `（${guard.warn}）` : "";
}

const truthy = (v) => v === true || v === 1 || v === "true" || v === "1";

// 上游给的是秒级时间戳，日志里直接打 1794546622 没人看得懂。
function timingText(timing) {
  if (!timing || timing.arriveSec === null) return "到站时间未知";
  const when = fmtCSTSec(timing.arriveSec);
  if (timing.remaining === null) return `预计 ${when} 到站`;
  if (timing.remaining > 0) return `预计 ${when} 到站（还需 ${humanGap(timing.remaining)}）`;
  return `预计 ${when} 到站，时间已过`;
}

// ── 每日签到 ────────────────────────────────────────────────────────────
export async function runCheckin(ctx, day) {
  if (["claimed", "already", "inactive"].includes(day.checkin)) {
    return { status: "reused", message: "签到今日已处理", credits: 0 };
  }
  const guard = await api.ensureAuth(ctx);
  const blocked = guarded(guard);
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

// ── 旅行：读状态 → 有礼先收 → 再派下一趟 ────────────────────────────────
// 不做阻塞等待：Worker 里阻塞等于烧子请求 + 撞超时，改成每 30 分钟轻量轮询。
//
// 两条铁律：
// 1. 绝不把「认不出来的状态」当成 idle。上游状态字段换过版、也可能藏在子对象里；
//    认错成 idle 会直接派新行程，把待领的礼物顶掉。状态不明确时先试一次 claim（幂等）。
// 2. 只要上游还标记 traveling，即使到了 arrive_at、即使收礼成功，也**不派新行程**。
//    派新行程可能把这趟在途的礼物顶掉，代价远高于多等一轮。
export async function runTravel(ctx, day) {
  if (day.travel === "done") {
    return { status: "reused", message: "旅行今日已收工", credits: 0 };
  }
  const guard = await api.ensureAuth(ctx);
  const blocked = guarded(guard);
  if (blocked) return blocked;

  const first = await api.readTravelStatus(ctx);
  if (api.isAuthFail(first)) {
    return { status: "login_required", message: "旅行状态被拒，凭据可能已失效", credits: 0 };
  }

  const info = api.travelStateOf(first.payload);
  const timing = api.travelTimingOf(first.payload);
  const limit = truthy(api.dig(first.payload, "daily_limit_reached") ?? api.dig(first.payload, "daily_limit"));
  const wasTraveling = info.kind === "traveling";
  // 把判定依据写进日志：下次上游再换字段，看一条运行记录就知道我们读到了什么。
  const notes = [`state=${info.raw} → ${info.kind}`];
  let credits = 0;

  // 在途且没到点：纯等待，不发任何写请求。
  if (wasTraveling && !timing.due) {
    notes.push(`旅行在途，${timingText(timing)}，不重复出发`);
    if (limit) notes.push("今日旅行次数已用尽");
    return { status: "waiting", message: truncate(scrub(notes.join("，"), ctx.secrets)), credits: 0 };
  }

  // 有礼可领 / 状态未知 / 在途但已过到站时间 → 先试领取，由上游回答有没有礼物。
  // 只有明确 idle 才跳过 claim 省一次请求。
  if (info.kind !== "idle") {
    if (wasTraveling) notes.push("已过到站时间但上游仍报在途，主动试领");
    const judged = api.judgeClaimTravel(await api.claimTravel(ctx));
    if (judged.kind === "claimed") {
      credits += judged.credits;
      notes.push(judged.message);
      day.rounds = day.rounds || 0;
    } else if (judged.kind === "no_gift") {
      notes.push(judged.message);
    } else {
      // 领取失败绝不派新行程：一失败就当 idle 去派，会把这次已到站的礼物顶掉。
      notes.push(`${judged.message}，本次不派新行程`);
      return { status: "error", message: truncate(scrub(notes.join("，"), ctx.secrets)), credits };
    }
  }

  // 上游仍认为在途：等它把状态更新成 arrived / idle，下一轮再决定是否派。
  if (wasTraveling) {
    notes.push("上游仍标记在途，本轮不派新行程，等状态更新");
    return {
      status: credits > 0 ? "claimed" : "waiting",
      message: truncate(scrub(notes.join("，"), ctx.secrets)), credits,
    };
  }

  if (limit) {
    notes.push("今日旅行次数已用尽");
    return { status: "done", message: truncate(scrub(notes.join("，"), ctx.secrets)), credits };
  }

  const config = await api.readTravelConfig(ctx);
  const places = api.pickLocations(api.dig(config.payload, "locations") || []);
  if (!places.length) {
    notes.push("旅行配置里没有可选地点，未派出");
    return { status: "error", message: truncate(scrub(notes.join("，"), ctx.secrets)), credits };
  }

  // 第一个地点被下线就换下一个，固定只用第一个会每轮都失败。
  const rejected = [];
  for (const place of places.slice(0, 3)) {
    const depart = await api.departTravel(ctx, place.id);
    // HTTP 200 不等于成功：业务码非 0 也是失败，不能报「已派新行程」。
    if (api.okResult(depart)) {
      const name = api.dig(depart.payload, "location")?.name || place.name || place.id;
      notes.push(`已派新行程 → ${name}`);
      return { status: "departed", message: truncate(scrub(notes.join("，") + warnOf(guard), ctx.secrets)), credits };
    }
    const why = api.classifyDepart(depart);
    if (why === "limit") {
      notes.push("今日旅行次数已用尽");
      return { status: "done", message: truncate(scrub(notes.join("，"), ctx.secrets)), credits };
    }
    if (why === "traveling") {
      notes.push("已在旅途中，不重复出发");
      return { status: "waiting", message: truncate(scrub(notes.join("，"), ctx.secrets)), credits };
    }
    if (why === "location") { rejected.push(place.name || place.id); continue; }
    const detail = api.bizMessage(depart);
    const code = api.codeOf(depart.payload);
    notes.push(`派发失败 HTTP ${depart.status}${code != null ? ` code=${code}` : ""}${detail ? ` ${detail}` : ""}，未派出`);
    return { status: "error", message: truncate(scrub(notes.join("，"), ctx.secrets)), credits };
  }
  notes.push(`可用地点都派不出去：${rejected.join("、")}，未派出`);
  return { status: "error", message: truncate(scrub(notes.join("，"), ctx.secrets)), credits };
}
