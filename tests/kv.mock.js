// 内存版 KV，接口形状对齐 Cloudflare KV。测试不联网、不需要 wrangler。
export function makeKv() {
  const store = new Map();
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value, opts) { store.set(key, String(value)); return undefined; },
    async delete(key) { store.delete(key); },
    async list({ prefix = "" } = {}) {
      const names = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      return { keys: names.map((name) => ({ name })), list_complete: true, cursor: null };
    },
    _dump() { return Object.fromEntries(store); },
  };
}
