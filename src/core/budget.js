// Cloudflare 免费版：一次 Worker 调用的外部子请求硬顶是 50。
// 撞顶不是「这次请求失败」，是整次调用抛异常——本轮已跑完的日志与进度一起丢。
// 所以业务侧自设 45，留 5 次给重试与非业务 fetch；可用 env.BUDGET_SUBREQUESTS 覆盖。
//
// 注意 redirect 链里每一跳平台都计数，而这里一次 fetch() 只记一笔。
// 所以自设值必须小于硬顶，不能取 50。
export const DEFAULT_LIMIT = 45;

export function budgetFrom(env) {
  const configured = Number(env && env.BUDGET_SUBREQUESTS);
  return Number.isFinite(configured) && configured > 0 && configured <= 50 ? configured : DEFAULT_LIMIT;
}

export function makeBudget(limit = DEFAULT_LIMIT) {
  const state = { used: 0 };
  return {
    limit,
    get used() { return state.used; },
    left() { return Math.max(0, limit - state.used); },
    fits(n = 1) { return state.used + n <= limit; },
    charge(n = 1) { state.used += n; return state.used <= limit; },
  };
}

// 出站白名单：合并多平台后最大的风险是凭据串味，这里做最后一道硬拦截。
// 白名单为空时拒绝一切（fail-closed），不是放行。
export function trackedFetch(budget, hosts) {
  const allowed = hosts && hosts.length ? new Set(hosts) : null;
  return async function fetchTracked(input, init) {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (!allowed) throw new Error("出站白名单为空，已拒绝一切请求");
    if (!allowed.has(url.hostname)) {
      throw new Error(`禁止的请求域名 ${url.hostname}（只允许 ${[...allowed].join(", ")}）`);
    }
    if (!budget.fits(1)) throw new Error("本轮外部请求额度已用尽");
    budget.charge(1);
    return fetch(input, init);
  };
}
