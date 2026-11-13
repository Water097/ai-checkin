// 网页内完成短信登录：发码 → 换票 → 由 Worker 直接存账号，用户不用跑任何本地命令。
// 目标域名是常量，URL 不接受任何用户输入；只有手机号和验证码进 body，杜绝 SSRF。
import { makeBudget, trackedFetch } from "../core/budget.js";

export const LOGIN_HOST = "www.workbuddy.cn";
const BASE = `https://${LOGIN_HOST}/v2/plugin/login`;

export const validPhone = (value) => /^1[3-9]\d{9}$/.test(String(value ?? "").trim());
export const validCode = (value) => /^\d{4,8}$/.test(String(value ?? "").trim());
export const maskPhone = (value) => {
  const s = String(value ?? "");
  return s.length >= 7 ? `${s.slice(0, 3)}****${s.slice(-4)}` : "***";
};

async function post(path, body) {
  // 与业务请求同一套白名单 + 预算机制，只是域名不同、上限更小。
  const fetchTracked = trackedFetch(makeBudget(5), [LOGIN_HOST]);
  let response;
  try {
    response = await fetchTracked(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    return { ok: false, message: `请求失败：${String((error && error.message) || error)}` };
  }

  const text = await response.text().catch(() => "");
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  const code = payload && (payload.code ?? payload.errcode);
  const msg = String((payload && (payload.msg ?? payload.message)) || "");
  const badCode = code !== undefined && code !== null && Number(code) !== 0;
  if (!response.ok || badCode) {
    return { ok: false, message: `HTTP ${response.status}${code != null ? ` / code=${code}` : ""}${msg ? ` ${msg}` : ""}` };
  }
  return { ok: true, payload, message: msg };
}

export async function sendSms(phone) {
  if (!validPhone(phone)) return { ok: false, message: "手机号格式不对，请填 11 位大陆手机号" };
  const result = await post("/send-sms", { phone: String(phone).trim() });
  return result.ok ? { ok: true, message: "验证码已发送，约 5 分钟内有效" } : result;
}

export async function exchangeToken(phone, code) {
  if (!validPhone(phone)) return { ok: false, message: "手机号格式不对" };
  if (!validCode(code)) return { ok: false, message: "验证码是 4~8 位数字" };
  const result = await post("/token", {
    login_method: "phone", phone: String(phone).trim(), sms_code: String(code).trim(),
  });
  if (!result.ok) return result;

  const data = (result.payload && (result.payload.data || result.payload)) || {};
  const accessToken = data.accessToken || data.access_token;
  const refreshToken = data.refreshToken || data.refresh_token;
  if (typeof accessToken !== "string" || !accessToken.trim()
    || typeof refreshToken !== "string" || !refreshToken.trim()) {
    return { ok: false, message: "接口没返回双令牌，请确认验证码是否正确或重新发送" };
  }
  // 令牌只在内存里流转，绝不进任何日志或页面 HTML
  return { ok: true, accessToken: accessToken.trim(), refreshToken: refreshToken.trim() };
}
