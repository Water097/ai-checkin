import { getJson, putJson, keys } from "./kv.js";
import { logicalDay } from "./time.js";

export const dayOf = (nowSec) => logicalDay(nowSec);

export function newDay(day) {
  return {
    day,
    checkin: "pending",   // pending | claimed | already | inactive | error
    travel: "pending",    // pending | departed | waiting | done | error
    credits: 0,
    rounds: 0,            // 本日成功派出的行程数
    lastMessage: "",
    lastAt: 0,
  };
}

export async function loadDay(kv, uid, day) {
  const saved = await getJson(kv, keys.day(uid, day), null);
  if (!saved || saved.day !== day) return newDay(day);
  return { ...newDay(day), ...saved };
}

export async function saveDay(kv, uid, day, state) {
  await putJson(kv, keys.day(uid, day), state, { expirationTtl: 3 * 86400 });
}

// 今天是不是可以收工了：签到有结论 + 旅行已到当日上限。
// 注意 travel=waiting 不算收工——旅行还在途，下一轮要再看一眼。
export function isSettled(state) {
  const checkinDone = ["claimed", "already", "inactive"].includes(state.checkin);
  const travelDone = state.travel === "done";
  return checkinDone && travelDone;
}
