'use strict';
// Characters (player + bots): physics, body models, bot AI
(function () {
  const GRAV = 22, JUMP = 7.4, STEP = 0.46;
  const W = BR.World, WEAP = BR.WEAPONS;
  const { clamp, angDiff, gauss, lerp } = BR;
  BR.PHYS = { GRAV, JUMP, STEP };

  const TEAM = {
    blue: { shirt: 0x2f62d6, dark: 0x1d3a80, pants: 0x2b3550 },
    red: { shirt: 0xc8352e, dark: 0x7a1d18, pants: 0x4a2b2b },
  };

  class Character {
    constructor(team, name, isPlayer) {
      this.team = team; this.name = name; this.isPlayer = !!isPlayer; this.isBot = !isPlayer;
      this.pos = new THREE.Vector3(); this.vel = new THREE.Vector3();
      this.radius = 0.35;
      this.reset();
    }
    reset() {
      this.hp = 100; this.alive = true; this.slots = [null, null, null]; this.cur = 0;
      this.medkits = 0; this.healT = 0; this.stamina = 100;
      this.fireCD = 0; this.reloadT = 0; this.switchT = 0; this.grounded = false; this.kills = 0;
      this.lastFireT = -99; this.deadT = 0; this.crouch = false; this.yaw = 0; this.pitch = 0;
      this.vel.set(0, 0, 0); this.moveSpeed = 0;
    }
    get item() { return this.slots[this.cur]; }
    get wtype() { const it = this.slots[this.cur]; return it ? it.type : 'fists'; }
    get def() { return WEAP[this.wtype]; }
    height() { return this.crouch ? 1.2 : 1.8; }
    eyeY() { return this.crouch ? 1.1 : 1.62; }
    headY() { return this.crouch ? 1.12 : 1.66; }
    bodyTop() { return this.crouch ? 0.95 : 1.45; }
    eye(out) { return out.set(this.pos.x, this.pos.y + this.eyeY(), this.pos.z); }
    chest(out) { return out.set(this.pos.x, this.pos.y + (this.crouch ? 0.8 : 1.2), this.pos.z); }
    forward(out) {
      const cp = Math.cos(this.pitch);
      return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
    }
    bestRank() { let r = 0; for (const s of this.slots) if (s) r = Math.max(r, WEAP[s.type].rank); return r; }

    physics(wx, wz, speed, jump, dt) {
      const v = this.vel, p = this.pos;
      const accel = this.grounded ? 14 : 2.5;
      const k = Math.min(1, accel * dt);
      v.x += (wx * speed - v.x) * k; v.z += (wz * speed - v.z) * k;
      if (jump && this.grounded) { v.y = JUMP; this.grounded = false; }
      v.y -= GRAV * dt;
      const ox = p.x, oz = p.z;
      p.x += v.x * dt; p.z += v.z * dt;
      const h = this.height();
      W.collideXZ(p, this.radius, p.y, h, STEP);
      const lim = W.HALF - 25;
      p.x = clamp(p.x, -lim, lim); p.z = clamp(p.z, -lim, lim);
      if (dt > 0) { this.moveSpeed = Math.hypot(p.x - ox, p.z - oz) / dt; }
      let ny = p.y + v.y * dt;
      if (v.y > 0) {
        const ceil = W.ceilingAt(p.x, p.z, this.radius * 0.9, p.y + h);
        if (ny + h > ceil) { ny = ceil - h; v.y = 0; }
      }
      const ground = W.groundAt(p.x, p.z, this.radius * 0.85, Math.max(p.y, ny), STEP);
      if (ny <= ground) { p.y = ground; v.y = 0; this.grounded = true; }
      else if (this.grounded && v.y <= 0 && ny - ground < 0.55) { p.y = ground; v.y = 0; this.grounded = true; }
      else { p.y = ny; this.grounded = false; }
      if (p.y < -200) p.y = W.getHeight(p.x, p.z) + 1;
    }
  }
  BR.Character = Character;

  // ------------------------------------------------------------ body model
  const boxG = {}, mats = {};
  const M = c => mats[c] || (mats[c] = new THREE.MeshLambertMaterial({ color: c }));
  function part(parent, w, h, d, c, x, y, z) {
    const k = w + ',' + h + ',' + d;
    const m = new THREE.Mesh(boxG[k] || (boxG[k] = new THREE.BoxGeometry(w, h, d)), M(c));
    m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m;
  }
  let markerTex = null;
  function makeModel(team, friendly) {
    const C = TEAM[team];
    const root = new THREE.Group(), body = new THREE.Group(); root.add(body);
    const legL = new THREE.Group(), legR = new THREE.Group();
    legL.position.set(-0.13, 0.92, 0); legR.position.set(0.13, 0.92, 0);
    part(legL, 0.19, 0.8, 0.22, C.pants, 0, -0.4, 0); part(legL, 0.2, 0.14, 0.3, 0x222222, 0, -0.85, -0.04);
    part(legR, 0.19, 0.8, 0.22, C.pants, 0, -0.4, 0); part(legR, 0.2, 0.14, 0.3, 0x222222, 0, -0.85, -0.04);
    body.add(legL, legR);
    const torso = part(body, 0.5, 0.6, 0.28, C.shirt, 0, 1.22, 0);
    part(body, 0.52, 0.3, 0.3, C.dark, 0, 1.3, 0); // vest
    part(body, 0.28, 0.28, 0.28, 0xd9a77a, 0, 1.66, 0);
    part(body, 0.33, 0.13, 0.34, C.dark, 0, 1.84, 0); // helmet
    part(body, 0.2, 0.05, 0.02, 0x111111, 0, 1.7, -0.145); // eyes band
    const armL = new THREE.Group(), armR = new THREE.Group();
    armL.position.set(-0.3, 1.47, 0); armR.position.set(0.3, 1.47, 0);
    part(armL, 0.13, 0.6, 0.14, C.shirt, 0, -0.3, 0); part(armL, 0.11, 0.1, 0.11, 0xd9a77a, 0, -0.62, 0);
    part(armR, 0.13, 0.6, 0.14, C.shirt, 0, -0.3, 0); part(armR, 0.11, 0.1, 0.11, 0xd9a77a, 0, -0.62, 0);
    body.add(armL, armR);
    const gunMount = new THREE.Group(); gunMount.position.set(0.12, 1.36, -0.42); body.add(gunMount);
    let marker = null;
    if (friendly) {
      if (!markerTex) {
        const cv = document.createElement('canvas'); cv.width = cv.height = 64;
        const x = cv.getContext('2d'); x.fillStyle = '#4da3ff'; x.strokeStyle = '#fff'; x.lineWidth = 4;
        x.beginPath(); x.moveTo(8, 12); x.lineTo(56, 12); x.lineTo(32, 52); x.closePath(); x.fill(); x.stroke();
        markerTex = new THREE.CanvasTexture(cv);
      }
      marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: markerTex, depthTest: false, transparent: true }));
      marker.scale.set(0.45, 0.45, 1); marker.position.y = 2.35; marker.renderOrder = 10; root.add(marker);
    }
    return { root, body, legL, legR, armL, armR, gunMount, torso, marker, gunType: null, gun: null };
  }

  // ------------------------------------------------------------ bots
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();
  // preferred fighting distance per weapon
  const PREF = { fists: 1, pistol: 22, nova: 8, smg: 18, ump45: 22, ak47: 40, m249: 40, sniper: 110 };

  class Bot extends Character {
    constructor(team, name, friendlyToPlayer) {
      super(team, name, false);
      this.model = makeModel(team, friendlyToPlayer);
      this.walkPhase = Math.random() * 6;
      this.resetAI();
    }
    resetAI() {
      this.ai = {
        state: 'loot', thinkT: Math.random() * 0.3, target: null, seenT: -99, lastSeen: new THREE.Vector3(),
        reactUntil: 0, err: 0.1, errYaw: 0, errPitch: 0, errT: 0,
        lootItem: null, blacklist: new Set(), goal: null, path: [], pathI: 0, pathGoal: null,
        roamDest: null, roamUntil: 0, strafe: 1, strafeT: 0, stuckT: 0.8, stuckPos: new THREE.Vector3(), stuckN: 0,
        detourT: 0, detourAng: 0, burstT: 0, pauseT: 0, semiT: 0, alertPos: null, alertT: -99, lookYaw: null, lookUntil: 0,
        jump: false, sprint: false,
      };
    }
    syncGun() {
      const m = this.model, t = this.wtype;
      if (m.gunType === t) return;
      if (m.gun) m.gunMount.remove(m.gun);
      m.gun = null; m.gunType = t;
      if (t !== 'fists') {
        m.gun = BR.makeWeaponModel(t, false);
        m.gun.traverse(o => { if (o.isMesh) o.castShadow = true; });
        m.gunMount.add(m.gun);
      }
    }
    muzzleWorld(out) {
      this.eye(out);
      const f = this.forward(tmpC);
      out.addScaledVector(f, 0.75);
      out.x += Math.cos(this.yaw) * 0.12; out.z -= Math.sin(this.yaw) * 0.12; out.y -= 0.28;
      return out;
    }

    // ---- perception
    scan(G) {
      const ai = this.ai, sight = this.def.scope ? 340 : 230;
      const eye = this.eye(tmpA), fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      const cand = [];
      for (const c of G.chars) {
        if (!c.alive || c.team === this.team) continue;
        const dx = c.pos.x - this.pos.x, dz = c.pos.z - this.pos.z, d = Math.hypot(dx, dz);
        if (d > sight) continue;
        const dot = d > 0.01 ? (dx * fx + dz * fz) / d : 1;
        const heard = G.time - c.lastFireT < 1.2 && d < 70;
        if (dot < 0.34 && d > 12 && !heard) continue;
        cand.push([d, c]);
      }
      // line-of-sight checks only on the nearest few candidates
      cand.sort((a, b) => a[0] - b[0]);
      for (let i = 0; i < cand.length && i < 4; i++) {
        const c = cand[i][1];
        if (W.lineOfSight(eye, c.chest(tmpB)) || W.lineOfSight(eye, tmpB.set(c.pos.x, c.pos.y + c.headY(), c.pos.z))) return c;
      }
      return null;
    }
    findLoot(G, range) {
      const my = this.bestRank(); let best = null, bd = range * range;
      for (const it of G.items) {
        if (it.upper || this.ai.blacklist.has(it)) continue;
        if (WEAP[it.inst.type].rank <= my) continue;
        const d = (it.x - this.pos.x) ** 2 + (it.z - this.pos.z) ** 2;
        if (d < bd) { bd = d; best = it; }
      }
      return best;
    }
    pickRoam(G) {
      const z = G.zone;
      const cx = z.nextCx, cz = z.nextCz, r = Math.max(10, z.nextR * 0.8);
      for (let i = 0; i < 20; i++) {
        const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * r;
        const x = clamp(cx + Math.cos(a) * d, -W.HALF + 60, W.HALF - 60), zz = clamp(cz + Math.sin(a) * d, -W.HALF + 60, W.HALF - 60);
        // prefer not-too-far legs of travel
        if (Math.hypot(x - this.pos.x, zz - this.pos.z) > 350 && i < 15) continue;
        const y = W.getHeight(x, zz);
        if (!W.buildingAt(x, y + 0.5, zz)) return new THREE.Vector3(x, y, zz);
      }
      return new THREE.Vector3(cx, W.getHeight(cx, cz), cz);
    }
    onDamaged(attacker, G) {
      if (!attacker || attacker.team === this.team) return;
      const ai = this.ai;
      if (!ai.target || G.time - ai.seenT > 1) {
        ai.target = attacker; ai.lastSeen.copy(attacker.pos); ai.seenT = G.time - 0.5;
      }
      ai.lookYaw = Math.atan2(-(attacker.pos.x - this.pos.x), -(attacker.pos.z - this.pos.z)); ai.lookUntil = G.time + 1.5;
    }
    hearShot(shooter, G) {
      const ai = this.ai;
      ai.alertPos = shooter.pos.clone(); ai.alertT = G.time;
      if (!ai.target) { ai.lookYaw = Math.atan2(-(shooter.pos.x - this.pos.x), -(shooter.pos.z - this.pos.z)); ai.lookUntil = G.time + 1.2; }
    }
    think(G) {
      const ai = this.ai, now = G.time, D = G.diff;
      const enemy = this.scan(G);
      if (enemy) {
        if (ai.target !== enemy || now - ai.seenT > 2) {
          ai.reactUntil = now + D.react * (0.7 + Math.random() * 0.6); ai.err = D.err0;
        }
        ai.target = enemy; ai.seenT = now; ai.lastSeen.copy(enemy.pos);
      }
      if (ai.target && (!ai.target.alive || now - ai.seenT > 6)) ai.target = null;
      const def = this.def, melee = !!def.melee;
      const visible = ai.target && now - ai.seenT < 0.45;
      const dist = ai.target ? ai.target.pos.distanceTo(this.pos) : Infinity;
      if (visible && (!melee || dist < 30)) ai.state = 'engage';
      else if (ai.target && !melee && def.rank >= 2) ai.state = 'hunt';
      else if (def.rank < 3) ai.state = 'loot';
      else ai.state = 'roam';

      if (ai.state === 'loot' || ai.state === 'roam') {
        if (ai.lootItem && (ai.lootItem.removed || ai.blacklist.has(ai.lootItem) || WEAP[ai.lootItem.inst.type].rank <= this.bestRank())) ai.lootItem = null;
        if (!ai.lootItem) ai.lootItem = ai.state === 'loot' ? (this.findLoot(G, 130) || this.findLoot(G, 450)) : (this.bestRank() < 5 ? this.findLoot(G, 35) : null);
        if (ai.lootItem) ai.state = 'loot';
        else if (ai.state === 'loot') ai.state = 'roam';
      }
      // goals
      if (ai.state === 'loot') ai.goal = tmpGoal(ai, ai.lootItem.x, ai.lootItem.y, ai.lootItem.z);
      else if (ai.state === 'hunt') {
        ai.goal = tmpGoal(ai, ai.lastSeen.x, ai.lastSeen.y, ai.lastSeen.z);
        if (this.pos.distanceTo(ai.lastSeen) < 3) ai.target = null;
      } else if (ai.state === 'roam') {
        const z = G.zone, outside = Math.hypot(this.pos.x - z.nextCx, this.pos.z - z.nextCz) > z.nextR * 0.9;
        if (ai.alertPos && now - ai.alertT < 8 && ai.alertPos.distanceTo(this.pos) < 160 && !outside) {
          ai.roamDest = ai.alertPos.clone(); ai.alertPos = null; ai.roamUntil = now + 25;
        }
        if (!ai.roamDest || now > ai.roamUntil || this.pos.distanceTo(ai.roamDest) < 4 ||
            (outside && Math.hypot(ai.roamDest.x - z.nextCx, ai.roamDest.z - z.nextCz) > z.nextR)) {
          ai.roamDest = this.pickRoam(G); ai.roamUntil = now + 40 + Math.random() * 30;
        }
        ai.goal = ai.roamDest;
      } else ai.goal = null;
      // medkits: heal when out of combat, detour to grab one when hurt (same rules as for any bot)
      const safe = !ai.target || now - ai.seenT > 2;
      if (safe && this.hp <= 55 && this.medkits > 0) G.useMedkit(this);
      if ((ai.state === 'loot' || ai.state === 'roam') && this.hp < 80 && this.medkits < 2) {
        const mk = G.nearestMedkit(this.pos, 45);
        if (mk) ai.goal = tmpGoal(ai, mk.x, mk.y, mk.z);
      }
      if (ai.goal && (!ai.pathGoal || ai.pathGoal.distanceToSquared(ai.goal) > 9)) {
        ai.path = W.route(this.pos, ai.goal); ai.pathI = 0; ai.pathGoal = ai.goal.clone();
      }
    }

    // ---- per-frame update
    update(dt, G) {
      const m = this.model;
      if (!this.alive) {
        m.body.rotation.x = Math.min(Math.PI / 2, m.body.rotation.x + dt * 3.5);
        m.body.position.y = -Math.min(0.15, m.body.rotation.x * 0.1);
        return;
      }
      const ai = this.ai, now = G.time, D = G.diff;
      ai.thinkT -= dt;
      if (ai.thinkT <= 0) { ai.thinkT = 0.18 + Math.random() * 0.12; this.think(G); }

      let wx = 0, wz = 0, speed = 4.8, trigger = false, jump = false;
      let faceYaw = null, facePitch = 0;
      const def = this.def;

      if (ai.state === 'engage' && ai.target) {
        const t = ai.target, eye = this.eye(tmpA);
        const aim = t.chest(tmpB);
        const dx = aim.x - eye.x, dy = aim.y - eye.y, dz = aim.z - eye.z, hd = Math.hypot(dx, dz), dist = Math.hypot(hd, dy);
        ai.errT -= dt;
        if (ai.errT <= 0) {
          ai.errT = 0.3 + Math.random() * 0.3;
          const mag = ai.err * (this.moveSpeed > 1 ? 1.3 : 1) * (t.moveSpeed > 4 ? 1.4 : 1);
          ai.errYaw = gauss() * mag; ai.errPitch = gauss() * mag * 0.6;
        }
        ai.err = Math.max(D.errMin, ai.err * Math.exp(-dt * D.settle));
        faceYaw = Math.atan2(-dx, -dz) + ai.errYaw;
        facePitch = Math.atan2(dy, hd) + ai.errPitch;
        const off = Math.abs(angDiff(this.yaw, faceYaw)) + Math.abs(this.pitch - facePitch);
        const canShoot = now > ai.reactUntil && now - ai.seenT < 0.35 && off < 0.06;
        if (def.melee) {
          const toward = this.dirTo(t.pos);
          wx = toward[0]; wz = toward[1]; speed = 6.8;
          trigger = dist < def.range && canShoot;
          if (t.pos.y - this.pos.y > 0.8 && dist < 4) jump = true;
        } else {
          const pref = PREF[this.wtype];
          ai.strafeT -= dt;
          if (ai.strafeT <= 0) { ai.strafeT = 0.7 + Math.random() * 1.5; ai.strafe = Math.random() < 0.5 ? -1 : 1; if (Math.random() < 0.25) ai.strafe = 0; }
          const fx = dx / (hd || 1), fz = dz / (hd || 1);
          if (dist > pref * 1.7 || now - ai.seenT > 0.3) { wx = fx; wz = fz; }
          else if (dist < 6) { wx = -fx; wz = -fz; }
          else if (!def.scope) { wx = -fz * ai.strafe; wz = fx * ai.strafe; speed = 3.6; }
          if (canShoot) {
            if (def.auto) {
              if (ai.burstT > 0) { ai.burstT -= dt; trigger = true; if (ai.burstT <= 0) ai.pauseT = 0.25 + Math.random() * 0.45 + (dist > 80 ? 0.3 : 0); }
              else if ((ai.pauseT -= dt) <= 0) ai.burstT = 0.3 + Math.random() * 0.6;
            } else {
              ai.semiT -= dt;
              if (ai.semiT <= 0 && (!def.pellets || dist < 35)) {
                trigger = true;
                ai.semiT = def.scope ? 1.4 + Math.random() * 1.2 : def.pellets ? 0.9 + Math.random() * 0.3 : 0.3 + Math.random() * 0.35;
              }
            }
          }
        }
      } else if (ai.goal) {
        ai.sprint = ai.state !== 'hunt';
        speed = ai.sprint ? 8.5 : 4.8;
        const path = ai.path;
        while (ai.pathI < path.length - 1 && Math.hypot(path[ai.pathI].x - this.pos.x, path[ai.pathI].z - this.pos.z) < 1.3) ai.pathI++;
        const wp = path[ai.pathI] || ai.goal;
        const d = Math.hypot(wp.x - this.pos.x, wp.z - this.pos.z);
        if (d > 0.4 || ai.pathI < path.length - 1) { const t = this.dirTo(wp); wx = t[0]; wz = t[1]; }
        if (ai.pathI === path.length - 1 && d < 2.5) speed = 2.5;
        faceYaw = Math.atan2(-wx, -wz);
        if (ai.lookUntil > now && ai.lookYaw !== null) faceYaw = ai.lookYaw;
        else if (!wx && !wz) faceYaw = this.yaw + Math.sin(now * 0.7) * 0.5;
        facePitch = 0;
      }

      // stuck handling / detours
      const wants = wx !== 0 || wz !== 0;
      ai.stuckT -= dt;
      if (ai.stuckT <= 0) {
        ai.stuckT = 0.7;
        const moved = Math.hypot(this.pos.x - ai.stuckPos.x, this.pos.z - ai.stuckPos.z);
        if (wants && moved < 0.5 && ai.detourT <= 0) {
          ai.stuckN++;
          ai.detourT = 0.8 + Math.random() * 0.6; ai.detourAng = (Math.random() < 0.5 ? -1 : 1) * (1.2 + Math.random() * 0.8);
          ai.jump = true;
          if (ai.stuckN > 5 && ai.state === 'loot' && ai.lootItem) { ai.blacklist.add(ai.lootItem); ai.lootItem = null; ai.stuckN = 0; }
          if (ai.stuckN > 3) ai.pathGoal = null; // force re-route
        } else if (moved > 1.5) ai.stuckN = Math.max(0, ai.stuckN - 1);
        ai.stuckPos.copy(this.pos);
      }
      if (ai.detourT > 0 && wants) {
        ai.detourT -= dt;
        const c = Math.cos(ai.detourAng), s = Math.sin(ai.detourAng);
        const nx = wx * c - wz * s, nz = wx * s + wz * c; wx = nx; wz = nz;
        if (ai.state !== 'engage') faceYaw = Math.atan2(-wx, -wz);
      }
      if (ai.jump) { jump = true; ai.jump = false; }

      // turn
      if (faceYaw !== null) {
        const maxT = (ai.state === 'engage' ? D.turn : 6) * dt;
        this.yaw += clamp(angDiff(this.yaw, faceYaw), -maxT, maxT);
        this.pitch += clamp(facePitch - this.pitch, -maxT, maxT);
      }
      this.physics(wx, wz, speed * (def.speedMult || 1), jump, dt);
      G.updateWeapon(this, dt, trigger && !(this.healT > 0));
      this.tryPickup(G);

      // animate
      m.root.position.copy(this.pos);
      m.root.rotation.y = this.yaw;
      const sp = Math.min(1, this.moveSpeed / 5);
      // stride follows distance travelled; running = longer strides, forward lean, bounce, gun lowered
      this.walkPhase += this.moveSpeed * dt * 1.15;
      const run = clamp((this.moveSpeed - 5) / 3, 0, 1) * (ai.state === 'engage' ? 0.3 : 1);
      const sw = Math.sin(this.walkPhase) * (0.6 + run * 0.35) * sp;
      m.legL.rotation.x = sw; m.legR.rotation.x = -sw;
      m.body.rotation.x = -0.22 * run;
      m.body.position.y = Math.abs(Math.sin(this.walkPhase)) * (0.03 + run * 0.06) * sp;
      const armed = this.wtype !== 'fists';
      const aimX = Math.PI / 2 + this.pitch;
      if (armed) {
        m.armR.rotation.x = lerp(aimX, 0.9 + sw * 0.15, run); m.armL.rotation.x = lerp(aimX, 1.1 - sw * 0.15, run);
        m.armL.rotation.z = -0.5; m.armR.rotation.z = 0.15;
      } else {
        m.armR.rotation.x = -sw * (0.8 + run * 0.6) + (this.fireCD > 0.2 ? 1.4 : 0); m.armL.rotation.x = sw * (0.8 + run * 0.6);
        m.armL.rotation.z = 0; m.armR.rotation.z = 0;
      }
      m.gunMount.rotation.x = lerp(this.pitch, -0.6, run);
      m.gunMount.position.y = lerp(1.36, 1.2, run);
      m.gunMount.visible = armed;
      this.syncGun();
    }
    dirTo(p) {
      const dx = p.x - this.pos.x, dz = p.z - this.pos.z, d = Math.hypot(dx, dz) || 1;
      return [dx / d, dz / d];
    }
    tryPickup(G) {
      G.pickMedkits(this);
      const my = this.bestRank();
      for (const it of G.items) {
        if (it.removed) continue;
        const dx = it.x - this.pos.x, dz = it.z - this.pos.z;
        if (dx * dx + dz * dz > 2.2 || Math.abs(it.y - this.pos.y) > 1.6) continue;
        if (it.noPickBy === this && G.time < it.noPickUntil) continue;
        if (WEAP[it.inst.type].rank <= my) continue;
        if (this.slots[0]) G.dropItem(this, 0);
        this.slots[0] = it.inst; this.cur = 0; this.switchT = 0.4; this.reloadT = 0;
        G.removeItem(it);
        this.ai.lootItem = null; this.ai.stuckN = 0;
        return;
      }
    }
  }
  function tmpGoal(ai, x, y, z) {
    if (!ai._goal) ai._goal = new THREE.Vector3();
    return ai._goal.set(x, y, z);
  }
  BR.Bot = Bot;
})();
