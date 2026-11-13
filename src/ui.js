import { page, esc } from "./core/http.js";
import { maskUid, credState } from "./core/accounts.js";
import { travelTimingOf, dig } from "./wb/api.js";
import { fmtCSTSec, humanGap } from "./core/time.js";

const q = (pwd) => (pwd ? `?pwd=${encodeURIComponent(pwd)}` : "");
const hidden = (name, value) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;

const STATUS_TEXT = {
  claimed: "已领取", already: "今日已领", inactive: "活动未开", waiting: "等待中",
  departed: "已派出", partial: "部分完成", deferred: "顺延", skipped: "跳过",
  login_required: "需重新登录", error: "失败", reused: "已处理", ok: "正常",
  done: "已完成", missing: "凭据不全", expiring: "即将过期", dead: "已失效",
  pending: "未开始",
};

function badge(status, state) {
  const tone = state || (["claimed", "ok", "done"].includes(status) ? "ok"
    : ["waiting", "partial", "deferred", "departed", "expiring"].includes(status) ? "wait"
      : ["error", "login_required", "dead", "missing"].includes(status) ? "bad" : "idle");
  return `<span class="badge b-${tone}">${esc(STATUS_TEXT[status] || status || "—")}</span>`;
}

export function renderGate() {
  return page("需要口令", `<p class="sub">这个页面受口令保护。</p>
    <div class="card" style="max-width:420px;margin:0 auto">
      <form method="post" action="/">
        <label>访问口令</label><input type="password" name="pwd" autocomplete="current-password" required autofocus>
        <p style="margin-top:18px"><button class="btn primary lg" type="submit">进入签到台</button></p>
      </form></div>`);
}

export function renderUnconfigured() {
  return page("还没配好", `<div class="note error">Worker 上没有 <code>PASSWORD</code>。
    线上用 <code>npx wrangler secret put PASSWORD</code>，本地在 <code>.dev.vars</code> 里填。</div>`);
}

export function renderFatal(message) {
  return page("出错了", `<div class="note error">${esc(message)}</div>
    <p><a href="/">回到首页</a></p>`);
}

export function renderResult(title, result, pwd) {
  const rows = (result.steps || []).map((s) => `<tr><td class="mono">${esc(s.id)}</td><td>${badge(s.status)}</td><td>${esc(s.message)}</td></tr>`).join("");
  return page(title, `
    <p class="sub"><a href="/${q(pwd)}">← 回到总览</a></p>
    <div class="card"><div class="row between"><div><span class="name">${esc(result.label || result.uid || "")}</span> ${badge(result.status)}</div>
      <div class="small">本轮 +${Number(result.credits) || 0} 积分 · ${Number(result.http) || 0} 次请求</div></div>
      <p class="meta">${esc(result.message || "")}</p></div>
    ${rows ? `<h2>步骤明细</h2><table><tr><th>步骤</th><th>结果</th><th>说明</th></tr>${rows}</table>` : ""}`);
}

// 网页内短信登录：两步，零 JS。手机号与备注名用隐藏字段在两步之间传递。
export function setupPage({ pwd, step = 1, label = "", phone = "", uid = "", notice = "", error = "" }) {
  const p = q(pwd);
  const steps = `<div class="steps">
    <span class="step ${step === 1 ? "on" : ""}"><b>1</b>填手机号</span><span class="step-line"></span>
    <span class="step ${step === 2 ? "on" : ""}"><b>2</b>填验证码</span></div>`;
  const banner = error ? `<div class="note error">${esc(error)}</div>`
    : notice ? `<div class="note success">${esc(notice)}</div>` : "";

  const body = step === 1
    ? `<form method="post" action="/account/sms/send${p}">
        ${hidden("pwd", pwd)}
        <label>备注名</label><input name="label" value="${esc(label)}" placeholder="主号" required>
        <label>手机号</label><input name="phone" value="${esc(phone)}" inputmode="numeric" autocomplete="tel" placeholder="11 位大陆手机号" required autofocus>
        <p style="margin-top:20px"><button class="btn primary lg" type="submit">发送验证码 →</button></p>
        <p class="hint">验证码由 WorkBuddy 官方登录接口下发，本站只经手一次，不保存手机号。</p>
      </form>`
    : `<form method="post" action="/account/sms/verify${p}">
        ${hidden("pwd", pwd)}${hidden("label", label)}${hidden("phone", phone)}
        <div class="row between"><div><span class="small">账号备注</span><div class="name">${esc(label || "未命名")}</div></div>
          <div><span class="small">手机号</span><div class="mono">${esc(phone)}</div></div></div>
        <label>短信验证码</label><input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="4~8 位数字" required autofocus>
        <label>账号标识 uid（一般留空，自动从令牌解出）</label><input name="uid" value="${esc(uid)}" placeholder="留空即可">
        <p style="margin-top:20px"><button class="btn primary lg" type="submit">完成添加</button></p>
        <p class="hint">换到令牌后由 Worker 直接存入 KV，页面不会显示令牌原文。</p>
      </form>
      <p style="margin-top:18px"><a href="/setup${p}">← 换个手机号 / 重新发送</a></p>`;

  return page("添加账号", `<p class="sub">全程在网页完成，不需要跑任何本地命令。</p>
    <div class="card" style="max-width:560px">${steps}${banner}${body}</div>
    <div class="note">新版桌面端把登录凭据加密成 <code>$wbEncrypted</code>，本地文件读不出明文，
      所以走官方短信登录换票。别在多个地方同时登录同一账号：refreshToken 是一次性的，被别处轮换会掉号。</div>`);
}

export function homePage({ accounts, days, logs, pwd, flash, now }) {
  const totalToday = accounts.reduce((sum, a) => sum + (Number((days[a.uid] || {}).credits) || 0), 0);
  const totalRounds = accounts.reduce((sum, a) => sum + (Number((days[a.uid] || {}).rounds) || 0), 0);
  const p = q(pwd);

  const cards = accounts.map((a) => {
    const d = days[a.uid] || {};
    const cs = credState(a, now);
    const uid = esc(a.uid);
    return `<div class="card hoverable">
      <div class="row between">
        <div><span class="name">${esc(a.label || "未命名")}</span><span class="uid">${esc(maskUid(a.uid))}</span></div>
        <div class="row">${badge(d.checkin || "pending")}${badge(d.travel || "pending")}</div>
      </div>
      <div class="row" style="gap:22px;margin-top:12px">
        <div><span class="small">今日积分</span><div class="name">+${Number(d.credits) || 0}</div></div>
        <div><span class="small">行程</span><div class="name">${Number(d.rounds) || 0} 趟</div></div>
        <div><span class="small">凭据</span><div>${badge(cs)}</div></div>
        <div class="grow"><span class="small">今日状态</span><div class="small" style="margin-top:3px">${esc(d.lastMessage || "尚未运行")}</div></div>
      </div>
      <div class="row" style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
        <form class="inline" method="post" action="/account/${uid}/test${p}">${hidden("pwd", pwd)}<button class="btn" type="submit">测试连接</button></form>
        <a class="btn" href="/travel/${uid}${p}">旅行状态</a>
        <form class="inline" method="post" action="/account/${uid}/claim${p}">${hidden("pwd", pwd)}<button class="btn" type="submit">立即领礼物</button></form>
        <form class="inline" method="post" action="/account/${uid}/run${p}">${hidden("pwd", pwd)}<button class="btn primary" type="submit">立即执行</button></form>
        <form class="inline" method="post" action="/account/${uid}/toggle${p}">${hidden("pwd", pwd)}<button class="btn" type="submit">${a.enabled === false ? "启用" : "停用"}</button></form>
        <form class="inline" method="post" action="/account/${uid}/delete${p}">${hidden("pwd", pwd)}<button class="btn danger" type="submit">删除</button></form>
      </div></div>`;
  }).join("") || `<div class="empty">还没有账号。点上面的「短信登录添加账号」，两步就能加好。</div>`;

  const recent = (logs || []).slice(0, 5).map((r) => `<tr><td class="small">${esc(r.when)}</td>
    <td>${esc(r.label || r.uid)}</td><td>${badge(r.status)}</td><td>+${Number(r.credits) || 0}</td></tr>`).join("");

  return page("总览", `
    ${flash ? `<div class="note success">${esc(flash)}</div>` : ""}
    <div class="hero">
      <div class="row between">
        <div><div class="kicker">Today</div><div class="big">+${totalToday}<small>积分</small></div>
          <div class="desc">WorkBuddy · 每日签到 + Buddy 旅行 + 回收积分</div></div>
        <a class="btn lg" href="/setup${p}">＋ 短信登录添加账号</a>
      </div>
      <div class="stats"><div>账号<strong>${accounts.length}</strong></div>
        <div>今日行程<strong>${totalRounds} 趟</strong></div>
        <div>自动运行<strong>每 30 分钟</strong></div></div>
    </div>
    <div class="note">每 30 分钟自动跑一轮；「立即执行」跳过收工判定，但步骤本身仍然幂等。
      「测试连接」只读登录态、不领取，可能顺带续期并写回新凭据。</div>
    <h2>账号（${accounts.length}）</h2>${cards}
    <h2>其他添加方式</h2>
    <details><summary>手填 Access Token / Refresh Token（兜底）</summary>
      <form method="post" action="/account/add${p}" style="padding-bottom:18px">
        ${hidden("pwd", pwd)}
        <label>备注名</label><input name="label" placeholder="主号" required>
        <label>Access Token（明文 JWT，eyJ 开头）</label><textarea name="accessToken" required></textarea>
        <label>Refresh Token</label><textarea name="refreshToken" required></textarea>
        <label>账号标识 uid（可留空，默认从 JWT 的 sub 解）</label><input name="uid" placeholder="留空即可">
        <p style="margin-top:16px"><button class="btn primary" type="submit">保存账号</button></p>
      </form></details>
    <h2>最近运行</h2>
    ${recent ? `<table><tr><th>时间</th><th>账号</th><th>结果</th><th>积分</th></tr>${recent}</table>
      <p style="margin-top:12px"><a href="/runs${p}">查看全部日志 →</a></p>` : `<div class="empty">还没有运行记录。</div>`}`);
}

// 主动领取的结果页：把上游原始响应一起摆出来，确认「昨天的礼物还在不在」。
export function claimResultPage({ pwd, uid, label, result, raw, meta }) {
  const p = q(pwd);
  const text = {
    claimed: "领取成功", no_gift: "上游明确说没有待领礼物",
    not_arrived: "还没到站（等到站后再领）", uncertain: "结果不明确，未确认领取", failed: "领取失败",
  }[result?.kind] || "未知结果";
  const tone = result?.kind === "claimed" ? "claimed"
    : result?.kind === "not_arrived" ? "waiting"
      : result?.kind === "no_gift" ? "already" : "error";
  return page("领取结果", `
    <p class="sub"><a href="/${p}">← 回到总览</a></p>
    <div class="card"><div class="row between"><div><span class="name">${esc(label)}</span>
      <span class="uid">${esc(uid)}</span></div><div>${badge(tone)} ${esc(text)}</div></div>
      <p class="meta">${esc(result?.message || "")} ｜ 本轮 +${Number(result?.credits) || 0} 积分</p>
      ${meta ? `<p class="small mono">${esc(meta)}</p>` : ""}</div>
    <h2>上游原始响应</h2><pre>${esc(raw || "（空响应体）")}</pre>
    <div class="note ${result?.kind === "no_gift" ? "error" : ""}">${
      result?.kind === "no_gift"
        ? "上游明确报「没有待领礼物」：昨天那趟多半已被新行程覆盖，接口层没有历史补领入口，本工具找不回来。"
        : result?.kind === "uncertain"
          ? "上游返回空响应：通常表示当前没有待领礼物（行程还在途中，或旧记录已被新行程覆盖）。这种情况下本工具不会派新行程。"
          : "领取接口是幂等的，多点几次不会重复扣；但如果上游一直说没有礼物，就说明记录已被覆盖。"
    }</div>
    <div class="row" style="margin-top:16px">
      <a class="btn" href="/travel/${esc(uid)}${p}">查看旅行状态</a>
      <form class="inline" method="post" action="/account/${esc(uid)}/claim${p}">${hidden("pwd", pwd)}<button class="btn primary" type="submit">再领一次</button></form></div>`);
}

// 只读诊断页：把上游旅行状态的原始响应摆出来，避免再靠猜字段。
export function travelStatusPage({ pwd, uid, label, payload, info, error }) {
  const p = q(pwd);
  const kindText = {
    claimable: "有礼可领（会先收礼）", traveling: "旅途中（不重复出发）",
    idle: "空闲（可直接派）", unknown: "未识别（会先试领取）",
  };
  const raw = payload ? JSON.stringify(payload, null, 2) : "（无响应）";
  const tone = info?.kind === "claimable" ? "claimed" : info?.kind === "traveling" ? "waiting" : "pending";
  const timing = payload ? travelTimingOf(payload) : null;
  const limitRaw = payload ? dig(payload, "daily_limit_reached") : null;
  const limitText = limitRaw === true || limitRaw === 1 ? "今日旅行次数已用尽" : "今日旅行次数未用尽";
  const remainingText = !timing || timing.remaining === null ? "剩余时间未知"
    : timing.remaining > 0 ? `还需 ${humanGap(timing.remaining)} 到站`
      : "到站时间已过（上游状态可能滞后，会主动试领）";
  const nextText = info?.kind === "traveling"
    ? (timing?.due ? "已过到站时间，主动试领；仍标记在途则不派新行程" : "等下一轮到站后再收")
    : info?.kind === "idle" ? "可以派新行程" : "先试领取，成功后再派";
  return page("旅行状态诊断", `
    <p class="sub">只读诊断：不领礼物、不派行程、不改任何状态。用来确认上游到底返回了什么。</p>
    ${error ? `<div class="note error">${esc(error)}</div>` : ""}
    <div class="card">
      <div class="row between"><div><span class="name">${esc(label)}</span><span class="uid">${esc(uid)}</span></div>${badge(tone)}</div>
      <dl class="kv">
        <dt>解析结论</dt><dd>${esc(kindText[info?.kind] || "未识别")}</dd>
        <dt>命中的字段</dt><dd class="mono">${esc(info?.path || "—")} = ${esc(info?.value || "—")}</dd>
        <dt>扫描到的状态</dt><dd class="mono">${esc(info?.raw || "—")}</dd>
        <dt>出发 / 到站</dt><dd class="mono">${esc(fmtCSTSec(timing?.departSec))} → ${esc(fmtCSTSec(timing?.arriveSec))}</dd>
        <dt>服务端时间</dt><dd class="mono">${esc(fmtCSTSec(timing?.nowSec))} · ${esc(remainingText)}</dd>
        <dt>今日次数</dt><dd>${esc(limitText)}</dd>
        <dt>下一步动作</dt><dd>${esc(nextText)}</dd>
      </dl></div>
    <h2>上游原始响应</h2><pre>${esc(raw)}</pre>
    <div class="row" style="margin-top:18px">
      <form class="inline" method="post" action="/account/${esc(uid)}/run${p}">${hidden("pwd", pwd)}<button class="btn primary" type="submit">立即执行</button></form>
      <a class="btn" href="/${p}">返回总览</a></div>
    <div class="note">显示「未识别」就把上面原始响应贴出来，一眼能定位字段名。响应里的票据已脱敏。</div>`);
}

export function runsPage({ logs, pwd }) {
  const rows = logs.map((r) => `<tr><td class="small">${esc(r.when)}</td>
    <td>${esc(r.label || r.uid)}</td><td>${badge(r.status)}</td><td>+${Number(r.credits) || 0}</td>
    <td class="small">${esc(r.trigger || "")}</td><td>${esc(r.message || "")}</td></tr>`).join("");
  return page("运行日志", `<p class="sub">保留 30 天，最新在前。</p>
    ${rows ? `<table><tr><th>时间</th><th>账号</th><th>结果</th><th>积分</th><th>触发</th><th>说明</th></tr>${rows}</table>`
      : `<div class="empty">还没有运行记录。</div>`}
    <p style="margin-top:18px"><a href="/${q(pwd)}">← 回到总览</a></p>`);
}
