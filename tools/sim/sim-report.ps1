# The balance report for the last batch (sim.ps1), and with -Save the raw results to sim-results.json
param([switch]$Save)
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'cdp.ps1')
$runKey = [IO.File]::ReadAllText((Join-Path $Here 'sim-run.txt')).Trim()
Connect-Cdp
$summary = Js (@'
(() => {
  // the bot stores each run's per-floor numbers as plain lists; unpack them (older batches stored objects)
  const ARRIVE_KEYS = ['hp', 'max', 'potions', 'level', 'coins', 'def', 'weapon', 'shield', 'steel'];
  const SHOP_KEYS = ['visits', 'inHp', 'inPotions', 'inCoins', 'potionsBought', 'onPotions', 'onGear', 'onOther', 'outPotions', 'outCoins', 'stockLeft'];
  const obj = (keys, v) => Array.isArray(v) ? Object.fromEntries(keys.map((k, i) => [k, v[i]])) : v;
  const R = JSON.parse(localStorage.getItem('__RUNKEY__') || '[]').map(r => r && !r.error && !r.stuck
    ? {...r, arrive: (r.arrive || []).map(a => a && obj(ARRIVE_KEYS, a)), shops: Object.fromEntries(Object.entries(r.shops || {}).map(([k, v]) => [k, obj(SHOP_KEYS, v)]))}
    : r);
  const stoppedAt = localStorage.getItem('__RUNKEY__:full');
  const ok = R.filter(r => !r.error && !r.stuck), wins = ok.filter(r => r.won), dead = ok.filter(r => !r.won), N = ok.length;
  const count = (list, f) => { const m = {}; for (const r of list) { const k = f(r); m[k] = (m[k] || 0) + 1; } return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : '-';
  const avg = (list, f) => list.length ? list.reduce((s, r) => s + f(r), 0) / list.length : NaN;
  const f1 = x => isNaN(x) ? '-' : x.toFixed(1);
  const L = [], flags = [];
  L.push(`runs ${R.length}   errors ${R.filter(r => r.error).length}   stuck ${R.filter(r => r.stuck).length}`);
  if (stoppedAt) L.push(`  NOTE: the browser's storage filled up, so the batch stopped early after ${stoppedAt} runs`);
  L.push(`WIN RATE ${pct(wins.length, N)} (${wins.length} of ${N})   target 10-15%`);
  const wr = wins.length / N;
  if (wr < 0.10) flags.push(`Win rate ${pct(wins.length, N)} is under the 10-15% target`);
  if (wr > 0.15) flags.push(`Win rate ${pct(wins.length, N)} is over the 10-15% target`);

  L.push('', 'HOW DEADLY EACH FLOOR IS (of the runs that reached it)');
  for (let fl = 1; fl <= 5; fl++) {
    const reached = ok.filter(r => r.floor >= fl).length, died = dead.filter(r => r.floor === fl);
    const lethal = died.length / Math.max(1, reached), top = count(died, r => r.killer).slice(0, 3).map(([k, n]) => `${k} ${pct(n, died.length)}`).join(', ');
    L.push(`  floor ${fl}: reached ${reached}, died ${died.length} = ${pct(died.length, reached)}   top killers: ${top || '-'}`);
    if (lethal > 0.35) flags.push(`Floor ${fl} kills ${pct(died.length, reached)} of the runs that reach it`);
    const [k0, n0] = count(died, r => r.killer)[0] || [];
    if (died.length >= 20 && n0 / died.length > 0.35) flags.push(`${k0} causes ${pct(n0, died.length)} of floor ${fl} deaths`);
  }
  const finalDeaths = dead.filter(r => r.floor === 5), bossKills = finalDeaths.filter(r => r.killer === 'Ogre King').length;
  if (finalDeaths.length >= 10) L.push(`  floor 5 deaths to the Ogre King himself: ${pct(bossKills, finalDeaths.length)}`);
  if (finalDeaths.length >= 20 && bossKills / finalDeaths.length < 0.3) flags.push(`On floor 5 the Ogre King causes only ${pct(bossKills, finalDeaths.length)} of deaths: the floor's crowd, not the boss, is the real final test`);

  L.push('', 'WHAT RUNS CARRY INTO EACH FLOOR (average on arrival)');
  for (let fl = 1; fl <= 5; fl++) {
    const a = ok.map(r => r.arrive && r.arrive[fl - 1]).filter(Boolean);
    if (!a.length) continue;
    L.push(`  floor ${fl}: ${a.length} runs   HP ${f1(avg(a, x => x.hp))}/${f1(avg(a, x => x.max))} (${pct(avg(a, x => x.hp / x.max), 1)})   potions ${f1(avg(a, x => x.potions))}   level ${f1(avg(a, x => x.level))}   Defense ${f1(avg(a, x => x.def ?? 0))}   weapon +${f1(avg(a, x => x.weapon ?? 0))}   Steel pieces ${f1(avg(a, x => x.steel ?? 0))}   shield ${pct(a.filter(x => x.shield > 0).length, a.length)}`);
  }

  L.push('', 'ECONOMY');
  L.push(`  gold earned per run ${f1(avg(ok, r => r.gold))}; unspent at death ${f1(avg(dead, r => r.coinsLeft))}; potions left at death ${f1(avg(dead, r => r.potionsLeft))}; potions drunk per run ${f1(avg(ok, r => r.potionsDrunk))}; sold ${f1(avg(ok, r => r.sold || 0))} coins a run`);
  for (let fl = 1; fl <= 5; fl++) { const d = dead.filter(r => r.floor === fl); if (d.length) L.push(`  died on floor ${fl}: ${f1(avg(d, r => r.coinsLeft))} coins and ${f1(avg(d, r => r.potionsLeft))} potions left`); }
  const outOfPotions = dead.filter(r => r.potionsLeft === 0).length;
  if (dead.length && outOfPotions / dead.length > 0.8 && avg(dead, r => r.coinsLeft) > 80) flags.push(`${pct(outOfPotions, dead.length)} of deaths have no potions left but ${f1(avg(dead, r => r.coinsLeft))} unspent coins: healing is short and gold has nothing to buy`);

  L.push('', 'SHOPS (floors 2-4): who gets there, what they buy, and where on the floor runs die');
  const SHOPNAME = {2: 'Iron Merchant', 3: 'Enchanter', 4: 'Steel Merchant'};
  for (const fl of [2, 3, 4]) {
    const reached = ok.filter(r => r.floor >= fl), shopped = reached.filter(r => r.shops && r.shops[fl - 1]), S = shopped.map(r => r.shops[fl - 1]);
    L.push(`  floor ${fl} (${SHOPNAME[fl]}): ${pct(shopped.length, reached.length)} of the ${reached.length} runs reaching the floor got to the shop`);
    if (S.length) {
      L.push(`    walking in: HP ${pct(avg(S, s => s.inHp), 1)}, ${f1(avg(S, s => s.inPotions))} potions, ${f1(avg(S, s => s.inCoins))} coins`);
      if (fl !== 3) L.push(`    bought ${f1(avg(S, s => s.potionsBought))} potions (of the 5 in stock; ${pct(S.filter(s => s.stockLeft === 0).length, S.length)} bought them all); spent ${f1(avg(S, s => s.onPotions))} on potions, ${f1(avg(S, s => s.onGear))} on gear, ${f1(avg(S, s => s.onOther))} on other things`);
      else L.push(`    spent ${f1(avg(S, s => s.onOther))} on enchantments (the Enchanter sells no potions)`);
      L.push(`    walking out: ${f1(avg(S, s => s.outPotions))} potions, ${f1(avg(S, s => s.outCoins))} coins`);
    }
    const died = dead.filter(r => r.floor === fl), before = died.filter(r => r.diedWhere === 'before shop'), after = died.filter(r => r.diedWhere === 'after shop');
    if (died.length) {
      L.push(`    deaths on floor ${fl}: ${before.length} before the shop (${pct(before.length, died.length)}), ${after.length} after it (${pct(after.length, died.length)})`);
      if (died.length >= 20 && before.length / died.length > 0.5) flags.push(`Most floor ${fl} deaths (${pct(before.length, died.length)}) happen before reaching the ${SHOPNAME[fl]}: runs arrive on floor ${fl} too weak, the shop comes too late to help`);
    }
    if (fl !== 3 && S.length >= 20) {
      const soldOut = S.filter(s => s.stockLeft === 0), richOut = soldOut.filter(s => s.outCoins >= 30);
      if (soldOut.length / S.length > 0.5 && richOut.length / S.length > 0.3) flags.push(`The ${SHOPNAME[fl]} sells out of potions for ${pct(soldOut.length, S.length)} of runs, and ${pct(richOut.length, S.length)} walk out with 30+ coins they'd have spent on more`);
    }
  }

  L.push('', 'SHIELDS AND BLOCK');
  const turns = ok.reduce((s, r) => s + (r.turns || 0), 0), blocks = ok.reduce((s, r) => s + (r.blocks || 0), 0), sb = ok.reduce((s, r) => s + (r.shieldBlocks || 0), 0);
  const withS = ok.filter(r => r.shieldFirstFloor), noS = ok.filter(r => !r.shieldFirstFloor);
  L.push(`  Block used on ${pct(blocks, turns)} of fight turns (${blocks} of ${turns}); ${pct(sb, blocks)} of Blocks were made holding a shield`);
  L.push(`  runs that ever held a shield: ${pct(withS.length, N)}; first shield on floor ${count(withS, r => r.shieldFirstFloor).sort((a, b) => a[0] - b[0]).map(([k, n]) => `${k}: ${n}`).join(', ')}`);
  L.push(`  win rate holding a shield at the end ${pct(ok.filter(r => r.won && r.shield > 0).length, ok.filter(r => r.shield > 0).length)} vs without ${pct(ok.filter(r => r.won && !r.shield).length, ok.filter(r => !r.shield).length)}`);
  // a fairer test: of the runs reaching floor 4, those already holding a shield vs not
  const r4 = ok.filter(r => r.arrive && r.arrive[3]), r4s = r4.filter(r => r.arrive[3].shield > 0), r4n = r4.filter(r => !(r.arrive[3].shield > 0));
  L.push(`  of runs reaching floor 4: with a shield then ${pct(r4s.filter(r => r.won).length, r4s.length)} won (${r4s.length} runs), without ${pct(r4n.filter(r => r.won).length, r4n.length)} won (${r4n.length} runs)`);
  if (turns && blocks / turns < 0.05) flags.push(`Block is chosen on only ${pct(blocks, turns)} of turns even by a bot that weighs it: Block (and so shields) may be too weak`);

  L.push('', `THE BUILD (${(ok[0] && ok[0].build) || 'default'}) at the end of the run, winners vs everyone`);
  for (const [name, list] of [['winners', wins], ['everyone', ok]]) if (list.length)
    L.push(`  ${name}: Thorns ${f1(avg(list, r => r.thorns || 0))} damage per hit taken (${f1(avg(list, r => r.thornsPieces || 0))} pieces), Shield Bash x${f1(avg(list, r => r.bash || 0))}, Vitality x${f1(avg(list, r => r.vit || 0))}, Block stops ${pct(avg(list, r => r.blockStops || 0), 1)}, stun ${pct(avg(list, r => r.stun || 0), 1)}, Blocked ${pct(list.reduce((s, r) => s + (r.blocks || 0), 0), list.reduce((s, r) => s + (r.turns || 0), 0))} of turns`);

  L.push('', 'WINNERS vs EVERYONE (at the end of the run)');
  L.push(`  winners: level ${f1(avg(wins, r => r.level))}, max HP ${f1(avg(wins, r => r.maxHp))}, Defense ${f1(avg(wins, r => r.def))}, weapon +${f1(avg(wins, r => r.weapon))}, shield +${f1(avg(wins, r => r.shield || 0))}`);
  L.push(`  everyone: level ${f1(avg(ok, r => r.level))}, max HP ${f1(avg(ok, r => r.maxHp))}, Defense ${f1(avg(ok, r => r.def))}, weapon +${f1(avg(ok, r => r.weapon))}, shield +${f1(avg(ok, r => r.shield || 0))}`);
  const perkUse = {}; for (const r of ok) for (const [k, v] of Object.entries(r.perks || {})) perkUse[k] = (perkUse[k] || 0) + v;
  L.push(`  perks taken (all runs): ${Object.entries(perkUse).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);

  L.push('', 'BALANCE FLAGS');
  for (const f of flags) L.push('  ! ' + f);
  if (!flags.length) L.push('  (none)');
  const errs = R.filter(r => r.error || r.stuck).slice(0, 3).map(r => JSON.stringify(r).slice(0, 300));
  if (errs.length) L.push('', 'SAMPLE PROBLEMS', ...errs);
  return L.join('\n');
})()
'@ -replace '__RUNKEY__', "crawlSim:$runKey")
$summary
if ($Save) {
  $raw = Js "localStorage.getItem('crawlSim:$runKey')"
  [IO.File]::WriteAllText((Join-Path $Here 'sim-results.json'), $raw)
  "saved sim-results.json"
}
