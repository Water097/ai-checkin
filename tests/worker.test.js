// 直接调 Worker 的 fetch / scheduled 入口，证明「能跑」，不需要 wrangler、不联网。
import test from "node:test";
import assert from "node:assert/strict";
import worker, { VERSION } from "../src/index.js";
import { makeKv } from "./kv.mock.js";
import { getAccount } from "../src/core/accounts.js";

const jwt = (payload) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
const NOW = Math.floor(Date.parse("2026-11-13T02:00:00Z") / 1000);
const ACCESS = jwt({ sub: "uid-entry-001", exp: NOW + 30 * 86400 });

function env(kv = makeKv()) {
  return { CHECKIN_KV: kv, PASSWORD: "sec ret" };
}

function mockFetch(routes = {}) {
  globalThis.fetch = async (input) => {
    const path = new URL(String(typeof input === "string" ? input : input.url)).pathname;
    const out = routes[path] || {};
    return new Response(JSON.stringify(out.body ?? { code: 0, data: {} }), {
      status: out.status ?? 200, headers: { "content-type": "application/json" },
    });
  };
}

function post(path, fields) {
  const body = new URLSearchParams(fields).toString();
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(body)) },
    body,
  });
}

test("未带口令 → 401 口令闸，且没碰 KV", async () => {
  const e = env();
  const res = await worker.fetch(new Request("http://localhost/"), e);
  assert.equal(res.status, 401);
  assert.match(await res.text(), /需要口令/);
});

test("口令正确 → 总览页 200，无任何 JavaScript", async () => {
  const res = await worker.fetch(new Request("http://localhost/?pwd=sec%20ret"), env());
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /总览/);
  assert.match(html, /新增账号/);
  assert.equal(html.includes("<script"), false);
  assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
});

test("口令闸表单提交 → 303 回首页并带上正确口令", async () => {
  const res = await worker.fetch(post("/", { pwd: "sec ret" }), env());
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location"), /pwd=sec%20ret/);
});

test("未配 PASSWORD → 明确报 500，不静默放行", async () => {
  const res = await worker.fetch(new Request("http://localhost/"), { CHECKIN_KV: makeKv() });
  assert.equal(res.status, 500);
  assert.match(await res.text(), /PASSWORD/);
});

test("/api/health 返回版本与逻辑日", async () => {
  const res = await worker.fetch(new Request("http://localhost/api/health?pwd=sec%20ret"), env());
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.version, VERSION);
  assert.match(json.day, /^\d{4}-\d{2}-\d{2}$/);
});

test("新增账号：表单 → 解出 uid → 落库 → 首页能看到", async () => {
  const e = env();
  const res = await worker.fetch(post("/account/add?pwd=sec%20ret", {
    pwd: "sec ret", label: "主号", accessToken: ACCESS, refreshToken: "REFRESH_ENTRY_VALUE_LONG",
  }), e);
  assert.equal(res.status, 303);
  const saved = await getAccount(e.CHECKIN_KV, "uid-entry-001");
  assert.equal(saved.label, "主号");
  assert.equal(saved.cred.accessToken, ACCESS);
  const home = await worker.fetch(new Request("http://localhost/?pwd=sec%20ret"), e);
  assert.match(await home.text(), /主号/);
});

test("加密票据被拒绝，不会写进 KV", async () => {
  const e = env();
  const res = await worker.fetch(post("/account/add?pwd=sec%20ret", {
    pwd: "sec ret", label: "坏号",
    accessToken: '{"$wbEncrypted":1,"envelope":"abc"}', refreshToken: "whatever",
  }), e);
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location"), /%24wbEncrypted|加密票据/);
  assert.deepEqual(e.CHECKIN_KV._dump(), {});
});

test("scheduled 一轮：不抛异常，账号被真正调度", async () => {
  const e = env();
  const { saveAccount } = await import("../src/core/accounts.js");
  await saveAccount(e.CHECKIN_KV, "uid-entry-001", {
    uid: "uid-entry-001", label: "主号", enabled: true,
    cred: { accessToken: ACCESS, refreshToken: "REFRESH_ENTRY_VALUE_LONG", expiresAt: String(NOW + 30 * 86400) },
  });
  mockFetch({
    "/v2/billing/meter/checkin-activity-status": { body: { code: 0, data: { today_checked_in: true } } },
    "/v2/activity/growth/buddy/travel/status": { body: { code: 0, data: { state: "idle", daily_limit_reached: true } } },
  });
  // console.log 是这一轮唯一的输出，断言不抛即可
  await worker.scheduled({ scheduledTime: NOW * 1000, cron: "*/30 * * * *" }, e);
  const { listLogs } = await import("../src/core/logs.js");
  const logs = await listLogs(e.CHECKIN_KV);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].credits, 0);
  // 签到已领 + 旅行收工是「今日已处理」，不能报成部分完成
  assert.equal(logs[0].status, "already");
});
