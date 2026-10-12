'use strict';
// Weapon definitions, 3D models and synthesized audio
(function () {
  // rank = how good bots consider a gun (they keep looting until rank >= 3)
  BR.WEAPONS = {
    fists:  { name: 'Fists', rank: 0, melee: true, dmg: 20, range: 2.2, rate: 2.2 },
    pistol: { name: 'Glock-14', tier: 'A', rank: 1, dmg: 24, rate: 5, auto: false, mag: 12, reserve: 60, reload: 1.3, spread: 0.014, adsSpread: 0.003,
              range: 220, fov: 60, recoil: 0.022, headMult: 2, falloff: 40, falloffMult: 0.7,
              hip: [0.2, -0.19, -0.42], ads: [0, -0.085, -0.34] },
    nova:   { name: 'NOVA', tier: 'B', rank: 2, pellets: 8, dmg: 12, rate: 1.15, auto: false, mag: 8, reserve: 40, reload: 2.8, spread: 0.075, adsSpread: 0.055,
              range: 70, fov: 62, recoil: 0.06, headMult: 1.3, falloff: 14, falloffMult: 0.45,
              hip: [0.21, -0.21, -0.44], ads: [0, -0.103, -0.3] },
    smg:    { name: 'MP5-SD', tier: 'B', rank: 3, quiet: true, dmg: 15, rate: 13, auto: true, mag: 30, reserve: 150, reload: 1.8, spread: 0.032, adsSpread: 0.011,
              range: 260, fov: 56, recoil: 0.011, headMult: 1.6, falloff: 45, falloffMult: 0.7,
              hip: [0.2, -0.2, -0.42], ads: [0, -0.098, -0.3] },
    ump45:  { name: 'UMP-45', tier: 'B', rank: 4, dmg: 21, rate: 10.5, auto: true, mag: 25, reserve: 125, reload: 2.0, spread: 0.03, adsSpread: 0.009,
              range: 300, fov: 55, recoil: 0.014, headMult: 1.6, falloff: 55, falloffMult: 0.75,
              hip: [0.2, -0.2, -0.42], ads: [0, -0.112, -0.3] },
    ak47:   { name: 'AK-47', tier: 'B', rank: 5, dmg: 29, rate: 9.5, auto: true, mag: 30, reserve: 150, reload: 2.3, spread: 0.032, adsSpread: 0.005,
              range: 500, fov: 50, recoil: 0.02, headMult: 1.8,
              hip: [0.21, -0.21, -0.44], ads: [0, -0.112, -0.3] },
    m249:   { name: 'M249', tier: 'C', rank: 6, dmg: 25, rate: 12, auto: true, mag: 100, reserve: 200, reload: 5.2, spread: 0.045, adsSpread: 0.008,
              range: 500, fov: 50, recoil: 0.017, headMult: 1.6, speedMult: 0.8,
              hip: [0.22, -0.22, -0.46], ads: [0, -0.175, -0.34] },
    sniper: { name: 'AWP', tier: 'C', rank: 6, dmg: 115, rate: 0.85, auto: false, mag: 5, reserve: 30, reload: 3.0, spread: 0.09, adsSpread: 0,
              range: 1200, fov: 13, recoil: 0.07, headMult: 2.5, scope: true,
              hip: [0.21, -0.21, -0.44], ads: [0, -0.15, -0.25] },
  };
  // spawn categories: A = most common, B = medium, C = most rare
  BR.TIERS = {
    A: { chance: 0.55, color: '#4caf50' },
    B: { chance: 0.33, color: '#2f8cff' },
    C: { chance: 0.12, color: '#ffb300' },
  };
  for (const t in BR.WEAPONS) { const d = BR.WEAPONS[t]; if (d.tier) d.color = BR.TIERS[d.tier].color; }
  BR.GUN_TYPES = Object.keys(BR.WEAPONS).filter(t => BR.WEAPONS[t].tier);
  // not a weapon you can hold; used for kill feed names
  BR.KILL_NAMES = { car: 'Car', zone: 'ZONE' };
  BR.randomWeaponType = function () {
    let r = Math.random(), tier = 'C';
    for (const k of ['A', 'B', 'C']) { if ((r -= BR.TIERS[k].chance) < 0) { tier = k; break; } }
    const list = BR.GUN_TYPES.filter(t => BR.WEAPONS[t].tier === tier);
    return list[Math.floor(Math.random() * list.length)];
  };
  BR.makeItem = function (type) {
    const d = BR.WEAPONS[type];
    return { type, mag: d.mag || 0, reserve: d.reserve || 0 };
  };

  // ------------------------------------------------------------ models (meters, barrel along -z)
  const geoCache = {}, matCache = {};
  const M = c => matCache[c] || (matCache[c] = new THREE.MeshLambertMaterial({ color: c }));
  const boxG = (w, h, d) => { const k = w + ',' + h + ',' + d; return geoCache[k] || (geoCache[k] = new THREE.BoxGeometry(w, h, d)); };
  function bx(g, w, h, d, c, x, y, z, rx) {
    const m = new THREE.Mesh(boxG(w, h, d), M(c));
    m.position.set(x, y, z); if (rx) m.rotation.x = rx;
    g.add(m); return m;
  }
  const cylCache = {};
  function cyl(g, r, len, c, x, y, z) { // cylinder lying along z
    const k = r + ',' + len;
    let geo = cylCache[k];
    if (!geo) { geo = cylCache[k] = new THREE.CylinderGeometry(r, r, len, 10); geo.rotateX(Math.PI / 2); }
    const m = new THREE.Mesh(geo, M(c)); m.position.set(x, y, z); g.add(m); return m;
  }
  const SKIN = 0xd9a77a, SLEEVE = 0x2f62d6;
  BR.makeWeaponModel = function (type, withArms) {
    const g = new THREE.Group();
    let muzzle = new THREE.Vector3(0, 0.03, -0.4);
    if (type === 'pistol') {
      bx(g, 0.034, 0.04, 0.19, 0x2a2a2a, 0, 0.035, -0.06);
      bx(g, 0.03, 0.025, 0.15, 0x1a1a1a, 0, 0.005, -0.05);
      bx(g, 0.03, 0.1, 0.045, 0x1a1a1a, 0, -0.045, 0.012, 0.25);
      bx(g, 0.008, 0.012, 0.01, 0x111111, 0, 0.061, -0.14);
      muzzle.set(0, 0.035, -0.16);
    } else if (type === 'smg') { // MP5-SD: integrated suppressor, curved mag
      bx(g, 0.05, 0.07, 0.3, 0x303030, 0, 0.02, -0.08);
      cyl(g, 0.026, 0.24, 0x1c1c1c, 0, 0.03, -0.34);
      bx(g, 0.03, 0.15, 0.045, 0x222222, 0, -0.08, -0.1, -0.2);
      bx(g, 0.034, 0.09, 0.045, 0x222222, 0, -0.045, 0.05, 0.25);
      bx(g, 0.02, 0.03, 0.17, 0x222222, 0, 0.01, 0.15);
      bx(g, 0.035, 0.07, 0.02, 0x222222, 0, -0.01, 0.235);
      bx(g, 0.014, 0.022, 0.03, 0x111111, 0, 0.065, -0.0);
      bx(g, 0.01, 0.025, 0.01, 0x111111, 0, 0.065, -0.2);
      muzzle.set(0, 0.03, -0.47);
    } else if (type === 'ump45') { // boxy receiver, straight mag, vertical foregrip, folding skeleton stock
      bx(g, 0.055, 0.085, 0.36, 0x2a2b2d, 0, 0.025, -0.1);
      bx(g, 0.03, 0.012, 0.3, 0x151515, 0, 0.074, -0.1);              // top rail
      bx(g, 0.05, 0.055, 0.14, 0x2a2b2d, 0, 0.015, -0.34);            // handguard
      cyl(g, 0.012, 0.06, 0x111111, 0, 0.03, -0.43);
      bx(g, 0.032, 0.21, 0.05, 0x222222, 0, -0.12, -0.13, 0.12);      // straight magazine
      bx(g, 0.026, 0.09, 0.03, 0x111111, 0, -0.06, -0.34);            // vertical foregrip
      bx(g, 0.034, 0.09, 0.045, 0x1c1c1c, 0, -0.05, 0.04, 0.3);       // pistol grip
      bx(g, 0.02, 0.02, 0.24, 0x1c1c1c, 0, 0.045, 0.19);              // stock top bar
      bx(g, 0.02, 0.02, 0.2, 0x1c1c1c, 0, -0.03, 0.18, -0.15);        // stock lower bar
      bx(g, 0.035, 0.11, 0.025, 0x1c1c1c, 0, 0.0, 0.31);             // butt plate
      bx(g, 0.012, 0.03, 0.012, 0x111111, 0, 0.09, -0.24);
      muzzle.set(0, 0.03, -0.47);
    } else if (type === 'm249') { // light machine gun: carry handle, bipod, box magazine
      bx(g, 0.07, 0.1, 0.42, 0x262626, 0, 0.03, -0.08);
      bx(g, 0.072, 0.025, 0.2, 0x1e1e1e, 0, 0.09, -0.02);             // feed cover
      bx(g, 0.012, 0.012, 0.16, 0x111111, 0, 0.16, -0.14);            // carry handle
      bx(g, 0.012, 0.06, 0.012, 0x111111, 0, 0.13, -0.07);
      bx(g, 0.012, 0.06, 0.012, 0x111111, 0, 0.13, -0.21);
      bx(g, 0.06, 0.06, 0.22, 0x1e1e1e, 0, 0.02, -0.4);               // handguard
      cyl(g, 0.014, 0.42, 0x111111, 0, 0.035, -0.68);                 // barrel
      cyl(g, 0.02, 0.05, 0x111111, 0, 0.035, -0.9);                   // flash hider
      bx(g, 0.012, 0.22, 0.012, 0x111111, 0.03, -0.07, -0.62, -0.5);  // bipod legs
      bx(g, 0.012, 0.22, 0.012, 0x111111, -0.03, -0.07, -0.62, -0.5);
      bx(g, 0.08, 0.13, 0.1, 0x4b4a36, -0.02, -0.08, -0.12);          // ammo box
      bx(g, 0.034, 0.09, 0.045, 0x1c1c1c, 0, -0.06, 0.06, 0.3);
      bx(g, 0.015, 0.015, 0.24, 0x1c1c1c, 0.02, 0.05, 0.25);           // stock tubes
      bx(g, 0.015, 0.015, 0.24, 0x1c1c1c, -0.02, -0.01, 0.25);
      bx(g, 0.05, 0.11, 0.03, 0x1c1c1c, 0, 0.02, 0.37);
      bx(g, 0.01, 0.03, 0.01, 0x111111, 0, 0.065, -0.5);
      muzzle.set(0, 0.035, -0.93);
    } else if (type === 'nova') { // pump shotgun: barrel over mag tube, pump forend, full polymer stock
      bx(g, 0.05, 0.075, 0.22, 0x1b1b1d, 0, 0.015, -0.06);
      cyl(g, 0.014, 0.56, 0x111111, 0, 0.042, -0.45);                 // barrel
      cyl(g, 0.016, 0.4, 0x1b1b1d, 0, 0.005, -0.37);                  // magazine tube
      bx(g, 0.05, 0.05, 0.17, 0x232325, 0, 0.012, -0.36);             // pump
      bx(g, 0.006, 0.012, 0.006, 0xdd2222, 0, 0.062, -0.72);          // front bead
      bx(g, 0.035, 0.1, 0.05, 0x1b1b1d, 0, -0.06, 0.08, 0.45);        // grip
      bx(g, 0.045, 0.1, 0.3, 0x1b1b1d, 0, -0.03, 0.24, -0.12);         // stock
      bx(g, 0.048, 0.13, 0.03, 0x111111, 0, -0.05, 0.39);
      muzzle.set(0, 0.042, -0.74);
    } else if (type === 'ak47') {
      bx(g, 0.05, 0.07, 0.42, 0x2b2b2b, 0, 0.02, -0.12);
      bx(g, 0.056, 0.056, 0.2, 0x8b5a2b, 0, 0.015, -0.42);
      bx(g, 0.02, 0.02, 0.26, 0x111111, 0, 0.04, -0.56);
      bx(g, 0.01, 0.04, 0.01, 0x111111, 0, 0.07, -0.64);
      bx(g, 0.035, 0.2, 0.07, 0x6b3b1b, 0, -0.1, -0.17, -0.3);
      bx(g, 0.034, 0.09, 0.045, 0x3a2a1a, 0, -0.05, 0.03, 0.3);
      bx(g, 0.045, 0.08, 0.28, 0x8b5a2b, 0, -0.01, 0.22);
      bx(g, 0.022, 0.016, 0.03, 0x111111, 0, 0.062, -0.06);
      muzzle.set(0, 0.04, -0.7);
    } else if (type === 'sniper') {
      bx(g, 0.055, 0.07, 0.55, 0x3b4a2f, 0, 0.02, -0.15);
      bx(g, 0.022, 0.022, 0.52, 0x111111, 0, 0.035, -0.68);
      const sc = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.03, 0.32, 10), M(0x111111));
      sc.rotation.x = Math.PI / 2; sc.position.set(0, 0.095, -0.12); g.add(sc);
      bx(g, 0.02, 0.03, 0.02, 0x222222, 0, 0.065, -0.2);
      bx(g, 0.02, 0.03, 0.02, 0x222222, 0, 0.065, -0.04);
      bx(g, 0.05, 0.1, 0.3, 0x3b4a2f, 0, -0.01, 0.25);
      bx(g, 0.034, 0.09, 0.045, 0x2a2a2a, 0, -0.05, 0.04, 0.3);
      bx(g, 0.07, 0.012, 0.012, 0x777777, 0.04, 0.03, 0.02);
      bx(g, 0.03, 0.06, 0.06, 0x222222, 0, -0.04, -0.1);
      muzzle.set(0, 0.035, -0.95);
    }
    if (withArms) {
      bx(g, 0.075, 0.075, 0.42, SLEEVE, 0.03, -0.09, 0.25);
      bx(g, 0.06, 0.06, 0.07, SKIN, 0.0, -0.04, 0.04);
      if (type !== 'pistol') {
        // left hand on the handguard / foregrip / pump
        const fz = { smg: -0.24, ump45: -0.33, m249: -0.42, nova: -0.36 }[type] || -0.38;
        const fy = type === 'ump45' ? -0.1 : -0.03;
        bx(g, 0.06, 0.05, 0.08, SKIN, -0.0, fy, fz);
        bx(g, 0.075, 0.075, 0.45, SLEEVE, -0.13, fy - 0.08, fz + 0.2).rotation.y = -0.45;
      } else {
        bx(g, 0.06, 0.06, 0.07, SKIN, -0.02, -0.05, 0.03);
        bx(g, 0.075, 0.075, 0.42, SLEEVE, -0.1, -0.1, 0.23).rotation.y = -0.3;
      }
    }
    g.userData.muzzle = muzzle;
    return g;
  };
  BR.makeFistsModel = function () {
    const g = new THREE.Group();
    const mk = (side) => {
      const f = new THREE.Group();
      bx(f, 0.07, 0.07, 0.08, SKIN, 0, 0, 0);
      bx(f, 0.075, 0.075, 0.4, SLEEVE, 0, -0.01, 0.24);
      f.position.set(0.2 * side, -0.27, -0.5);
      f.rotation.y = 0.12 * side;
      g.add(f); return f;
    };
    g.userData.right = mk(1); g.userData.left = mk(-1);
    g.userData.muzzle = new THREE.Vector3();
    return g;
  };

  // ------------------------------------------------------------ audio
  BR.Audio = (function () {
    let ctx = null, master = null, noise = null;
    const A = {};
    A.init = function () {
      if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        master = ctx.createGain(); master.gain.value = 0.45; master.connect(ctx.destination);
        noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      } catch (e) { ctx = null; }
    };
    const P = {
      pistol: { f: 2400, d: 0.16, v: 0.7, th: 130 }, smg: { f: 900, d: 0.08, v: 0.3, th: 60 },
      ump45: { f: 2100, d: 0.14, v: 0.7, th: 85 }, ak47: { f: 1700, d: 0.24, v: 0.9, th: 75 },
      m249: { f: 1500, d: 0.22, v: 0.95, th: 70 }, sniper: { f: 1200, d: 0.65, v: 1.1, th: 55 },
      nova: { f: 1000, d: 0.45, v: 1.15, th: 45 },
    };
    let active = 0;
    A.shot = function (type, dist) {
      if (!ctx || !P[type]) return;
      const p = P[type], vol = p.v / (1 + dist / 22);
      if (vol < 0.015 || active > 24) return;
      const t = ctx.currentTime, far = dist > 90;
      const src = ctx.createBufferSource(); src.buffer = noise;
      const f = ctx.createBiquadFilter(); f.type = 'lowpass';
      f.frequency.setValueAtTime(p.f * (far ? 0.45 : 1), t); f.frequency.exponentialRampToValueAtTime(180, t + p.d);
      const g = ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + p.d * (far ? 1.6 : 1));
      src.connect(f); f.connect(g); g.connect(master);
      src.start(t, Math.random() * 0.4); src.stop(t + p.d * 1.7);
      active++; src.onended = () => active--;
      const o = ctx.createOscillator(), og = ctx.createGain();
      o.frequency.setValueAtTime(p.th, t); o.frequency.exponentialRampToValueAtTime(30, t + 0.15);
      og.gain.setValueAtTime(vol * 0.9, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      o.connect(og); og.connect(master); o.start(t); o.stop(t + 0.18);
    };
    A.tone = function (freq, dur, vol, type) {
      if (!ctx) return;
      const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type || 'square'; o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.02);
    };
    A.whoosh = function (vol) {
      if (!ctx) return;
      const t = ctx.currentTime, src = ctx.createBufferSource(); src.buffer = noise;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.setValueAtTime(600, t); f.frequency.linearRampToValueAtTime(1800, t + 0.15);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vol, t + 0.05); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      src.connect(f); f.connect(g); g.connect(master); src.start(t); src.stop(t + 0.25);
    };
    A.thud = function (vol, dist) {
      if (!ctx) return;
      const v = vol / (1 + (dist || 0) / 15); if (v < 0.02) return;
      const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(35, t + 0.25);
      g.gain.setValueAtTime(v * 0.8, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.32);
    };
    // continuous engine hum; level < 0 turns it off
    let eng = null;
    A.engine = function (level) {
      if (!ctx) return;
      if (!eng) {
        const o = ctx.createOscillator(), o2 = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
        o.type = 'sawtooth'; o2.type = 'square'; f.type = 'lowpass'; f.frequency.value = 500; g.gain.value = 0;
        o.connect(f); o2.connect(f); f.connect(g); g.connect(master); o.start(); o2.start();
        eng = { o, o2, f, g };
      }
      const t = ctx.currentTime;
      if (level < 0) { eng.g.gain.setTargetAtTime(0, t, 0.08); return; }
      eng.o.frequency.setTargetAtTime(38 + level * 95, t, 0.05);
      eng.o2.frequency.setTargetAtTime(19 + level * 47, t, 0.05);
      eng.f.frequency.setTargetAtTime(350 + level * 900, t, 0.05);
      eng.g.gain.setTargetAtTime(0.07 + level * 0.06, t, 0.08);
    };
    A.hit = () => A.tone(1900, 0.05, 0.15, 'square');
    A.kill = () => { A.tone(1200, 0.08, 0.18, 'square'); setTimeout(() => A.tone(1700, 0.12, 0.18, 'square'), 70); };
    A.click = () => A.tone(500, 0.03, 0.12, 'square');
    A.reload = () => { A.tone(300, 0.05, 0.12, 'triangle'); setTimeout(() => A.tone(420, 0.05, 0.12, 'triangle'), 350); };
    A.pickup = () => A.tone(880, 0.07, 0.12, 'triangle');
    A.hurt = () => A.tone(140, 0.12, 0.25, 'sawtooth');
    return A;
  })();
})();
