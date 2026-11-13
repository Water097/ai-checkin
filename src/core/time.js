export const CST_OFFSET = 8 * 3600;

// 逻辑日按北京时间（UTC+8）算，与上游「今天签没签」对齐。
// 一轮开始时就固定这个值，绝不在运行途中重算：23:59 开始的那轮
// 不能把属于 D 日的领取记到 D+1 日名下。
export function logicalDay(nowSec) {
  return new Date((nowSec + CST_OFFSET) * 1000).toISOString().slice(0, 10);
}

export function fmtCST(ms) {
  return new Date(ms + CST_OFFSET * 1000).toISOString().replace("T", " ").slice(0, 19);
}

export function fmtCSTSec(sec) {
  return Number(sec) > 0 ? fmtCST(Number(sec) * 1000) : "—";
}

export function humanGap(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h} 小时 ${mm} 分` : `${h} 小时`;
}
