# 還原為 netsh portproxy 80 / 443(停用 Traefik L4 轉送;來源 IP 會再次遺失,DEPLOYMENT.md §6.1)。以系統管理員 PowerShell 執行。
param([string]$TaskName = 'GigaNexus-Traefik')
$ErrorActionPreference = 'Stop'

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Get-Process traefik -ErrorAction SilentlyContinue | Stop-Process -Force
foreach ($p in 80, 443) {
  netsh interface portproxy add v4tov6 listenport=$p listenaddress=0.0.0.0 connectport=$p connectaddress=::1 | Out-Null
}
netsh interface portproxy show all
