// Crawlspace bot v2: plays full runs through the game's own action functions (the ones the buttons call),
// with fog of war (it only knows tiles it has seen and enemies it has bumped into or spotted with Pathfinder).
// Strategy knobs come in window.__SIM.pol; results go to localStorage, one page load per run.
(() => {
  if (location.protocol !== 'file:' || window.__simBot) return;
  window.__simBot = true;
  const cfg = window.__SIM;
  if (!cfg) return;
  const KEY = 'crawlSim:' + cfg.id;
  addEventListener('load', () => setTimeout(runOne, 0));

  // ---------------------------------------------------------------- policy
  const DEF = {
    name: 'smart',
    explore: 'full',        // 'full' = clear the floor; 'rush' = head for the stairs once known; 'gated' = full while healthy
    fightKnown: 'smart',    // 'all' | 'smart' (skip known groups that look too costly) | 'none' (avoid all known enemies)
    fleeScout: true,        // flee from a group judged too dangerous on contact (not the guard/boss)
    fleeCost: 1.0,          // flee if expected damage > fleeCost * (hp + potion healing available) ... scaled
    fleeLowHp: 0.35,        // flee anything skippable when hp below this share and no potions
    potionFight: 'danger',  // when to drink in a fight
    potionExplore: 0.5,     // drink outside fights below this share
    preBossHp: 0.8,
    heavy: 'ev',            // 'ev' | 'never' | 'always'
    block: 'ev',            // 'ev' | 'never' | 'main'
    perk: {secondwind: 10, vitality: 8, attack: 7.5, focus: 6, executioner: 5, ambusher: 5, shieldbash: 4.5, pathfinder: 4, antidote: 3, purse: 2},
    redraw: 0,              // redraw when best card weight < this (and coins allow)
    redrawReserve: 20,
    potionsKeep: 3,         // potions to buy first at a merchant
    buyBelt: true,
    buyBandolier: true,
    buySatchel: false,
    shieldWeight: 0.7,
    backtrackShop: true,    // return to the merchant before taking the stairs if there is money to spend
    ench: [['weapon', 'vampiric'], ['chest', 'fortitude'], ['helmet', 'fortitude'], ['bracers', 'fortitude'], ['greaves', 'fortitude'], ['shield', 'fortitude']],
    enchReserve: 25,
    enchPref: {},           // extra score for drops/scrolls with these enchantments
    sellScrolls: true,
    sellPotionsAtShop: false,
    target: 'threat',       // 'threat' | 'weakest'
    camp: null,             // the campfire on floor 5: null = rest or train by health, or force 'rest' | 'train'
    campRestNow: 0.45,      // rest on the way past it if below this share of max HP
    campRestEnd: 0.7        // coming back to it before the King: rest below this share, train above
  };
  const P = Object.assign({}, DEF, cfg.pol || {});
  if (cfg.pol && cfg.pol.perk) P.perk = Object.assign({}, cfg.pol.perk);

  function runOne() {
    const results = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (results.length >= cfg.n) { document.title = 'SIM DONE'; return; }
    if (!results.length) for (const k of Object.keys(localStorage)) if (k.startsWith('crawlSim:') && k !== KEY) localStorage.removeItem(k);
    let res;
    try { res = playGame(); } catch (e) { res = {error: String((e && e.stack) || e).slice(0, 400)}; }
    results.push(res);
    try { localStorage.setItem(KEY, JSON.stringify(results)); }
    catch (e) { document.title = 'SIM DONE'; return; }
    if (results.length < cfg.n) { document.title = `SIM ${results.length}/${cfg.n}`; location.reload(); }
    else document.title = 'SIM DONE';
  }

  // ---------------------------------------------------------------- one run
  let K, ST;   // K = what the bot knows; ST = stats
  function playGame() {
    window.draw = () => {};
    requestFrames = () => {};
    refresh = () => {};
    LEVEL_TAP_GUARD_MS = 0;
    LOOT_TAP_GUARD_MS = 0;
    title.hidden = true;
    K = {known: new Set(), avoid: new Set(), shopVisits: {}, floorFights: 0};
    ST = {fights: 0, fled: 0, fleeTry: 0, turns: 0, heavy: 0, block: 0, normal: 0, potFight: 0, potExplore: 0, bought: [], enchBought: [],
          sold: 0, redraws: 0, arrive: [], hpLostFloor: [0, 0, 0, 0, 0], coinsEnd: [], deathFoes: null, killer: null, sw: 0, steps: 0,
          skipped: 0, fullAtStairs: []};
    const origEnd = endRun;
    endRun = (won, killer) => { ST.killer = won ? null : killer; ST.deathFoes = won ? null : foes.filter(f => f.hp > 0 || true).map(f => f.name); origEnd(won, killer); };
    const origLoad = loadFloor;
    loadFloor = i => { ST.coinsEnd[floor] = coins; origLoad(i); K.known = new Set(); K.avoid = new Set(); K.floorFights = 0; K.backDone = false; K.headFor = null; K.campBack = false; K.stuckCount = 0; see(); arrive(); };
    see(); arrive();
    // every fight, by where it was: floor + N (the near half), F (the far half), G (the stairs guard) or B (the boss);
    // segs[key] = [fights, share of max HP lost in them, coins gained in them]; deathSeg = where the run ended
    ST.segs = {}; ST.deathSeg = null;
    const segOf = e => `${floor + 1}${e.boss ? 'B' : openNbrs(map.map(r => [...r]), e.x, e.y).some(([a, b]) => map[b][a] === 'D') ? 'G' : e.hard ? 'F' : 'N'}`;
    let seg = null, segTaken = 0, segMax = 1, segGold = 0;
    let n = 0, lastHp = p.hp;
    while (!over && n < 30000) {
      n++;
      step();
      if (current && !seg) { seg = segOf(current); segTaken = run.taken; segMax = p.max; segGold = run.gold; }
      else if (seg && (!current || over)) {
        const s = ST.segs[seg] || (ST.segs[seg] = [0, 0, 0]);
        s[0]++; s[1] += (run.taken - segTaken) / segMax; s[2] += run.gold - segGold;
        if (over && !runSummary.won) ST.deathSeg = seg;
        seg = null;
      }
      if (p.hp < lastHp) ST.hpLostFloor[floor] += lastHp - p.hp;
      lastHp = p.hp;
    }
    if (!over) return {stuck: true, phase, floor: floor + 1, pol: P.name};
    const ench = {};
    for (const it of Object.values(worn)) if (it && it.ench) ench[it.ench.id + it.ench.t] = (ench[it.ench.id + it.ench.t] || 0) + 1;
    return {
      won: runSummary.won, floor: floor + 1, killer: ST.killer, deathFoes: ST.deathFoes, level, maxHp: p.max, def: defense(),
      weapon: power('weapon'), shield: power('shield'), perks: {...perks}, ench, gold: run.gold, coins, potions, drunk: run.potions,
      steps: run.steps, kills: Object.values(run.kills).reduce((a, b) => a + b, 0), taken: run.taken, dealt: run.dealt,
      fights: ST.fights, fled: ST.fled, fleeTry: ST.fleeTry, turns: ST.turns, heavy: ST.heavy, block: ST.block, normal: ST.normal,
      potFight: ST.potFight, potExplore: ST.potExplore, bought: ST.bought, enchBought: ST.enchBought, sold: ST.sold, redraws: ST.redraws,
      arrive: ST.arrive, hpLost: ST.hpLostFloor, coinsEnd: ST.coinsEnd, skipped: ST.skipped, maxPotions, sw: secondWinds,
      segs: ST.segs, deathSeg: ST.deathSeg, spent: ST.bought.length, camp: ST.camp || null
    };
  }
  function arrive() { ST.arrive[floor] = [p.hp, p.max, potions, level, coins, defense(), power('weapon'), power('shield')]; }

  // what the player can see: tiles in sight; Pathfinder spots enemies in sight (the game shows them on the map)
  function see() {
    const r = sight();
    for (let y = p.y - r; y <= p.y + r; y++) for (let x = p.x - r; x <= p.x + r; x++) if (map[y] && map[y][x]) K.known.add(`${x},${y}`);
    if (perkN('pathfinder')) enemies.forEach(e => { if (inSight(e.x, e.y) && e !== current) { e.spottedEarly = true; if (!e.group) e.group = makeGroup(e.zone, e); } });
    if (P.omni) enemies.forEach(e => { if (!e.group && !e.boss && e !== current) e.group = makeGroup(e.zone, e); });
  }
  // P.omni: knows every enemy, as if it had a perfect map (a ceiling on what information is worth)
  const knownEnemy = e => !e.dead && (P.omni || e.seen || e.boss && K.known.has(`${e.x},${e.y}`) || (perkN('pathfinder') && e.spottedEarly));

  function step() {
    if (overlay) { overlay = null; return; }
    switch (phase) {
      case 'level': return pickPerk();
      case 'loot': return lootChoice();
      case 'scroll': return scrollPick();
      case 'shop': return shopping();
      case 'enchanter': return enchanting();
      case 'camp': return camping();
      case 'choice': return choose();
      case 'fight': return fightTurn();
      case 'finale': return finishBossFinale();
      default: return explore();
    }
  }

  // ---------------------------------------------------------------- combat math
  function foeHit(f) {
    const crush = f.crushEvery && ((f.swings || 0) + 1) % f.crushEvery === 0;
    const charge = f.charge && f.fresh;
    const raw = f.dmg[1] + f.bonus + (f.raged ? RAGE_BONUS : 0) + (f.bloodlust && p.hp < p.max / 2 ? f.bloodlust : 0);
    let h = Math.max(1, raw - (crush ? 0 : defense()));
    if (charge) h *= 2;
    return h;
  }
  const incoming = (mult = 1) => foes.filter(f => f.hp > 0 && !f.stunned)
    .reduce((s, f) => s + Math.max(1, Math.round(foeHit(f) * mult)), 0) + (poison ? poisonDmg() : 0);
  function foeAvg(f, spike) {
    const crush = spike && f.crushEvery && ((f.swings || 0) + 1) % f.crushEvery === 0;
    const charge = spike && f.charge && f.fresh;
    const raw = (f.dmg[0] + f.dmg[1]) / 2 + (f.bonus || 0) + (f.raged ? RAGE_BONUS : 0) + (f.bloodlust && p.hp < p.max / 2 ? f.bloodlust : 0);
    let h = Math.max(1, raw - (crush ? 0 : defense()));
    if (charge) h *= 2;
    return crush || charge ? h : h * (1 - FOE_MISS) * (1 + FOE_CRIT * (FOE_CRIT_MULT - 1));
  }
  const shieldKeep = t => t.shield !== undefined ? 1 - FOE_SHIELD_BLOCK[t.shield] * (1 - FOE_SHIELD_KEEP) : 1;
  function myAvg(t, heavy) {
    let d = Math.max(1, 11 + power('weapon') + bonusDmg - (t.def || 0));
    if (heavy) d *= HEAVY_MULT;
    if (t.max >= GIANT_HP) d *= 1 + enchSum('giantslayer');
    if (perkN('executioner') && t.hp < t.max * EXEC_THRESHOLD) d *= 1 + execBonus();
    const miss = ((t.evasion ?? PLAYER_MISS) + (heavy ? HEAVY_MISS : 0)) * missKeep() * (heavy ? 1 - enchSum('balanced') : 1);
    const hit = 1 - miss;
    return d * (hit + critChance() * (PLAYER_CRIT_MULT - 1)) * shieldKeep(t) * (1 + enchSum('swift')) + hit * enchSum('flaming');
  }
  // rough cost of a whole fight against a group: damage you expect to take
  function fightCost(group) {
    const live = group.filter(f => f.hp > 0);
    if (!live.length) return 0;
    const dps = myAvg({def: 0, max: 50, hp: 50}, false);
    let t = 0, cost = 0;
    const order = live.slice().sort((a, b) => foeAvg(b) / b.hp - foeAvg(a) / a.hp);
    let alive = order.reduce((s, f) => s + foeAvg(f, false), 0);
    for (const f of order) {
      const eff = Math.max(1, myAvg(f, false));
      let hp = f.hp + (f.regen ? f.regen * 2 : 0) + (f.reassemble ? f.max * 0.25 * 0.33 : 0) + (f.split ? 28 * 0.6 : 0) + (f.drain ? 6 : 0);
      const rounds = hp / eff;
      cost += rounds * alive;
      alive -= foeAvg(f, false);
      t += rounds;
    }
    cost += live.some(f => f.charge) ? 15 : 0;
    cost -= enchSum('thorns') * t * 0.3;
    cost -= enchSum('vampiric') * dps * t;
    return Math.max(0, cost);
  }
  const healAvail = () => potions * potionHeal();

  // Block weighed by expected value (from the repo bot)
  function blockPays(live) {
    const atk = live.filter(f => !f.stunned), bm = blockMult(), s = stunChance();
    const now = atk.reduce((a, f) => a + foeAvg(f, true), 0), avg = atk.reduce((a, f) => a + foeAvg(f, false), 0);
    const stunSaved = atk.reduce((a, f) => a + (f.stunProof ? 0 : (1 - FOE_MISS) * s * foeAvg(f, false)), 0);
    const bash = perkN('shieldbash') && target ? Math.min(bashDmg(), target.hp) / Math.max(1, myAvg(target)) * avg : 0;
    const regen = live.reduce((a, f) => a + (f.regen && !(f.burn > 0) ? Math.min(f.regen, f.max - f.hp) : 0), 0);
    const thornsLost = enchSum('thorns') * atk.reduce((a, f) => a + (1 - FOE_MISS), 0);
    const extra = avg + (poison ? poisonDmg() : 0) + (target ? (regen + thornsLost) / Math.max(1, myAvg(target)) * avg : 0);
    return now * (1 - bm) + stunSaved + bash > extra * 1.15;
  }

  function pickTarget(live) {
    const thief = live.find(f => f.stolen);
    if (thief) return thief;
    if (P.target === 'weakest') return live.slice().sort((a, b) => a.hp - b.hp)[0];
    // threat per turn of work: kill whoever removes the most damage per hit spent
    return live.slice().sort((a, b) => (foeAvg(b) / Math.max(1, b.hp / myAvg(b))) - (foeAvg(a) / Math.max(1, a.hp / myAvg(a))))[0];
  }

  function fightTurn() {
    const live = foes.filter(f => f.hp > 0);
    target = pickTarget(live);
    const danger = incoming(1);
    const worst = live.filter(f => !f.stunned).reduce((m, f) => Math.max(m, foeHit(f)), 0);
    const swLeft = secondWinds > 0;
    if (potions > 0 && p.hp <= danger + worst * 0.5 && p.max - p.hp >= 20 && !(swLeft && p.hp > danger * 0.5 && P.potionFight === 'greedy')) {
      ST.potFight++; return drinkPotion();
    }
    ST.turns++;
    let kind = 'normal';
    const finishing = target && target.hp <= myAvg(target) * 0.6;
    if (P.block === 'main' && power('shield') && !finishing) kind = 'block';
    else if (P.block === 'ev' && blockPays(live)) kind = 'block';
    else if (P.heavy === 'always' && !target.riposte) kind = 'heavy';
    else if (P.heavy === 'ev') {
      const base = target.evasion ?? PLAYER_MISS;
      const normalEV = 1 - base * missKeep();
      const heavyEV = (1 - (base + HEAVY_MISS) * missKeep() * (1 - enchSum('balanced'))) * HEAVY_MULT;
      if (!target.riposte && heavyEV > normalEV * 1.15 && p.hp > incoming(HEAVY_EXPOSED) * 3) kind = 'heavy';
    }
    ST[kind]++;
    act(kind);
  }

  // the stairs guard and the boss can't be skipped
  function required(e) {
    if (!e) return false;
    if (e.boss) return true;
    return DIRS.some(([dx, dy]) => map[e.y + dy] && (map[e.y + dy][e.x + dx] === 'D' || map[e.y + dy][e.x + dx] === 'E'));
  }
  function choose() {
    ST.fights++;
    if (!canFlee() || required(current)) return startFight();
    const low = p.hp < p.max * P.fleeLowHp && potions === 0;
    const cost = fightCost(foes);
    const budget = p.hp + healAvail();
    const tooMuch = P.fleeScout && cost > budget * 0.6 * P.fleeCost;
    if ((low || tooMuch) && !K.avoid.has(current)) {
      K.avoid.add(current);
      ST.fleeTry++;
      const before = phase;
      tryFlee();
      if (phase === 'explore') ST.fled++;
      return;
    }
    startFight();
  }

  // ---------------------------------------------------------------- level-ups
  function pickPerk() {
    const score = id => (P.perk[id] || 0) - ((P.decay || {})[id] || 0) * perkN(id) + (id === 'secondwind' && secondWinds > 0 ? -1 : 0);
    const best = hand.slice().sort((a, b) => score(b) - score(a))[0];
    if (P.redraw && score(best) < P.redraw && coins >= redrawCost() + P.redrawReserve) { ST.redraws++; return redraw(); }
    takePerk(best);
  }

  // ---------------------------------------------------------------- gear
  const enchVal = e => {
    if (!e) return 0;
    const pref = P.enchPref[e.id] || 0;
    return 1.5 + e.t + pref * (1 + e.t);
  };
  const gearScore = it => it ? it.power * (it.slot === 'shield' || it === worn.shield ? P.shieldWeight * 1.4 : 1) + enchVal(it.ench) : -1;
  function lootChoice() {
    const cur = worn[pending.slot];
    const a = pending.power * (pending.slot === 'shield' ? P.shieldWeight * 1.4 : 1) + enchVal(pending.ench);
    const b = cur ? cur.power * (pending.slot === 'shield' ? P.shieldWeight * 1.4 : 1) + enchVal(cur.ench) : -1;
    return a > b ? (equipItem(), equipItem()) : (leaveItem(), leaveItem());   // each takes two taps
  }
  const scrollTarget = s => {
    const ok = enchSlots(s.id).filter(k => worn[k] && worn[k].tier >= s.t);
    const v = enchVal(s);
    return ok.find(k => !worn[k].ench) || ok.find(k => enchVal(worn[k].ench) < v - 0.5) || null;
  };
  function scrollPick() {
    const s = scrollNow, k = scrollTarget(s);
    if (k) { scrollChoice(k); return scrollChoice(k); }   // two taps
    if (s.fromBag === null) { if (scrolls.length < bagSlots) return scrollChoice('keep'); scrollChoice('discard'); return scrollChoice('discard'); }
    return scrollChoice('back');
  }

  // ---------------------------------------------------------------- shops
  function sellWorn(slot) {
    if (!worn[slot]) return;
    const c0 = coins;
    shopMode = 'sell'; sellGear(slot); sellGear(slot); shopMode = 'buy';
    ST.sold += coins - c0;
  }
  function shopping() {
    K.headFor = null;
    K.shopVisits[floor] = (K.shopVisits[floor] || 0) + 1;
    const buy = i => { const it = shopStock[i]; const c0 = coins; if (!saleArmed('buy:' + i)) buyItem(i); buyItem(i); if (coins < c0) { ST.bought.push(floor + 1 + ':' + (it.slot || it.type)); return true; } return false; };
    const idx = pred => shopStock.findIndex(pred);
    if (P.sellScrolls && scrolls.some(s => !scrollTarget(s))) {
      shopMode = 'sell';
      for (let i = scrolls.length - 1; i >= 0; i--) if (!scrollTarget(scrolls[i])) { const c0 = coins; sellScroll(i); sellScroll(i); ST.sold += coins - c0; }
      shopMode = 'buy';
    }
    if (P.sellPotionsAtShop) { shopMode = 'sell'; while (potions > 0) sellPotion(); shopMode = 'buy'; }
    if (p.hp < p.max * 0.65) buy(idx(s => s.type === 'rest'));
    for (let g = 0; g < 40; g++) {
      let done = false;
      if (potions < P.potionsKeep) done = buy(idx(s => s.type === 'potion'));
      if (!done) {
        const trade = s => worn[s.slot] ? sellValue(gearRetail(worn[s.slot])) : 0;
        const ups = shopStock.map((s, i) => ({s, i}))
          .filter(({s}) => s.type === 'gear' && !(worn[s.slot] && worn[s.slot].power >= s.power) && coins + trade(s) >= s.price)
          .map(({s, i}) => ({s, i, gain: (s.power - (worn[s.slot] ? worn[s.slot].power : 0)) * (s.slot === 'shield' ? P.shieldWeight : 1)
            - (worn[s.slot] && worn[s.slot].ench ? enchVal(worn[s.slot].ench) : 0) + (s.slot === 'weapon' ? 0.5 : 0)}))
          .filter(u => u.gain > 0).sort((a, b) => b.gain - a.gain);
        if (ups.length) { sellWorn(ups[0].s.slot); done = buy(ups[0].i); }
      }
      if (!done && P.buyBelt) done = buy(idx(s => s.type === 'bag' && s.from === 5 && maxPotions === 5 && potions >= Math.min(5, P.potionsKeep)));
      if (!done && P.buyBandolier) done = buy(idx(s => s.type === 'bag' && s.from === 7 && maxPotions === 7));
      if (!done) { const i = idx(s => s.type === 'potion'); if (i >= 0 && shopStock[i].price <= (P.maxPotPrice || 999) && coins - shopStock[i].price >= (floor === 1 ? (P.potReserve || 0) : 0)) done = buy(i); }
      if (!done && P.buySatchel) done = buy(idx(s => s.type === 'satchel'));
      if (!done) break;
    }
    leaveShop();
  }
  // the campfire: rest on the way past if badly hurt; otherwise clear the far half and come back to it before the King
  function camping() {
    const k = p.hp / p.max, pick = K.campBack ? (P.camp || (k < P.campRestEnd ? 'rest' : 'train'))
      : P.camp !== 'train' && k < P.campRestNow ? 'rest' : 'leave';
    if (pick !== 'leave') ST.camp = pick;
    K.headFor = null;
    campChoice(pick);
  }
  function enchanting() {
    K.headFor = null;
    K.shopVisits[floor] = (K.shopVisits[floor] || 0) + 1;
    if (P.sellScrolls && scrolls.some(s => !scrollTarget(s))) {
      ench = {sell: true};
      for (let i = scrolls.length - 1; i >= 0; i--) if (!scrollTarget(scrolls[i])) { const c0 = coins; sellScroll(i); sellScroll(i); ST.sold += coins - c0; }
      ench = {};
    }
    for (const [slot, id] of P.ench) {
      const it = worn[slot];
      if (!it || (it.ench && (it.ench.id === id || enchVal(it.ench) >= enchVal({id, t: it.tier})))) continue;
      for (let t = 2; t >= 0; t--) {
        if (it.tier >= t && coins - TIER_PRICE[t] >= P.enchReserve) {
          enchanterClick('slot:' + slot); enchanterClick('id:' + id); enchanterClick('tier:' + t);
          ST.enchBought.push(slot + ':' + id + t);
          break;
        }
      }
    }
    ench = {};
    enchanterClick('leave');
  }

  // ---------------------------------------------------------------- exploring
  function stepDir(dx, dy) {
    shownView = 'map';
    const px = 144 + dx * 120, py = 176 + dy * 150;
    handleTap({x: view.play.x + px * view.play.s, y: view.play.y + py * view.play.s});
    see();
  }
  const tile = (x, y) => map[y] && map[y][x];
  const isOpen = (x, y) => { const c = tile(x, y); return c && c !== '#'; };

  function explore() {
    const k = p.hp / p.max;
    if (potions > 0 && (k < P.potionExplore || (poison && k < 0.7)) && p.hp < p.max) { ST.potExplore++; return drinkPotion(); }
    const usable = scrolls.findIndex(s => scrollTarget(s));
    if (usable >= 0) { useBagScroll(usable); if (phase === 'scroll') return; }
    const known = K.known;
    const goals = [];
    const blockedKnown = new Set(enemies.filter(e => knownEnemy(e)).map(e => `${e.x},${e.y}`));
    const lowNoPot = k < P.fleeLowHp && potions === 0;
    const wantFights = P.fightKnown !== 'none' && !lowNoPot && !(P.explore === 'gated' && (p.hp + healAvail()) < p.max * 0.9);
    let stairs = null, shopTile = null;
    for (const key of known) {
      const [x, y] = key.split(',').map(Number), c = tile(x, y);
      if (c === 'D' || c === 'E') stairs = [x, y];
      if (c === FLOOR_SHOPS[floor]) shopTile = [x, y];
    }
    const rush = P.explore === 'rush' || (P.explore === 'gated' && (p.hp + healAvail()) < p.max * 0.6);
    const bossAt = key => enemies.some(e => e.boss && !e.dead && knownEnemy(e) && `${e.x},${e.y}` === key);   // walk into him only on purpose
    // chests and the unknown (frontier) as goals
    for (const key of known) {
      const [x, y] = key.split(',').map(Number), c = tile(x, y);
      if ((c === 'C' || c === 'K') && !opened.has(key)) goals.push(key);
      if (c !== '#' && !rush && !bossAt(key) && DIRS.some(([dx, dy]) => isOpen(x + dx, y + dy) && !known.has(`${x + dx},${y + dy}`))) goals.push(key);
    }
    if (wantFights && !rush) for (const e of enemies) {
      if (!knownEnemy(e) || e.boss || required(e) || K.avoid.has(e)) continue;
      if (P.fightKnown === 'smart' && e.group && fightCost(e.group) > (p.hp + healAvail()) * 0.5) continue;
      goals.push(`${e.x},${e.y}`);
    }
    // in rush mode, the frontier only matters until the stairs are found
    if (rush && !stairs) for (const key of known) {
      const [x, y] = key.split(',').map(Number), c = tile(x, y);
      if (c !== '#' && DIRS.some(([dx, dy]) => isOpen(x + dx, y + dy) && !known.has(`${x + dx},${y + dy}`))) goals.push(key);
    }
    let path = bfs(goals, blockedKnown);
    if (!path) {
      // back to the merchant with money to spend, once per floor after clearing
      if (P.backtrackShop && shopTile && shops[FLOOR_SHOPS[floor]] && !shops[FLOOR_SHOPS[floor]].enchanter && shopWorth() && (K.shopVisits[floor] || 0) < 3 && !K.backDone) {
        K.backDone = true;
        path = bfs([shopTile.join(',')], blockedKnown);
        if (path) K.headFor = shopTile.join(',');
      }
      if (!path && FLOOR_SHOPS[floor] === 'X' && shopTile && (K.shopVisits[floor] || 0) < 2 && !K.backDone && coins >= 15 + P.enchReserve) {
        K.backDone = true; path = bfs([shopTile.join(',')], blockedKnown); if (path) K.headFor = shopTile.join(',');
      }
    }
    if (!path && FLOOR_SHOPS[floor] === 'F' && shopTile && !K.campBack) {   // back to the unused campfire
      K.campBack = true; K.headFor = shopTile.join(',');
    }
    if (!path && K.headFor) { path = bfs([K.headFor], blockedKnown); if (!path) K.headFor = null; }   // keep going where it set off for
    if (!path) {
      const boss = enemies.find(e => e.boss && !e.dead);
      if (boss && potions > 0 && k < P.preBossHp) { ST.potExplore++; return drinkPotion(); }
      if (boss && knownEnemy(boss) && !stairs) path = bfs([`${boss.x},${boss.y}`], blockedKnown);   // the exit is behind him: time to fight
      if (stairs) {
        const guard = enemies.find(e => !e.dead && required(e));
        if (guard && potions > 0 && k < 0.6) { ST.potExplore++; return drinkPotion(); }
        path = bfs([stairs.join(',')], blockedKnown, true);
      }
      if (!path) {
        // nothing left that is safe: walk into whatever's known (avoided groups included), or the frontier
        const any = enemies.filter(e => knownEnemy(e) && !e.boss).map(e => `${e.x},${e.y}`);
        path = bfs(any, new Set()) || bfs([...known], new Set(), true);
      }
    }
    if (!path || !path.length) { K.stuckCount = (K.stuckCount || 0) + 1; if (K.stuckCount > 50) throw new Error('bot stuck exploring'); return; }
    stepDir(path[0][0], path[0][1]);
  }
  function shopWorth() {
    if (coins < 10) return false;
    if (potions < maxPotions && shopPotionsLeft > 0) return true;
    if (coins >= 30 && p.hp < p.max * 0.65 && !(window.__rest || {})[floor] && typeof makeStock === 'function' && makeStock(1).some(s => s.type === 'rest')) return true;
    const tier = shops[FLOOR_SHOPS[floor]].tier;
    return Object.keys(slots).some(k => { const [, pow] = slots[k].items[tier]; return !(worn[k] && worn[k].power >= pow) && coins >= pow * 5; });
  }
  // shortest path over known tiles to a goal; known enemies block unless they are the goal (or passThrough)
  function bfs(goals, blocked, passThrough) {
    if (!goals.length) return null;
    const want = new Set(goals);
    const start = `${p.x},${p.y}`;
    const from = new Map([[start, null]]), q = [[p.x, p.y]];
    while (q.length) {
      const [x, y] = q.shift(), key = `${x},${y}`;
      if (want.has(key) && key !== start) {
        const out = [];
        let k = key;
        while (from.get(k)) { const [d, prevKey] = from.get(k); out.unshift(d); k = prevKey; }
        return out;
      }
      if (key !== start && blocked.has(key) && !passThrough) continue;
      // a shop tile is a stop (it opens the menu), fine to walk through
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy, nk = `${nx},${ny}`;
        if (!isOpen(nx, ny) || from.has(nk) || !K.known.has(nk)) continue;
        if (blocked.has(nk) && !want.has(nk) && !passThrough) continue;
        from.set(nk, [[dx, dy], key]);
        q.push([nx, ny]);
      }
    }
    return null;
  }
})();
