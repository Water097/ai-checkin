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
