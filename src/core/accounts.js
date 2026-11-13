import { getJson, putJson, listUids, keys } from "./kv.js";

// 只有这三个字段允许被续期写回，防止工具返回什么就往账号里塞什么。
export const CRED_FIELDS = ["accessToken", "refreshToken", "expiresAt"];

export async function listAccounts(kv) {
  const uids = await listUids(kv);
  const out = [];
  for (const uid of uids) {
    const account = await getAccount(kv, uid);
    if (account) out.push(account);
  }
  return out;
}

export async function getAccount(kv, uid) {
  const raw = await getJson(kv, keys.acct(uid), null);
  if (!raw || typeof raw !== "object" || !raw.cred || typeof raw.uid !== "string") return null;
  return raw;
}

export async function saveAccount(kv, uid, account) {
  await putJson(kv, keys.acct(uid), { ...account, uid, updatedAt: Date.now() });
}

export async function deleteAccount(kv, uid) {
  await kv.delete(keys.acct(uid));
}

// 续期换出的一次性新双令牌必须**当场**落盘。
// refreshToken 用完即废，攒到本轮收尾再写，中间任何一次掐死都会把新旧两张票同时烧掉。
export async function applyCredPatch(kv, uid, patch) {
  const account = await getAccount(kv, uid);
  if (!account) return false;
  let changed = false;
  for (const field of CRED_FIELDS) {
    const value = patch && patch[field];
    if (typeof value === "string" && value.trim() !== "" && account.cred[field] !== value) {
      account.cred[field] = value;
      changed = true;
    }
  }
  if (changed) await saveAccount(kv, uid, account);
  return changed;
}

export function secretValuesOf(account) {
  const cred = (account && account.cred) || {};
  return [...new Set(CRED_FIELDS.map((field) => cred[field])
    .filter((v) => typeof v === "string" && v.length >= 8))];
}

export function maskUid(uid) {
  const s = String(uid || "");
  return s.length <= 8 ? s : `${s.slice(0, 6)}…${s.slice(-4)}`;
}

export function credState(account, now) {
  const exp = Number(account?.cred?.expiresAt) || 0;
  if (!account?.cred?.accessToken || !account?.cred?.refreshToken) return "missing";
  if (exp && exp <= now) return "dead";
  if (exp && exp - now < 7 * 86400) return "expiring";
  return "ok";
}
