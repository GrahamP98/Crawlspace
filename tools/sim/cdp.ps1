# Drive Crawlspace in headless Chrome over the DevTools protocol (no Node/Python needed).
# Usage (each PowerShell call):  . <this file>; Connect-Game; Tap 144 300; Shot 'name'; Js 'p.hp'
$ErrorActionPreference = 'Stop'
$Port = 9333
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$Game = 'file:///C:/Users/gpurn/Crawlspace/Crawlspace/index.html#play'
$Shots = Join-Path $Here 'shots'
New-Item -ItemType Directory -Force $Shots | Out-Null

function Test-Chrome { try { Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 2 | Out-Null; $true } catch { $false } }

# start headless Chrome once; it keeps running between calls
function Start-Chrome {
  if (Test-Chrome) { return }
  Start-Process $Chrome -ArgumentList @('--headless=new', "--remote-debugging-port=$Port", '--remote-allow-origins=*',
    "--user-data-dir=$Here\chrome-profile", '--no-first-run', '--hide-scrollbars', '--mute-audio', 'about:blank') | Out-Null
  for ($i = 0; $i -lt 50 -and -not (Test-Chrome); $i++) { Start-Sleep -Milliseconds 200 }
  if (-not (Test-Chrome)) { throw 'Chrome did not start' }
}
function Stop-Chrome {
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*remote-debugging-port=$Port*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

$script:ws = $null; $script:id = 0; $script:CdpTimeout = 15
function Connect-Cdp {
  $page = (Invoke-RestMethod "http://127.0.0.1:$Port/json") | Where-Object { $_.type -eq 'page' } | Select-Object -First 1
  $script:ws = New-Object System.Net.WebSockets.ClientWebSocket
  $script:ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, [Threading.CancellationToken]::None).Wait()
}
# send one command and return the raw JSON text of its reply
function Send-Raw($method, $params = @{}) {
  $script:id++
  $msg = @{id = $script:id; method = $method; params = $params} | ConvertTo-Json -Depth 20 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($msg)
  $script:ws.SendAsync((New-Object 'ArraySegment[byte]' (,$bytes)), 'Text', $true, [Threading.CancellationToken]::None).Wait()
  $buf = New-Object byte[] 65536
  $deadline = (Get-Date).AddSeconds($script:CdpTimeout)
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

# evaluate JS in the page; returns the value (objects come back as JSON text)
function Js([string]$expr) {
  $wrapped = "(async () => { const __v = await (async () => ($expr))(); return typeof __v === 'object' ? JSON.stringify(__v) : __v; })()"
  $r = Send-Cdp 'Runtime.evaluate' @{expression = $wrapped; awaitPromise = $true; returnByValue = $true}
  if ($r.result.exceptionDetails) { throw ('JS error: ' + $r.result.exceptionDetails.exception.description) }
  $r.result.result.value
}

# phone-sized viewport, then load the game (skipping the title screen)
function Open-Game([int]$w = 390, [int]$h = 844) {
  Send-Cdp 'Emulation.setDeviceMetricsOverride' @{width = $w; height = $h; deviceScaleFactor = 2; mobile = $true} | Out-Null
  Send-Cdp 'Page.enable' | Out-Null
  Send-Cdp 'Page.navigate' @{url = 'about:blank'} | Out-Null
  Send-Cdp 'Page.navigate' @{url = $Game} | Out-Null
  for ($i = 0; $i -lt 50; $i++) { Start-Sleep -Milliseconds 200; try { if ((Js "document.readyState") -eq 'complete' -and (Js "typeof draw") -eq 'function') { break } } catch {} }
  Js "document.fonts.ready.then(() => { draw(); return true; })" | Out-Null
  Js "(LEVEL_TAP_GUARD_MS = 0, true)" | Out-Null
}
function Set-Phone([int]$w = 390, [int]$h = 844) {
  Send-Cdp 'Emulation.setDeviceMetricsOverride' @{width = $w; height = $h; deviceScaleFactor = 2; mobile = $true} | Out-Null
}
# the viewport override only lasts while connected, so set it again on every connect
function Connect-Game { Start-Chrome; Connect-Cdp; Set-Phone; Js "(typeof fitScreen === 'function' && fitScreen(), true)" | Out-Null }

# a real mouse press at page coordinates
function Click([double]$x, [double]$y) {
  foreach ($t in 'mousePressed', 'mouseReleased') {
    Send-Cdp 'Input.dispatchMouseEvent' @{type = $t; x = $x; y = $y; button = 'left'; clickCount = 1} | Out-Null
  }
  Start-Sleep -Milliseconds 60
}
# tap at screen units (the screen is 288 units wide)
function Tap([double]$x, [double]$y) {
  $pt = Js "(() => { const r = c.getBoundingClientRect(), k = r.width / CANVAS_W; return {x: r.left + $x * k, y: r.top + $y * k}; })()" | ConvertFrom-Json
  Click $pt.x $pt.y
}
# tap at play-area units (the map / arena is 288 x 352)
function TapPlay([double]$x, [double]$y) {
  $pt = Js "playToClient($x, $y)" | ConvertFrom-Json
  Click $pt.clientX $pt.clientY
}
# tap the on-screen item with this id (a button, a card, a menu row...)
function TapId([string]$id) {
  $b = Js "(() => { const b = screenItems().find(i => i.id === '$id'); return b ? {x: b.x + b.w / 2, y: b.y + b.h / 2, on: b.enabled !== false} : null; })()"
  if (-not $b) { throw "no item '$id' on screen (phase: $(Js 'phase'))" }
  $b = $b | ConvertFrom-Json
  Tap $b.x $b.y
}
# ids of everything tappable right now
function Items { Js "screenItems().filter(i => i.id).map(i => i.id + (i.enabled === false ? ' (off)' : '')).join(', ')" }

# save a screenshot; returns its path
function Shot([string]$name = 'shot') {
  Start-Sleep -Milliseconds 120
  $raw = Send-Raw 'Page.captureScreenshot' @{format = 'png'}
  if ($raw -notmatch '"data":"([^"]+)"') { throw 'no screenshot data' }
  $path = Join-Path $Shots "$name.png"
  [IO.File]::WriteAllBytes($path, [Convert]::FromBase64String($Matches[1]))
  $path
}
# console errors / uncaught exceptions since the page loaded (needs Watch-Errors after Open-Game)
function Watch-Errors { Js "(window.__errs = [], addEventListener('error', e => __errs.push(e.message)), true)" | Out-Null }
function Errors { Js "(window.__errs || []).join(' | ')" }
