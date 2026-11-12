# Start a batch of bot runs:  sim.ps1 -N 2000      (check progress / results with sim-report.ps1)
param([int]$N = 2000, [string]$Build = 'default')
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'cdp.ps1')
Start-Chrome; Connect-Cdp
Send-Cdp 'Page.enable' | Out-Null
Send-Cdp 'Page.navigate' @{url = $Game} | Out-Null
for ($i = 0; $i -lt 100; $i++) {   # wait until the game itself has loaded (not about:blank)
  Start-Sleep -Milliseconds 200
  try { if ((Js "location.protocol + (typeof draw)") -eq 'file:function') { break } } catch {}
}
if ((Js "location.protocol") -ne 'file:') { throw 'game page did not load' }
$runId = Get-Date -Format 'yyyyMMddHHmmss'
[IO.File]::WriteAllText((Join-Path $Here 'sim-run.txt'), $runId)
# (Get-Content -Raw adds properties that ConvertTo-Json chokes on)
$bot = "window.__SIM = {n: $N, id: '$runId', build: '$Build'};`n" + [IO.File]::ReadAllText((Join-Path $Here 'sim-bot.js'))
Send-Cdp 'Page.addScriptToEvaluateOnNewDocument' @{source = $bot} | Out-Null
Send-Cdp 'Page.reload' @{ignoreCache = $true} | Out-Null
"started $N runs"
# the injected bot only lasts as long as this connection, so stay connected until every run is in
# progress is read from the tab's title (SIM n/N, then SIM DONE), never from the page itself
$t = Get-Date
do {
  Start-Sleep 5
  $title = ((Invoke-RestMethod "http://127.0.0.1:$Port/json") | Where-Object { $_.type -eq 'page' } | Select-Object -First 1).title
} until ($title -eq 'SIM DONE' -or ((Get-Date) - $t).TotalMinutes -gt 30)
"finished ($title) in $([int]((Get-Date) - $t).TotalSeconds)s"
