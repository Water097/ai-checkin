// 页面全部服务端渲染，一行 JavaScript 都没有。
// style-src 'unsafe-inline' 是必须的：样式由服务端内联输出，不放行它浏览器会忽略整份 CSS。
// 脚本依旧完全禁止（default-src 'none' 且没有 script-src），表单只能提交回本站。
export const SECURITY_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; img-src data:",
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
:root{color-scheme:light;--ink:#101828;--muted:#667085;--line:#e6e9f0;--brand:#4f46e5;--brand-dark:#4338ca;--bg:#f6f8fc;--card:#fff}
*{box-sizing:border-box}
html,body{min-height:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
body::before{content:"";position:fixed;inset:0 0 auto;height:340px;pointer-events:none;background:radial-gradient(900px 300px at 18% -10%,rgba(79,70,229,.10),transparent 70%),radial-gradient(700px 260px at 88% -20%,rgba(56,189,248,.10),transparent 70%);z-index:0}
.topbar{position:relative;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:16px;max-width:1000px;margin:0 auto;padding:20px 24px}
.brand{display:inline-flex;align-items:center;gap:10px;color:var(--ink);text-decoration:none;font-weight:650;letter-spacing:-.01em}
.logo{width:30px;height:30px;border-radius:9px;background:linear-gradient(145deg,#6366f1,#4338ca);color:#fff;display:inline-flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(79,70,229,.28)}
nav{display:flex;gap:4px;flex-wrap:wrap}
nav a{color:var(--muted);text-decoration:none;font-size:13px;padding:6px 12px;border-radius:8px}
nav a:hover{background:#eaeef7;color:var(--ink)}
main{position:relative;z-index:1;max-width:1000px;margin:0 auto;padding:8px 24px 72px}
h1{font-size:26px;line-height:1.25;margin:0 0 6px;font-weight:700;letter-spacing:-.02em}
h2{font-size:15px;margin:32px 0 14px;font-weight:650;letter-spacing:.01em;display:flex;align-items:center;gap:9px}
h2::before{content:"";width:3px;height:14px;border-radius:3px;background:var(--brand)}
.sub{color:var(--muted);margin:0 0 24px;font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-bottom:12px;box-shadow:0 1px 2px rgba(16,24,40,.03),0 8px 24px rgba(16,24,40,.045)}
.card.hoverable{transition:border-color .16s,box-shadow .16s}
.card.hoverable:hover{border-color:#cfd5e6;box-shadow:0 2px 4px rgba(16,24,40,.04),0 12px 30px rgba(16,24,40,.07)}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.grow{flex:1;min-width:180px}
.between{justify-content:space-between}
.name{font-weight:650;font-size:16px;letter-spacing:-.01em}
.uid{color:#98a2b3;font-size:12px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;margin-left:8px}
.meta{color:var(--muted);font-size:13px;margin-top:8px}
.badge{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:550;border:1px solid transparent;white-space:nowrap}
.badge::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.75}
.b-ok{background:#ecfdf3;color:#067647;border-color:#d1fadf}
.b-wait{background:#fffaeb;color:#b54708;border-color:#fedf89}
.b-bad{background:#fef3f2;color:#b42318;border-color:#fecdca}
.b-idle{background:#f2f4f7;color:#475467;border-color:#e4e7ec}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid #d6dce8;background:#fff;color:#344054;border-radius:9px;padding:8px 14px;font:inherit;font-size:13px;font-weight:550;cursor:pointer;text-decoration:none;transition:background .15s,border-color .15s,transform .15s,box-shadow .15s}
.btn:hover{background:#f7f8fc;border-color:#c3cbdb}
.btn:active{transform:translateY(1px)}
.btn.primary{background:linear-gradient(180deg,#5b53ea,#4f46e5);border-color:#4f46e5;color:#fff;box-shadow:0 2px 6px rgba(79,70,229,.24)}
.btn.primary:hover{background:linear-gradient(180deg,#5149e0,#4338ca);border-color:#4338ca;box-shadow:0 4px 12px rgba(79,70,229,.3)}
.btn.danger{color:#b42318;border-color:#f0cbc8}
.btn.danger:hover{background:#fef3f2}
.btn.lg{padding:10px 18px;font-size:14px}
form.inline{display:inline-flex}
label{display:block;font-size:12px;font-weight:600;color:#475467;margin:14px 0 6px;letter-spacing:.01em}
input,textarea{width:100%;border:1px solid #d6dce8;border-radius:9px;padding:9px 12px;font:inherit;font-size:14px;background:#fff;color:var(--ink);outline:none;transition:border-color .15s,box-shadow .15s}
input:focus,textarea:focus{border-color:#a5a0f5;box-shadow:0 0 0 3px rgba(79,70,229,.12)}
input::placeholder{color:#b3bac7}
textarea{min-height:78px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}
.hint{font-size:12px;color:#98a2b3;margin-top:6px}
.note{background:#f0f3fd;border:1px solid #dfe4fb;border-radius:11px;padding:12px 15px;color:#475467;font-size:13px;margin:14px 0}
.note.error{background:#fef3f2;border-color:#fecdca;color:#912018}
.note.success{background:#ecfdf3;border-color:#d1fadf;color:#067647}
.hero{background:linear-gradient(135deg,#1e1b4b 0%,#312e81 55%,#4338ca 100%);color:#fff;border:0;border-radius:18px;padding:26px 28px;margin-bottom:22px;box-shadow:0 10px 30px rgba(49,46,129,.22)}
.hero .kicker{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#c7d2fe;font-weight:600}
.hero .big{font-size:38px;font-weight:700;letter-spacing:-.03em;line-height:1.15;margin:8px 0 2px}
.hero .big small{font-size:15px;font-weight:500;color:#c7d2fe;margin-left:6px;letter-spacing:0}
.hero .desc{font-size:13px;color:#dfe3ff}
.hero .btn{background:#fff;border-color:#fff;color:#312e81;font-weight:650}
.hero .btn:hover{background:#eef2ff;border-color:#eef2ff}
.stats{display:flex;gap:26px;margin-top:18px;padding-top:16px;border-top:1px solid rgba(255,255,255,.16)}
.stats div{font-size:12px;color:#c7d2fe}
.stats strong{display:block;font-size:17px;color:#fff;font-weight:650;margin-top:2px}
.empty{border:1px dashed #d6dce8;border-radius:14px;padding:28px;text-align:center;color:var(--muted);background:rgba(255,255,255,.5);font-size:13px}
table{width:100%;border-collapse:collapse;font-size:13px;background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden}
th{background:#f9fafc;color:#667085;font-weight:600;font-size:12px;text-align:left;padding:10px 12px;border-bottom:1px solid var(--line)}
td{padding:10px 12px;border-bottom:1px solid #f0f2f6;vertical-align:top}
tr:last-child td{border-bottom:0}
.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}
.small{font-size:12px;color:#98a2b3}
code{background:#f2f4f7;border:1px solid #e6e9f0;border-radius:5px;padding:1px 5px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
a{color:var(--brand)}
a:hover{color:var(--brand-dark)}
details{background:#fff;border:1px solid var(--line);border-radius:12px;padding:0 18px}
summary{cursor:pointer;padding:14px 0;font-size:13px;font-weight:600;color:#475467}
details[open] summary{border-bottom:1px solid var(--line);margin-bottom:8px}
.steps{display:flex;gap:8px;align-items:center;margin:0 0 20px}
.step{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:600;color:#98a2b3}
.step b{width:22px;height:22px;border-radius:50%;background:#f2f4f7;color:#98a2b3;display:inline-flex;align-items:center;justify-content:center;font-size:11px}
.step.on{color:var(--brand)}
.step.on b{background:var(--brand);color:#fff}
.step-line{width:28px;height:1px;background:#e4e7ec}
pre{background:#f8fafc;border:1px solid var(--line);border-radius:10px;padding:14px 16px;font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;color:#344054;white-space:pre-wrap;word-break:break-all;max-height:420px;overflow:auto;margin:0}
.kv{display:grid;grid-template-columns:120px 1fr;gap:8px 14px;font-size:13px;margin:12px 0}
.kv dt{color:var(--muted)}
.kv dd{margin:0;font-weight:600;overflow-wrap:anywhere}
footer{text-align:center;color:#b3bac7;font-size:12px;margin-top:40px}
@media(max-width:640px){main{padding:8px 16px 56px}.topbar{padding:16px}.hero{padding:22px}.hero .big{font-size:32px}.stats{gap:16px}.card{padding:16px}}
`;

const LOGO = `<span class="logo"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg></span>`;

// 所有站内链接都带上当次通过的口令：无 cookie，转发链接即可直接打开。
export function page(title, inner, pwd = "") {
  const q = pwd ? `?pwd=${encodeURIComponent(pwd)}` : "";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${esc(title)} · ai-checkin</title><style>${CSS}</style></head><body>`
    + `<header class="topbar"><a class="brand" href="/${q}">${LOGO}<span>ai-checkin</span></a>`
    + `<nav><a href="/${q}">总览</a><a href="/setup${q}">添加账号</a><a href="/runs${q}">运行日志</a></nav></header>`
    + `<main><h1>${esc(title)}</h1>${inner}`
    + `<footer>ai-checkin v0.1 · 仅用于管理本人账号 · 接口非官方公开 API</footer>`
    + `</main></body></html>`;
}
