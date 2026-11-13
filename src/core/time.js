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
