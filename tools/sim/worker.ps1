# One sim worker: its own headless Edge (own port + profile), plays N runs of the bot with a policy, writes results JSON.
param([int]$Port, [int]$N, [string]$PolFile, [string]$Game, [string]$Out, [string]$Tag = 'w')
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Edge) { throw 'Microsoft Edge not found' }
$Prof = Join-Path $env:LOCALAPPDATA "CrawlspaceSim\prof\$Port"   # outside OneDrive: profiles are big and thrown away

function Test-Up { try { Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 2 | Out-Null; $true } catch { $false } }
$proc = Start-Process $Edge -PassThru -ArgumentList @('--headless=new', "--remote-debugging-port=$Port", '--remote-allow-origins=*',
  "--user-data-dir=$Prof", '--no-first-run', '--mute-audio', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-extensions', '--disable-sync', '--no-default-browser-check', 'about:blank')
for ($i = 0; $i -lt 100 -and -not (Test-Up); $i++) { Start-Sleep -Milliseconds 200 }
if (-not (Test-Up)) { throw "edge did not start on $Port" }

$script:ws = $null; $script:id = 0
function Connect-Cdp {
  $page = (Invoke-RestMethod "http://127.0.0.1:$Port/json") | Where-Object { $_.type -eq 'page' -and ($_.url -like 'file:*' -or $_.url -eq 'about:blank') } | Select-Object -First 1
  $script:ws = New-Object System.Net.WebSockets.ClientWebSocket
  $script:ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, [Threading.CancellationToken]::None).Wait()
}
function Send-Raw($method, $params = @{}) {
  $script:id++
  $msg = @{id = $script:id; method = $method; params = $params} | ConvertTo-Json -Depth 20 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($msg)
  $script:ws.SendAsync((New-Object 'ArraySegment[byte]' (,$bytes)), 'Text', $true, [Threading.CancellationToken]::None).Wait()
  $buf = New-Object byte[] 1048576
  $deadline = (Get-Date).AddSeconds(60)
  while ($true) {
    $ms = New-Object IO.MemoryStream
    do {
      $task = $script:ws.ReceiveAsync((New-Object 'ArraySegment[byte]' (,$buf)), [Threading.CancellationToken]::None)
      while (-not $task.Wait(250)) { if ((Get-Date) -gt $deadline) { $script:ws.Abort(); throw "CDP timeout waiting for $method" } }
      $r = $task.Result
      $ms.Write($buf, 0, $r.Count)
    } until ($r.EndOfMessage)
    $text = [Text.Encoding]::UTF8.GetString($ms.ToArray())
    if ($text -match ('^\{"id":' + $script:id + '[,}]')) { return $text }
  }
}
function Send-Cdp($method, $params = @{}) { Send-Raw $method $params | ConvertFrom-Json }
function Js([string]$expr) {
  $r = Send-Cdp 'Runtime.evaluate' @{expression = $expr; returnByValue = $true}
  $r.result.result.value
}
try {
  Connect-Cdp
  Send-Cdp 'Page.enable' | Out-Null
  $runId = "$Tag$Port" + (Get-Date -Format 'HHmmssfff')
  $pol = [IO.File]::ReadAllText($PolFile)
  $bot = "window.__SIM = {n: $N, id: '$runId', pol: $pol};`n" + [IO.File]::ReadAllText((Join-Path $Here 'bot.js'))
  Send-Cdp 'Page.addScriptToEvaluateOnNewDocument' @{source = $bot} | Out-Null
  Send-Cdp 'Page.navigate' @{url = $Game} | Out-Null
  $t = Get-Date
  do {
    Start-Sleep 2
    $title = ((Invoke-RestMethod "http://127.0.0.1:$Port/json") | Where-Object { $_.type -eq 'page' -and ($_.url -like 'file:*' -or $_.url -eq 'about:blank') } | Select-Object -First 1).title
  } until ($title -eq 'SIM DONE' -or ((Get-Date) - $t).TotalMinutes -gt 40)
  Connect-Cdp
  $json = Js "localStorage.getItem('crawlSim:$runId') || '[]'"
  [IO.File]::WriteAllText($Out, $json)
  "$Tag port $Port : $title in $([int]((Get-Date) - $t).TotalSeconds)s"
} finally {
  try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
  Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like "*remote-debugging-port=$Port *" -or $_.CommandLine -like "*prof\$Port*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
