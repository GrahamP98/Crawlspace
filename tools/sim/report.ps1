# Summarize a batch folder: res\<Label>\<pol>-<w>.json
param([string]$Label = 'base', [switch]$Detail)
$S = Split-Path -Parent $MyInvocation.MyCommand.Path
$rdir = Join-Path $env:LOCALAPPDATA "CrawlspaceSim\res\$Label"
$byPol = @{}
foreach ($f in Get-ChildItem $rdir -Filter *.json) {
  $pol = $f.BaseName -replace '-\d+$', ''
  $arr = Get-Content $f.FullName -Raw | ConvertFrom-Json
  if (-not $byPol[$pol]) { $byPol[$pol] = New-Object System.Collections.ArrayList }
  foreach ($r in $arr) { [void]$byPol[$pol].Add($r) }
}
function P($a, $b) { if ($b) { '{0,5:N1}%' -f (100.0 * $a / $b) } else { '    -' } }
foreach ($pol in ($byPol.Keys | Sort-Object)) {
  $R = $byPol[$pol]
  $bad = @($R | Where-Object { $_.error -or $_.stuck })
  $ok = @($R | Where-Object { -not $_.error -and -not $_.stuck })
  $n = $ok.Count; $wins = @($ok | Where-Object { $_.won -eq $true }).Count
  $se = if ($n) { 100 * [math]::Sqrt(($wins / $n) * (1 - $wins / $n) / $n) } else { 0 }
  "== $pol  runs $n  WIN $(P $wins $n) (+-$('{0:N1}' -f $se))  errors/stuck $($bad.Count)"
  if ($bad.Count) { "   first error: " + (($bad[0].error, $bad[0].phase) -join ' ') }
  $line = '   floors:'
  for ($fl = 1; $fl -le 5; $fl++) {
    $reach = @($ok | Where-Object { $_.floor -ge $fl }).Count
    $died = @($ok | Where-Object { $_.floor -eq $fl -and -not $_.won })
    $line += " F$fl dies $(P $died.Count $reach)"
  }
  $line
  if ($Detail) {
    for ($fl = 1; $fl -le 5; $fl++) {
      $died = @($ok | Where-Object { $_.floor -eq $fl -and -not $_.won })
      if (-not $died.Count) { continue }
      $k = $died | Group-Object killer | Sort-Object Count -Descending | Select-Object -First 4 | ForEach-Object { "$($_.Name) $(P $_.Count $died.Count)" }
      "     F$fl killers: $($k -join ', ')"
    }
    $avg = { param($list, $sb) if ($list.Count) { '{0:N1}' -f (($list | ForEach-Object $sb | Measure-Object -Average).Average) } else { '-' } }
    $dead = @($ok | Where-Object { -not $_.won })
    "   avg: level $(& $avg $ok {$_.level})  maxHp $(& $avg $ok {$_.maxHp})  gold $(& $avg $ok {$_.gold})  coinsLeft(dead) $(& $avg $dead {$_.coins})  potsLeft(dead) $(& $avg $dead {$_.potions})  drunk $(& $avg $ok {$_.drunk})  fights $(& $avg $ok {$_.fights})  fled $(& $avg $ok {$_.fled})/$(& $avg $ok {$_.fleeTry})"
    "   moves: normal $(& $avg $ok {$_.normal})  heavy $(& $avg $ok {$_.heavy})  block $(& $avg $ok {$_.block})  potFight $(& $avg $ok {$_.potFight})  redraws $(& $avg $ok {$_.redraws})"
    $won = @($ok | Where-Object { $_.won -eq $true })
    if ($won.Count) { "   winners: level $(& $avg $won {$_.level}) maxHp $(& $avg $won {$_.maxHp}) def $(& $avg $won {$_.def}) coinsLeft $(& $avg $won {$_.coins}) potsLeft $(& $avg $won {$_.potions})" }
    # perks: win rate of runs that took the perk at least twice, vs not at all
    $pk = foreach ($id in 'attack', 'vitality', 'focus', 'pathfinder', 'executioner', 'antidote', 'shieldbash', 'secondwind', 'purse') {
      $with = @($ok | Where-Object { $_.perks.$id -ge 1 }); $w2 = @($with | Where-Object { $_.won -eq $true }).Count
      "$id $($with.Count)/$(P $w2 $with.Count)"
    }
    "   perk(>=1): $($pk -join ' | ')"
    # enchantments worn at the end
    $en = @{}
    foreach ($r in $ok) { foreach ($p in $r.ench.PSObject.Properties) { $id = $p.Name -replace '\d$', ''; if (-not $en[$id]) { $en[$id] = @(0, 0) }; $en[$id][0]++; if ($r.won) { $en[$id][1]++ } } }
    "   ench worn: " + (($en.Keys | Sort-Object | ForEach-Object { "$_ $($en[$_][0])/$(P $en[$_][1] $en[$_][0])" }) -join ' | ')
  }
}
