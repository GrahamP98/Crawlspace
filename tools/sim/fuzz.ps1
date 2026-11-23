# Run the fuzzer: W headless Edges, each N runs of random tapping with the game drawing; then report.
#   .\fuzz.ps1 -W 6 -N 100 -Steps 2500 -Label fuzz1
param([int]$W = 6, [int]$N = 50, [int]$Steps = 2500, [double]$Deep = 0.6, [string]$Label = 'fuzz', [int]$PortBase = 9700)
$S = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $S '..\..')
$Work = Join-Path $env:LOCALAPPDATA 'CrawlspaceSim'
$gdir = Join-Path $Work 'games'; New-Item -ItemType Directory -Force $gdir | Out-Null
$gfile = Join-Path $gdir "$Label.html"
Copy-Item (Join-Path $root 'index.html') $gfile -Force
Copy-Item (Join-Path $root '*.png') $gdir -Force
$url = 'file:///' + $gfile.Replace([char]92, [char]47)
$rdir = Join-Path $Work "res\$Label"; New-Item -ItemType Directory -Force $rdir | Out-Null
$opt = Join-Path $rdir 'options.json'
[IO.File]::WriteAllText($opt, (@{steps = $Steps; deep = $Deep} | ConvertTo-Json -Compress))
$procs = @()
for ($i = 0; $i -lt $W; $i++) {
  $procs += Start-Process powershell -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "$S\worker.ps1",
    '-Port', ($PortBase + $i), '-N', $N, '-PolFile', $opt, '-Game', $url, '-Out', (Join-Path $rdir "fuzz-$i.json"), '-Tag', 'fz', '-Script', 'fuzz.js', '-Var', '__FUZZ')
}
$procs | Wait-Process -Timeout 20000
"fuzz $Label done: $W x $N"
