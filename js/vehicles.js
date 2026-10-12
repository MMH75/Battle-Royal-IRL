'use strict';
// Drivable cars: models, driving physics, collisions, running people over
(function () {
  const { clamp } = BR;
  const HW = 0.95, HL = 2.2, H = 1.85, WHEELBASE = 2.7;
  BR.CAR = { HW, HL, H };

  const mats = {}, geos = {};
  const M = c => mats[c] || (mats[c] = new THREE.MeshLambertMaterial({ color: c }));
  function box(p, w, h, d, c, x, y, z) {
    const k = w + ',' + h + ',' + d;
    const m = new THREE.Mesh(geos[k] || (geos[k] = new THREE.BoxGeometry(w, h, d)), M(c));
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; p.add(m); return m;
  }
  const wheelGeo = new THREE.CylinderGeometry(0.38, 0.38, 0.3, 12); wheelGeo.rotateZ(Math.PI / 2);
  const lightMat = new THREE.MeshBasicMaterial({ color: 0xfff6c0 }), tailMat = new THREE.MeshBasicMaterial({ color: 0xd01010 });

  // car forward is local +z
  BR.makeCar = function (col) {
    const mesh = new THREE.Group(); mesh.rotation.order = 'YXZ';
    box(mesh, 1.9, 0.72, 4.3, col, 0, 0.74, 0);
    box(mesh, 1.7, 0.62, 2.1, 0x24313d, 0, 1.4, -0.15);
    box(mesh, 1.74, 0.07, 1.9, col, 0, 1.74, -0.15);
    box(mesh, 1.95, 0.18, 0.15, 0x222222, 0, 0.5, 2.18);
    box(mesh, 1.95, 0.18, 0.15, 0x222222, 0, 0.5, -2.18);
    for (const s of [-1, 1]) {
      const h = new THREE.Mesh(geos.light || (geos.light = new THREE.BoxGeometry(0.35, 0.14, 0.05)), lightMat);
      h.position.set(0.6 * s, 0.85, 2.16); mesh.add(h);
      const t = new THREE.Mesh(geos.light, tailMat); t.position.set(0.6 * s, 0.85, -2.16); mesh.add(t);
    }
    const wheels = [], front = [];
    for (const [x, z] of [[1, 1.4], [-1, 1.4], [1, -1.35], [-1, -1.35]]) {
      const pivot = new THREE.Group(); pivot.position.set(0.92 * x, 0.38, z); mesh.add(pivot);
      const w = new THREE.Mesh(wheelGeo, M(0x151515)); w.castShadow = true; pivot.add(w);
      wheels.push(w); if (z > 0) front.push(pivot);
    }
    return { mesh, wheels, front, x: 0, y: 0, z: 0, ang: 0, speed: 0, steer: 0, driver: null, spin: 0, hitCD: new Map() };
  };

  function settle(car) {
    const W = BR.World;
    const s = Math.sin(car.ang), c = Math.cos(car.ang);
    const at = (lx, lz) => W.getHeight(car.x + lx * c + lz * s, car.z - lx * s + lz * c);
    const hf = at(0, HL - 0.4), hb = at(0, -HL + 0.4), hl = at(HW, 0), hr = at(-HW, 0);
    car.y = Math.max((hf + hb) / 2, (hl + hr) / 2, W.getHeight(car.x, car.z)) - 0.03;
    car.mesh.position.set(car.x, car.y, car.z);
    car.mesh.rotation.set(Math.atan2(hb - hf, 2 * (HL - 0.4)), car.ang, Math.atan2(hl - hr, 2 * HW));
  }
  BR.resetCar = function (car) {
    car.x = car.home.x; car.z = car.home.z; car.ang = car.home.ang;
    car.speed = 0; car.steer = 0; car.driver = null; car.hitCD.clear();
    settle(car);
  };

  // blocked by buildings, trees, rocks or other cars?
  function blocked(car, x, z, ang) {
    const W = BR.World, s = Math.sin(ang), c = Math.cos(ang);
    for (const o of [-1.35, 0, 1.35]) {
      const px = x + s * o, pz = z + c * o, gy = W.getHeight(px, pz);
      if (W.circleBlocked(px, pz, 1.0, gy + 0.6, gy + 1.9, car)) return true;
    }
    return false;
  }

  BR.Vehicles = {
    // ctl: {throttle -1..1, steer -1..1, brake bool} for the player's car
    update(dt, G, ctl) {
      const W = BR.World;
      for (const car of W.cars) {
        const driven = car.driver && car.driver.alive;
        if (!driven && Math.abs(car.speed) < 0.02) { car.speed = 0; continue; }
        if (driven && ctl) {
          const th = ctl.throttle;
          if (th > 0) car.speed += (car.speed < -0.5 ? 16 : 8.5) * th * dt;
          else if (th < 0) car.speed += (car.speed > 0.5 ? 16 : 6) * th * dt;
          else car.speed -= Math.sign(car.speed) * Math.min(Math.abs(car.speed), 2.5 * dt);
          if (ctl.brake) car.speed -= Math.sign(car.speed) * Math.min(Math.abs(car.speed), 18 * dt);
          const maxSteer = 0.55 / (1 + Math.abs(car.speed) * 0.07);
          car.steer += clamp(ctl.steer * maxSteer - car.steer, -3 * dt, 3 * dt);
        } else {
          car.speed -= Math.sign(car.speed) * Math.min(Math.abs(car.speed), 6 * dt);
          car.steer *= Math.exp(-dt * 3);
        }
        car.speed = clamp(car.speed, -9, 30);
        // steering
        const yawRate = clamp(car.speed * Math.tan(car.steer) / WHEELBASE, -1.4, 1.4);
        const na = car.ang + yawRate * dt;
        if (!blocked(car, car.x, car.z, na)) car.ang = na;
        // movement
        const nx = car.x + Math.sin(car.ang) * car.speed * dt, nz = car.z + Math.cos(car.ang) * car.speed * dt;
        const lim = W.HALF - 30;
        if (blocked(car, nx, nz, car.ang) || Math.abs(nx) > lim || Math.abs(nz) > lim) {
          const impact = Math.abs(car.speed);
          if (impact > 4) BR.Audio.thud(Math.min(1, impact / 25), car.driver && car.driver.isPlayer ? 0 : G.camDist(car));
          if (impact > 14 && car.driver) G.applyDamage(car.driver, (impact - 14) * 3, null, 'car', false);
          car.speed = -car.speed * 0.25;
        } else { car.x = nx; car.z = nz; }
        settle(car);
        car.spin += car.speed * dt / 0.38;
        for (const w of car.wheels) w.rotation.x = car.spin;
        for (const f of car.front) f.rotation.y = car.steer;
        this.hitPeople(car, G);
      }
    },
    hitPeople(car, G) {
      const W = BR.World, sp = Math.abs(car.speed);
      if (sp < 0.5) return;
      for (const ch of G.chars) {
        if (!ch.alive || ch === car.driver || ch.inCar) continue;
        if (Math.abs(ch.pos.x - car.x) > 4 || Math.abs(ch.pos.z - car.z) > 4 || Math.abs(ch.pos.y - car.y) > 1.8) continue;
        const [lx, lz] = W.carLocal(car, ch.pos.x, ch.pos.z);
        if (Math.abs(lx) > HW + 0.4 || Math.abs(lz) > HL + 0.4) continue;
        const d = car.driver;
        if (sp > 5 && d && d.team !== ch.team && !(car.hitCD.get(ch) > G.time)) {
          car.hitCD.set(ch, G.time + 0.6);
          G.applyDamage(ch, sp * 5, d, 'car', false);
          BR.Audio.thud(0.6, G.camDist(car));
        }
        // shove the person out of the car's way (sideways)
        const side = lx >= 0 ? 1 : -1;
        const [wx, wz] = W.carWorld(car, side * (HW + 0.45), lz);
        ch.pos.x = wx; ch.pos.z = wz;
      }
    },
    nearestCar(pos, maxD) {
      const W = BR.World; let best = null, bd = maxD;
      for (const car of W.cars) {
        if (car.driver || Math.abs(pos.x - car.x) > 6 || Math.abs(pos.z - car.z) > 6) continue;
        const [lx, lz] = W.carLocal(car, pos.x, pos.z);
        const dx = Math.max(0, Math.abs(lx) - HW), dz = Math.max(0, Math.abs(lz) - HL), d = Math.hypot(dx, dz);
        if (d < bd) { bd = d; best = car; }
      }
      return best;
    },
  };
})();
