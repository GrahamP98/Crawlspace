# Print the simulation's progress every 20 seconds until it finishes (read-only: it never touches the run)
param([int]$Every = 20)
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'cdp.ps1')
$runKey = [IO.File]::ReadAllText((Join-Path $Here 'sim-run.txt')).Trim()
$last = -1
while ($true) {
  try {
    $title = ((Invoke-RestMethod "http://127.0.0.1:$Port/json" -TimeoutSec 5) | Where-Object { $_.type -eq 'page' } | Select-Object -First 1).title
    Connect-Cdp
    $done = [int](Js "JSON.parse(localStorage.getItem('crawlSim:$runKey') || '[]').length")
    $wins = [int](Js "JSON.parse(localStorage.getItem('crawlSim:$runKey') || '[]').filter(r => r.won).length")
    try { $script:ws.Dispose() } catch {}
    if ($title -eq 'SIM DONE') { "DONE: $done / 2000 runs, $wins wins so far"; break }
    if ($done -eq $last) { "STALLED? still $done / 2000 runs" } else { "progress: $done / 2000 runs ($([math]::Round(100 * $done / 2000))%), $wins wins so far" }
    $last = $done
  } catch { "progress check failed: $($_.Exception.Message)" }
  Start-Sleep $Every
}
