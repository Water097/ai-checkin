// 页面全部服务端渲染，一行 JavaScript 都没有。
// CSP 收到 default-src 'none'，表单只能提交回本站；口令只在查询串里流转，不写 cookie。
export const SECURITY_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; img-src data:",
};

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

export function htmlRes(body, status = 200) {
  return new Response(body, { status, headers: SECURITY_HEADERS });
}

export function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8" },
  });
}

const CSS = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#f6f7f9;color:#1c2430;font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:880px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:22px;margin:0 0 4px;font-weight:650}
h2{font-size:16px;margin:28px 0 12px;font-weight:650}
.sub{color:#6b7684;margin:0 0 24px;font-size:13px}
.card{background:#fff;border:1px solid #e4e8ed;border-radius:10px;padding:16px 18px;margin-bottom:12px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.grow{flex:1;min-width:180px}
.name{font-weight:600;font-size:15px}
.uid{color:#8a94a1;font-size:12px;font-family:ui-monospace,Consolas,monospace}
.meta{color:#6b7684;font-size:13px;margin-top:6px}
.badge{display:inline-block;padding:1px 8px;border-radius:20px;font-size:12px;border:1px solid transparent}
.b-ok{background:#e8f6ec;color:#1a7f42;border-color:#c8e9d3}
.b-wait{background:#fff4e2;color:#a4620a;border-color:#f3ddb8}
.b-bad{background:#fdecec;color:#b42318;border-color:#f5cfcf}
.b-idle{background:#eef1f5;color:#5a6675;border-color:#dde3ea}
.btn{display:inline-block;border:1px solid #d5dce4;background:#fff;color:#25303d;border-radius:7px;padding:6px 12px;font:inherit;font-size:13px;cursor:pointer;text-decoration:none}
.btn:hover{background:#f2f5f8}
.btn.primary{background:#1c2430;border-color:#1c2430;color:#fff}
.btn.danger{color:#b42318}
form.inline{display:inline}
label{display:block;font-size:13px;color:#5a6675;margin:10px 0 4px}
input,textarea{width:100%;border:1px solid #d5dce4;border-radius:7px;padding:8px 10px;font:inherit;font-size:13px;background:#fff;color:#1c2430}
textarea{min-height:76px;resize:vertical;font-family:ui-monospace,Consolas,monospace;font-size:12px}
.note{background:#f0f4f9;border-left:3px solid #94a8c0;padding:10px 14px;border-radius:0 7px 7px 0;color:#4a5868;font-size:13px;margin:14px 0}
nav a{color:#3a6ea5;text-decoration:none;margin-right:14px;font-size:13px}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{text-align:left;padding:7px 8px;border-bottom:1px solid #eef1f5;vertical-align:top}
th{color:#6b7684;font-weight:600}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}
.small{font-size:12px;color:#8a94a1}
`;

// 所有站内链接都带上当次通过的口令：无 cookie，转发链接即可直接打开。
export function page(title, inner, pwd = "") {
  const q = pwd ? `?pwd=${encodeURIComponent(pwd)}` : "";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${esc(title)} · ai-checkin</title><style>${CSS}</style></head><body><main>`
    + `<nav><a href="/${q}">总览</a><a href="/runs${q}">运行日志</a></nav>`
    + `<h1>${esc(title)}</h1>${inner}`
    + `<p class="small" style="margin-top:36px">ai-checkin v0.1 · 仅用于管理本人账号</p>`
    + `</main></body></html>`;
}
