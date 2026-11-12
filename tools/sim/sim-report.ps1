# Progress, or (once done) save the results to sim-results.json and print the summary
param([switch]$Save)
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'cdp.ps1')
$runId = [IO.File]::ReadAllText((Join-Path $Here 'sim-run.txt')).Trim()
Connect-Cdp
$summary = Js (@'
(() => {
  const R = JSON.parse(localStorage.getItem('__RUNKEY__') || '[]'), cfg = {n: '?'};
  const ok = R.filter(r => !r.error && !r.stuck), wins = ok.filter(r => r.won), dead = ok.filter(r => !r.won);
  const count = (list, f) => { const m = {}; for (const r of list) { const k = f(r); m[k] = (m[k] || 0) + 1; } return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : '-';
  const avg = (list, f) => list.length ? (list.reduce((s, r) => s + f(r), 0) / list.length).toFixed(1) : '-';
  const lines = [];
  lines.push(`runs ${R.length}/${cfg.n}   errors ${R.filter(r => r.error).length}   stuck ${R.filter(r => r.stuck).length}`);
  lines.push(`WIN RATE ${pct(wins.length, ok.length)}  (${wins.length} of ${ok.length})`);
  lines.push('', 'DIED ON FLOOR');
  for (let f = 1; f <= 5; f++) { const n = dead.filter(r => r.floor === f).length; lines.push(`  floor ${f}: ${n}  (${pct(n, ok.length)} of all runs)`); }
  lines.push('', 'KILLED BY');
  for (const [k, n] of count(dead, r => r.killer)) lines.push(`  ${k}: ${n}  (${pct(n, dead.length)} of deaths)`);
  lines.push('', 'KILLER BY FLOOR');
  for (let f = 1; f <= 5; f++) { const c = count(dead.filter(r => r.floor === f), r => r.killer).map(([k, n]) => `${k} ${n}`).join(', '); if (c) lines.push(`  floor ${f}: ${c}`); }
  lines.push('', 'ARRIVING ON EACH FLOOR (runs that got there): avg HP / max, potions, level');
  for (let f = 1; f < 5; f++) { const a = ok.filter(r => r.arrive && r.arrive[f]).map(r => r.arrive[f]); if (a.length) lines.push(`  floor ${f + 1}: ${a.length} runs, HP ${avg(a, x => x.hp)}/${avg(a, x => x.max)}, potions ${avg(a, x => x.potions)}, level ${avg(a, x => x.level)}`); }
  lines.push('', `AT THE END: level ${avg(ok, r => r.level)}, max HP ${avg(ok, r => r.maxHp)}, defense ${avg(ok, r => r.def)}, weapon +${avg(ok, r => r.weapon)}, potions drunk ${avg(ok, r => r.potionsDrunk)}, kills ${avg(ok, r => r.kills)}, flees ${avg(ok, r => r.fled)}`);
  lines.push(`SELLING: avg ${avg(ok, r => r.sold || 0)} coins a run from sales; ${ok.filter(r => r.sold > 0).length} of ${ok.length} runs sold something`);
  lines.push('', 'GOLD THEY DIED WITH (unspent coins at death)');
  lines.push(`  average ${avg(dead, r => r.coinsLeft)}, median ${(() => { const s = dead.map(r => r.coinsLeft).sort((a, b) => a - b); return s.length ? s[s.length >> 1] : '-'; })()}, most ${dead.reduce((m, r) => Math.max(m, r.coinsLeft), 0)}   (gold earned over the run: avg ${avg(dead, r => r.gold)})`);
  for (let f = 1; f <= 5; f++) { const d = dead.filter(r => r.floor === f); if (d.length) lines.push(`  died on floor ${f}: avg ${avg(d, r => r.coinsLeft)} coins left, ${avg(d, r => r.potionsLeft)} potions left`); }
  lines.push(`WINNERS: level ${avg(wins, r => r.level)}, max HP ${avg(wins, r => r.maxHp)}, defense ${avg(wins, r => r.def)}, weapon +${avg(wins, r => r.weapon)}`);
  const errs = R.filter(r => r.error || r.stuck).slice(0, 3).map(r => JSON.stringify(r).slice(0, 300));
  if (errs.length) lines.push('', 'SAMPLE PROBLEMS', ...errs);
  return lines.join('\n');
})()
'@ -replace '__RUNKEY__', "crawlSim:$runId")
$summary
if ($Save) {
  $raw = Js "localStorage.getItem('crawlSim:$runId')"
  [IO.File]::WriteAllText((Join-Path $Here 'sim-results.json'), $raw)
  "saved sim-results.json"
}
