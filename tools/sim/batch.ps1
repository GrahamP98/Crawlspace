# Run a batch of bot games: for each policy, W workers (each its own headless Edge) x N runs.
#   .\batch.ps1 -Pols A_atk,E_scout -W 2 -N 300 -Label mytest            (policies\<name>.json)
#   .\batch.ps1 -Pols A_atk -Patch package-B -Label withB                  (patches\<name>.txt, join several with +)
# A patch file holds literal "find ==> replace" lines applied to a copy of index.html; the real file is never changed.
# Keep W x (number of policies) at 12 or fewer: with more, some workers' results get lost.
# Then read the results with:  .\report.ps1 -Label mytest [-Detail]
param([string[]]$Pols = @('smart'), [int]$W = 2, [int]$N = 250, [string]$Patch = '', [string]$Label = 'base', [int]$PortBase = 9500)
$ErrorActionPreference = 'Stop'
$S = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $S '..\..')
$html = [IO.File]::ReadAllText((Join-Path $root 'index.html'))
if ($Patch) {
  foreach ($pp in ($Patch -split "[+]")) { foreach ($ln in [IO.File]::ReadAllLines((Join-Path $S "patches\$pp.txt"))) {
    if (-not $ln.Trim() -or $ln.StartsWith("#")) { continue }
    $pr = $ln -split " ==> ", 2
    $before = $html
    $html = $html.Replace($pr[0], $pr[1])
    if ($html -eq $before) { throw "patch '$pp' did not match: $($pr[0])" }
  } }
}
$gdir = Join-Path $S 'games'; New-Item -ItemType Directory -Force $gdir | Out-Null
$gfile = Join-Path $gdir "$Label.html"
[IO.File]::WriteAllText($gfile, $html)
Copy-Item (Join-Path $root '*.png') $gdir -Force
$url = 'file:///' + ($gfile -replace '\\', '/') + '#play'
$rdir = Join-Path $S "res\$Label"; New-Item -ItemType Directory -Force $rdir | Out-Null
$procs = @(); $port = $PortBase
foreach ($pol in $Pols) {
  for ($wi = 0; $wi -lt $W; $wi++) {
    $port++
    $out = Join-Path $rdir "$pol-$wi.json"
    $procs += Start-Process powershell -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "$S\worker.ps1",
      '-Port', $port, '-N', $N, '-PolFile', "$S\policies\$pol.json", '-Game', $url, '-Out', $out, '-Tag', $pol)
  }
}
$procs | Wait-Process -Timeout 3000
"batch $Label done: $($Pols -join ',') x $W x $N"
