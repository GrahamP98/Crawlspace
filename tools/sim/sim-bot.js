// Crawlspace simulation bot. Injected into every page load; plays one full run through the game's own
// on-screen buttons (handleTap on each item's box), records the result in localStorage, reloads, repeats.
(() => {
  if (location.protocol !== 'file:' || window.__simBot) return;   // one bot per page, even if injected twice
  window.__simBot = true;
  // the settings come built into the injected script (window.__SIM = {n, id}); results are kept per batch id
  const cfg = window.__SIM;
  if (!cfg) return;
  const KEY = 'crawlSim:' + cfg.id;
  addEventListener('load', () => setTimeout(runOne, 0));

  function runOne() {
    const results = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (results.length >= cfg.n) { document.title = 'SIM DONE'; return; }
    let res;
    try { res = playGame(); } catch (e) { res = {error: String((e && e.stack) || e)}; }
    results.push(res);
    localStorage.setItem(KEY, JSON.stringify(results));
    if (results.length < cfg.n) { document.title = `SIM ${results.length}/${cfg.n}`; location.reload(); }
    else document.title = 'SIM DONE';
  }

  // ---------------------------------------------------------------- one run
  function playGame() {
    // no drawing: the game logic runs exactly as normal, just without painting frames
    window.draw = () => {};
    requestFrames = () => {};
    LEVEL_TAP_GUARD_MS = 0;
    title.hidden = true;

    const B = {avoid: new Set(), shopDone: new Set(), arrive: [], killer: null, deathFoes: null, fled: 0, sold: 0};
    const origEnd = endRun;
    endRun = (won, killer) => {
      B.killer = won ? null : killer;
      B.deathFoes = won ? null : foes.map(f => f.name);
      origEnd(won, killer);
    };
    const origLoad = loadFloor;
    loadFloor = i => { B.arrive[i] = {hp: p.hp, max: p.max, potions, level, coins}; origLoad(i); };
    B.arrive[0] = {hp: p.hp, max: p.max, potions, level, coins};

    let n = 0;
    while (!over && n < 20000) { n++; step(B); }
    if (!over) return {stuck: true, phase, floor: floor + 1};
    return {
      won: runSummary.won, floor: floor + 1, killer: B.killer, deathFoes: B.deathFoes, level,
      maxHp: p.max, def: defense(), weapon: power('weapon'), perks: {...perks},
      gold: run.gold, coinsLeft: coins, potionsLeft: potions, potionsDrunk: run.potions, steps: run.steps, fled: B.fled, sold: B.sold,
      kills: Object.values(run.kills).reduce((a, b) => a + b, 0), arrive: B.arrive
    };
  }

  // ---------------------------------------------------------------- taps
  function tapItem(id) {
    const it = screenItems().find(i => i.id === id);
    if (!it || it.enabled === false) return false;
    shownView = inCombatScene() ? 'combat' : 'map';
    handleTap({x: it.x + it.w / 2, y: it.y + it.h / 2});
    return true;
  }
  // tap the side of the map to step that way
  function stepDir(dx, dy) {
    shownView = 'map';
    const px = 144 + dx * 120, py = 176 + dy * 150;
    handleTap({x: view.play.x + px * view.play.s, y: view.play.y + py * view.play.s});
  }

  function step(B) {
    if (overlay) { overlay = null; return; }
    switch (phase) {
      case 'level': return pickPerk();
      case 'loot': return lootChoice();
      case 'scroll': return scrollPick();
      case 'shop': return shopping(B);
      case 'enchanter': return enchanting(B);
      case 'choice': return choose(B);
      case 'fight': return fightTurn();
      default: return explore(B);
    }
  }

  // ---------------------------------------------------------------- fighting
  // the most an enemy can do to you with its next swing (max roll; Crushing Blow ignores armor; Charge doubles)
  function foeHit(f) {
    const crush = f.crushEvery && ((f.swings || 0) + 1) % f.crushEvery === 0;
    const charge = f.charge && f.fresh;
    const raw = f.dmg[1] + f.bonus + (f.raged ? RAGE_BONUS : 0) + (f.bloodlust && p.hp < p.max / 2 ? f.bloodlust : 0);
    let h = Math.max(1, raw - (crush ? 0 : defense()));
    if (charge) h *= 2;
    return {h, big: !!(crush || charge)};
  }
  const incoming = (mult = 1) => foes.filter(f => f.hp > 0 && !f.stunned)
    .reduce((s, f) => s + Math.max(1, Math.round(foeHit(f).h * mult)), 0) + (poison ? poisonDmg() : 0);

  function fightTurn() {
    const live = foes.filter(f => f.hp > 0);
    // kill a Goblin that has your coins first, otherwise the weakest enemy (fewer attackers sooner)
    target = live.find(f => f.stolen) || live.slice().sort((a, b) => a.hp - b.hp)[0];
    const danger = incoming(1);
    // drink when the next round could kill you, allowing for a critical hit (x1.5) from one of them
    const worst = foes.filter(f => f.hp > 0 && !f.stunned).reduce((m, f) => Math.max(m, foeHit(f).h), 0);
    if (potions > 0 && p.hp <= danger + worst * 0.5 && p.max - p.hp >= 20) return tapItem('potion');
    if (live.some(f => !f.stunned && foeHit(f).big)) return tapItem('block');
    // Heavy only when its expected damage clearly beats Normal and you can afford being exposed
    const t = target, base = t.evasion ?? PLAYER_MISS;
    const normalEV = 1 - base * missKeep();
    const heavyEV = (1 - (base + HEAVY_MISS) * missKeep() * (1 - enchSum('balanced'))) * HEAVY_MULT;
    const heavyOk = !t.riposte && heavyEV > normalEV * 1.15 && p.hp > incoming(HEAVY_EXPOSED) * 3;
    return tapItem(heavyOk ? 'heavy' : 'normal');
  }

  // the enemy beside the stairs and the Ogre King can't be skipped
  function required(e) {
    if (!e) return false;
    if (e.boss) return true;
    return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => map[e.y + dy] && map[e.y + dy][e.x + dx] === 'D');
  }
  function choose(B) {
    const low = p.hp < p.max * 0.35 && potions === 0;
    if (low && canFlee() && !required(current) && !B.avoid.has(current)) {
      B.avoid.add(current);
      B.fled++;
      return tapItem('flee');
    }
    return tapItem('fight');
  }

  // ---------------------------------------------------------------- choices
  const PERK_RANK = {secondwind: 10, vitality: 8, attack: 7.5, focus: 6, executioner: 5, shieldbash: 4.5,
                     pathfinder: 4, antidote: 3, purse: 2};
  function pickPerk() {
    const best = hand.slice().sort((a, b) => (PERK_RANK[b] || 0) - (PERK_RANK[a] || 0))[0];
    tapItem('up:' + best);
  }
  const gearScore = it => it ? it.power + (it.ench ? 1.5 + it.ench.t : 0) : -1;
  function lootChoice() {
    tapItem(gearScore(pending) > gearScore(worn[pending.slot]) ? 'equip' : 'leaveItem');
  }
  // the worn piece a scroll would go on right now (empty of enchantments, or with a weaker one), or null
  const scrollTarget = s => {
    const ok = enchSlots(s.id).filter(k => worn[k] && worn[k].tier >= s.t);
    return ok.find(k => !worn[k].ench) || ok.find(k => worn[k].ench.t < s.t) || null;
  };
  function scrollPick() {
    const s = scrollNow, k = scrollTarget(s);
    if (k) return tapItem('scroll:' + k);
    // nothing to put it on yet: keep it (for better gear later, or to sell to the Enchanter), else throw it away
    if (s.fromBag === null) return tapItem('scroll:keep') || tapItem('scroll:discard');
    return tapItem('scroll:back');
  }
  // sell what you wear in a slot at the merchant (two taps), counting the coins
  function sellWorn(B, slot) {
    if (!worn[slot]) return;
    const before = coins;
    if (shopMode !== 'sell') tapItem('shop:mode');
    tapItem('sell:' + slot); tapItem('sell:' + slot);
    tapItem('shop:mode');
    B.sold += coins - before;
  }

  function shopping(B) {
    B.shopDone.add(floor);
    const idx = pred => shopStock.findIndex(pred);
    const tryBuy = i => i >= 0 && tapItem('buy:' + i);
    for (let guard = 0; guard < 40; guard++) {
      let bought = false;
      if (potions < 2) bought = tryBuy(idx(s => s.type === 'potion'));
      if (!bought) {
        // gear upgrades, the biggest gain first (skip ones that would throw away an enchantment for +1);
        // the piece it replaces is sold first, and that money counts toward the price
        const trade = s => worn[s.slot] ? sellValue(gearRetail(worn[s.slot])) : 0;
        const ups = shopStock.map((s, i) => ({s, i}))
          .filter(({s}) => s.type === 'gear' && !(worn[s.slot] && worn[s.slot].power >= s.power) && coins + trade(s) >= s.price)
          .map(({s, i}) => ({s, i, gain: s.power - (worn[s.slot] ? worn[s.slot].power : 0) - (worn[s.slot] && worn[s.slot].ench ? 2 : 0) + (s.slot === 'weapon' ? 0.5 : 0)}))
          .filter(u => u.gain > 0).sort((a, b) => b.gain - a.gain);
        if (ups.length) { sellWorn(B, ups[0].s.slot); bought = tryBuy(ups[0].i); }
      }
      if (!bought) bought = tryBuy(idx(s => s.type === 'potion'));
      if (!bought && potions >= maxPotions) bought = tryBuy(idx(s => s.type === 'bag'));
      if (!bought) break;
    }
    tapItem('shop:leave');
  }

  // the Enchanter: Vampiric on the weapon, Fortitude on armor, best tier affordable, keeping some coins for floor 4
  function enchanting(B) {
    B.shopDone.add(floor);
    // first sell the scrolls in the bag that nothing you wear can take (the last one first, so the list holds still)
    if (scrolls.some(s => !scrollTarget(s)) && tapItem('ench:sellScrolls')) {
      for (let i = scrolls.length - 1; i >= 0; i--) if (!scrollTarget(scrolls[i])) {
        const before = coins;
        tapItem('ench:sell:' + i); tapItem('ench:sell:' + i);
        B.sold += coins - before;
      }
      tapItem('ench:back');
    }
    const RESERVE = 25;
    const plan = [['weapon', 'vampiric'], ['chest', 'fortitude'], ['helmet', 'fortitude'], ['bracers', 'fortitude'], ['greaves', 'fortitude']];
    for (const [slot, id] of plan) {
      const it = worn[slot];
      if (!it || it.ench) continue;
      for (let t = 2; t >= 0; t--) {
        if (it.tier >= t && coins - TIER_PRICE[t] >= RESERVE) {
          tapItem('ench:slot:' + slot); tapItem('ench:id:' + id); tapItem('ench:tier:' + t);
          break;
        }
      }
    }
    if (!tapItem('ench:leave')) { ench = {}; tapItem('ench:leave'); }
  }

  // ---------------------------------------------------------------- exploring
  function explore(B) {
    const k = p.hp / p.max;
    if (potions > 0 && (k < 0.5 || (poison && k < 0.7))) return tapItem('potion');
    // a kept scroll that fits your gear now: open the Bag and use it
    const usable = scrolls.findIndex(s => scrollTarget(s));
    if (usable >= 0) { overlay = {kind: 'hero', tab: 'bag', pick: null}; if (tapItem('bagUse:' + usable)) return; overlay = null; }
    // the Ogre King waits by the exit: go in as healthy as you can
    const boss = enemies.find(e => e.boss && !e.dead);
    const low = k < 0.35 && potions === 0;
    const goals = [];
    for (let y = 0; y < map.length; y++) for (let x = 0; x < map[y].length; x++) {
      const ch = map[y][x];
      if (ch === 'C' && !opened.has(`${x},${y}`)) goals.push([x, y, 0]);
    }
    if (!low) for (const e of enemies) if (!e.dead && !e.boss && !B.avoid.has(e) && !required(e)) goals.push([e.x, e.y, 0]);
    let path = nearest(goals, false);
    if (!path) {
      // the shop last (more coins by then), then the stairs (through their guard), then the exit
      const later = [];
      if (FLOOR_SHOPS[floor] && !B.shopDone.has(floor)) {
        for (let y = 0; y < map.length; y++) { const x = map[y].indexOf(FLOOR_SHOPS[floor]); if (x >= 0) later.push([x, y, 0]); }
      }
      path = nearest(later, false);
      if (!path) {
        if (boss && potions > 0 && k < 0.8) return tapItem('potion');
        const end = [];
        for (let y = 0; y < map.length; y++) for (let x = 0; x < map[y].length; x++) if (map[y][x] === 'D' || map[y][x] === 'E') end.push([x, y, 0]);
        path = nearest(end, false) || nearest(end, true);
      }
    }
    if (!path || !path.length) return;   // nowhere to go: the run is recorded as stuck
    const [dx, dy] = path[0];
    stepDir(dx, dy);
  }
  // shortest path to the nearest goal; live enemies block the way unless passThrough (or they are the goal)
  function nearest(goals, passThrough) {
    if (!goals.length) return null;
    const want = new Set(goals.map(([x, y]) => `${x},${y}`));
    const blocked = new Set(enemies.filter(e => !e.dead).map(e => `${e.x},${e.y}`));
    const from = new Map([[`${p.x},${p.y}`, null]]), q = [[p.x, p.y]];
    while (q.length) {
      const [x, y] = q.shift(), key = `${x},${y}`;
      if (want.has(key) && key !== `${p.x},${p.y}`) {
        const out = [];
        let k = key;
        while (from.get(k)) { const [d, prevKey] = from.get(k); out.unshift(d); k = prevKey; }
        return out;
      }
      if (blocked.has(key) && key !== `${p.x},${p.y}` && !passThrough) continue;   // you'd stop to fight here
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, nk = `${nx},${ny}`;
        if (!map[ny] || !map[ny][nx] || map[ny][nx] === '#' || from.has(nk)) continue;
        if (blocked.has(nk) && !want.has(nk) && !passThrough) continue;
        from.set(nk, [[dx, dy], key]);
        q.push([nx, ny]);
      }
    }
    return null;
  }
})();
