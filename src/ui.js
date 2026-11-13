import { page, esc } from "./core/http.js";
import { maskUid, credState } from "./core/accounts.js";

const q = (pwd) => (pwd ? `?pwd=${encodeURIComponent(pwd)}` : "");
const hidden = (pwd) => `<input type="hidden" name="pwd" value="${esc(pwd)}">`;

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
    <div class="card"><form method="post" action="/">
      <label>访问口令</label><input type="password" name="pwd" autocomplete="current-password" required>
      <p style="margin-top:14px"><button class="btn primary" type="submit">进入</button></p>
    </form></div>`);
}

export function renderUnconfigured() {
  return page("还没配好", `<div class="note">Worker 上没有 <code>PASSWORD</code>。
    线上用 <code>npx wrangler secret put PASSWORD</code>，本地在 <code>.dev.vars</code> 里填。</div>`);
}

export function renderFatal(message) {
  return page("出错了", `<div class="note">${esc(message)}</div>`);
}

export function renderResult(title, result, pwd) {
  const rows = (result.steps || []).map((s) => `<tr><td class="mono">${esc(s.id)}</td><td>${badge(s.status)}</td><td>${esc(s.message)}</td></tr>`).join("");
  return page(title, `
    <p class="sub"><a href="/${q(pwd)}">← 回到总览</a></p>
    <div class="card"><div class="row"><div class="grow"><span class="name">${esc(result.label || result.uid || "")}</span>
      ${badge(result.status)}</div><div class="small">本轮 +${Number(result.credits) || 0} 积分 · ${Number(result.http) || 0} 次请求</div></div>
      <p class="meta">${esc(result.message || "")}</p></div>
    ${rows ? `<table><tr><th>步骤</th><th>结果</th><th>说明</th></tr>${rows}</table>` : ""}`);
}

export function homePage({ accounts, days, logs, pwd, flash, now }) {
  const totalToday = accounts.reduce((sum, a) => sum + (Number((days[a.uid] || {}).credits) || 0), 0);
  const cards = accounts.map((a) => {
    const d = days[a.uid] || {};
    const cs = credState(a, now);
    const uid = esc(a.uid);
    const p = q(pwd);
    return `<div class="card">
      <div class="row">
        <div class="grow"><span class="name">${esc(a.label || "未命名")}</span>
          <span class="uid">${esc(maskUid(a.uid))}</span></div>
        <div>${badge(d.checkin || "pending")} ${badge(d.travel || "pending")}</div>
      </div>
      <div class="meta">凭据 ${badge(cs)} · 今日 +${Number(d.credits) || 0} 积分 · 行程 ${Number(d.rounds) || 0} 趟
        ${d.lastMessage ? `<br><span class="small">${esc(d.lastMessage)}</span>` : ""}</div>
      <div class="row" style="margin-top:12px">
        <form class="inline" method="post" action="/account/${uid}/test${p}">${hidden(pwd)}<button class="btn" type="submit">测试连接</button></form>
        <form class="inline" method="post" action="/account/${uid}/run${p}">${hidden(pwd)}<button class="btn primary" type="submit">立即执行</button></form>
        <form class="inline" method="post" action="/account/${uid}/delete${p}">${hidden(pwd)}<button class="btn danger" type="submit">删除</button></form>
        <form class="inline" method="post" action="/account/${uid}/toggle${p}">${hidden(pwd)}<button class="btn" type="submit">${a.enabled === false ? "启用" : "停用"}</button></form>
      </div></div>`;
  }).join("") || `<div class="note">还没有账号。用下面的表单加一个。</div>`;

  const recent = (logs || []).slice(0, 5).map((r) => `<tr><td class="small">${esc(r.when)}</td>
    <td>${esc(r.label || r.uid)}</td><td>${badge(r.status)}</td><td>+${Number(r.credits) || 0}</td></tr>`).join("");

  return page("总览", `
    <p class="sub">WorkBuddy · 每日签到 + Buddy 旅行 + 回收积分 ｜ 今日合计 <strong>+${totalToday}</strong></p>
    ${flash ? `<div class="note">${esc(flash)}</div>` : ""}
    <div class="note">每 30 分钟自动跑一轮；「立即执行」跳过收工判定，但步骤本身仍然幂等。
      「测试连接」只读登录态、不领取，可能顺带续期并写回新凭据。</div>
    <h2>账号（${accounts.length}）</h2>${cards}
    <h2>新增账号</h2>
    <div class="card"><form method="post" action="/account/add${q(pwd)}">
      ${hidden(pwd)}
      <label>备注名</label><input name="label" placeholder="主号" required>
      <label>Access Token（明文 JWT，eyJ 开头）</label><textarea name="accessToken" required></textarea>
      <label>Refresh Token</label><textarea name="refreshToken" required></textarea>
      <label>账号标识 uid（可留空，默认从 JWT 的 sub 解）</label><input name="uid" placeholder="留空即可">
      <p style="margin-top:14px"><button class="btn primary" type="submit">保存账号</button></p>
    </form>
    <p class="small">凭据只存在你自己 Cloudflare 账号的 KV 里。取 token 的方法见 README。</p></div>
    <h2>最近运行</h2>
    ${recent ? `<table><tr><th>时间</th><th>账号</th><th>结果</th><th>积分</th></tr>${recent}</table>
      <p><a href="/runs${q(pwd)}">查看全部日志 →</a></p>` : `<p class="small">还没有运行记录。</p>`}`);
}

export function runsPage({ logs, pwd }) {
  const rows = logs.map((r) => `<tr><td class="small">${esc(r.when)}</td>
    <td>${esc(r.label || r.uid)}</td><td>${badge(r.status)}</td><td>+${Number(r.credits) || 0}</td>
    <td class="small">${esc(r.trigger || "")}</td><td>${esc(r.message || "")}</td></tr>`).join("");
  return page("运行日志", `<p class="sub">保留 30 天，最新在前。</p>
    ${rows ? `<table><tr><th>时间</th><th>账号</th><th>结果</th><th>积分</th><th>触发</th><th>说明</th></tr>${rows}</table>`
      : `<div class="note">还没有运行记录。</div>`}
    <p style="margin-top:18px"><a href="/${q(pwd)}">← 回到总览</a></p>`);
}
