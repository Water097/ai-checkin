// 只认明文 JWT。新版桌面端把 token 存成 {"$wbEncrypted":1,"envelope":"…"}，
// 密钥不在文件里，本平台不解密、也不接受这种值——遇到就直接报「需短信登录换票」。
export function decodeJwt(token) {
  if (typeof token !== "string" || token.includes("$wbEncrypted")) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const body = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = body.length % 4 ? "=".repeat(4 - (body.length % 4)) : "";
    return JSON.parse(atob(body + pad));
  } catch { return null; }
}

export function subjectOf(token) {
  return String(decodeJwt(token)?.sub ?? "");
}

export function expiresAtOf(token) {
  return Number(decodeJwt(token)?.exp ?? 0) || 0;
}

export function isEncrypted(raw) {
  if (raw && typeof raw === "object") return raw.$wbEncrypted === 1;
  return typeof raw === "string" && raw.includes('"$wbEncrypted"');
}
