# 用官方插件的短信登录接口换明文双令牌。
# 新版桌面端会话文件里的 token 是加密的（$wbEncrypted），读不出来，只能走这里。
#
#   ./tools/get-token.ps1 -Phone 13800000000              # 发验证码
#   ./tools/get-token.ps1 -Phone 13800000000 -Code 123456 # 换 token
#
param(
  [Parameter(Mandatory = $true)][string]$Phone,
  [string]$Code
)

$ErrorActionPreference = "Stop"
$base = "https://www.workbuddy.cn/v2/plugin/login"

if (-not $Code) {
  $r = Invoke-RestMethod -Uri "$base/send-sms" -Method Post `
    -ContentType "application/json" -Body (@{ phone = $Phone } | ConvertTo-Json)
  Write-Host "验证码已发送（返回 code=$($r.code)）。约 5 分钟内有效，再跑一次并传 -Code。"
  return
}

$r = Invoke-RestMethod -Uri "$base/token" -Method Post `
  -ContentType "application/json" `
  -Body (@{ login_method = "phone"; phone = $Phone; sms_code = $Code } | ConvertTo-Json)

if (-not $r.data.accessToken -or -not $r.data.refreshToken) {
  throw "没拿到双令牌，接口返回：$($r | ConvertTo-Json -Compress)"
}

Write-Host ""
Write-Host "====== 填到「新增账号」======" -ForegroundColor Cyan
Write-Host "Access Token : $($r.data.accessToken)"
Write-Host "Refresh Token: $($r.data.refreshToken)"
Write-Host "=============================" -ForegroundColor Cyan
Write-Host "注意：别在多个地方同时登录同一账号，refreshToken 是一次性的，被别处轮换就会掉号。"
