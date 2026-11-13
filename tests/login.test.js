import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { makeKv } from "./kv.mock.js";
import { getAccount } from "../src/core/accounts.js";
import { validPhone, validCode, maskPhone, sendSms, exchangeToken, LOGIN_HOST } from "../src/wb/login.js";

const jwt = (payload) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
const PHONE = "18875150684";
const ACCESS = jwt({ sub: "uid-sms-001", exp: 1893456000 });

const env = (kv = makeKv()) => ({ CHECKIN_KV: kv, PASSWORD: "pw" });

function post(path, fields) {
  const body = new URLSearchParams(fields).toString();
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(body)) },
    body,
  });
}

function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(typeof input === "string" ? input : input.url);
    calls.push({ url, host: new URL(url).hostname, init });
    const out = routes[new URL(url).pathname] || {};
    return new Response(JSON.stringify(out.body ?? { code: 0, data: {} }), {
      status: out.status ?? 200, headers: { "content-type": "application/json" },
    });
  };
  return calls;
}

test("输入校验：手机号 / 验证码 / 掩码", () => {
  assert.equal(validPhone(PHONE), true);
  assert.equal(validPhone("12345"), false);
  assert.equal(validPhone("abc"), false);
  assert.equal(validCode("123456"), true);
  assert.equal(validCode("12"), false);
  assert.equal(maskPhone(PHONE), "188****0684");
});

test("发码只打固定域名，失败时给出可读原因", async () => {
  const calls = mockFetch({ "/v2/plugin/login/send-sms": { body: { code: 0, msg: "OK" } } });
  const ok = await sendSms(PHONE);
  assert.equal(ok.ok, true);
  assert.equal(calls[0].host, LOGIN_HOST);
  assert.deepEqual(JSON.parse(calls[0].init.body), { phone: PHONE });

  mockFetch({ "/v2/plugin/login/send-sms": { body: { code: 5001, msg: "too fast" } } });
  const bad = await sendSms(PHONE);
  assert.equal(bad.ok, false);
  assert.match(bad.message, /5001/);
  assert.equal((await sendSms("123")).ok, false);
});

test("换票：返回双令牌；接口没给令牌时明确报错", async () => {
  mockFetch({ "/v2/plugin/login/token": { body: { code: 0, data: { accessToken: ACCESS, refreshToken: "REFRESH_FROM_SMS" } } } });
  const ok = await exchangeToken(PHONE, "123456");
  assert.equal(ok.ok, true);
  assert.equal(ok.accessToken, ACCESS);
  assert.equal(ok.refreshToken, "REFRESH_FROM_SMS");

  mockFetch({ "/v2/plugin/login/token": { body: { code: 0, data: {} } } });
  assert.equal((await exchangeToken(PHONE, "123456")).ok, false);
  assert.equal((await exchangeToken(PHONE, "ab")).ok, false);
});

test("CSP 放行内联样式，但依然禁止脚本", async () => {
  const res = await worker.fetch(new Request("http://localhost/?pwd=pw"), env());
  const csp = res.headers.get("content-security-policy");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /style-src 'unsafe-inline'/);
  assert.equal(csp.includes("script-src"), false);
  const html = await res.text();
  assert.match(html, /<style>/);
  assert.equal(html.includes("<script"), false);
});

test("GET /setup：两步引导页，零脚本", async () => {
  const res = await worker.fetch(new Request("http://localhost/setup?pwd=pw"), env());
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /发送验证码/);
  assert.match(html, /短信登录|手机号/);
  assert.equal(html.includes("<script"), false);
});

test("网页短信登录端到端：发码 → 换票 → 落库 → 首页可见", async () => {
  const e = env();
  mockFetch({
    "/v2/plugin/login/send-sms": { body: { code: 0, msg: "OK" } },
    "/v2/plugin/login/token": { body: { code: 0, data: { accessToken: ACCESS, refreshToken: "REFRESH_FROM_SMS" } } },
  });

  const step1 = await worker.fetch(post("/account/sms/send?pwd=pw", {
    pwd: "pw", label: "主号", phone: PHONE,
  }), e);
  assert.equal(step1.status, 200);
  const html1 = await step1.text();
  assert.match(html1, /短信验证码/);
  assert.match(html1, new RegExp(`name="phone" value="${PHONE}"`));
  assert.equal(html1.includes(ACCESS), false);

  const step2 = await worker.fetch(post("/account/sms/verify?pwd=pw", {
    pwd: "pw", label: "主号", phone: PHONE, code: "123456",
  }), e);
  assert.equal(step2.status, 303);
  const saved = await getAccount(e.CHECKIN_KV, "uid-sms-001");
  assert.equal(saved.label, "主号");
  assert.equal(saved.cred.accessToken, ACCESS);
  assert.equal(saved.cred.refreshToken, "REFRESH_FROM_SMS");

  const home = await worker.fetch(new Request("http://localhost/?pwd=pw"), e);
  assert.match(await home.text(), /主号/);
});

test("非法手机号不发任何上游请求", async () => {
  const calls = mockFetch({});
  const e = env();
  const res = await worker.fetch(post("/account/sms/send?pwd=pw", {
    pwd: "pw", label: "坏号", phone: "123",
  }), e);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /手机号格式不对/);
  assert.equal(calls.length, 0);
  assert.deepEqual(e.CHECKIN_KV._dump(), {});
});

test("验证码错误时保留手机号，且令牌不出现在页面上", async () => {
  mockFetch({ "/v2/plugin/login/token": { body: { code: 4001, msg: "wrong code" } } });
  const res = await worker.fetch(post("/account/sms/verify?pwd=pw", {
    pwd: "pw", label: "主号", phone: PHONE, code: "000000",
  }), env());
  const html = await res.text();
  assert.match(html, /wrong code/);
  assert.match(html, new RegExp(`name="phone" value="${PHONE}"`));
  assert.equal(html.includes("REFRESH_FROM_SMS"), false);
});
