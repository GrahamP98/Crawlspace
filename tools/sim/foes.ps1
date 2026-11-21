# Each enemy kind on each floor, all policies of a batch pooled: how often you meet it, what one of its blows does,
# what a fight with it costs (share of max HP) and how many runs it ended.
param([string]$Label, [string]$Pol = '')
$agg = @{}; $kills = @{}; $runs = 0
foreach ($f in Get-ChildItem (Join-Path $env:LOCALAPPDATA "CrawlspaceSim\res\$Label") -Filter *.json) {
  if ($Pol -and ($f.BaseName -replace '-\d+$', '') -ne $Pol) { continue }
  foreach ($r in (Get-Content $f.FullName -Raw | ConvertFrom-Json)) {
    if ($r.error -or $r.stuck -or -not $r.foe) { continue }
    $runs++
    foreach ($pr in $r.foe.PSObject.Properties) {
      if (-not $agg.ContainsKey($pr.Name)) { $agg[$pr.Name] = @(0.0, 0.0, 0.0, 0.0, 0.0) }
      for ($i = 0; $i -lt 5; $i++) { $agg[$pr.Name][$i] += $pr.Value[$i] }
    }
    if (-not $r.won -and $r.killer) { $k = "$($r.killer)@$($r.floor)"; $kills[$k] = 1 + [int]$kills[$k] }
  }
}
"$Label  runs $runs"
'  enemy@floor          fights/run  blows   dmg/blow  %maxHP/blow  %maxHP/fight  runs ended'
foreach ($k in ($agg.Keys | Sort-Object { [int]($_ -split '@')[1] }, { $_ })) {
  $a = $agg[$k]
  if ($a[3] -lt 20) { continue }
  '  {0,-20} {1,8:N2}  {2,6:N0}  {3,8:N1}  {4,10:N1}%  {5,11:N1}%  {6,8}' -f $k, ($a[3] / $runs), $a[0], ($a[1] / [math]::Max(1, $a[0])), (100 * $a[2] / [math]::Max(1, $a[0])), (100 * $a[4] / [math]::Max(1, $a[3])), [int]$kills[$k]
}
