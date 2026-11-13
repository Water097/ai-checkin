import test from "node:test";
import assert from "node:assert/strict";
import { travelStateOf, judgeClaimTravel, okResult, classifyDepart, HOSTS } from "../src/wb/api.js";
import { runTravel } from "../src/wb/steps.js";
import { makeBudget, trackedFetch } from "../src/core/budget.js";
import { makeKv } from "./kv.mock.js";
import { saveAccount, secretValuesOf } from "../src/core/accounts.js";
import { newDay } from "../src/core/state.js";

const jwt = (payload) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
const NOW = Math.floor(Date.parse("2026-11-13T02:00:00Z") / 1000);
const ACCESS = jwt({ sub: "uid-travel-001", exp: NOW + 30 * 86400 });

function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(typeof input === "string" ? input : input.url);
    const path = new URL(url).pathname;
    calls.push(path);
    const out = routes[path] || {};
    return new Response(JSON.stringify(out.body ?? { code: 0, data: {} }), {
      status: out.status ?? 200, headers: { "content-type": "application/json" },
    });
  };
  return calls;
}

async function fixture() {
  const kv = makeKv();
  const account = {
    uid: "uid-travel-001", label: "主号", enabled: true,
    cred: { accessToken: ACCESS, refreshToken: "REFRESH_TRAVEL_VALUE", expiresAt: String(NOW + 30 * 86400) },
  };
  await saveAccount(kv, account.uid, account);
  const budget = makeBudget(45);
  const ctx = {
    account, kv, budget, now: NOW, day: "2026-11-13", trigger: "test",
    timeoutMs: 1000, fetch: trackedFetch(budget, HOSTS),
    secrets: secretValuesOf(account), renewAttempted: false,
  };
  return { ctx, kv, account };
}

const STATUS = "/v2/activity/growth/buddy/travel/status";
const CLAIM = "/v2/activity/growth/buddy/travel/claim";
const CONFIG = "/v2/activity/growth/buddy/travel/config";
const DEPART = "/v2/activity/growth/buddy/travel/depart";
const routes = (statusBody, overrides = {}) => ({
  [STATUS]: { body: statusBody },
  [CLAIM]: { body: { code: 0, data: { reward_credit: 20 } } },
  [CONFIG]: { body: { code: 0, data: { locations: [{ id: 1, name: "咖啡馆" }] } } },
  [DEPART]: { body: { code: 0, data: { location: { name: "咖啡馆" } } } },
  ...overrides,
});

test("状态解析：字段藏在 travel 子对象里也能认出「待领取」", () => {
  const info = travelStateOf({ code: 0, status: "ok", data: { travel: { status: "待领取礼物" } } });
  assert.equal(info.kind, "claimable");
  assert.match(info.path, /travel\.status/);
  assert.match(info.raw, /待领取礼物/);
});

test("状态解析：多种写法与中英文", () => {
  assert.equal(travelStateOf({ data: { state: "arrived" } }).kind, "claimable");
  assert.equal(travelStateOf({ data: { trip: { state: "traveling" } } }).kind, "traveling");
  assert.equal(travelStateOf({ data: { state: "idle" } }).kind, "idle");
  assert.equal(travelStateOf({ data: { foo: "bar" } }).kind, "unknown");
  assert.equal(travelStateOf({ data: { reward_credit: 20 } }).kind, "claimable");
});

test("业务码：HTTP 200 + code!=0 不算成功", () => {
  assert.equal(okResult({ status: 200, payload: { code: 0 } }), true);
  assert.equal(okResult({ status: 200, payload: { code: 5001 } }), false);
  assert.equal(okResult({ status: 400, payload: { code: 0 } }), false);
});

test("领取结果三分：收到 / 没礼物 / 真失败", () => {
  assert.equal(judgeClaimTravel({ status: 200, payload: { code: 0, data: { reward_credit: 20 } } }).credits, 20);
  assert.equal(judgeClaimTravel({ status: 200, payload: { code: 0, msg: "无可领取礼物" } }).kind, "no_gift");
  assert.equal(judgeClaimTravel({ status: 500, payload: {} }).kind, "failed");
});

test("状态认不出来时：先收礼再派，日志带原始 state", async () => {
  const { ctx } = await fixture();
  const calls = mockFetch(routes({ code: 0, data: { foo: "bar" } }));
  const out = await runTravel(ctx, newDay("2026-11-13"));
  assert.equal(out.status, "departed");
  assert.equal(out.credits, 20);
  assert.match(out.message, /state=/);
  assert.match(out.message, /回收到站礼物 \+20/);
  assert.match(out.message, /已派新行程/);
  assert.equal(calls.filter((p) => p === CLAIM).length, 1);
  assert.equal(calls.filter((p) => p === DEPART).length, 1);
});

test("上游明确说没礼物：跳过收礼继续派", async () => {
  const { ctx } = await fixture();
  const calls = mockFetch(routes({ code: 0, data: { state: "arrived" } }, {
    [CLAIM]: { body: { code: 0, msg: "already_claimed，无可领取礼物" } },
  }));
  const out = await runTravel(ctx, newDay("2026-11-13"));
  assert.equal(out.status, "departed");
  assert.equal(out.credits, 0);
  assert.equal(calls.filter((p) => p === DEPART).length, 1);
});

test("派发 200 但业务码非 0：不报成功，明确写「未派出」", async () => {
  const { ctx } = await fixture();
  mockFetch(routes({ code: 0, data: { state: "idle" } }, {
    [DEPART]: { body: { code: 5001, msg: "礼物待领取，不能出发" } },
  }));
  const out = await runTravel(ctx, newDay("2026-11-13"));
  assert.equal(out.status, "error");
  assert.match(out.message, /5001|礼物待领取/);
  assert.match(out.message, /未派出/);
  assert.equal(out.message.includes("已派新行程"), false);
});

test("明确在途：不发 claim、不派行程", async () => {
  const { ctx } = await fixture();
  const calls = mockFetch(routes({ code: 0, data: { state: "traveling" } }));
  const out = await runTravel(ctx, newDay("2026-11-13"));
  assert.equal(out.status, "waiting");
  assert.equal(calls.includes(CLAIM), false);
  assert.equal(calls.includes(DEPART), false);
});

test("领取失败：绝不派新行程（避免顶掉待领礼物）", async () => {
  const { ctx } = await fixture();
  const calls = mockFetch(routes({ code: 0, data: { state: "arrived" } }, {
    [CLAIM]: { status: 502, body: { msg: "upstream error" } },
  }));
  const out = await runTravel(ctx, newDay("2026-11-13"));
  assert.equal(out.status, "error");
  assert.match(out.message, /不派新行程/);
  assert.equal(calls.includes(DEPART), false);
});

test("403 + 次数用尽：判 limit 而不是 traveling", () => {
  assert.equal(classifyDepart({ status: 403, payload: { msg: "daily_limit_reached" } }), "limit");
});

test("诊断页：显示上游原始响应与解析结论，且只读、不泄漏令牌", async () => {
  const { default: worker } = await import("../src/index.js");
  const kv = makeKv();
  await saveAccount(kv, "uid-travel-001", {
    uid: "uid-travel-001", label: "主号", enabled: true,
    cred: { accessToken: ACCESS, refreshToken: "REFRESH_TRAVEL_VALUE", expiresAt: String(NOW + 30 * 86400) },
  });
  const calls = mockFetch(routes({ code: 0, data: { travel: { status: "待领取礼物" } } }));
  const res = await worker.fetch(
    new Request("http://localhost/travel/uid-travel-001?pwd=pw"),
    { CHECKIN_KV: kv, PASSWORD: "pw" },
  );
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /旅行状态诊断/);
  assert.match(html, /待领取礼物/);
  assert.match(html, /有礼可领/);
  assert.equal(html.includes(ACCESS), false);
  assert.equal(html.includes("REFRESH_TRAVEL_VALUE"), false);
  // 只读：只发了状态查询，没有 claim / depart
  assert.equal(calls.filter((p) => p === STATUS).length, 1);
  assert.equal(calls.includes(CLAIM), false);
  assert.equal(calls.includes(DEPART), false);
});

const LIVE = { depart_at: 1794539422, arrive_at: 1794546622, server_now: 1794540085, daily_limit_reached: true };

test("时间解析：截图里的真实响应，剩余 1 小时 48 分", async () => {
  const { travelTimingOf } = await import("../src/wb/api.js");
  const { fmtCSTSec, humanGap } = await import("../src/core/time.js");
  const t = travelTimingOf({ data: LIVE });
  assert.equal(t.remaining, 6537);
  assert.equal(t.due, false);
  assert.equal(humanGap(t.remaining), "1 小时 48 分");
  assert.equal(fmtCSTSec(t.departSec), "2026-11-13 11:10:22");
  assert.equal(fmtCSTSec(t.arriveSec), "2026-11-13 13:10:22");
});

test("在途未到点：等待，日志显示北京时间与剩余时长，不再有裸时间戳", async () => {
  const { ctx } = await fixture();
  const calls = mockFetch(routes({ code: 0, data: { state: "traveling", ...LIVE } }));
  const out = await runTravel(ctx, newDay("2026-11-13"));
  assert.equal(out.status, "waiting");
  assert.match(out.message, /13:10:22/);
  assert.match(out.message, /还需 1 小时 48 分/);
  assert.match(out.message, /今日旅行次数已用尽/);
  assert.equal(out.message.includes("1794546622"), false);
  assert.equal(calls.includes(CLAIM), false);
  assert.equal(calls.includes(DEPART), false);
});

test("已过到站时间但仍报在途：主动试领，收礼后也绝不派新行程", async () => {
  const { ctx } = await fixture();
  const calls = mockFetch(routes({
    code: 0, data: { state: "traveling", arrive_at: 1794540000, server_now: 1794546622 },
  }));
  const out = await runTravel(ctx, newDay("2026-11-13"));
  assert.equal(out.credits, 20);
  assert.match(out.message, /主动试领/);
  assert.match(out.message, /不派新行程/);
  assert.equal(calls.filter((p) => p === CLAIM).length, 1);
  assert.equal(calls.includes(DEPART), false);
});

test("领取应答没给奖励金额：判未确认，绝不派行程", async () => {
  const { judgeClaimTravel } = await import("../src/wb/api.js");
  assert.equal(judgeClaimTravel({ status: 200, payload: { code: 0, data: {} } }).kind, "uncertain");
  const { ctx } = await fixture();
  const calls = mockFetch(routes({ code: 0, data: { state: "arrived" } }, {
    [CLAIM]: { body: { code: 0, data: {} } },
  }));
  const out = await runTravel(ctx, newDay("2026-11-13"));
  assert.equal(out.status, "error");
  assert.match(out.message, /不派新行程/);
  assert.equal(calls.includes(DEPART), false);
});

test("诊断页显示出发/到站/剩余时间与今日次数", async () => {
  const { default: worker } = await import("../src/index.js");
  const kv = makeKv();
  await saveAccount(kv, "uid-travel-001", {
    uid: "uid-travel-001", label: "主号", enabled: true,
    cred: { accessToken: ACCESS, refreshToken: "REFRESH_TRAVEL_VALUE", expiresAt: String(NOW + 30 * 86400) },
  });
  mockFetch(routes({ code: 0, data: { state: "traveling", ...LIVE } }));
  const res = await worker.fetch(
    new Request("http://localhost/travel/uid-travel-001?pwd=pw"),
    { CHECKIN_KV: kv, PASSWORD: "pw" },
  );
  const html = await res.text();
  assert.match(html, /11:10:22/);
  assert.match(html, /13:10:22/);
  assert.match(html, /还需 1 小时 48 分/);
  assert.match(html, /今日旅行次数已用尽/);
});

test("主动领取按钮：直连 claim 并把上游原始响应摆出来", async () => {
  const { default: worker } = await import("../src/index.js");
  const kv = makeKv();
  await saveAccount(kv, "uid-travel-001", {
    uid: "uid-travel-001", label: "主号", enabled: true,
    cred: { accessToken: ACCESS, refreshToken: "REFRESH_TRAVEL_VALUE", expiresAt: String(NOW + 30 * 86400) },
  });
  const calls = mockFetch(routes({ code: 0, data: {} }, {
    [CLAIM]: { body: { code: 0, msg: "OK", data: { reward_credit: 5 } } },
  }));
  const res = await worker.fetch(
    new Request("http://localhost/account/uid-travel-001/claim?pwd=pw", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "content-length": "5" },
      body: "pwd=pw",
    }),
    { CHECKIN_KV: kv, PASSWORD: "pw" },
  );
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /领取结果/);
  assert.match(html, /领取成功|reward_credit/);
  assert.equal(calls.includes(DEPART), false);
  assert.equal(html.includes(ACCESS), false);
});

test("未到站单独归类，绝不当成没礼物继续派行程", async () => {
  const { judgeClaimTravel } = await import("../src/wb/api.js");
  assert.equal(judgeClaimTravel({ status: 403, payload: { code: 403, msg: "not arrived yet" } }).kind, "not_arrived");
  const { ctx } = await fixture();
  const calls = mockFetch(routes({ code: 0, data: { state: "unknown_value" } }, {
    [CLAIM]: { status: 403, body: { code: 403, msg: "not arrived yet" } },
  }));
  const out = await runTravel(ctx, newDay("2026-11-13"));
  assert.equal(out.status, "error");
  assert.equal(calls.includes(DEPART), false);
});
