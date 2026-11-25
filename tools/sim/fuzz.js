// Crawlspace fuzzer: plays runs by tapping at random, the way a careless player would, with the game drawing normally,
// and checks the game's rules after every tap. It looks for crashes, broken numbers, soft locks, saves that don't
// come back the same, and taps that give more than they should. One run per page load, like bot.js; results go to
// localStorage under crawlSim:<id>. Options in window.__FUZZ.pol: steps (taps per run), deep (share of runs that start
// on a later floor with random gear, so the deep floors and the King get tapped too), mash (share of taps made without
// waiting for the turn to play out)
(() => {
  if (location.protocol !== 'file:' || window.__fuzzBot) return;
  window.__fuzzBot = true;
  const cfg = window.__FUZZ;
  if (!cfg) return;
  const KEY = 'crawlSim:' + cfg.id, O = Object.assign({steps: 2500, deep: 0.6, mash: 0.15, roundtrip: 0.04}, cfg.pol || {});
  const errs = [];
  // the game's clock runs SPEED times faster, so fights play out quickly (the game times its turns with performance.now)
  const SPEED = O.speed || 6, realNow = performance.now.bind(performance), base = realNow();
  performance.now = () => base + (realNow() - base) * SPEED;
  addEventListener('error', e => errs.push(String(e.message) + ' @' + e.lineno + ':' + e.colno));
  addEventListener('unhandledrejection', e => errs.push('promise: ' + String(e.reason && (e.reason.stack || e.reason))));
  addEventListener('load', () => setTimeout(runOne, 400));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const pick = a => a[Math.floor(Math.random() * a.length)];

  async function runOne() {
    const results = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (results.length >= cfg.n) { document.title = 'SIM DONE'; return; }
    if (!results.length) for (const k of Object.keys(localStorage)) if (k.startsWith('crawlSim:') && k !== KEY) localStorage.removeItem(k);
    let res;
    let hung = null;
    try { res = await Promise.race([fuzz(), new Promise(r => setTimeout(() => r(hung = {hung: true, where: document.title, phase, floor: floor + 1, title: !title.hidden, overlay: overlay && overlay.kind}), O.watchdog || 240000))]); }
    catch (e) { res = {error: String((e && e.stack) || e).slice(0, 600)}; }
    results.push(res);
    try { localStorage.setItem(KEY, JSON.stringify(results)); } catch (e) { document.title = 'SIM DONE'; return; }
    if (results.length < cfg.n) { document.title = `SIM ${results.length}/${cfg.n}`; location.reload(); }
    else document.title = 'SIM DONE';
  }

  // a tap where a player's finger would land, through the same path as the canvas's pointerdown
  const tapAt = pt => { handleTap(pt); draw(); saveRun(); };
  const tapItem = it => tapAt({x: it.x + it.w / 2, y: it.y + it.h / 2});
  const playPt = (ax, ay) => ({x: view.play.x + ax * view.play.s, y: view.play.y + ay * view.play.s});
  const SKIP = new Set(['set:journal', 'set:title']);                      // (a file to save; a page reload, which Continue at the start covers)
  const PASSABLE = ch => ch && ch !== '#';

  // a later floor, with gear a player could have by then (the deep floors and the King get tapped too)
  function deepStart() {
    const k = 1 + Math.floor(Math.random() * 4);
    loadFloor(k);
    for (const s of Object.keys(slots)) {
      if (Math.random() > 0.85) continue;
      const tier = Math.min(2, Math.max(0, k - 1 - (Math.random() < 0.4 ? 1 : 0))), g = gearOf(s, tier, rollWeight(s));
      worn[s] = {name: g.name, power: g.power, tier: g.tier, ...(g.wt ? {wt: g.wt} : {})};
      const ids = Object.keys(ENCHANTS).filter(id => ENCHANTS[id].slot === (s === 'weapon' ? 'weapon' : 'armor'));
      if (ids.length && Math.random() < 0.3) worn[s].ench = {id: pick(ids), t: Math.floor(Math.random() * (tier + 1))};
    }
    p.base = p.max = 100 + 25 * k; p.hp = p.max;
    potions = maxPotions; coins = Math.floor(Math.random() * 250);
    draw();
    return k + 1;
  }

  async function fuzz() {
    const t0 = performance.now(), viol = {}, hist = [], econ = {};
    let lastHash = '', same = 0, checks = 0, lastId = null;
    const V = (kind, msg) => {
      const v = viol[kind] || (viol[kind] = {n: 0});
      v.n++;
      if (!v.first) v.first = {msg: String(msg).slice(0, 400), phase, floor: floor + 1, overlay: overlay && overlay.kind, title: !title.hidden, last: hist.slice(-10)};
    };
    errs.length = 0;
    // start: a fresh run, or (now and then) the run the last page left saved, through Continue
    const chain = +(sessionStorage.getItem('fz:chain') || 0);
    let how = 'new', deep = 0;
    if (savedRun && chain < 3 && Math.random() < 0.5) { sessionStorage.setItem('fz:chain', chain + 1); how = 'continue'; contBtn.click(); }
    else {                                                                   // a new run, as a class picked at random (or pol.cls)
      sessionStorage.setItem('fz:chain', 0);
      if (typeof beginRun === 'function') beginRun(O.cls || pick(typeof CLASS_IDS !== 'undefined' ? CLASS_IDS : ['knight']));
      else { playBtn.click(); if (!title.hidden) playBtn.click(); }
    }
    await sleep(300);
    if (!title.hidden) V('start', 'still on the title after Play/Continue');
    if (how === 'new' && Math.random() < O.deep) deep = deepStart();
    const strip = s => JSON.stringify(s, (k, v) => (k === 'rasters' || k === '_art' || k === 'elapsed' || k === 'bornAt' || k === 'fellAt') ? undefined : v);

    let step = 0;
    for (; step < O.steps; step++) {
      if (over && !turnBusy()) { if (runSummary) break; }
      // back at the title mid-run (Settings > Return to the title): continue it
      if (!title.hidden) { if (savedRun && !over) { hist.push('continue'); contBtn.click(); await sleep(150); continue; } break; }
      const items = screenItems().filter(i => i.act && i.enabled !== false && i.x !== undefined && !SKIP.has(i.id));
      const c0 = coins, pot0 = potions, r = Math.random();
      let label;
      try {
        if (items.length && (r < 0.5 || (phase !== 'explore' && phase !== 'fight' && phase !== 'choice'))) {
          // (half the time the button just pressed again: many ask for a second tap to confirm)
          const again = lastId && Math.random() < 0.5 && items.find(i => i.id === lastId), it = again || pick(items);
          lastId = it.id; label = 'tap:' + it.id; tapItem(it);
          if (Math.random() < 0.06) { label += '+double'; tapItem(it); }   // a double tap: does anything happen twice that shouldn't?
        } else if (phase === 'explore' && r < 0.9) {
          // a step: toward a tile not walked yet when there is one, otherwise anywhere it can go
          const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => map[p.y + dy] && PASSABLE(map[p.y + dy][p.x + dx]));
          const fresh = dirs.filter(([dx, dy]) => !visited.has(`${p.x + dx},${p.y + dy}`));
          const [dx, dy] = fresh.length && Math.random() < 0.7 ? pick(fresh) : dirs.length ? pick(dirs) : [1, 0];
          label = `step:${dx},${dy}`; tapAt(playPt(CANVAS_W / 2 + dx * 100, PLAY_H / 2 + dy * 100));
        } else {
          label = 'tap:anywhere'; tapAt({x: Math.random() * CANVAS_W, y: view.top + Math.random() * view.h});
        }
      } catch (e) { V('throw', label + ': ' + ((e && e.stack) || e)); }
      hist.push(label);
      if (step % 25 === 0) document.title = `FZ ${step} ${phase} f${floor + 1}`;
      if (hist.length > 40) hist.shift();
      // what a tap gave: coins and potions from taps that aren't fights, loot or sales are worth a look
      if (coins > c0) { const k = label.replace(/\+double/, '') + '@' + phase; econ[k] = Math.max(econ[k] || 0, coins - c0); }
      if (label.endsWith('+double') && (coins > c0 + 60 || potions > pot0 + 1)) V('double tap gain', `${label}: coins ${c0}->${coins}, potions ${pot0}->${potions}`);
      // let the turn play out (now and then not: a player mashing buttons)
      if (Math.random() > O.mash) { for (let w = 0; w < 60 && turnBusy(); w++) await sleep(25); }
      await sleep(Math.random() < 0.5 ? 0 : 8);
      // the rules
      checks++;
      try { draw(); } catch (e) { V('draw', (e && e.stack) || e); }
      const num = (k, v) => { if (typeof v !== 'number' || !Number.isFinite(v)) V('not a number', k + ' = ' + v); };
      num('hp', p.hp); num('max hp', p.max); num('coins', coins); num('potions', potions); num('xp', xp); num('level', level); num('floor', floor);
      if (!over && !turnBusy()) {
        if (p.hp > p.max) V('hp above max', `${p.hp}/${p.max}`);
        if (p.hp <= 0 && phase !== 'finale') V('alive at 0 hp', `${p.hp}/${p.max} phase ${phase}`);
      }
      if (coins < 0) V('coins below 0', coins);
      if (potions < 0 || potions > maxPotions) V('potions out of range', `${potions}/${maxPotions}`);
      if (phase === 'explore' && !(map[p.y] && PASSABLE(map[p.y][p.x]))) V('standing in a wall', `${p.x},${p.y} '${map[p.y] && map[p.y][p.x]}'`);
      for (const f of foes || []) { num(f.name + ' hp', f.hp); if (f.hp > f.max) V('enemy hp above max', `${f.name} ${f.hp}/${f.max}`); }
      for (const k of Object.keys(worn)) if (worn[k] && !(worn[k].tier >= 0 && worn[k].tier <= 2 && Number.isFinite(worn[k].power))) V('bad gear', k + ' ' + JSON.stringify(worn[k]));
      if ((phase === 'fight' || phase === 'choice') && !(foes || []).some(f => f.hp > 0) && !turnBusy() && !over) V('fight with no enemy standing', phase);
      while (errs.length) V('uncaught error', errs.shift());
      // the save: what is saved must come back exactly (as when the game is closed and opened again)
      if (title.hidden && !over && !turnBusy() && Math.random() < O.roundtrip) {
        try {
          const a = strip(runSnapshot()); restoreRun(JSON.parse(a)); const b = strip(runSnapshot());
          if (a !== b) { let i = 0; while (i < a.length && a[i] === b[i]) i++; V('save does not come back the same', `at ${i}: ${a.slice(Math.max(0, i - 120), i + 80)} || ${b.slice(Math.max(0, i - 120), i + 80)}`); }
          draw();
        } catch (e) { V('save round trip throws', (e && e.stack) || e); }
      }
      // stuck: nothing changes however it taps
      const h = JSON.stringify([phase, overlay && overlay.kind, p.x, p.y, p.hp, coins, potions, floor, (foes || []).map(f => f.hp), level, xp, title.hidden]);
      if (h === lastHash) { if (++same > 400) { V('stuck', `phase ${phase}, buttons: ${items.map(i => i.id).join(' ')}`); break; } } else { same = 0; lastHash = h; }
    }
    const top = Object.entries(econ).sort((a, b) => b[1] - a[1]).slice(0, 6);
    return {how, cls: typeof cls === 'string' ? cls : 'knight', deep, steps: step, checks, floor: floor + 1, over: !!over, won: !!(runSummary && runSummary.won), phase,
            ms: Math.round(performance.now() - t0), viol, econ: Object.fromEntries(top)};
  }
})();
