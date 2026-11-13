# ai-checkin

> ⚠️ **免责声明**：本项目调用的 WorkBuddy 接口是客户端自用接口，**非官方公开 API**，无稳定性承诺，可能随客户端版本变更而失效。仅供个人管理**自己拥有**的账号使用，不得用于代领、批量注册或商业化服务。使用产生的账号风险由使用者自行承担。请遵守 WorkBuddy 用户服务协议。

跑在 Cloudflare Worker 上的无人值守签到台。**第一版只做 WorkBuddy 一家、只做三件事**：

1. 每日签到领积分
2. 派 Buddy 旅行
3. 到站后回收旅行积分

不做：其他 AI 工具、盲盒 / 抽奖 / 连签兑换 / 成长任务、通知推送、扫码登录。这些留到后续版本。

---

## 为什么是这套技术栈

第一版的目标是「一条命令能跑起来」，所以刻意选了最轻的形态：

| 层 | 选型 | 理由 |
| --- | --- | --- |
| 运行时 | Cloudflare Workers，纯 JS ESM | 零运行时依赖，`wrangler dev` 直接起 |
| 存储 | KV | 账号几个，不需要关系型；不用写 migration |
| 前端 | 服务端渲染 HTML，零 JavaScript | 口令闸 + 表单够用，CSP 可以收到 `default-src 'none'` |
| 定时 | 单条 `*/30 * * * *` | 到期判定在代码里，加功能不用加 cron 槽 |
| 凭据 | 手填明文双令牌 + 自动 refresh | 新版客户端会话文件已加密，解不开；短信登录换票最稳 |

后续要上通知、扫码、多平台、AES-GCM 加密存储时，这套底座都能原地长出来；要换 D1 / TypeScript / SPA 是另一个量级的重写，现阶段没收益。

接口契约与踩坑记录参照了 MIT 项目 [`chevy222/app-cf-checkin`](https://github.com/chevy222/app-cf-checkin) 公开的设计文档，**本仓库代码为重新实现，不含其源码**。

---

## 快速开始（本地）

需要 Node.js 18+。

```bash
npm install
cp .dev.vars.example .dev.vars      # 把 PASSWORD 改成自己的
npm run dev
```

打开 `http://localhost:8787`，输入口令。本地 KV 由 wrangler 模拟，不用先建 namespace。

跑测试（不联网、不需要 Cloudflare 账号）：

```bash
npm test
```

验证能打包成单文件 Worker：

```bash
npm run bundle
```

---

## 部署到 Cloudflare

```bash
npx wrangler login
npx wrangler kv namespace create CHECKIN_KV
```

把输出里的 `id = "…"` 填进 `wrangler.toml` 的 `kv_namespaces`，然后：

```bash
npx wrangler secret put PASSWORD    # 访问口令，别写进任何文件
npm run deploy
```

`cron` 已在 `wrangler.toml` 里配好（`*/30 * * * *`）。部署完打开 `*.workers.dev` 域名，输入口令，加账号。

想立刻验证而不等 30 分钟：访问 `/api/tick?pwd=你的口令`，会手动跑一整轮并返回 JSON 汇总。

---

## 怎么取 token

新版桌面端的会话文件里 `accessToken` / `refreshToken` 是 `{"$wbEncrypted":1,"envelope":"…"}` 密文，密钥不在文件里，**读不出来，本项目也不做解密**。走官方插件的短信登录换明文票：

PowerShell 里跑项目自带的脚本（两步）：

```powershell
# 第 1 步：发验证码
./tools/get-token.ps1 -Phone 13800000000

# 第 2 步：换成 token
./tools/get-token.ps1 -Phone 13800000000 -Code 123456
```

把输出的两行 `Access Token` / `Refresh Token` 粘进「新增账号」表单。备注名随便起，`uid` 留空即可（平台从 JWT 的 `sub` 解；解不出时表单会提示手填）。

> **别在多个地方同时用同一账号登录。** refreshToken 是一次性的，刷新后旧串立即作废；被别的端轮换掉就会掉号，届时重新跑一次上面的脚本换票即可。

---

## 运行逻辑

每 30 分钟醒一次，逐个账号串行：

- **签到**：先读 `checkin-activity-status`，`today_checked_in` / `checked_in_today` 为真就跳过；活动下线（`code=12302` / `active=false`）也跳过。领取成功后回读一次状态确认，避免误报。
- **旅行**：严格按服务端 `state` 推进，不做乐观假设。
  - `arrived` → `claim` 收回积分 → 立刻派下一趟
  - `traveling` → 本轮收手，不阻塞等待（Worker 里阻塞 = 烧子请求 + 撞超时）
  - `idle` 且未用尽 → 读地点配置，按奖励上限选地点 `depart`
  - `daily_limit_reached` → 当日收工
- **幂等**：按北京时间逻辑日记录日状态；签到只认服务端结论，claim 只在 `arrived` 时发。重复触发不会重复领取。
- **凭据**：到期前 7 天自动 refresh；换出新双令牌**当场写回 KV**，中途崩掉不会把新旧两张票同时烧掉。

三道护栏：

1. **预算闸**：Cloudflare 免费版一次调用 50 次外部 fetch 是硬顶，撞顶整次调用作废、日志和进度一起丢。业务侧自设 45（`BUDGET_SUBREQUESTS` 可改），每次 fetch 前判定。
2. **出站白名单**：只允许 `copilot.tencent.com` 与备站 `www.codebuddy.cn`，白名单为空时拒绝一切请求（fail-closed）。主站超时 / 5xx 自动切备站。
3. **凭据脱敏**：进度、日志、响应页、控制台四个出口统一清洗，且包含被轮换掉的旧串（上游报错最爱回显刚带来的那把票）。

---

## 页面与接口

| 路径 | 作用 |
| --- | --- |
| `/` | 总览：今日积分、账号状态、测试 / 立即执行 / 停用 / 删除、新增账号 |
| `/runs` | 运行日志（保留 30 天） |
| `/api/health` | 版本 + 当前逻辑日 |
| `/api/tick` | 手动触发整轮，返回 JSON 汇总 |

所有页面都在口令闸后。**测试连接**只读登录态不领取（可能顺带续期并写回新凭据）；**立即执行**跳过收工判定，但跳不过预算、锁和步骤幂等。

口令走 `?pwd=` 查询串，无 cookie、零 JS，链接可以直接转发。代价是口令会进入 Cloudflare 平台侧访问日志——应用自己绝不把 URL 写进任何日志。

---

## 配置项

| 名称 | 位置 | 说明 |
| --- | --- | --- |
| `PASSWORD` | Secret | 访问口令，**必填** |
| `CHECKIN_KV` | KV 绑定 | 账号 / 日状态 / 锁 / 日志 |
| `BUDGET_SUBREQUESTS` | 变量（可选） | 业务侧单次调用上限，默认 45，不要设成 50 |

---

## 后续可做（按价值排序）

1. 微信/企微日报通知（当前社区里真正的空白）
2. 微信扫码托管 + 凭据 AES-GCM 加密存储（去掉手填 token）
3. 盲盒 / 抽奖 / 连签兑换 / 成长任务
4. 接入其他 AI 工具（注册表式插件，内核不用改）
5. 7 天收益曲线、通道配置页

## License

MIT · 见 [LICENSE](LICENSE)
