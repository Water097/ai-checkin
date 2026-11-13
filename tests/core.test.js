import test from "node:test";
import assert from "node:assert/strict";
import { makeBudget, trackedFetch, budgetFrom } from "../src/core/budget.js";
import { decodeJwt, subjectOf, expiresAtOf, isEncrypted } from "../src/core/jwt.js";
import { scrub } from "../src/core/logs.js";
import { logicalDay } from "../src/core/time.js";
import { newDay, isSettled } from "../src/core/state.js";
import { authenticate } from "../src/core/gate.js";
import { makeKv } from "./kv.mock.js";
import { getAccount, saveAccount, applyCredPatch } from "../src/core/accounts.js";

const jwt = (payload) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

test("预算：fits 是纯判定，charge 才改状态", () => {
  const b = makeBudget(3);
  assert.equal(b.fits(2), true);
  assert.equal(b.used, 0);
  b.charge(2);
  assert.equal(b.used, 2);
  assert.equal(b.fits(2), false);
  assert.equal(b.left(), 1);
});

test("预算：默认上限小于平台硬顶 50，且可被 env 覆盖", () => {
  assert.equal(budgetFrom({}), 45);
  assert.equal(budgetFrom({ BUDGET_SUBREQUESTS: "30" }), 30);
  assert.equal(budgetFrom({ BUDGET_SUBREQUESTS: "999" }), 45);
});

test("出站白名单：不在名单里直接拒绝，且不消耗预算", async () => {
  const b = makeBudget(5);
  const f = trackedFetch(b, ["copilot.tencent.com"]);
  await assert.rejects(() => f("https://evil.example.com/x"), /禁止的请求域名/);
  assert.equal(b.used, 0);
});

test("出站白名单：空名单 fail-closed", async () => {
  const f = trackedFetch(makeBudget(5), []);
  await assert.rejects(() => f("https://copilot.tencent.com/x"), /白名单为空/);
});

test("JWT：只认明文票据，加密 envelope 一律拒绝", () => {
  const token = jwt({ sub: "uid-123", exp: 1893456000 });
  assert.equal(subjectOf(token), "uid-123");
  assert.equal(expiresAtOf(token), 1893456000);
  assert.equal(decodeJwt('{"$wbEncrypted":1,"envelope":"abc"}'), null);
  assert.equal(isEncrypted({ $wbEncrypted: 1 }), true);
  assert.equal(isEncrypted("plain"), false);
});

test("脱敏：长串优先，且能洗掉被轮换掉的旧串", () => {
  const text = "网关回显了 eyJ.LONG.SECRET 和 REFRESH_OLD_VALUE";
  const out = scrub(text, ["eyJ.LONG.SECRET", "REFRESH_OLD_VALUE"]);
  assert.equal(out.includes("eyJ.LONG.SECRET"), false);
  assert.equal(out.includes("REFRESH_OLD_VALUE"), false);
  assert.equal(out.includes("***"), true);
});

test("逻辑日按北京时间，UTC 16:01 已是次日", () => {
  assert.equal(logicalDay(Date.parse("2026-11-12T16:00:00Z") / 1000), "2026-11-13");
  assert.equal(logicalDay(Date.parse("2026-11-12T15:59:00Z") / 1000), "2026-11-12");
});

test("收工判定：签到有结论 + 旅行 done 才算；waiting 不算", () => {
  const d = newDay("2026-11-13");
  assert.equal(isSettled(d), false);
  d.checkin = "claimed";
  d.travel = "waiting";
  assert.equal(isSettled(d), false);
  d.travel = "done";
  assert.equal(isSettled(d), true);
});

test("口令闸：查询串 / 头 / 表单三个来路，取真正匹配的那个", async () => {
  const env = { PASSWORD: "correct-horse" };
  const req = (url, headers = {}) => new Request(url, { headers });
  assert.equal((await authenticate(req("https://x/?pwd=correct-horse"), new URL("https://x/?pwd=correct-horse"), env)).verdict, "ok");
  const u2 = new URL("https://x/");
  assert.equal((await authenticate(req("https://x/", { "x-pwd": "correct-horse" }), u2, env)).verdict, "ok");
  // 查询串塞错口令、靠头通过时，回传的必须是头里那个正确的
  const u3 = new URL("https://x/?pwd=wrong");
  const a = await authenticate(req("https://x/?pwd=wrong", { "x-pwd": "correct-horse" }), u3, env);
  assert.equal(a.verdict, "ok");
  assert.equal(a.pwd, "correct-horse");
  const u4 = new URL("https://x/?pwd=wrong");
  assert.equal((await authenticate(req("https://x/?pwd=wrong"), u4, env)).verdict, "reject");
  assert.equal((await authenticate(req("https://x/"), new URL("https://x/"), {})).verdict, "unconfigured");
});

test("续期写回：只收白名单字段，且真的落到 KV", async () => {
  const kv = makeKv();
  await saveAccount(kv, "u1", { uid: "u1", label: "主号", cred: { accessToken: "OLD_ACCESS_VALUE", refreshToken: "OLD_REFRESH_VALUE", expiresAt: "" } });
  const changed = await applyCredPatch(kv, "u1", { accessToken: "NEW_ACCESS_VALUE", refreshToken: "NEW_REFRESH_VALUE", expiresAt: "1893456000", evil: "nope" });
  assert.equal(changed, true);
  const saved = await getAccount(kv, "u1");
  assert.equal(saved.cred.accessToken, "NEW_ACCESS_VALUE");
  assert.equal(saved.cred.refreshToken, "NEW_REFRESH_VALUE");
  assert.equal(saved.cred.expiresAt, "1893456000");
  assert.equal(saved.cred.evil, undefined);
});
