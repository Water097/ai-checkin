// 存储只有 KV，不引 D1：第一版账号数是个位数，关系型没有收益。
// 键族按职责分开，互不相交，任何一类都能单独列出来。
const NS = "v1";
export const LOG_TTL = 30 * 86400;
export const LOCK_TTL = 90;

export const keys = {
  acct: (uid) => `${NS}:acct:${uid}`,
  acctPrefix: `${NS}:acct:`,
  day: (uid, day) => `${NS}:day:${uid}:${day}`,
  lock: (uid) => `${NS}:lock:${uid}`,
  // 上次服务时刻单独存，绝不写回账号记录——那会覆盖用户刚提交的凭据
  last: (uid) => `${NS}:last:${uid}`,
  log: (atMs, uid) => `${NS}:log:${String(atMs).padStart(13, "0")}:${uid}`,
  logPrefix: `${NS}:log:`,
};

export function requireKv(env) {
  const kv = env && env.CHECKIN_KV;
  if (!kv) throw new Error("缺少 KV 绑定：CHECKIN_KV");
  return kv;
}

export async function getJson(kv, key, fallback = null) {
  const raw = await kv.get(key);
  if (raw === null || raw === undefined) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export function putJson(kv, key, value, opts) {
  return kv.put(key, JSON.stringify(value), opts);
}

// KV list 只回键名。翻页直到 list_complete，避免账号或日志超过一页时静默丢数据。
export async function listKeys(kv, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const entry of page.keys) out.push(entry.name);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

export async function listUids(kv) {
  const prefix = keys.acctPrefix;
  return (await listKeys(kv, prefix)).map((name) => name.slice(prefix.length));
}
