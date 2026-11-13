import { getJson, putJson, listKeys, keys, LOG_TTL } from "./kv.js";
import { fmtCST } from "./time.js";

// 凭据可能出现在上游报错原文里（网关最爱回显「你刚才带来的那把票」）。
// 同一个 message 有四个出口：日状态、运行日志、手动执行响应页、控制台，
// 所以清洗集合必须包含**本轮被轮换掉的旧串**，不只是账号里当前的值。
export function scrub(text, secrets = []) {
  let out = String(text ?? "");
  for (const value of [...new Set(secrets)].filter((v) => typeof v === "string" && v.length >= 8)
    .sort((a, b) => b.length - a.length)) {
    out = out.split(value).join("***");
  }
  return out;
}

export function truncate(text, max = 300) {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export async function writeLog(kv, entry) {
  const atMs = entry.atMs || Date.now();
  const key = keys.log(atMs, entry.uid || "unknown");
  await putJson(kv, key, {
    at: atMs, uid: entry.uid, label: entry.label || entry.uid,
    status: entry.status, message: truncate(scrub(entry.message, entry.secrets), 400),
    credits: Number(entry.credits) || 0, trigger: entry.trigger || "cron",
    http: Number(entry.http) || 0,
  }, { expirationTtl: LOG_TTL });
}

export async function listLogs(kv, limit = 40) {
  const names = (await listKeys(kv, keys.logPrefix)).sort().reverse().slice(0, limit);
  const out = [];
  for (const name of names) {
    const row = await getJson(kv, name, null);
    if (row) out.push({ ...row, when: fmtCST(row.at) });
  }
  return out;
}
