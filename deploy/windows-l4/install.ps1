# 安裝 Traefik L4 轉送並取代 netsh portproxy 80 / 443(DEPLOYMENT.md §6.1)。以系統管理員 PowerShell 執行:
#   powershell -ExecutionPolicy Bypass -File install.ps1 -HostIp 10.10.130.124
# 前置:traefik.exe(官方 GitHub Release,驗證 SHA256)、traefik.yml、dynamic.yml 放在 -Dir;Gateway 已部署含 10080 / 10443 的 Nginx。
# 切換時 80 / 443 會中斷數秒。還原:rollback.ps1
param(
  [Parameter(Mandatory = $true)][string]$HostIp,
  [string]$Dir = 'C:\traefik',
  [string]$TaskName = 'GigaNexus-Traefik'
)
$ErrorActionPreference = 'Stop'

foreach ($f in 'traefik.exe', 'traefik.yml', 'dynamic.yml') {
  if (-not (Test-Path (Join-Path $Dir $f))) { throw "缺少 $Dir\$f" }
}
# 主機 IP 寫入設定(只綁主機 IP,不佔用 127.0.0.1 / ::1,避免與 WSL localhost 轉送衝突)
$yml = Join-Path $Dir 'traefik.yml'
(Get-Content $yml -Raw -Encoding UTF8).Replace('__HOST_IP__', $HostIp) | Set-Content $yml -Encoding UTF8 -NoNewline

# 開機以 SYSTEM 啟動、失敗自動重啟、不限執行時間
$action = New-ScheduledTaskAction -Execute (Join-Path $Dir 'traefik.exe') -Argument "--configFile=$yml" -WorkingDirectory $Dir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null

# 移除 portproxy 80 / 443(其他 port 不動)
foreach ($p in 80, 443) { netsh interface portproxy delete v4tov6 listenport=$p listenaddress=0.0.0.0 | Out-Null }

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3
$listening = Get-NetTCPConnection -State Listen -LocalAddress $HostIp -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 80, 443 }
if (($listening | Measure-Object).Count -lt 2) {
  Write-Warning "Traefik 未在 ${HostIp}:80 / 443 監聽,請查看 $Dir\traefik.log;必要時執行 rollback.ps1"
  exit 1
}
Write-Output "已切換:${HostIp}:80 / 443 由 Traefik 轉送(PROXY protocol → 127.0.0.1:10080 / 10443)"
