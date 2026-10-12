'use strict';
// Game: rendering, player control, combat, items, zone, HUD, rounds
(function () {
  const W = BR.World, WEAP = BR.WEAPONS, AU = BR.Audio;
  const { clamp, lerp } = BR;
  const $ = id => document.getElementById(id);

  const DIFF = {
    // react = seconds before first shot, err0/errMin = aim error (radians), settle = how fast aim tightens, turn = rad/s
    easy:   { react: 0.6,  err0: 0.1,   errMin: 0.022, settle: 1.3, turn: 4.5 },
    normal: { react: 0.38, err0: 0.072, errMin: 0.013, settle: 1.9, turn: 6.5 },
    hard:   { react: 0.2,  err0: 0.048, errMin: 0.006, settle: 2.8, turn: 10 },
  };
  const G = BR.Game = { chars: [], items: [], time: 0, state: 'loading', player: null, diff: DIFF.normal, round: 0, timeScale: 1, blueSize: 5, redSize: 5 };
  const BLUE_NAMES = ['Hawk', 'Viper', 'Ghost', 'Wolf'], RED_NAMES = ['Raven', 'Cobra', 'Titan', 'Blaze', 'Fang'];
  const BASE_FOV = 75;

  let renderer, scene, camera, vmScene, vmCamera, vmRoot, sun, muzzleLight, sky, zoneMesh, mapCanvas;
  const vmModels = {}; let vmFlash;
  const input = { keys: {}, mouseDown: false, firePressedT: -9, locked: false, sens: 1 };
  const P = { ads: false, adsT: 0, bobT: 0, kick: 0, swayX: 0, swayY: 0, eyeY: 1.62, melee: 0, punch: 1, specIdx: 0, mapOpen: false, nearItem: null };
  const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3();

  // ============================================================ init
  function init() {
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(innerWidth, innerHeight);
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.autoClear = false;
    $('game').appendChild(renderer.domElement);

    scene = new THREE.Scene();
    const fogCol = new THREE.Color(0xc9dcec);
    scene.background = fogCol;
    scene.fog = new THREE.Fog(fogCol, 180, 900);
    camera = new THREE.PerspectiveCamera(BASE_FOV, innerWidth / innerHeight, 0.05, 2200);
    scene.add(camera);

    scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x5d6a42, 0.8));
    sun = new THREE.DirectionalLight(0xfff1d6, 0.95);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera; sc.left = -75; sc.right = 75; sc.top = 75; sc.bottom = -75; sc.near = 1; sc.far = 400;
    sun.shadow.bias = -0.0006;
    scene.add(sun); scene.add(sun.target);
    muzzleLight = new THREE.PointLight(0xffc070, 0, 12); scene.add(muzzleLight);

    // sky dome
    {
      const g = new THREE.SphereGeometry(2000, 32, 16), cols = [], top = new THREE.Color(0x4f86d0);
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const t = clamp(pos.getY(i) / 2000, 0, 1), c = fogCol.clone().lerp(top, Math.pow(t, 0.6));
        cols.push(c.r, c.g, c.b);
      }
      g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
      sky = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
      sky.renderOrder = -1; scene.add(sky);
    }

    W.generate(scene, (Math.random() * 1e9) | 0);
    mapCanvas = W.makeMapCanvas(1000);

    // zone wall
    zoneMesh = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 700, 96, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xff5a36, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false, fog: false }));
    scene.add(zoneMesh);

    // viewmodel scene
    vmScene = new THREE.Scene();
    vmCamera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.01, 10);
    vmScene.add(new THREE.HemisphereLight(0xffffff, 0x666655, 0.8));
    const vl = new THREE.DirectionalLight(0xffffff, 0.6); vl.position.set(1, 2, 1); vmScene.add(vl);
    vmRoot = new THREE.Group(); vmScene.add(vmRoot);
    for (const t of BR.GUN_TYPES) { vmModels[t] = BR.makeWeaponModel(t, true); vmModels[t].visible = false; vmRoot.add(vmModels[t]); }
    vmModels.fists = BR.makeFistsModel(); vmModels.fists.visible = false; vmRoot.add(vmModels.fists);
    {
      const cv = document.createElement('canvas'); cv.width = cv.height = 64;
      const x = cv.getContext('2d'), gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, 'rgba(255,255,220,1)'); gr.addColorStop(0.3, 'rgba(255,190,80,0.9)'); gr.addColorStop(1, 'rgba(255,120,0,0)');
      x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
      G.flashTex = new THREE.CanvasTexture(cv);
      vmFlash = new THREE.Sprite(new THREE.SpriteMaterial({ map: G.flashTex, transparent: true, depthTest: false, blending: THREE.AdditiveBlending }));
      vmFlash.scale.set(0.18, 0.18, 1); vmFlash.visible = false; vmScene.add(vmFlash);
    }
    initEffects();
    bindInput();
    addEventListener('resize', onResize);
    $('loading').classList.add('hidden');
    $('menu').classList.remove('hidden');
    G.state = 'menu';
    startRound();
    let last = performance.now();
    const loop = now => {
      requestAnimationFrame(loop);
      const raw = clamp((now - last) / 1000, 0, 0.05); last = now;
      if (G.state === 'playing' || G.state === 'ending') {
        const n = G.timeScale;
        for (let i = 0; i < n; i++) update(raw);
      }
      render(raw);
    };
    requestAnimationFrame(loop);
  }
  function onResize() {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = vmCamera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix(); vmCamera.updateProjectionMatrix();
  }

  // ============================================================ rounds
  function findSpot(cx, cz, r0, r1) {
    for (let i = 0; i < 60; i++) {
      const a = Math.random() * Math.PI * 2, r = r0 + Math.random() * (r1 - r0);
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r, y = W.getHeight(x, z);
      if (W.isFree(x, z, 0.8, y) && !W.buildingAt(x, y + 0.5, z)) return new THREE.Vector3(x, y, z);
    }
    return new THREE.Vector3(cx, W.getHeight(cx, cz) + 2, cz);
  }
  function startRound() {
    G.round++;
    for (const c of G.chars) if (c.model) scene.remove(c.model.root);
    for (const it of G.items) scene.remove(it.group);
    for (const mk of G.medkits || []) scene.remove(mk.group);
    G.medkits = [];
    G.items = []; G.chars = []; G.killfeed = []; $('killfeed').innerHTML = '';
    for (const car of W.cars) BR.resetCar(car);
    G.time = 0; G.endT = 0; G.timeScale = 1;
    const NB = clamp(G.blueSize | 0, 1, 50), NR = clamp(G.redSize | 0, 1, 50);
    // loot scales with the bigger team; both bases still get identical starting loot
    spawnItems(Math.max(NB, NR));
    const player = G.player = new BR.Character('blue', 'You', true);
    G.chars.push(player);
    // bots-only mode (used for balance testing): player sits out, blue gets a full bot team
    if (G.botsOnly) player.alive = false;
    const name = (list, i, team) => i < list.length ? list[i] : `${team}-${i + 1}`;
    for (let i = 0; i < NB - (G.botsOnly ? 0 : 1); i++) G.chars.push(new BR.Bot('blue', name(BLUE_NAMES, i, 'Blue'), true));
    for (let i = 0; i < NR; i++) G.chars.push(new BR.Bot('red', name(RED_NAMES, i, 'Red'), false));
    const tb = W.towns[0], tr = W.towns[1];
    // spawn ring grows with team size; both teams face the enemy base
    const spreadB = 45 + Math.sqrt(NB) * 12, spreadR = 45 + Math.sqrt(NR) * 12;
    for (const c of G.chars) {
      const blue = c.team === 'blue', t = blue ? tb : tr, o = blue ? tr : tb;
      c.pos.copy(findSpot(t.x, t.z, 10, blue ? spreadB : spreadR));
      c.yaw = Math.atan2(-(o.x - c.pos.x), -(o.z - c.pos.z)); // face the enemy base
      if (c.model) { scene.add(c.model.root); c.model.root.position.copy(c.pos); }
    }
    // zone: first circle is centred at the same distance from both bases
    const mx = (tb.x + tr.x) / 2, mz = (tb.z + tr.z) / 2, bl = Math.hypot(tr.x - tb.x, tr.z - tb.z);
    const off = (Math.random() - 0.5) * 500;
    const zc = [mx - (tr.z - tb.z) / bl * off, mz + (tr.x - tb.x) / bl * off];
    G.zone = { cx: 0, cz: 0, r: 1500, phase: 0, t: 0, shrinking: false, dmg: 1, fromCx: 0, fromCz: 0, fromR: 1500, nextCx: zc[0], nextCz: zc[1], nextR: 760 };
    P.ads = false; P.adsT = 0; P.specIdx = 0; P.exhausted = false; P.recover = 0; P.shake = 0; P.vault = null;
    $('end').classList.add('hidden');
    $('center').textContent = ''; $('spec').textContent = '';
    updateTeams(true);
  }
  function spawnItems(N) {
    const bases = [W.towns[0], W.towns[1]];
    const nearBase = s => bases.some(t => Math.hypot(s.x - t.x, s.z - t.z) < t.r * 1.4);
    // total loot: 70% inside buildings (ground or 1st floor), 30% out in the open
    const total = 290 + N * 4;
    const indoorTarget = Math.round(total * 0.7), outdoorTarget = total - indoorTarget;
    let indoor = 0, outdoor = 0;
    const outdoorSpot = () => {
      for (let i = 0; i < 50; i++) {
        const x = (Math.random() - 0.5) * 1750, z = (Math.random() - 0.5) * 1750, y = W.getHeight(x, z);
        if (y > 80 || nearBase({ x, z }) || !W.isFree(x, z, 0.6, y) || W.buildingAt(x, y + 0.5, z)) continue;
        return { x, y, z };
      }
      return null;
    };
    // both bases get the exact same weapons, indoors, filling their ground-floor spots nearest the base centre
    const count = Math.max(3, Math.round(N * 0.9));
    const types = []; for (let i = 0; i < count; i++) types.push(BR.randomWeaponType());
    const baseSpots = bases.map(t => W.lootSpots.filter(s => !s.upper && Math.hypot(s.x - t.x, s.z - t.z) < t.r * 1.4)
      .sort((a, b) => Math.hypot(a.x - t.x, a.z - t.z) - Math.hypot(b.x - t.x, b.z - t.z)));
    const baseIndoor = Math.min(count, baseSpots[0].length, baseSpots[1].length);
    for (let b = 0; b < 2; b++) {
      const t = bases[b];
      types.forEach((type, i) => {
        if (i < baseIndoor) { const s = baseSpots[b][i]; spawnItem(type, null, s.x, s.y, s.z); indoor++; }
        else { const p = findSpot(t.x, t.z, 10, 60); spawnItem(type, null, p.x, p.y, p.z); outdoor++; }
      });
    }
    // the rest: random building spots (ground and 1st floor) away from the bases
    const spots = W.lootSpots.filter(s => !nearBase(s));
    for (let i = spots.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [spots[i], spots[j]] = [spots[j], spots[i]]; }
    for (const s of spots) { if (indoor >= indoorTarget) break; spawnItem(BR.randomWeaponType(), null, s.x, s.y, s.z, null, s.upper); indoor++; }
    // and the fields
    while (outdoor < outdoorTarget) { const p = outdoorSpot(); if (!p) break; spawnItem(BR.randomWeaponType(), null, p.x, p.y, p.z); outdoor++; }
    G.lootStats = { indoor, outdoor };

    // medkits: same count at both bases, the rest 70% in buildings / 30% in the open
    const baseMeds = Math.max(1, Math.round(N * 0.4));
    const medR = []; for (let i = 0; i < baseMeds; i++) medR.push(8 + Math.random() * 50);
    for (const t of bases) for (const r of medR) { const p = findSpot(t.x, t.z, r, r + 4); spawnMedkit(p.x, p.y, p.z); }
    const meds = 60 + N * 2, medIn = Math.round(meds * 0.7);
    const used = spots.slice(indoor);
    for (let i = 0; i < medIn && i < used.length; i++) { const s = used[i]; spawnMedkit(s.x, s.y, s.z); }
    for (let i = 0; i < meds - medIn; i++) { const p = outdoorSpot(); if (p) spawnMedkit(p.x, p.y, p.z); }
  }

  // ============================================================ medkits
  const MEDKIT_MAX = 5, MEDKIT_HEAL = 50, MEDKIT_TIME = 1.5;
  function makeMedkitModel() {
    const g = new THREE.Group();
    const mk = (w, h, d, c, x, y, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), makeMedkitModel.mats[c] || (makeMedkitModel.mats[c] = new THREE.MeshLambertMaterial({ color: c })));
      m.position.set(x, y, z); m.castShadow = true; g.add(m);
    };
    mk(0.42, 0.28, 0.3, 0xf2f2f2, 0, 0, 0);
    mk(0.26, 0.02, 0.08, 0xd81e1e, 0, 0.145, 0); mk(0.08, 0.02, 0.26, 0xd81e1e, 0, 0.145, 0);
    for (const s of [-1, 1]) { mk(0.2, 0.06, 0.02, 0xd81e1e, 0, 0, 0.155 * s); mk(0.06, 0.2, 0.02, 0xd81e1e, 0, 0, 0.155 * s); }
    mk(0.16, 0.05, 0.04, 0x555555, 0, 0.16, 0);
    return g;
  }
  makeMedkitModel.mats = {};
  function spawnMedkit(x, y, z) {
    const group = new THREE.Group(), model = makeMedkitModel();
    model.position.y = 0.4; group.add(model); group.position.set(x, y, z); scene.add(group);
    const mk = { x, y, z, group, model, spin: Math.random() * 6, removed: false };
    G.medkits.push(mk); return mk;
  }
  function removeMedkit(mk) {
    mk.removed = true; scene.remove(mk.group);
    const i = G.medkits.indexOf(mk); if (i >= 0) G.medkits.splice(i, 1);
  }
  G.nearestMedkit = function (pos, maxD) {
    let best = null, bd = maxD * maxD;
    for (const mk of G.medkits) {
      const d = (mk.x - pos.x) ** 2 + (mk.z - pos.z) ** 2;
      if (d < bd && Math.abs(mk.y - pos.y) < 1.6) { bd = d; best = mk; }
    }
    return best;
  };
  // walk over a medkit to put it in the medkit box (separate from the 3 weapon slots)
  G.pickMedkits = function (ch) {
    if (ch.medkits >= MEDKIT_MAX) return;
    for (const mk of G.medkits) {
      const dx = mk.x - ch.pos.x, dz = mk.z - ch.pos.z;
      if (dx * dx + dz * dz > 1.6 * 1.6 || Math.abs(mk.y - ch.pos.y) > 1.6) continue;
      removeMedkit(mk); ch.medkits++;
      if (ch.isPlayer) { AU.pickup(); feedMsg(`Picked up Medkit (${ch.medkits}/${MEDKIT_MAX})`); }
      return;
    }
  };
  G.useMedkit = function (ch) {
    if (!ch.alive || ch.medkits <= 0 || ch.hp >= 100 || ch.healT > 0) return false;
    ch.healT = MEDKIT_TIME; ch.reloadT = 0;
    if (ch.isPlayer) { P.ads = false; AU.tone(520, 0.12, 0.1, 'triangle'); }
    return true;
  };
  function updateHealing(dt) {
    for (const c of G.chars) {
      if (!(c.healT > 0)) continue;
      if (!c.alive) { c.healT = 0; continue; }
      c.healT -= dt;
      if (c.healT <= 0) {
        c.healT = 0; c.medkits--; c.hp = Math.min(100, c.hp + MEDKIT_HEAL);
        if (c.isPlayer) { AU.tone(660, 0.1, 0.12, 'triangle'); setTimeout(() => AU.tone(990, 0.15, 0.12, 'triangle'), 90); }
      }
    }
  }

  // ============================================================ items
  function spawnItem(type, inst, x, y, z, dropper, upper) {
    const group = new THREE.Group();
    const model = BR.makeWeaponModel(type, false);
    model.scale.setScalar(1.5); model.position.y = 0.5; model.rotation.z = Math.PI / 2 * 0.15;
    group.add(model);
    group.position.set(x, y, z);
    scene.add(group);
    const it = { inst: inst || BR.makeItem(type), group, model, x, y, z, noPickBy: dropper || null, noPickUntil: dropper ? G.time + 2 : 0, upper: !!upper, removed: false, spin: Math.random() * 6 };
    G.items.push(it);
    return it;
  }
  G.removeItem = function (it) {
    it.removed = true; scene.remove(it.group);
    const i = G.items.indexOf(it); if (i >= 0) G.items.splice(i, 1);
  };
  G.dropItem = function (ch, slot) {
    const inst = ch.slots[slot]; if (!inst) return;
    ch.slots[slot] = null;
    const a = ch.yaw + (Math.random() - 0.5) * 0.6;
    let x = ch.pos.x - Math.sin(a) * 0.9, z = ch.pos.z - Math.cos(a) * 0.9;
    if (!W.isFree(x, z, 0.2, ch.pos.y)) { x = ch.pos.x; z = ch.pos.z; }
    const y = W.groundAt(x, z, 0.1, ch.pos.y + 0.3, 0.5);
    spawnItem(inst.type, inst, x, y, z, ch);
  };
  function pickUp(ch, it, slot) {
    ch.slots[slot] = it.inst;
    G.removeItem(it);
    if (ch.isPlayer) { AU.pickup(); feedMsg(`Picked up ${WEAP[it.inst.type].name}`); }
  }

  // ============================================================ combat
  G.updateWeapon = function (ch, dt, trigger) {
    const it = ch.item, def = ch.def;
    ch.fireCD -= dt;
    if (ch.switchT > 0) ch.switchT -= dt;
    if (ch.reloadT > 0) {
      ch.reloadT -= dt;
      if (ch.reloadT <= 0 && it) {
        const need = def.mag - it.mag, take = ch.isBot ? need : Math.min(need, it.reserve);
        it.mag += take; if (!ch.isBot) it.reserve -= take;
      }
      return false;
    }
    if (!trigger || ch.fireCD > 0 || ch.switchT > 0) return false;
    if (def.melee) { doMelee(ch); ch.fireCD = 1 / def.rate; return true; }
    if (it.mag <= 0) { if (ch.isPlayer) AU.click(); startReload(ch); ch.fireCD = 0.25; return false; }
    it.mag--; ch.fireCD = 1 / def.rate;
    shoot(ch);
    if (it.mag <= 0) startReload(ch);
    return true;
  };
  function startReload(ch) {
    const it = ch.item, def = ch.def;
    if (!it || def.melee || it.mag >= def.mag || ch.reloadT > 0) return;
    if (!ch.isBot && it.reserve <= 0) return;
    ch.reloadT = def.reload;
    if (ch.isPlayer) AU.reload();
  }
  function applySpread(d, s) {
    if (s <= 0) return d;
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * s;
    v2.set(0, 1, 0).cross(d).normalize(); v3.crossVectors(d, v2);
    d.addScaledVector(v2, Math.cos(a) * r).addScaledVector(v3, Math.sin(a) * r).normalize();
    return d;
  }
  function playerSpread() {
    const pl = G.player, def = pl.def;
    let s = lerp(def.spread, def.adsSpread, P.adsT);
    if (P.sprinting) s *= 2.6;
    else if (pl.moveSpeed > 1) s *= 1.6;
    if (!pl.grounded) s *= 2;
    if (pl.crouch) s *= 0.6;
    return s;
  }
  // recoil multiplier by stance: crouched very low, standing normal, walking high, running very high
  function stanceRecoil(pl) {
    if (!pl.grounded) return 2.4;
    if (pl.crouch) return pl.moveSpeed > 1 ? 0.5 : 0.35;
    if (P.sprinting) return 3.0;
    if (pl.moveSpeed > 1) return 1.8;
    return 1.0;
  }
  function shoot(ch) {
    const def = ch.def, o = ch.eye(new THREE.Vector3()), aim = ch.forward(new THREE.Vector3());
    let spread;
    if (ch.isPlayer) spread = playerSpread();
    else spread = def.adsSpread + (def.spread - def.adsSpread) * (def.scope ? 0.05 : 0.25);
    // shotguns fire several pellets; everything else fires one bullet
    const pellets = def.pellets || 1, d = new THREE.Vector3();
    let hp = null;
    for (let i = 0; i < pellets; i++) {
      applySpread(d.copy(aim), spread);
      const p = hitscan(ch, o, d, def);
      if (!hp || i % 3 === 0) { if (hp && i) tracer(o.clone().addScaledVector(aim, 0.8), p, false); hp = hp || p; }
    }
    if (!def.quiet) ch.lastFireT = G.time; // suppressed shots don't reveal you on the minimap
    const muzzle = new THREE.Vector3();
    if (ch.isPlayer) {
      const right = v1.set(Math.cos(ch.yaw), 0, -Math.sin(ch.yaw));
      muzzle.copy(o).addScaledVector(ch.forward(v2), 0.7).addScaledVector(right, 0.18 * (1 - P.adsT)).add(v3.set(0, -0.14 * (1 - P.adsT) - 0.05, 0));
      const sm = stanceRecoil(ch);
      const rec = def.recoil * sm * (P.adsT > 0.5 ? 0.65 : 1);
      ch.pitch = clamp(ch.pitch + rec, -1.5, 1.5);
      ch.yaw += (Math.random() - 0.5) * rec * (0.5 + sm * 0.3); // more sideways kick when moving
      P.recover = (P.recover || 0) + rec * 0.5; P.lastShotT = G.time;
      P.kick = Math.min(1.8, 0.7 + sm * 0.3);
      P.shake = Math.min(0.03, (P.shake || 0) + rec * 0.25);
      vmFlash.visible = true; G.vmFlashT = 0.05;
      muzzleLight.position.copy(muzzle); muzzleLight.intensity = 2.2; G.mLightT = 0.05;
      AU.shot(ch.wtype, 0);
    } else {
      ch.muzzleWorld(muzzle);
      flash(muzzle);
      AU.shot(ch.wtype, muzzle.distanceTo(camera.position));
    }
    tracer(muzzle, hp, !!def.scope);
    const hearR = def.quiet ? 40 : 160;
    for (const b of G.chars) {
      if (b.isBot && b.alive && b.team !== ch.team && b.pos.distanceToSquared(ch.pos) < hearR * hearR) b.hearShot(ch, G);
    }
  }
  function rayChar(o, d, c, maxT) {
    const px = c.pos.x - o.x, pz = c.pos.z - o.z;
    const along = px * d.x + pz * d.z; // quick reject: perpendicular xz distance
    if (along < -1) return null;
    const hx = c.pos.x, hy = c.pos.y + c.headY(), hz = c.pos.z, R = 0.24;
    let best = null;
    const ox = o.x - hx, oy = o.y - hy, oz = o.z - hz;
    const b = ox * d.x + oy * d.y + oz * d.z, cc = ox * ox + oy * oy + oz * oz - R * R, disc = b * b - cc;
    if (disc >= 0) { const t = -b - Math.sqrt(disc); if (t > 0 && t < maxT) best = { t, head: true }; }
    const bt = W.rayAABB(o, d, { minx: c.pos.x - 0.3, miny: c.pos.y, minz: c.pos.z - 0.3, maxx: c.pos.x + 0.3, maxy: c.pos.y + c.bodyTop(), maxz: c.pos.z + 0.3 });
    if (bt >= 0 && bt < maxT && (!best || bt < best.t)) best = { t: bt, head: false };
    return best;
  }
  function hitscan(ch, o, d, def) {
    const wr = W.raycast(o, d, def.range);
    let bestT = wr.t, hit = null, head = false;
    for (const c of G.chars) {
      if (c === ch || !c.alive) continue;
      const r = rayChar(o, d, c, bestT);
      if (r) { bestT = r.t; hit = c; head = r.head; }
    }
    const hp = o.clone().addScaledVector(d, bestT);
    if (hit) {
      if (hit.team !== ch.team) {
        let dmg = def.dmg;
        if (def.falloff && bestT > def.falloff) dmg *= def.falloffMult;
        if (head) dmg *= def.headMult || 1.6;
        applyDamage(hit, dmg, ch, ch.wtype, head);
      }
      puff(hp, 0xa01010, 0.5);
    } else if (wr.hit) puff(hp, 0xb8ab90, 0.6);
    return hp;
  }
  function doMelee(ch) {
    const def = ch.def, eye = ch.eye(new THREE.Vector3()), f = ch.forward(new THREE.Vector3());
    let best = null, bd = Infinity;
    for (const c of G.chars) {
      if (!c.alive || c === ch || c.team === ch.team) continue;
      const ch2 = c.chest(v1);
      const d = ch2.distanceTo(eye);
      if (d > def.range + 0.5 || d > bd) continue;
      v2.subVectors(ch2, eye).normalize();
      if (v2.dot(f) < (ch.isPlayer ? 0.7 : 0.4)) continue;
      if (!W.lineOfSight(eye, ch2)) continue;
      best = c; bd = d;
    }
    if (ch.isPlayer) { P.melee = 1; P.punch = -P.punch; }
    AU.whoosh(ch.isPlayer ? 0.25 : 0.25 / (1 + ch.pos.distanceTo(camera.position) / 8));
    if (best) {
      applyDamage(best, def.dmg, ch, ch.wtype, false);
      puff(best.chest(v1), 0xa01010, 0.5);
    }
    ch.lastFireT = G.time - 0.8; // melee is quiet-ish
  }
  G.applyDamage = (...a) => applyDamage(...a);
  G.camDist = o => Math.hypot(o.x - camera.position.x, o.z - camera.position.z);
  function applyDamage(t, dmg, attacker, wtype, head) {
    if (!t.alive || G.state === 'menu') return;
    t.hp -= dmg;
    if (t.isPlayer) {
      AU.hurt();
      $('vignette').style.opacity = Math.min(0.85, 0.35 + dmg / 80);
      G.vignT = 0.6;
      if (attacker) damageDir(attacker.pos);
    }
    if (attacker && attacker.isPlayer) hitmarker(t.hp <= 0, head);
    if (t.isBot) t.onDamaged(attacker, G);
    if (t.hp <= 0) kill(t, attacker, wtype, head);
  }
  function kill(t, attacker, wtype, head) {
    t.alive = false; t.hp = 0; t.deadT = G.time;
    if (t.inCar) exitCar(t);
    for (let i = 0; i < t.medkits; i++) {
      const a = Math.random() * Math.PI * 2;
      spawnMedkit(t.pos.x + Math.cos(a) * 0.8, W.groundAt(t.pos.x, t.pos.z, 0.1, t.pos.y + 0.3, 0.5), t.pos.z + Math.sin(a) * 0.8);
    }
    t.medkits = 0; t.healT = 0;
    for (let i = 0; i < 3; i++) if (t.slots[i]) G.dropItem(t, i);
    if (t.model && t.model.marker) t.model.marker.visible = false;
    if (attacker && attacker !== t) attacker.kills++;
    addKill(attacker, t, wtype, head);
    if (t.isPlayer) {
      P.ads = false;
      $('center').innerHTML = '<span class="dead">ELIMINATED</span>';
      setTimeout(() => { if (!G.player.alive && G.state === 'playing') $('center').textContent = ''; }, 2500);
    }
    updateTeams();
    const blue = G.chars.filter(c => c.alive && c.team === 'blue').length, red = G.chars.filter(c => c.alive && c.team === 'red').length;
    if ((blue === 0 || red === 0) && G.state === 'playing') { G.state = 'ending'; G.endT = G.time + 2.5; G.winner = blue > 0 ? 'blue' : 'red'; }
  }

  // ============================================================ effects
  const tracers = [], puffs = [];
  let puffTex;
  function initEffects() {
    const cv = document.createElement('canvas'); cv.width = cv.height = 32;
    const x = cv.getContext('2d'), gr = x.createRadialGradient(16, 16, 0, 16, 16, 16);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = gr; x.fillRect(0, 0, 32, 32);
    puffTex = new THREE.CanvasTexture(cv);
    for (let i = 0; i < 40; i++) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 1], 3));
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffe9a0, transparent: true, opacity: 0 }));
      l.frustumCulled = false; l.visible = false; scene.add(l); tracers.push({ l, life: 0, max: 0.08 });
    }
    for (let i = 0; i < 60; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTex, transparent: true, depthWrite: false }));
      s.visible = false; scene.add(s); puffs.push({ s, life: 0, max: 0.4, size: 0.5, add: false });
    }
  }
  let ti = 0, pi = 0;
  function tracer(a, b, heavy) {
    const t = tracers[ti++ % tracers.length], p = t.l.geometry.attributes.position;
    p.setXYZ(0, a.x, a.y, a.z); p.setXYZ(1, b.x, b.y, b.z); p.needsUpdate = true;
    t.l.visible = true; t.max = heavy ? 0.35 : 0.07; t.life = t.max;
  }
  function puff(pos, color, size) {
    const p = puffs[pi++ % puffs.length];
    p.s.position.copy(pos); p.s.material.color.setHex(color); p.s.material.blending = THREE.NormalBlending;
    p.s.material.map = puffTex; p.size = size; p.max = p.life = 0.4; p.s.visible = true;
  }
  function flash(pos) {
    const p = puffs[pi++ % puffs.length];
    p.s.position.copy(pos); p.s.material.color.setHex(0xffffff); p.s.material.blending = THREE.AdditiveBlending;
    p.s.material.map = G.flashTex; p.size = 0.7; p.max = p.life = 0.06; p.s.visible = true;
  }
  function updateEffects(dt) {
    for (const t of tracers) if (t.life > 0) { t.life -= dt; t.l.material.opacity = Math.max(0, t.life / t.max) * 0.8; if (t.life <= 0) t.l.visible = false; }
    for (const p of puffs) if (p.life > 0) {
      p.life -= dt; const k = 1 - p.life / p.max;
      p.s.scale.setScalar(p.size * (0.5 + k)); p.s.material.opacity = 1 - k;
      if (p.life <= 0) p.s.visible = false;
    }
  }

  // ============================================================ zone
  const PHASES = [
    { wait: 100, shrink: 70, r: 760, dmg: 1 }, { wait: 70, shrink: 50, r: 400, dmg: 2 },
    { wait: 55, shrink: 45, r: 200, dmg: 4 }, { wait: 45, shrink: 35, r: 90, dmg: 7 },
    { wait: 35, shrink: 30, r: 30, dmg: 10 }, { wait: 25, shrink: 25, r: 4, dmg: 14 },
  ];
  function updateZone(dt) {
    const Z = G.zone, ph = PHASES[Z.phase];
    if (!ph) return;
    Z.t += dt;
    if (!Z.shrinking) {
      if (Z.t >= ph.wait) { Z.shrinking = true; Z.t = 0; Z.fromCx = Z.cx; Z.fromCz = Z.cz; Z.fromR = Z.r; }
    } else {
      const k = Math.min(1, Z.t / ph.shrink);
      Z.r = lerp(Z.fromR, Z.nextR, k); Z.cx = lerp(Z.fromCx, Z.nextCx, k); Z.cz = lerp(Z.fromCz, Z.nextCz, k);
      if (k >= 1) {
        Z.phase++; Z.shrinking = false; Z.t = 0; Z.dmg = ph.dmg * 1.5;
        const nx = PHASES[Z.phase];
        if (nx) {
          const a = Math.random() * Math.PI * 2, d = Math.random() * (Z.r - nx.r) * 0.85;
          Z.nextCx = Z.cx + Math.cos(a) * d; Z.nextCz = Z.cz + Math.sin(a) * d; Z.nextR = nx.r;
        }
      }
    }
    for (const c of G.chars) {
      if (!c.alive) continue;
      if (Math.hypot(c.pos.x - Z.cx, c.pos.z - Z.cz) > Z.r) {
        c.hp -= Z.dmg * dt;
        if (c.isPlayer) { $('vignette').style.opacity = 0.35; G.vignT = 0.2; }
        if (c.hp <= 0) kill(c, null, 'zone', false);
      }
    }
  }

  // ============================================================ player
  function updatePlayer(dt) {
    const pl = G.player, k = input.keys;
    if (pl.inCar) {
      P.carCtl = { throttle: (k.KeyW ? 1 : 0) - (k.KeyS ? 1 : 0), steer: (k.KeyA ? 1 : 0) - (k.KeyD ? 1 : 0), brake: !!k.Space };
      P.sprinting = false; P.ads = false;
      G.updateWeapon(pl, dt, false); // lets a reload finish
      setHTML('prompt', '<b>[F]</b> Exit car');
      return;
    }
    // jumping through a window: short animated dive, collisions ignored while it plays
    if (P.vault) {
      const v = P.vault; v.t += dt / v.dur; const t = Math.min(1, v.t);
      pl.pos.x = lerp(v.ax, v.bx, t); pl.pos.z = lerp(v.az, v.bz, t);
      pl.pos.y = t < 0.5 ? lerp(v.ay, v.my, t * 2) : lerp(v.my, v.by, (t - 0.5) * 2);
      pl.crouch = true; P.eyeY = 1.1;
      if (t >= 1) { P.vault = null; pl.vel.set(0, 0, 0); pl.grounded = false; }
      G.updateWeapon(pl, dt, false);
      setHTML('prompt', '');
      return;
    }
    const win = pl.grounded ? findWindow(pl) : null;
    if (win && k.Space) {
      k.Space = false; // don't also jump
      P.vault = { t: 0, dur: 0.55, ax: pl.pos.x, ay: pl.pos.y, az: pl.pos.z, bx: win.x, by: win.y, bz: win.z, my: win.sill - 0.4 };
      P.ads = false;
      AU.whoosh(0.3);
      return;
    }
    const fwd = (k.KeyW ? 1 : 0) - (k.KeyS ? 1 : 0), str = (k.KeyD ? 1 : 0) - (k.KeyA ? 1 : 0);
    const sy = Math.sin(pl.yaw), cy = Math.cos(pl.yaw);
    let wx = -sy * fwd + cy * str, wz = -cy * fwd - sy * str;
    const l = Math.hypot(wx, wz); if (l > 0) { wx /= l; wz /= l; }
    P.strafe = str;
    // sprinting drains stamina; when it runs out you must rest until it is back to 35
    const sprint = k.ShiftLeft && fwd > 0 && !pl.crouch && !P.exhausted && pl.stamina > 0;
    if (sprint && P.ads) P.ads = false;
    let speed = pl.crouch ? 2.6 : sprint ? 10.5 : 5.6;
    if (P.adsT > 0.5) speed = Math.min(speed, pl.crouch ? 2.2 : 3.4);
    if (pl.reloadT > 0) speed *= 0.9;
    speed *= pl.def.speedMult || 1; // heavy guns (M249) slow you down
    // crouch toggle handled in keydown; stand up only if headroom
    if (!pl.wantCrouch && pl.crouch) {
      const ceil = W.ceilingAt(pl.pos.x, pl.pos.z, pl.radius, pl.pos.y + 1.2);
      if (ceil > pl.pos.y + 1.85) pl.crouch = false;
    } else if (pl.wantCrouch) pl.crouch = true;
    const jump = k.Space && pl.grounded && pl.stamina >= 8;
    const wasAir = !pl.grounded, vyBefore = pl.vel.y;
    pl.physics(wx, wz, speed, jump, dt);
    if (jump && !pl.grounded) { pl.stamina -= 10; P.lastDrain = G.time; }
    if (wasAir && pl.grounded && vyBefore < -3) P.land = Math.min(1, -vyBefore / 12); // landing dip
    P.sprinting = sprint && pl.moveSpeed > 5;
    if (P.sprinting) {
      pl.stamina = Math.max(0, pl.stamina - 14 * dt); P.lastDrain = G.time;
      if (pl.stamina <= 0) P.exhausted = true;
    } else if (G.time - (P.lastDrain || 0) > 0.9) pl.stamina = Math.min(100, pl.stamina + 20 * dt);
    if (P.exhausted && pl.stamina >= 35) P.exhausted = false;

    const def = pl.def;
    const trigger = def.auto ? input.mouseDown : (G.time - input.firePressedT < 0.2);
    const fired = G.updateWeapon(pl, dt, trigger && !(pl.healT > 0));
    if (fired) P.sprintFire = 0.35; // raise the gun out of the sprint pose while shooting
    G.pickMedkits(pl);
    if (fired && !def.auto) input.firePressedT = -9;
    // recoil recovery: part of each kick springs back once you stop firing
    if (P.recover > 0 && G.time - (P.lastShotT || 0) > 0.12) {
      const r = Math.min(P.recover, P.recover * dt * 10 + dt * 0.01);
      pl.pitch -= r; P.recover -= r;
    }

    // nearby items
    let near = null, nd = 1.9 * 1.9;
    for (const it of G.items) {
      const dx = it.x - pl.pos.x, dz = it.z - pl.pos.z, d = dx * dx + dz * dz;
      if (it.noPickBy === pl) { if (d > 2.6 * 2.6) it.noPickBy = null; else continue; }
      if (d < nd && Math.abs(it.y - pl.pos.y) < 1.6) { nd = d; near = it; }
    }
    P.nearItem = near;
    let prompt = '';
    if (near) {
      const t = near.inst.type, have = pl.slots.some(s => s && s.type === t);
      const free = pl.slots.indexOf(null);
      if (free >= 0 && !have) {
        const slot = pl.slots[pl.cur] ? free : pl.cur;
        const better = WEAP[t].rank > pl.def.rank;
        pickUp(pl, near, slot);
        if (slot === pl.cur || better) equip(slot, true);
        P.nearItem = null;
      } else {
        prompt = pl.item ? `<b>[G]</b> Swap ${pl.def.name} for <span style="color:${WEAP[t].color}">${WEAP[t].name}</span>`
                         : `<b>[G]</b> Pick up <span style="color:${WEAP[t].color}">${WEAP[t].name}</span>`;
      }
    }
    if (!prompt && BR.Vehicles.nearestCar(pl.pos, 1.6)) prompt = '<b>[F]</b> Drive car';
    if (!prompt && win) prompt = '<b>[Space]</b> Jump through window';
    if (!prompt && pl.hp <= 50 && pl.medkits > 0 && !(pl.healT > 0)) prompt = '<b>[E]</b> Use medkit';
    setHTML('prompt', prompt);
  }
  // a window the player is standing at and facing, with a sill they can climb over
  function findWindow(pl) {
    const fx = -Math.sin(pl.yaw), fz = -Math.cos(pl.yaw);
    for (const w of W.windows) {
      const dx = pl.pos.x - w.x, dz = pl.pos.z - w.z;
      if (Math.abs(dx) > 2 || Math.abs(dz) > 2) continue;
      const side = dx * w.nx + dz * w.nz;              // distance from the wall
      const lat = dx * -w.nz + dz * w.nx;               // offset along the wall
      if (Math.abs(side) > 1.2 || Math.abs(lat) > w.hw + 0.1) continue;
      const sill = w.y0 - pl.pos.y;
      if (sill < 0.3 || sill > 1.5) continue;
      const s = side >= 0 ? -1 : 1, inx = w.nx * s, inz = w.nz * s; // direction through the window
      if (fx * inx + fz * inz < 0.55) continue;
      const l = clamp(lat, -(w.hw - 0.35), w.hw - 0.35);
      const x = w.x + inx * 1.0 - w.nz * l, z = w.z + inz * 1.0 + w.nx * l;
      const y = W.groundAt(x, z, 0.3, w.y0, 0.3);
      if (!W.isFree(x, z, 0.35, y)) continue;
      return { x, y, z, sill: w.y0 };
    }
    return null;
  }
  function toggleCar() {
    const pl = G.player; if (!pl.alive) return;
    if (pl.inCar) { exitCar(pl); return; }
    const car = BR.Vehicles.nearestCar(pl.pos, 1.6); if (!car) return;
    pl.inCar = car; car.driver = pl; P.ads = false; P.adsT = 0;
    P.camYaw = car.ang; P.camPitch = 0.22; P.camIdle = 0;
  }
  function exitCar(ch) {
    const car = ch.inCar; if (!car) return;
    car.driver = null; ch.inCar = null;
    if (ch.isPlayer) AU.engine(-1);
    if (!ch.alive) return;
    let spot = null;
    for (const [lx, lz] of [[2.0, 0], [-2.0, 0], [0, 3.5], [0, -3.5], [2.3, 2.2], [-2.3, -2.2]]) {
      const [x, z] = W.carWorld(car, lx, lz), gy = W.getHeight(x, z);
      const y = W.groundAt(x, z, 0.3, gy + 0.5, 0.5);
      if (!spot) spot = [x, y, z];
      if (W.isFree(x, z, 0.4, y)) { spot = [x, y, z]; break; }
    }
    ch.pos.set(spot[0], spot[1], spot[2]); ch.vel.set(0, 0, 0);
    ch.crouch = !!ch.wantCrouch; ch.yaw = car.ang + Math.PI; ch.pitch = 0;
  }
  // keep the driver sitting in the seat (bots can still shoot them through the windows)
  function syncDriver() {
    const pl = G.player, car = pl.inCar; if (!car) return;
    const [x, z] = W.carWorld(car, 0.45, 0.1);
    pl.pos.set(x, car.y + 0.25, z); pl.vel.set(0, 0, 0);
    pl.yaw = car.ang + Math.PI; pl.crouch = true; pl.moveSpeed = Math.abs(car.speed); pl.grounded = true;
  }
  function equip(i, force) {
    const pl = G.player;
    if (!force && i === pl.cur) return;
    pl.cur = i; pl.switchT = 0.35; pl.reloadT = 0; P.ads = false;
  }
  function pressG() {
    const pl = G.player; if (!pl.alive) return;
    const near = P.nearItem;
    if (near && !near.removed) {
      if (pl.slots[pl.cur]) G.dropItem(pl, pl.cur);
      pickUp(pl, near, pl.cur); equip(pl.cur, true);
    } else if (pl.item) {
      G.dropItem(pl, pl.cur); equip(pl.cur, true);
    }
  }

  // ============================================================ update / render
  function update(dt) {
    G.time += dt;
    updateZone(dt);
    if (G.player.alive) updatePlayer(dt);
    updateHealing(dt);
    BR.Vehicles.update(dt, G, G.player.inCar ? P.carCtl : null);
    syncDriver();
    // alternate update order every tick so neither team always reacts first
    G.flip = !G.flip;
    const cs = G.chars, n = cs.length;
    for (let i = 0; i < n; i++) { const c = cs[G.flip ? i : n - 1 - i]; if (c.isBot) c.update(dt, G); }
    // items: spin + distance culling
    G.itemCullT = (G.itemCullT || 0) - dt;
    const cull = G.itemCullT <= 0; if (cull) G.itemCullT = 0.3;
    for (const it of G.items) {
      it.spin += dt * 1.5; it.model.rotation.y = it.spin; it.model.position.y = 0.5 + Math.sin(it.spin * 1.3) * 0.06;
      if (cull) it.group.visible = it.group.position.distanceToSquared(camera.position) < 190 * 190;
    }
    for (const mk of G.medkits) {
      mk.spin += dt * 1.5; mk.model.rotation.y = mk.spin; mk.model.position.y = 0.4 + Math.sin(mk.spin * 1.3) * 0.05;
      if (cull) mk.group.visible = mk.group.position.distanceToSquared(camera.position) < 190 * 190;
    }
    updateEffects(dt);
    if (G.state === 'ending' && G.time >= G.endT) showEnd();
  }

  function render(dt) {
    const pl = G.player;
    // timers that should run on real time
    if (G.vmFlashT > 0 && (G.vmFlashT -= dt) <= 0) vmFlash.visible = false;
    if (G.mLightT > 0 && (G.mLightT -= dt) <= 0) muzzleLight.intensity = 0;
    if (G.vignT > 0) { G.vignT -= dt; if (G.vignT <= 0) $('vignette').style.opacity = 0; }

    let showVM = false;
    const def = pl.def;
    const scoped = def.scope && P.adsT > 0.85 && pl.reloadT <= 0 && !pl.inCar;
    if (pl.alive && pl.inCar) {
      // third-person chase camera; mouse orbits, drifts back behind the car while driving
      const car = pl.inCar;
      P.camIdle = (P.camIdle || 0) + dt;
      if (P.camIdle > 1 && Math.abs(car.speed) > 3) {
        const target = car.speed > 0 ? car.ang : car.ang + Math.PI;
        P.camYaw += BR.angDiff(P.camYaw, target) * Math.min(1, dt * 2.5);
      }
      if (camera.fov !== BASE_FOV) { camera.fov = BASE_FOV; camera.updateProjectionMatrix(); }
      const D = 7.5, cp = Math.cos(P.camPitch);
      const want = v2.set(car.x - Math.sin(P.camYaw) * cp * D, car.y + 1.6 + Math.sin(P.camPitch) * D, car.z - Math.cos(P.camYaw) * cp * D);
      const gy = W.getHeight(want.x, want.z) + 0.6; if (want.y < gy) want.y = gy;
      camera.position.copy(want);
      camera.lookAt(car.x, car.y + 1.3, car.z);
      AU.engine(Math.min(1, Math.abs(car.speed) / 30)); P.engineOn = true;
    } else if (pl.alive) {
      P.eyeY = lerp(P.eyeY, pl.eyeY(), Math.min(1, dt * 12));
      // head bob: dips on every step, bigger and with more roll when sprinting; less while aiming
      const sp = Math.min(1.6, pl.moveSpeed / 5.6) * (pl.grounded ? 1 : 0), ba = 1 - P.adsT * 0.75, st = P.sprintT || 0;
      const bobY = -Math.abs(Math.sin(P.bobT)) * lerp(0.035, 0.075, st) * sp * ba;
      const roll = Math.sin(P.bobT) * lerp(0.004, 0.012, st) * sp * ba - (P.strafeT || 0) * 0.012 * ba;
      P.shake = Math.max(0, (P.shake || 0) - dt * 0.15);
      const sh = P.shake > 0 ? (Math.random() - 0.5) * P.shake : 0;
      camera.position.set(pl.pos.x, pl.pos.y + P.eyeY + bobY - (P.land || 0) * 0.14, pl.pos.z);
      camera.rotation.set(pl.pitch + sh * 0.5, pl.yaw + sh * 0.3, roll + sh, 'YXZ');
      const target = P.ads && !def.melee && pl.switchT <= 0 ? 1 : 0;
      const adsSpeed = def.scope ? 5 : 8;
      P.adsT = clamp(P.adsT + (target ? 1 : -1) * dt * adsSpeed, 0, 1);
      const fov = def.melee ? BASE_FOV : lerp(BASE_FOV, def.fov, P.adsT * (def.scope && !scoped ? 0.3 : 1));
      if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
      showVM = !scoped;
      updateViewmodel(dt);
    } else {
      // spectate a living teammate
      const mates = G.chars.filter(c => c.alive && c.team === 'blue');
      if (camera.fov !== BASE_FOV) { camera.fov = BASE_FOV; camera.updateProjectionMatrix(); }
      if (mates.length) {
        const t = mates[P.specIdx % mates.length];
        const back = v1.set(Math.sin(t.yaw), 0, Math.cos(t.yaw));
        const want = v2.copy(t.pos).addScaledVector(back, 3.6); want.y += 2.3;
        const gy = W.getHeight(want.x, want.z) + 0.5; if (want.y < gy) want.y = gy;
        camera.position.lerp(want, Math.min(1, dt * 6));
        camera.lookAt(t.pos.x, t.pos.y + 1.5, t.pos.z);
        setHTML('spec', `Spectating <b>${t.name}</b> &nbsp;·&nbsp; HP ${Math.ceil(t.hp)} · ${t.def.name} &nbsp;·&nbsp; <b>[LMB]</b> next teammate &nbsp;·&nbsp; <b>[F]</b> fast-forward ${G.timeScale > 1 ? 'ON' : 'OFF'}`);
      }
    }
    $('scope').style.display = scoped && pl.alive ? 'block' : 'none';
    if (P.engineOn && !(pl.alive && pl.inCar) || P.engineOn && G.state !== 'playing' && G.state !== 'ending') { AU.engine(-1); P.engineOn = false; }

    sky.position.copy(camera.position);
    sun.position.set(camera.position.x + 90, camera.position.y + 160, camera.position.z + 50);
    sun.target.position.copy(camera.position);
    const Z = G.zone;
    zoneMesh.position.set(Z.cx, 150, Z.cz); zoneMesh.scale.set(Z.r, 1, Z.r);

    renderer.clear();
    renderer.render(scene, camera);
    if (showVM) { renderer.clearDepth(); renderer.render(vmScene, vmCamera); }
    updateHUD(dt);
  }

  function updateViewmodel(dt) {
    const pl = G.player, t = pl.wtype, def = pl.def;
    for (const k in vmModels) vmModels[k].visible = k === t;
    const m = vmModels[t];
    const hip = def.hip || [0.2, -0.22, -0.42], ads = def.ads || hip;
    const a = P.adsT;
    const ground = pl.grounded ? 1 : 0.25;
    const sp = Math.min(1.5, pl.moveSpeed / 5.6) * ground;
    // step cycle follows distance travelled, so faster movement = faster steps
    P.bobT += pl.moveSpeed * dt * 1.15 * ground;
    P.sprintFire = Math.max(0, (P.sprintFire || 0) - dt);
    P.sprintT = clamp((P.sprintT || 0) + (P.sprinting && !P.sprintFire ? 1 : -1) * dt * 6, 0, 1);
    P.strafeT = lerp(P.strafeT || 0, P.strafe || 0, Math.min(1, dt * 8));
    P.land = Math.max(0, (P.land || 0) - dt * 4);
    P.kick = Math.max(0, P.kick - dt * 12);
    P.swayX *= Math.exp(-dt * 10); P.swayY *= Math.exp(-dt * 10);
    P.melee = Math.max(0, P.melee - dt * 4);
    const s = P.sprintT, bob = (1 - a * 0.85) * sp, ph = P.bobT;
    // walking: gun traces a figure-8; sprinting: gun lowered and tilted across the body with big bounces
    const breathe = Math.sin(G.time * 1.6) * 0.0025 * (1 - a);
    const wbx = Math.sin(ph) * 0.016 * bob, wby = -Math.abs(Math.cos(ph)) * 0.014 * bob + Math.sin(ph * 2) * 0.003 * bob;
    const sbx = Math.sin(ph) * 0.04, sby = -Math.abs(Math.cos(ph)) * 0.035;
    let x = lerp(hip[0], ads[0], a) + lerp(wbx, sbx, s) - 0.07 * s + P.swayX;
    let y = lerp(hip[1], ads[1], a) + lerp(wby, sby, s) - 0.08 * s + P.swayY + breathe - P.land * 0.07;
    const heavy = def.scope || def.pellets;
    let z = lerp(hip[2], ads[2], a) + P.kick * (heavy ? 0.08 : 0.035) + 0.04 * s;
    let rx = P.kick * (heavy ? 0.15 : 0.06) + s * (-0.4 + Math.sin(ph * 2) * 0.07) - P.land * 0.12;
    let ry = s * 0.8 + Math.sin(ph) * 0.025 * bob;
    let rz = s * (0.3 + Math.sin(ph) * 0.1) + Math.sin(ph) * 0.035 * bob - P.strafeT * 0.08 * (1 - a);
    if (pl.reloadT > 0) { const pr = 1 - pl.reloadT / def.reload; const s = Math.sin(pr * Math.PI); rx -= s * 0.7; y -= s * 0.12; rz = s * 0.3; }
    if (pl.switchT > 0) y -= pl.switchT / 0.35 * 0.3;
    if (t === 'fists') {
      x = 0; y = -P.land * 0.05; z = 0; rx = 0; ry = 0; rz = -P.strafeT * 0.05;
      // fists pump alternately when running
      const r = m.userData.right, l = m.userData.left, pu = Math.sin(P.melee * Math.PI);
      const amp = lerp(0.014, 0.06, s) * Math.min(1, sp + s);
      r.position.set(0.2, -0.27 - Math.max(0, Math.sin(ph)) * amp * 1.5 + (P.punch > 0 ? pu * 0.08 : 0), -0.5 + Math.sin(ph) * amp * 2 - (P.punch > 0 ? pu * 0.3 : 0));
      l.position.set(-0.2, -0.27 - Math.max(0, -Math.sin(ph)) * amp * 1.5 + (P.punch < 0 ? pu * 0.08 : 0), -0.5 - Math.sin(ph) * amp * 2 - (P.punch < 0 ? pu * 0.3 : 0));
    }
    m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
    if (vmFlash.visible) { vmFlash.position.copy(m.userData.muzzle).applyEuler(m.rotation).add(m.position); vmFlash.material.rotation = Math.random() * 6; }
  }

  // ============================================================ HUD
  const htmlCache = {};
  function setHTML(id, h) { if (htmlCache[id] !== h) { htmlCache[id] = h; $(id).innerHTML = h; } }
  function updateHUD() {
    const pl = G.player, def = pl.def, it = pl.item;
    $('hpfill').style.width = Math.max(0, pl.hp) + '%';
    $('hpfill').style.background = pl.hp > 60 ? '#5fd35f' : pl.hp > 30 ? '#e8c547' : '#e8493f';
    setHTML('hptext', Math.ceil(Math.max(0, pl.hp)));
    $('stamfill').style.width = pl.stamina.toFixed(1) + '%';
    $('stamfill').classList.toggle('tired', !!P.exhausted);
    setHTML('wname', pl.inCar ? 'Car' : def.name + (pl.reloadT > 0 ? ' <span class="rl">RELOADING</span>' : ''));
    setHTML('ammo', pl.inCar ? `${Math.round(Math.abs(pl.inCar.speed) * 3.6)}<small> km/h</small>` : def.melee ? '<span class="inf">∞</span>' : `<span class="${it.mag === 0 ? 'empty' : ''}">${it.mag}</span><small> / ${it.reserve}</small>`);
    let sh = '';
    for (let i = 0; i < 3; i++) {
      const s = pl.slots[i], d = s ? WEAP[s.type] : null;
      sh += `<div class="slot ${i === pl.cur ? 'cur' : ''}" style="${d ? 'border-color:' + d.color : ''}"><span>${i + 1}</span>${d ? d.name : 'Fists'}</div>`;
    }
    setHTML('slots', sh);
    setHTML('medcount', String(pl.medkits));
    $('medbox').classList.toggle('empty', pl.medkits === 0);
    const healing = pl.alive && pl.healT > 0;
    $('heal').style.display = healing ? 'block' : 'none';
    if (healing) $('healfill').style.width = ((1 - pl.healT / MEDKIT_TIME) * 100).toFixed(1) + '%';
    // crosshair
    const ch = $('crosshair');
    if (!pl.alive || pl.inCar || P.adsT > 0.6 || G.state !== 'playing' && G.state !== 'ending') ch.style.display = 'none';
    else {
      ch.style.display = 'block';
      const gap = def.melee ? 3 : 5 + playerSpread() * 520;
      ch.style.setProperty('--gap', gap.toFixed(1) + 'px');
    }
    $('adsdot').style.display = pl.alive && P.adsT > 0.6 && !def.scope ? 'block' : 'none';
    // zone text
    const Z = G.zone, ph = PHASES[Z.phase];
    let zt = '';
    if (ph) {
      const left = Math.max(0, Math.ceil((Z.shrinking ? ph.shrink : ph.wait) - Z.t));
      zt = (Z.shrinking ? '<span class="warn">ZONE CLOSING</span> ' : 'Zone shrinks in ') + `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    } else zt = '<span class="warn">FINAL ZONE</span>';
    if (pl.alive && Math.hypot(pl.pos.x - Z.cx, pl.pos.z - Z.cz) > Z.r) zt += '<br><span class="warn">YOU ARE OUTSIDE THE ZONE!</span>';
    setHTML('zoneinfo', zt);
    if (G.state === 'playing' && !pl.alive) {} else if (pl.alive) setHTML('spec', '');
    drawMinimap();
    if (P.mapOpen) drawBigMap();
    // killfeed expiry
    const kf = $('killfeed');
    for (const el of Array.from(kf.children)) if (performance.now() - el._t > 7000) el.remove();
  }
  function updateTeams(force) {
    let h = '';
    for (const team of ['blue', 'red']) {
      const list = G.chars.filter(c => c.team === team);
      const alive = list.filter(c => c.alive).length;
      const icons = list.length <= 10 ? list.map(c => `<i class="${c.alive ? '' : 'dead'} ${c.isPlayer ? 'me' : ''}"></i>`).join('')
        : `<em class="bar"><em style="width:${(alive / list.length * 100).toFixed(1)}%"></em></em>`;
      h += `<div class="team ${team}"><b>${team.toUpperCase()}</b> ${icons}<span>${alive}<small>/${list.length}</small></span></div>`;
      if (team === 'blue') h += '<div class="vs">VS</div>';
    }
    $('teams').innerHTML = h;
  }
  function addKill(att, vic, wtype, head) {
    const wn = BR.KILL_NAMES[wtype] || WEAP[wtype].name;
    const el = document.createElement('div');
    el._t = performance.now();
    const nm = c => `<span class="${c.team}">${c.name}</span>`;
    el.innerHTML = att && att !== vic ? `${nm(att)} <em>[${wn}${head ? ' ✛' : ''}]</em> ${nm(vic)}` : `${nm(vic)} <em>${wtype === 'car' ? 'crashed' : 'died in the zone'}</em>`;
    if ((att && att.isPlayer) || vic.isPlayer) el.className = 'me';
    $('killfeed').prepend(el);
    while ($('killfeed').children.length > 6) $('killfeed').lastChild.remove();
  }
  function feedMsg(text) {
    const el = $('pickmsg'); el.textContent = text; el.style.opacity = 1;
    clearTimeout(feedMsg.t); feedMsg.t = setTimeout(() => el.style.opacity = 0, 1300);
  }
  function hitmarker(killed, head) {
    const h = $('hitmarker'); h.className = killed ? 'show kill' : head ? 'show head' : 'show';
    clearTimeout(hitmarker.t); hitmarker.t = setTimeout(() => h.className = '', 160);
    killed ? AU.kill() : AU.hit();
  }
  const dirEls = [];
  function damageDir(from) {
    const pl = G.player;
    const ang = Math.atan2(from.x - pl.pos.x, from.z - pl.pos.z);
    // relative to facing: forward is (-sin yaw, -cos yaw)
    const rel = -(ang - Math.atan2(-Math.sin(pl.yaw), -Math.cos(pl.yaw)));
    let el = dirEls.find(e => performance.now() - e._t > 1200);
    if (!el) { if (dirEls.length >= 4) el = dirEls[0]; else { el = document.createElement('div'); el.className = 'dmgdir'; $('dmgdirs').appendChild(el); dirEls.push(el); } }
    el._t = performance.now();
    el.style.transform = `translate(-50%,-50%) rotate(${rel}rad)`;
    el.style.animation = 'none'; void el.offsetWidth; el.style.animation = 'dirfade 1.2s forwards';
  }

  // ------------------------------------------------------------ maps
  function drawMinimap() {
    const cv = $('minimap'), x = cv.getContext('2d'), S = cv.width, pl = G.player;
    const c = pl.alive ? pl.pos : camera.position;
    const mpp = 1.6, view = S * mpp, k = mapCanvas.width / W.SIZE;
    x.save();
    x.clearRect(0, 0, S, S);
    x.beginPath(); x.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2); x.clip();
    x.fillStyle = '#334'; x.fillRect(0, 0, S, S);
    x.drawImage(mapCanvas, (c.x + W.HALF - view / 2) * k, (c.z + W.HALF - view / 2) * k, view * k, view * k, 0, 0, S, S);
    const toS = (wx, wz) => [S / 2 + (wx - c.x) / mpp, S / 2 + (wz - c.z) / mpp];
    drawZone(x, toS, 1 / mpp);
    drawChars(x, toS, 3.5);
    x.restore();
    x.strokeStyle = 'rgba(255,255,255,0.7)'; x.lineWidth = 2; x.beginPath(); x.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2); x.stroke();
    x.fillStyle = '#fff'; x.font = 'bold 11px sans-serif'; x.textAlign = 'center'; x.fillText('N', S / 2, 13);
  }
  function drawZone(x, toS, scale) {
    const Z = G.zone;
    x.strokeStyle = 'rgba(255,90,54,0.95)'; x.lineWidth = 2;
    let [zx, zy] = toS(Z.cx, Z.cz); x.beginPath(); x.arc(zx, zy, Z.r * scale, 0, Math.PI * 2); x.stroke();
    if (PHASES[Z.phase]) {
      [zx, zy] = toS(Z.nextCx, Z.nextCz);
      x.strokeStyle = 'rgba(255,255,255,0.9)'; x.setLineDash([5, 4]); x.beginPath(); x.arc(zx, zy, Z.nextR * scale, 0, Math.PI * 2); x.stroke(); x.setLineDash([]);
    }
  }
  function drawChars(x, toS, size) {
    for (const ch of G.chars) {
      if (!ch.alive || ch.isPlayer) continue;
      const enemySpotted = ch.team === 'red' && G.time - ch.lastFireT < 2.5;
      if (ch.team !== 'blue' && !enemySpotted) continue;
      const [sx, sy] = toS(ch.pos.x, ch.pos.z);
      x.fillStyle = ch.team === 'blue' ? '#4da3ff' : '#ff4040';
      x.beginPath(); x.arc(sx, sy, size, 0, Math.PI * 2); x.fill();
    }
    const pl = G.player;
    if (pl.alive) {
      const [sx, sy] = toS(pl.pos.x, pl.pos.z);
      x.save(); x.translate(sx, sy); x.rotate(-pl.yaw);
      x.fillStyle = '#ffe14d'; x.strokeStyle = '#000'; x.lineWidth = 1.5;
      x.beginPath(); x.moveTo(0, -size * 2.2); x.lineTo(size * 1.5, size * 1.6); x.lineTo(0, size * 0.8); x.lineTo(-size * 1.5, size * 1.6); x.closePath(); x.fill(); x.stroke();
      x.restore();
    }
  }
  function drawBigMap() {
    const cv = $('bigmap'), x = cv.getContext('2d'), S = cv.width, sc = S / W.SIZE;
    x.drawImage(mapCanvas, 0, 0, S, S);
    const toS = (wx, wz) => [(wx + W.HALF) * sc, (wz + W.HALF) * sc];
    drawZone(x, toS, sc);
    drawChars(x, toS, 4);
    x.fillStyle = 'rgba(0,0,0,0.55)'; x.fillRect(0, S - 26, S, 26);
    x.fillStyle = '#fff'; x.font = '13px sans-serif'; x.textAlign = 'left';
    x.fillText('Map 2km × 2km   ·   orange = zone   ·   dashed = next zone   ·   red dots = enemies who fired recently   ·   [M] close', 10, S - 9);
  }

  // ============================================================ menus / input
  function showEnd() {
    G.state = 'ended';
    document.exitPointerLock && document.exitPointerLock();
    $('center').textContent = ''; setHTML('spec', ''); G.timeScale = 1;
    const win = G.winner === 'blue';
    $('endtitle').textContent = win ? 'VICTORY' : 'DEFEAT';
    $('endtitle').className = win ? 'win' : 'lose';
    const sorted = G.chars.slice().sort((a, b) => b.kills - a.kills);
    const shown = sorted.slice(0, 12);
    if (!shown.includes(G.player)) shown.push(G.player);
    const rows = shown.map(c =>
      `<tr class="${c.team} ${c.isPlayer ? 'me' : ''}"><td>${c.name}</td><td>${c.team.toUpperCase()}</td><td>${c.kills}</td><td>${c.alive ? 'Alive' : 'Dead'}</td></tr>`).join('');
    $('endstats').innerHTML = `<p>${win ? 'Blue team' : 'Red team'} wins round ${G.round}.</p><table><tr><th>Player</th><th>Team</th><th>Kills</th><th>Status</th></tr>${rows}</table>`;
    $('end').classList.remove('hidden');
  }
  function applyQuality(q) {
    const hi = q === 'high', lo = q === 'low';
    renderer.setPixelRatio(lo ? 0.75 : hi ? Math.min(devicePixelRatio, 1.5) : 1);
    renderer.setSize(innerWidth, innerHeight);
    sun.castShadow = !lo;
    const ms = hi ? 2048 : 1024;
    if (sun.shadow.mapSize.x !== ms) { sun.shadow.mapSize.set(ms, ms); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; } }
    scene.fog.far = lo ? 550 : hi ? 900 : 700; scene.fog.near = lo ? 120 : 180;
    camera.far = scene.fog.far + 200; camera.updateProjectionMatrix();
  }
  function lock() { renderer.domElement.requestPointerLock(); }
  function bindInput() {
    const cv = renderer.domElement;
    $('play').onclick = () => {
      G.diff = DIFF[$('difficulty').value];
      applyQuality($('quality').value);
      G.blueSize = clamp(parseInt($('bluesize').value, 10) || 5, 1, 50);
      G.redSize = clamp(parseInt($('redsize').value, 10) || 5, 1, 50);
      startRound();
      input.sens = parseFloat($('sens').value);
      AU.init();
      $('menu').classList.add('hidden'); $('hud').classList.remove('hidden');
      G.state = 'playing'; lock();
    };
    $('resume').onclick = () => { $('pause').classList.add('hidden'); G.state = G.prevState || 'playing'; lock(); };
    $('again').onclick = () => { startRound(); G.state = 'playing'; $('end').classList.add('hidden'); lock(); };
    $('sens').oninput = e => { $('sensv').textContent = e.target.value; };
    $('bluesize').oninput = e => { $('bluesizev').textContent = e.target.value; };
    $('redsize').oninput = e => { $('redsizev').textContent = e.target.value; };
    document.addEventListener('pointerlockchange', () => {
      input.locked = document.pointerLockElement === cv;
      if (!input.locked && (G.state === 'playing' || G.state === 'ending')) {
        G.prevState = G.state; G.state = 'paused';
        input.mouseDown = false; input.keys = {};
        $('pause').classList.remove('hidden');
      }
    });
    document.addEventListener('mousemove', e => {
      if (!input.locked || !G.player.alive) return;
      const s = 0.0022 * input.sens * (camera.fov / BASE_FOV);
      const pl = G.player;
      if (pl.inCar) {
        P.camYaw -= e.movementX * s; P.camPitch = clamp(P.camPitch + e.movementY * s, -0.15, 1.1); P.camIdle = 0;
        return;
      }
      pl.yaw -= e.movementX * s; pl.pitch = clamp(pl.pitch - e.movementY * s, -1.5, 1.5);
      P.swayX = clamp(P.swayX - e.movementX * 0.00006, -0.02, 0.02); P.swayY = clamp(P.swayY + e.movementY * 0.00006, -0.02, 0.02);
    });
    cv.addEventListener('mousedown', e => {
      if (!input.locked) return;
      if (e.button === 0) {
        input.mouseDown = true; input.firePressedT = G.time;
        if (!G.player.alive) P.specIdx++;
      } else if (e.button === 2) {
        const pl = G.player;
        if (pl.alive && !pl.def.melee) { P.ads = !P.ads; }
      }
    });
    addEventListener('mouseup', e => { if (e.button === 0) input.mouseDown = false; });
    addEventListener('contextmenu', e => e.preventDefault());
    addEventListener('wheel', e => {
      if (!input.locked || !G.player.alive) return;
      equip((G.player.cur + (e.deltaY > 0 ? 1 : 2)) % 3);
    });
    addEventListener('keydown', e => {
      if (e.code === 'Tab') e.preventDefault();
      if (!input.locked) return;
      input.keys[e.code] = true;
      const pl = G.player;
      if (e.code === 'KeyM') { P.mapOpen = !P.mapOpen; $('bigmap').classList.toggle('hidden', !P.mapOpen); }
      if (e.code === 'KeyF' && !pl.alive) G.timeScale = G.timeScale > 1 ? 1 : 4;
      if (!pl.alive) return;
      if (e.code === 'Digit1') equip(0); if (e.code === 'Digit2') equip(1); if (e.code === 'Digit3') equip(2);
      if (e.code === 'KeyR') startReload(pl);
      if (e.code === 'KeyF') toggleCar();
      if (e.code === 'KeyE' && !G.useMedkit(pl) && !(pl.healT > 0)) feedMsg(pl.medkits <= 0 ? 'No medkits' : 'Health is already full');
      if (pl.inCar) return;
      if (e.code === 'KeyG') pressG();
      if (e.code === 'KeyC' || e.code === 'ControlLeft') pl.wantCrouch = !pl.wantCrouch;
      if (e.code === 'Space' && pl.wantCrouch) pl.wantCrouch = false;
    });
    addEventListener('keyup', e => { input.keys[e.code] = false; });
  }

  // debug hook (handy for testing in the console)
  BR.debug = { G, P, input, toggleCar, get camera() { return camera; }, startRound, spawnItem, step(n, dt) { for (let i = 0; i < n && G.state !== 'ended'; i++) update(dt || 0.05); } };

  window.addEventListener('load', () => setTimeout(() => {
    try { init(); } catch (err) { $('loading').innerHTML = 'Failed to start: ' + err.message; console.error(err); }
  }, 30));
})();
