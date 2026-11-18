// Crawlspace bot v3: plays full runs through the game's own action functions (the ones the buttons call),
// with fog of war (it only knows tiles it has seen and enemies it has bumped into or spotted with Pathfinder).
// Strategy knobs come in window.__SIM.pol; results go to localStorage, one page load per run. In a fight it plays
// every option out (expertTurn, below); pol.tactics = 'old' brings back the v2 rules of thumb for comparison.
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
  // the bot reads each enemy's intent (f.next, see MOVES in the game) just as a player reads its badge
  const HM = () => typeof heavyMult === 'function' ? heavyMult() : HEAVY_MULT;
  const bigT = t => typeof isBig === 'function' ? isBig(t) : t.max >= GIANT_HP;
  const moveOf = f => (typeof MOVES !== 'undefined' && f.next && MOVES[f.next]) || null;
  const bigMult = f => { const M = moveOf(f); return M && M.big && f.next !== 'crush' ? M.big : 1; };
  const strikes = f => { const M = moveOf(f); return !M || !!M.hit; };   // (a stance, a heal or a cry hurts no one this turn)
  const armorVs = f => f.next === 'crush' ? 0 : (typeof armorNow === 'function' ? armorNow() : defense());
  const cryBonus = f => typeof warcry === 'function' ? warcry(f) : 0;
  function foeHit(f) {
    if (!strikes(f)) return 0;
    const raw = f.dmg[1] + f.bonus + (f.raged ? RAGE_BONUS : 0) + (f.bloodlust && p.hp < p.max / 2 ? f.bloodlust : 0) + cryBonus(f);
    return Math.max(1, raw - armorVs(f)) * bigMult(f);
  }
  const incoming = (mult = 1) => foes.filter(f => f.hp > 0 && !f.stunned && strikes(f))
    .reduce((s, f) => s + Math.max(1, Math.round(foeHit(f) * mult)), 0) + (poison ? poisonDmg() : 0);
  // spike: this turn's move as shown; otherwise its plain attack, averaged
  function foeAvg(f, spike) {
    if (spike && !strikes(f)) return 0;
    const big = spike && moveOf(f) && moveOf(f).big;
    const raw = (f.dmg[0] + f.dmg[1]) / 2 + (f.bonus || 0) + (f.raged ? RAGE_BONUS : 0) + (f.bloodlust && p.hp < p.max / 2 ? f.bloodlust : 0) + cryBonus(f);
    const h = Math.max(1, raw - (big ? armorVs(f) : defense())) * (big ? bigMult(f) : 1);
    return big ? h : h * (1 - FOE_MISS) * (1 + FOE_CRIT * (FOE_CRIT_MULT - 1));
  }
  const shieldKeep = t => t.shield !== undefined ? 1 - FOE_SHIELD_BLOCK[t.shield] * (1 - FOE_SHIELD_KEEP) : 1;
  function myAvg(t, heavy) {
    let d = Math.max(1, 11 + power('weapon') + bonusDmg - (t.def || 0));
    if (heavy) d *= HM();
    if (bigT(t)) d *= 1 + enchSum('giantslayer');
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

  // stances that make an enemy a poor target this turn: a flitting Bat, a braced Skeleton, a guarding Dark Knight
  const poorTarget = f => f.next === 'flit' || f.next === 'brace' || f.next === 'guard';
  function pickTarget(all) {
    const inReach = all.filter(f => typeof reachable !== 'function' || reachable(f));
    if (!inReach.length) return null;
    const good = inReach.filter(f => !poorTarget(f)), live = good.length ? good : inReach;
    const off = live.find(f => f.off);               // Off balance: can't miss
    if (off) return off;
    const thief = live.find(f => f.stolen);
    if (thief) return thief;
    const crier = live.find(f => f.cry);             // the Orc whose war cry drives the group
    if (crier) return crier;
    if (P.target === 'weakest') return live.slice().sort((a, b) => a.hp - b.hp)[0];
    // threat per turn of work: kill whoever removes the most damage per hit spent
    return live.slice().sort((a, b) => (foeAvg(b) / Math.max(1, b.hp / myAvg(b))) - (foeAvg(a) / Math.max(1, a.hp / myAvg(a))))[0];
  }

  // ---------------------------------------------------------------- expert tactics
  // Every option this turn (Normal or Heavy at each enemy in reach, Block, a potion) is played out SAMPLES times with
  // the game's own rules: your swing (miss, crit, the stances, Off balance, Shaken, Ambush, Executioner, Giantslayer,
  // a shield catching it, Swift, Flaming, Vampiric), then each enemy's shown move (big moves, crits, misses, ripostes,
  // Guard, war cry, Thorns, stuns off your shield, Shield Bash, poison, Second Wind). Each sample is scored in HP: what
  // you lose this turn, plus what the rest of the fight should cost from where it leaves things, plus DEATH_COST if it
  // kills you. The option with the lowest average cost is taken
  const SAMPLES = 200, DEATH_COST = 500, SW_COST = 45, MARGIN = 2;
  // the dice for a play-out: every option is played on the same rolls (sample k uses seed k), so options are compared fairly
  let seed = 1; const R = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const rnd = (a, b) => a + Math.floor(R() * (b - a + 1));
  // what one of your swings at t does: {dmg, crit, hit}
  function swingAt(t, heavy, hp) {
    const base = (t.next === 'flit' ? FLIT_EVADE : t.evasion ?? PLAYER_MISS) + (heavy ? HEAVY_MISS : 0);
    const miss = t.off ? 0 : Math.min(0.95, base * missKeep() * (heavy ? 1 - enchSum('balanced') : 1));
    const r = R();
    if (r < miss) return {dmg: 0, crit: false, hit: false};
    const crit = r < miss + critChance();
    let d = Math.max(1, rnd(8, 14) + power('weapon') + bonusDmg + purseDmg() - t.def);
    if (heavy) d = Math.round(d * HM());
    if (perkN('executioner') && hp < t.max * EXEC_THRESHOLD) d = Math.round(d * (1 + execBonus()));
    if (current && current.ambushReady) d = Math.round(d * (1 + ambushBonus()));
    if (bigT(t) && enchSum('giantslayer') > 0) d = Math.round(d * (1 + enchSum('giantslayer')));
    if (crit) d *= PLAYER_CRIT_MULT;
    if (weak) d = Math.max(1, Math.round(d * WAIL_KEEP));
    if (t.next === 'brace') d = Math.max(1, Math.round(d * BRACE_KEEP));
    if (!t.off && t.shield !== undefined && R() < FOE_SHIELD_BLOCK[t.shield]) d = Math.max(1, Math.round(d * FOE_SHIELD_KEEP));
    return {dmg: d, crit, hit: true};
  }
  // one enemy blow at you: mult from your stance; move = what it is doing
  function blowAt(f, mult, move, cry) {
    const M = (move && MOVES[move]) || MOVES.attack, big = !!M.big;
    const r = R();
    const fm = FOE_MISS + (typeof fleetEvade === 'function' ? fleetEvade() : 0);
    if (!big && r < fm) return 0;
    const crit = !big && r < fm + FOE_CRIT;
    let d = Math.max(1, rnd(f.dmg[0], f.dmg[1]) + (f.bonus || 0) + (f.raged ? RAGE_BONUS : 0) + (f.bloodlust && p.hp < p.max / 2 ? f.bloodlust : 0) + cry - (move === 'crush' ? 0 : armorNow()));
    if (crit) d = Math.round(d * FOE_CRIT_MULT);
    if (big && move !== 'crush') d *= M.big;
    return Math.max(1, Math.round(d * mult));
  }
  // what the rest of the fight should cost in HP, from a state: [{f, hp}] of living enemies (killing the worst first)
  function restCost(state) {
    const alive = state.filter(s => s.hp > 0);
    if (!alive.length) return 0;
    const crier = alive.some(s => s.f.cry);
    const per = s => { const f = s.f;
      const cry = crier && !f.cry ? WARCRY_BONUS : 0;
      const raw = (f.dmg[0] + f.dmg[1]) / 2 + (f.bonus || 0) + (f.raged ? RAGE_BONUS : 0) + (f.bloodlust && p.hp < p.max / 2 ? f.bloodlust : 0) + cry;
      return Math.max(1, raw - armorNow()) * (1 - FOE_MISS) * (1 + FOE_CRIT * (FOE_CRIT_MULT - 1)) * (f.boss ? 1.12 : 1); };
    // (Flaming keeps a Troll burning from your next hit on, so it stops regenerating; Thorns cuts every enemy that swings at you;
    //  a Wraith's drain heals it by a share of what it hits you for)
    const thornsEach = enchSum('thorns') * (1 - FOE_MISS);
    const eff = s => { const f = s.f;
      const regen = f.regen && !(f.burn > 0) && !enchSum('flaming') ? f.regen * 0.8 : 0;
      const drain = f.drain ? per(s) * f.drain * purityKeep() : 0;
      return Math.max(2, myAvg(f, false) - regen - drain + thornsEach); };
    const hpOf = s => s.hp + (s.f.reassemble && !s.f.rose ? s.f.max * REASSEMBLE_HP * REASSEMBLE_CHANCE : 0) + (s.f.split ? 14 * 2 * 0.8 : 0);
    const order = alive.slice().sort((a, b) => per(b) / Math.max(1, hpOf(b) / eff(b)) - per(a) / Math.max(1, hpOf(a) / eff(a)));
    let incoming = order.reduce((a, s) => a + per(s), 0), cost = 0;
    for (const s of order) { const rounds = hpOf(s) / eff(s); cost += rounds * incoming; incoming -= per(s); }
    return cost * (1 - enchSum('vampiric') * 0.6);
  }
  // what the enemies still standing should deal next turn, on average
  function nextTurn(state) {
    const alive = state.filter(s => s.hp > 0), crier = alive.some(s => s.f.cry);
    return alive.reduce((a, s) => { const f = s.f, cry = crier && !f.cry ? WARCRY_BONUS : 0;
      return a + Math.max(1, (f.dmg[0] + f.dmg[1]) / 2 + (f.bonus || 0) + (f.raged ? RAGE_BONUS : 0) + (f.bloodlust ? f.bloodlust : 0) + cry - armorNow()) * (1 - FOE_MISS); }, 0);
  }
  // play one option out once; returns its cost in HP
  function playOut(opt, live) {
    const st = new Map(live.map(f => [f, {f, hp: f.hp, stunned: f.stunned}]));
    let hp = p.hp, cost = 0;
    const exposure = opt.kind === 'heavy' ? HEAVY_EXPOSED : 1, blocking = opt.kind === 'block';
    const reach = live.filter(f => reachable(f));
    const hitFoe = (f, d, crit) => {
      const s = st.get(f); s.hp -= d;
      if (s.hp <= 0 && f.reassemble && !f.rose && !crit && R() < REASSEMBLE_CHANCE) s.hp = Math.round(f.max * REASSEMBLE_HP);
      if (s.hp <= 0 && f.split) for (let k = 0; k < 2; k++) st.set({...LITTLE_SLIME, max: LITTLE_SLIME.hp, def: 0, bonus: 0}, {f: {...LITTLE_SLIME, max: LITTLE_SLIME.hp, def: 0, bonus: 0}, hp: LITTLE_SLIME.hp, fresh: true});
    };
    let dealt = 0;
    if (opt.kind === 'normal' || opt.kind === 'heavy') {
      const t = opt.t, sw = swingAt(t, opt.kind === 'heavy', t.hp);
      if (sw.hit) { hitFoe(t, sw.dmg, sw.crit); dealt += sw.dmg;
        if (enchSum('flaming') && st.get(t).hp > 0) st.get(t).burnNow = enchSum('flaming');
        if (R() < enchSum('swift')) { const n2 = st.get(t).hp > 0 ? t : reach.find(f => f !== t && st.get(f).hp > 0);
          if (n2) { const s2 = swingAt(n2, opt.kind === 'heavy', st.get(n2).hp); if (s2.hit) { hitFoe(n2, s2.dmg, s2.crit); dealt += s2.dmg;
            if (enchSum('flaming') && st.get(n2).hp > 0) st.get(n2).burnNow = enchSum('flaming'); } } } }
      if (st.get(t).hp > 0 && !t.off && !t.stunned && ((!sw.hit && t.riposte) || t.next === 'guard')) { const d = blowAt(t, exposure, 'attack', 0); hp -= d; cost += d; }
    } else if (blocking) {
      if (perkN('shieldbash') && reach.length) { const t = target && reachable(target) ? target : reach[0]; hitFoe(t, bashDmg(), false); }
    } else if (opt.kind === 'potion') {
      hp = Math.min(p.max, hp + potionHeal()); cost -= Math.min(potionHeal(), p.max - p.hp) - potionHeal();   // (only overheal is lost)
    }
    hp += Math.min(Math.round(dealt * enchSum('vampiric')), p.max - hp); cost -= Math.round(dealt * enchSum('vampiric'));
    // the enemies' turn, in order
    const crierAlive = () => [...st.values()].some(s => s.f.cry && s.hp > 0);
    let stunsSaved = 0;
    for (const f of live) {
      const s = st.get(f); if (s.hp <= 0) continue;
      if (f.burn > 0 || s.burnNow) { s.hp -= f.burnDmg || s.burnNow; if (s.hp <= 0) continue; }
      if (f.stunned) continue;
      const move = f.next || 'attack', M = MOVES[move] || MOVES.attack;
      if (move === 'lick' && !(f.burn > 0)) s.hp = Math.min(f.max, s.hp + f.regen * LICK_REGENS);
      if (move === 'feast') s.hp = Math.min(f.max, s.hp + FEAST_HEAL);
      if (move === 'roar') st.set({k: 'servant'}, {f: types.find(t => t.name === 'Goblin'), hp: 40, fresh: true});
      if (!M.hit) continue;
      const cry = crierAlive() && !f.cry ? WARCRY_BONUS : 0;
      const guardBig = blocking && M.big && typeof BIG_BLOCK === 'number' ? BIG_BLOCK : 1;   // (a big blow may break through a raised guard)
      const d = blowAt(f, blocking ? 1 - (1 - blockMult()) * guardBig : exposure, move, cry);
      if (d > 0) {
        hp -= d; cost += d;
        if (f.drain) s.hp = Math.min(f.max, s.hp + Math.round(d * f.drain * purityKeep()));
        if (f.poison && R() < POISON_CHANCE) cost += Math.max(1, poisonTurns() - enchSum('purity')) * poisonDmg() * 0.8;
        if (blocking && !f.stunProof && R() < stunChance()) stunsSaved += restCost([s]) > 0 ? (f.dmg[0] + f.dmg[1]) / 2 : 0;
        if (!blocking && enchSum('thorns')) s.hp -= enchSum('thorns');
        if (move === 'snatch' && !blocking && !f.stolen && coins > 0 && !perkN('purse')) cost += 4;   // (coins you may not get back)
        if (move === 'sunder' || move === 'acid') cost += 3;
      }
      if (hp <= 0) break;
    }
    // poison ticks after their turn, and keeps ticking (every turn and step) until it wears off; a potion cures it
    if (poison && opt.kind !== 'potion') { hp -= poisonDmg(); cost += poisonDmg() * poison; }
    if (hp <= 0) { if (secondWinds > 0) { cost += SW_COST; hp = Math.max(1, Math.round(p.max * SECOND_WIND_SHARE)); } else return cost + DEATH_COST; }
    const rest = restCost([...st.values()]) - stunsSaved, avail = healAvail() - (opt.kind === 'potion' ? potionHeal() : 0);
    // ending the turn low against what is still standing: their next blows could finish you before a potion helps
    const next = nextTurn([...st.values()]);
    if (potions - (opt.kind === 'potion' ? 1 : 0) > 0 && hp < next * 1.5) cost += (next * 1.5 - hp) * 2.5;   // (only worth it with a potion to drink)
    cost += rest + (rest > hp + avail ? (rest - hp - avail) * 2 : 0);    // a fight you can't finish costs more
    return cost;
  }
  function expertTurn() {
    const live = foes.filter(f => f.hp > 0), reach = live.filter(f => reachable(f));
    const opts = [{kind: 'block'}];
    for (const t of reach) { opts.push({kind: 'normal', t}); opts.push({kind: 'heavy', t}); }
    if (potions > 0 && p.hp < p.max) opts.push({kind: 'potion'});
    const base = (Math.random() * 1e9) | 0;
    const costOf = o => { let c = 0; for (let k = 0; k < SAMPLES; k++) { seed = base + k * 7919; c += playOut(o, live); } return c / SAMPLES; };
    // the plain hit at the best target is the default; anything else has to beat it by a clear margin (MARGIN HP)
    let best = null, bestCost = Infinity;
    for (const o of opts.filter(o => o.kind === 'normal')) { const c = costOf(o); if (c < bestCost) { bestCost = c; best = o; } }
    if (!best) { best = opts[0]; bestCost = costOf(best); }
    const plain = bestCost;
    for (const o of opts.filter(o => o.kind !== 'normal' && o !== best)) {
      const c = costOf(o) + (o.kind === 'potion' ? 2 : 0);                 // (a small bias toward keeping potions for later)
      if (c < bestCost && c < plain - MARGIN) { bestCost = c; best = o; }
    }
    if (best.kind === 'potion') { ST.potFight++; return drinkPotion(); }
    ST.turns++; ST[best.kind]++;
    if (best.t) target = best.t;
    act(best.kind);
  }

  function fightTurn() {
    if (P.tactics !== 'old') return expertTurn();
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
    const bigComing = live.some(f => !f.stunned && moveOf(f) && moveOf(f).big);
    if (!target || (target.next === 'guard' && !finishing)) kind = 'block';        // nothing worth swinging at
    else if (target.off) kind = 'heavy';                                             // Off balance: a Heavy can't miss (or be riposted)
    else if (bigComing && P.block !== 'never' && !finishing) kind = 'block';             // (a Snatch risks only 3-6 coins: Block weighs it like any hit)
    else if (P.block === 'main' && power('shield') && !finishing) kind = 'block';
    else if (P.block === 'ev' && blockPays(live)) kind = 'block';
    else if (P.heavy === 'always' && !target.riposte) kind = 'heavy';
    else if (P.heavy === 'ev') {
      const base = target.evasion ?? PLAYER_MISS;
      const normalEV = 1 - base * missKeep();
      const heavyEV = (1 - (base + HEAVY_MISS) * missKeep() * (1 - enchSum('balanced'))) * HM();
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
    const k = p.hp / p.max, pick = P.camp || (k < P.campRestEnd ? 'rest' : 'train');   // one visit only: leaving puts it out
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
