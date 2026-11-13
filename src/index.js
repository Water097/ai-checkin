import { authenticate } from "./core/gate.js";
import { htmlRes, jsonRes, esc } from "./core/http.js";
import { renderGate, renderFatal, renderUnconfigured, renderResult, homePage, runsPage } from "./ui.js";
import { requireKv } from "./core/kv.js";
import { listAccounts, getAccount, saveAccount, deleteAccount } from "./core/accounts.js";
import { runTick, runAccount, validateAccount, nowSec } from "./core/runner.js";
import { makeBudget, budgetFrom } from "./core/budget.js";
import { listLogs } from "./core/logs.js";
import { dayOf, loadDay } from "./core/state.js";
import { uidOf } from "./wb/api.js";
import { expiresAtOf, isEncrypted } from "./core/jwt.js";

export const VERSION = "0.1.0";

function redirect(path, pwd) {
  const sep = path.includes("?") ? "&" : "?";
  return new Response(null, { status: 303, headers: { location: `${path}${sep}pwd=${encodeURIComponent(pwd)}` } });
}

function flash(text, pwd) {
  return redirect(`/?flash=${encodeURIComponent(text)}`, pwd);
}

async function home(env, pwd, flashText) {
  const kv = requireKv(env);
  const now = nowSec();
  const accounts = await listAccounts(kv);
  const day = dayOf(now);
  const days = {};
  for (const account of accounts) {
    days[account.uid] = await loadDay(kv, account.uid, day);
  }
  const logs = await listLogs(kv, 5);
  return htmlRes(homePage({ accounts, days, logs, pwd, flash: flashText, now }));
}

async function dispatch(request, url, env, auth) {
  const { pwd, form } = auth;
  const kv = requireKv(env);
  const method = request.method.toUpperCase();
  const path = url.pathname;

  if (method === "GET" && path === "/") return home(env, pwd, url.searchParams.get("flash"));
  // 口令闸页提交表单：鉴权已通过，转成带 pwd 的 GET 回首页。
  if (method === "POST" && path === "/") return redirect("/", pwd);
  if (method === "GET" && path === "/runs") return htmlRes(runsPage({ logs: await listLogs(kv, 60), pwd }));

  if (method === "GET" && path === "/api/health") {
    return jsonRes({ ok: true, version: VERSION, now: nowSec(), day: dayOf(nowSec()) });
  }

  // 手动触发整轮，方便部署后不用等 cron 就能验证。
  if ((method === "GET" || method === "POST") && path === "/api/tick") {
    return jsonRes(await runTick({ env, now: nowSec(), trigger: "manual" }));
  }

  if (method === "POST" && path === "/account/add") {
    const label = String(form.get("label") || "").trim() || "未命名";
    const accessToken = String(form.get("accessToken") || "").trim();
    const refreshToken = String(form.get("refreshToken") || "").trim();
    const uidInput = String(form.get("uid") || "").trim();
    if (!accessToken || !refreshToken) return flash("Access Token 和 Refresh Token 都要填", pwd);
    if (isEncrypted(accessToken) || isEncrypted(refreshToken)) {
      return flash("这是新版桌面端的加密票据（$wbEncrypted），请用短信登录换明文 token", pwd);
    }
    const uid = uidInput || uidOf({ accessToken, refreshToken });
    if (!uid) return flash("解不出账号标识，请在「账号标识 uid」一栏手填", pwd);
    const exp = expiresAtOf(accessToken);
    await saveAccount(kv, uid, {
      uid, label, enabled: true, createdAt: Date.now(),
      cred: { accessToken, refreshToken, expiresAt: exp ? String(exp) : "" },
    });
    return flash(`账号「${label}」已保存`, pwd);
  }

  const match = /^\/account\/([^/]+)\/(test|run|delete|toggle)$/.exec(path);
  if (method === "POST" && match) {
    let uid;
    try { uid = decodeURIComponent(match[1]); } catch { return htmlRes(renderFatal("路径编码不合法"), 400); }
    const action = match[2];
    const account = await getAccount(kv, uid);
    if (!account) return flash("账号不存在或记录已损坏", pwd);

    if (action === "delete") {
      await deleteAccount(kv, uid);
      return flash(`账号「${account.label}」已删除`, pwd);
    }
    if (action === "toggle") {
      account.enabled = account.enabled === false;
      await saveAccount(kv, uid, account);
      return flash(`账号「${account.label}」已${account.enabled ? "启用" : "停用"}`, pwd);
    }
    if (action === "test") {
      const result = await validateAccount({ env, account, now: nowSec() });
      return htmlRes(renderResult("连接测试", result, pwd));
    }
    // 「立即执行」跳过收工判定，但跳过不了预算、锁和步骤自身的幂等。
    const budget = makeBudget(budgetFrom(env));
    const result = await runAccount({ env, budget, account, now: nowSec(), trigger: "manual", force: true });
    return htmlRes(renderResult("立即执行", result, pwd));
  }

  return htmlRes(renderFatal(`没有这个页面：${esc(path)}`), 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // favicon 不带口令，放在鉴权之前，否则浏览器永远拿到 401
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });

    const auth = await authenticate(request, url, env);
    if (auth.verdict === "unconfigured") return htmlRes(renderUnconfigured(), 500);
    if (auth.verdict === "bad_body") {
      return htmlRes(renderFatal("请求体无法处理：必须是 urlencoded 表单、带 content-length、且不超过 64 KB"), 413);
    }
    // 未鉴权时不进路由、不读 KV：错误口令不该产生任何可观察的差异
    if (auth.verdict !== "ok") return htmlRes(renderGate(), 401);
    try {
      return await dispatch(request, url, env, auth);
    } catch (error) {
      // 只记 message，绝不记 url——口令在查询串里
      console.error("[ai-checkin] 请求处理失败：" + String((error && error.message) || error));
      return htmlRes(renderFatal(String((error && error.message) || error)), 500);
    }
  },

  async scheduled(controller, env) {
    // 用平台给的计划时刻而不是 Date.now()：那才是这次触发对应的时间点
    const now = Math.floor(Number(controller && controller.scheduledTime) / 1000) || nowSec();
    const cron = String((controller && controller.cron) || "");
    try {
      const summary = await runTick({ env, now, trigger: `cron:${cron}` });
      console.log("[ai-checkin] " + JSON.stringify(summary));
    } catch (error) {
      console.error("[ai-checkin] 本轮执行失败：" + String((error && error.message) || error));
    }
  },
};
