// WorkBuddy 请求层。接口是客户端自用的业务接口，不是公开 API：
// 字段解析一律防御式（optional + 默认值），code != 0 视为业务错误。
//
// 参照 MIT 项目 app-cf-checkin 已验证的接口契约与踩坑记录重新实现，不含其源码。
import { expiresAtOf, subjectOf, isEncrypted } from "../core/jwt.js";
import { applyCredPatch } from "../core/accounts.js";

export const HOSTS = ["copilot.tencent.com", "www.codebuddy.cn"];
const ENDPOINTS = ["https://copilot.tencent.com", "https://www.codebuddy.cn"];

const P = {
  status: "/v2/billing/meter/checkin-activity-status",
  checkin: "/v2/billing/meter/daily-checkin",
  refresh: "/v2/plugin/auth/token/refresh",
  travelStatus: "/v2/activity/growth/buddy/travel/status",
  travelConfig: "/v2/activity/growth/buddy/travel/config",
  travelDepart: "/v2/activity/growth/buddy/travel/depart",
  travelClaim: "/v2/activity/growth/buddy/travel/claim",
};

export function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// 上游在不同接口里把同一个字段挂在顶层 / data / result / 更深一层，混着用。
// 命中了但值为 null 时继续往包装层里钻——顶层置 null、真值在 data 里是常见形态。
export function dig(node, key, depth = 0) {
  if (!node || typeof node !== "object" || Array.isArray(node) || depth > 4) return null;
  if (node[key] !== undefined && node[key] !== null) return node[key];
  for (const child of [node.data, node.result, node.payload]) {
    const found = dig(child, key, depth + 1);
    if (found !== null && found !== undefined) return found;
  }
  return null;
}

export function codeOf(payload) {
  const raw = payload && (payload.code ?? payload.errcode);
  if (raw === undefined || raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export const isAuthFail = (result) => result.status === 401 || result.status === 403;

export function uidOf(values) {
  return subjectOf(values.accessToken) || subjectOf(values.refreshToken);
}

// 主站超时 / 5xx 自动切备站；4xx 是业务结论，不切（切了只会把 401 重复打一遍）。
// 每次真实 fetch 都由 ctx.fetch（trackedFetch）计费，重试自然也计入预算。
export async function call(ctx, path, {
  method = "POST", body = {}, auth = true, extraHeaders = {},
} = {}) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    // 插件鉴权请求必带，缺了会 401
    "X-Domain": "copilot.tencent.com",
    ...extraHeaders,
  };
  if (auth) {
    headers.Authorization = `Bearer ${ctx.account.cred.accessToken}`;
    headers["X-User-Id"] = ctx.account.uid;
  }

  const init = {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(ctx.timeoutMs || 15000),
  };

  let last = { status: 0, payload: null, error: "没有可用端点" };
  for (const base of ENDPOINTS) {
    if (!ctx.budget.fits(1)) { last = { status: 0, payload: null, error: "预算已用尽" }; break; }
    let response;
    try {
      response = await ctx.fetch(base + path, init);
    } catch (error) {
      last = { status: 0, payload: null, error: String((error && error.message) || error) };
      continue;
    }
    const text = await response.text().catch(() => "");
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
    last = { status: response.status, payload, raw: text };
    if (response.status < 500) return last;
  }
  return last;
}

// 到期前 7 天才续期；refresh_token 是一次性的，一轮最多换一次。
// 换出新双令牌后**当场落盘**：中途崩溃而没写回，等于把新旧两张票同时烧掉。
export async function ensureAuth(ctx) {
  const cred = ctx.account.cred;
  if (isEncrypted(cred.accessToken) || isEncrypted(cred.refreshToken)) {
    return { error: "票据是新版桌面端加密格式，请用短信登录换明文 token", authFailed: true };
  }
  if (!cred.refreshToken) return { error: "缺少 Refresh Token", authFailed: true };

  const expiresAt = Number(cred.expiresAt) || expiresAtOf(cred.accessToken) || 0;
  if (ctx.renewAttempted || (expiresAt && expiresAt - ctx.now > 7 * 86400)) return {};
  ctx.renewAttempted = true;

  const result = await call(ctx, P.refresh, {
    auth: false,
    extraHeaders: {
      "X-Refresh-Token": cred.refreshToken,
      "X-Auth-Refresh-Source": "plugin",
    },
  });
  const token = dig(result.payload, "access_token") ?? dig(result.payload, "accessToken");
  const refresh = dig(result.payload, "refresh_token") ?? dig(result.payload, "refreshToken");
  const failed = result.status >= 400 || typeof token !== "string" || !token.trim();

  if (failed) {
    const message = `续期失败（HTTP ${result.status}）`;
    // 票还没过期就只是警告，别把好账号直接判死；已过期才要求重新登录。
    return expiresAt > ctx.now ? { warn: message } : { error: message, authFailed: true };
  }

  const patch = {
    accessToken: token.trim(),
    // 上游偶尔不回 refresh_token：沿用旧串，下一轮还要用它换票
    refreshToken: typeof refresh === "string" && refresh.trim() ? refresh.trim() : cred.refreshToken,
    expiresAt: String(num(dig(result.payload, "expires_in"))
      ? ctx.now + num(dig(result.payload, "expires_in"))
      : (expiresAtOf(token) || ctx.now + 7 * 86400)),
  };
  Object.assign(cred, patch);
  const saved = await applyCredPatch(ctx.kv, ctx.account.uid, patch).catch(() => false);
  return {
    rotated: patch,
    // 写不回去 = 下一轮手里的旧串可能已被上游作废，必须出现在日志里
    warn: saved ? "" : "新凭据写回失败，旧串可能已作废，请尽快重新录入",
  };
}

export const readStatus = (ctx) => call(ctx, P.status);
export const submitCheckin = (ctx) => call(ctx, P.checkin);
export const readTravelStatus = (ctx) => call(ctx, P.travelStatus, { method: "GET" });
export const readTravelConfig = (ctx) => call(ctx, P.travelConfig, { method: "GET" });
export const departTravel = (ctx, locationId) => call(ctx, P.travelDepart, { body: { location_id: locationId } });
export const claimTravel = (ctx) => call(ctx, P.travelClaim);

// 签到状态：字段名社区见过两个版本，两个都判；活动下线不报错。
export function judgeStatus(payload) {
  if (codeOf(payload) === 12302 || dig(payload, "active") === false) {
    return { verdict: "inactive", message: "签到活动未开或已下线" };
  }
  const today = dig(payload, "today_checked_in") ?? dig(payload, "checked_in_today");
  if (today === true || today === 1 || today === "true") {
    return { verdict: "already", message: "今日已签到" };
  }
  return { verdict: "claimable", message: "今日尚未签到" };
}

export function judgeClaim(result) {
  const code = codeOf(result.payload);
  if (code === 10001) return { status: "already", message: "上游报已签到", credits: 0 };
  if (result.status >= 400) return { status: "error", message: `签到接口 HTTP ${result.status}`, credits: 0 };
  if (code !== null && code !== 0) return { status: "error", message: `签到接口 code=${code}`, credits: 0 };
  return { status: "claimed", message: "签到成功", credits: num(dig(result.payload, "credit") ?? dig(result.payload, "today_credit")) };
}

export function streakFacts(payload) {
  const days = num(dig(payload, "streak_days"));
  const total = num(dig(payload, "total_credits"));
  const bits = [];
  if (days) bits.push(`连签 ${days} 天`);
  if (total) bits.push(`累计 ${total}`);
  return bits.length ? `，${bits.join("，")}` : "";
}

// 地点策略默认「奖励上限最高」；字段名上游换过几版，都试一遍，读不到就取第一个。
export function pickLocations(locations) {
  if (!Array.isArray(locations)) return [];
  const score = (p) => num(p && (p.max_reward ?? p.reward_credit ?? p.reward ?? p.credit));
  return [...locations].filter((p) => p && p.id !== undefined)
    .sort((a, b) => score(b) - score(a));
}

// HTTP 200 不等于成功：上游大量业务错误是 code != 0 配 200 返回的。
export function okResult(result) {
  const code = codeOf(result.payload);
  return result.status < 400 && (code === null || code === 0);
}

export function bizMessage(result) {
  const p = result.payload || {};
  return String(p.msg ?? p.message ?? "").slice(0, 120);
}

const STATE_KEYS = [
  "state", "status", "travel_state", "travelStatus", "trip_state", "tripStatus",
  "buddy_state", "buddyStatus", "phase", "stage", "travel_state_code",
];
const CLAIMABLE = /^(arrived|claimable|pending_?claim|waiting_?claim|can_?claim|finished|completed|done|reward_?pending|unclaimed|ready_?to_?claim)$|待领|可领|到站|已完成|可领取|领取礼物|待收取|等待领取/i;
const TRAVELING = /^(travel+ing|in_?transit|on_?trip|departed|running|in_?progress|ongoing|started)$|旅途中|派送中|进行中|在途|已出发/i;
const IDLE = /^(idle|none|not_?started|ready|unstarted)$|未开始|未出发|待出发/i;
const NO_GIFT = /no_?reward|nothing_?to_?claim|already_?claimed|no_?gift|无可领|已领取|没有.*礼物|nothing.*claim/i;
// 「还没到站」必须单独成类：它既不是领取成功，也不是「没有礼物」。
// 混进 no_gift 会让状态机以为可以派下一趟，把在途行程顶掉。
const NOT_ARRIVED = /not[\s_-]*arrived|未到站|尚未到达|还没到|not[\s_-]*yet/i;

// 上游状态字段换过版、也可能藏在 travel / trip / buddy 这类子对象里。
// 不再假设单一键名：受限深度遍历整份响应，收集所有可能的状态值，按「有礼可领 → 在途 → 空闲」的优先顺序判定。
// 优先顺序很重要：认错成 idle 会直接派新行程，把待领的礼物顶掉，这是最贵的错。
export function travelStateOf(payload) {
  const found = [];
  const walk = (node, depth, path) => {
    if (!node || typeof node !== "object" || Array.isArray(node) || depth > 5) return;
    for (const [key, value] of Object.entries(node)) {
      if (STATE_KEYS.includes(key) && (typeof value === "string" || typeof value === "number")) {
        found.push({ key, value: String(value), path: `${path}.${key}` });
      }
      if (value && typeof value === "object" && !Array.isArray(value)) {
        walk(value, depth + 1, `${path}.${key}`);
      }
    }
  };
  walk(payload, 0, "$");

  const raw = found.length ? found.map((f) => `${f.path}=${f.value}`).join(", ").slice(0, 200) : "未找到状态字段";
  const pick = (re) => {
    const hit = found.find((f) => re.test(f.value));
    return hit ? { ...hit, raw, found } : null;
  };
  const claimable = pick(CLAIMABLE);
  if (claimable) return { kind: "claimable", ...claimable };
  const traveling = pick(TRAVELING);
  if (traveling) return { kind: "traveling", ...traveling };
  const idle = pick(IDLE);
  if (idle) return { kind: "idle", ...idle };

  // 状态全认不出来时，奖励信号也能救一次：有可领奖励就先收。
  const reward = num(dig(payload, "reward_credit"));
  const canClaim = dig(payload, "can_claim");
  const hasReward = dig(payload, "has_reward");
  if (reward > 0 || canClaim === true || hasReward === true) {
    return { kind: "claimable", value: "奖励信号", path: "$", raw, found };
  }
  return { kind: "unknown", value: "未识别", path: "$", raw, found };
}

// 旅行时间：上游给秒级时间戳（也可能是毫秒或字符串），统一换算成秒。
// 判断「到点没到点」要看 server_now 与 arrive_at 的差，不能只信 state：
// 上游状态更新可能滞后，已经到点了还报 traveling。
export function travelTimingOf(payload) {
  const toSec = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  };
  const departSec = toSec(dig(payload, "depart_at") ?? dig(payload, "depart_time"));
  const arriveSec = toSec(dig(payload, "arrive_at") ?? dig(payload, "arrive_time"));
  const nowSec = toSec(dig(payload, "server_now") ?? dig(payload, "now") ?? dig(payload, "timestamp"));
  const remaining = arriveSec !== null && nowSec !== null ? arriveSec - nowSec : null;
  return { departSec, arriveSec, nowSec, remaining, due: remaining !== null && remaining <= 0 };
}

// 领取结果三分：收到了 / 上游明确说没礼物 / 真失败。
// 「没礼物」要走继续派发的路，不能当成失败把流程卡死。
export function judgeClaimTravel(result) {
  const code = codeOf(result.payload);
  const msg = bizMessage(result);
  const text = `${msg} ${String(result.raw || "")}`;
  if (NOT_ARRIVED.test(text)) {
    return { kind: "not_arrived", credits: 0, message: `行程尚未到站${msg ? `（${msg}）` : ""}` };
  }
  if (NO_GIFT.test(text) || code === 10001) {
    return { kind: "no_gift", credits: 0, message: "上游报没有待领礼物" };
  }
  if (okResult(result)) {
    const reward = dig(result.payload, "reward_credit") ?? dig(result.payload, "credit") ?? dig(result.payload, "reward");
    // 上游说成功却没给任何奖励字段：绝不能当成「已收礼」。
    // 旧版就是在这种模糊应答之后继续派行程，把待领礼物顶掉了。
    if (reward === null || reward === undefined) {
      return { kind: "uncertain", credits: 0, message: "领取接口没返回奖励金额，无法确认是否已收礼" };
    }
    return { kind: "claimed", credits: num(reward), message: `回收到站礼物 +${num(reward)}` };
  }
  return {
    kind: "failed", credits: 0,
    message: `领取失败 HTTP ${result.status}${code != null ? ` code=${code}` : ""}${msg ? ` ${msg}` : ""}`,
  };
}

// 派发被拒时要分流：今日用尽 / 已在途中 / 该地点不可用（换下一个）/ 真失败。
export function classifyDepart(result) {
  const text = `${bizMessage(result)} ${String(result.raw || "")}`.toLowerCase();
  if (result.status === 429 || /limit|用尽|已达上限|daily_limit/.test(text)) return "limit";
  if (result.status === 403 || result.status === 409
    || /already_?travel|已有行程|旅途中|in ?progress/.test(text)) return "traveling";
  if (/location|地点|available|不可选/.test(text)) return "location";
  return "other";
}
