# The difficulty curve of a batch (all its policies pooled): for each stretch of the run (floor + N near half,
# F far half, G stairs guard, B the Ogre King), how many runs got there, how many died there, how many fights it
# held and how much of your max HP one of them cost; then where the gold went.
#   .\curve.ps1 -Label today            (add -Pol A_atk to look at one policy)
param([string]$Label = 'base', [string]$Pol = '')
$S = Split-Path -Parent $MyInvocation.MyCommand.Path
$runs = New-Object System.Collections.ArrayList
foreach ($f in Get-ChildItem (Join-Path $env:LOCALAPPDATA "CrawlspaceSim\res\$Label") -Filter *.json) {
  if ($Pol -and ($f.BaseName -replace '-\d+$', '') -ne $Pol) { continue }
  foreach ($r in (Get-Content $f.FullName -Raw | ConvertFrom-Json)) { if (-not $r.error -and -not $r.stuck -and $r.segs) { [void]$runs.Add($r) } }
}
$n = $runs.Count; $wins = @($runs | Where-Object { $_.won }).Count
"$Label  runs $n  WIN $('{0:N1}' -f (100.0 * $wins / [math]::Max(1, $n)))%"
'  stretch   reach  died-here  fights  hp/fight  coins/fight'
foreach ($fl in 1..5) { foreach ($k in 'N', 'F', 'G', 'B') {
  $key = "$fl$k"; $in = 0; $died = 0; $fights = 0; $dmg = 0.0; $gold = 0.0
  foreach ($r in $runs) {
    $s = $r.segs.$key
    if ($s -or $r.deathSeg -eq $key) { $in++ }
    if ($s) { $fights += $s[0]; $dmg += $s[1]; $gold += $s[2] }
    if ($r.deathSeg -eq $key) { $died++ }
  }
  if (-not $in) { continue }
  '  {0,-6} {1,7}  {2,8:N1}%  {3,6:N1}  {4,7:N1}%  {5,8:N1}' -f $key, $in, (100.0 * $died / $in), ($fights / $in), (100.0 * $dmg / [math]::Max(1, $fights)), ($gold / [math]::Max(1, $fights))
} }
$line = '  died on each floor (of those who reached it):'
foreach ($fl in 1..5) { $reach = @($runs | Where-Object { $_.floor -ge $fl }).Count; $d = @($runs | Where-Object { $_.floor -eq $fl -and -not $_.won }).Count; $line += " F$fl $('{0:N0}' -f (100.0 * $d / [math]::Max(1, $reach)))%" }
$line
$other = @($runs | Where-Object { -not $_.won -and -not $_.deathSeg }).Count
"  (died outside a fight: $other)"
$won = @($runs | Where-Object { $_.won }); $dead = @($runs | Where-Object { -not $_.won })
$avg = { param($l, $sb) if ($l.Count) { '{0:N0}' -f (($l | ForEach-Object $sb | Measure-Object -Average).Average) } else { '-' } }
"  gold earned per run $(& $avg $runs {$_.gold}); coins left: winners $(& $avg $won {$_.coins}), the dead $(& $avg $dead {$_.coins})"
$line = '  coins in hand leaving each floor:'
foreach ($i in 0..3) { $l = @($runs | Where-Object { $_.coinsEnd.Count -gt $i -and $null -ne $_.coinsEnd[$i] }); $line += " F$($i + 1) $(& $avg $l {$_.coinsEnd[$i]})" }
$line
