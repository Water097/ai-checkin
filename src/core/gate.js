// 单口令闸。口令三个来路：查询串（点链接）、表单隐藏字段（提交）、X-Pwd 头（curl）。
// 已知代价：口令会出现在 URL 里并进入 Cloudflare 平台侧访问日志，这不是 Worker 能控制的。
// 换来的是零 JS、无 cookie、链接可直接转发。本应用自己绝不把 URL 写进任何日志。
const MAX_BODY = 64 * 1024;
const FORM_TYPE = "application/x-www-form-urlencoded";

async function readForm(request) {
  const type = (request.headers.get("content-type") || "").toLowerCase();
  if (!type.startsWith(FORM_TYPE)) return null;
  const rawLength = request.headers.get("content-length");
  if (rawLength === null) return null;
  const length = Number(rawLength);
  if (!Number.isFinite(length) || length > MAX_BODY) return null;
  const text = await request.text();
  return text.length > MAX_BODY ? null : new URLSearchParams(text);
}

// 定长比较，避免按字符短路造成的时间差。
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function authenticate(request, url, env) {
  const expected = env && typeof env.PASSWORD === "string" ? env.PASSWORD : "";
  if (expected === "") return { verdict: "unconfigured", pwd: "", form: null };

  const isPost = request.method.toUpperCase() === "POST";
  const form = isPost ? await readForm(request) : null;
  if (isPost && form === null) return { verdict: "bad_body", pwd: "", form: null };

  const candidates = [url.searchParams.get("pwd"), request.headers.get("x-pwd"), form && form.get("pwd")]
    .filter((v) => typeof v === "string" && v !== "");
  // 必须回传真正匹配的那个口令，不能取第一个候选：
  // 否则查询串塞个错口令、靠头通过，页面里所有链接都会带上错口令。
  const winner = candidates.find((candidate) => safeEqual(candidate, expected));
  if (!winner) return { verdict: "reject", pwd: "", form: null };
  return { verdict: "ok", pwd: winner, form };
}
