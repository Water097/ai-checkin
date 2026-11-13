# Optional CLI fallback. The web UI (/setup) does the same job.
# Get a plaintext token pair via the official plugin SMS login endpoint.
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI,
# which breaks parsing when comments contain non-ASCII characters.
#
#   ./tools/get-token.ps1 -Phone 13800000000
#   ./tools/get-token.ps1 -Phone 13800000000 -Code 123456
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
  Write-Host "SMS sent (code=$($r.code)). Valid for about 5 minutes. Run again with -Code."
  return
}

$r = Invoke-RestMethod -Uri "$base/token" -Method Post `
  -ContentType "application/json" `
  -Body (@{ login_method = "phone"; phone = $Phone; sms_code = $Code } | ConvertTo-Json)

if (-not $r.data.accessToken -or -not $r.data.refreshToken) {
  throw "No token pair in response: $($r | ConvertTo-Json -Compress)"
}

Write-Host ""
Write-Host "====== Paste into the web form ======" -ForegroundColor Cyan
Write-Host "Access Token : $($r.data.accessToken)"
Write-Host "Refresh Token: $($r.data.refreshToken)"
Write-Host "====================================" -ForegroundColor Cyan
Write-Host "Do not sign in elsewhere with the same account: refreshToken is one-time."
