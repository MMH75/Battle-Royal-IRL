'use strict';
// World generation: terrain, roads, towns, enterable buildings, trees, rocks, cars,
// plus collision (AABB grid) and raycasting.
(function () {
  const SIZE = 2000, HALF = SIZE / 2, N = 250, CS = SIZE / N;
  const CELL = 16, GN = Math.ceil(SIZE / CELL);
  const W = BR.World = { SIZE, HALF };
  const { clamp, lerp, smoothstep, distSeg, segRect } = BR;

  let H = null;                 // terrain heights (N+1)^2
  let grid = new Array(GN * GN);
  let colliders = [];
  let stamp = 1;
  W.buildings = []; W.towns = []; W.roads = []; W.lootSpots = []; W.trees = [];

  // ---------------------------------------------------------------- terrain height
  function getHeight(x, z) {
    const gx = (x + HALF) / CS, gz = (z + HALF) / CS;
    let i = Math.floor(gx), j = Math.floor(gz);
    if (i < 0) i = 0; else if (i > N - 1) i = N - 1;
    if (j < 0) j = 0; else if (j > N - 1) j = N - 1;
    const u = clamp(gx - i, 0, 1), v = clamp(gz - j, 0, 1);
    const r = N + 1;
    const h00 = H[j * r + i], h10 = H[j * r + i + 1], h01 = H[(j + 1) * r + i], h11 = H[(j + 1) * r + i + 1];
    if (u + v <= 1) return h00 + (h10 - h00) * u + (h01 - h00) * v;
    return h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
  }
  W.getHeight = getHeight;

  // ---------------------------------------------------------------- colliders
  function cellOf(v) { let c = Math.floor((v + HALF) / CELL); return c < 0 ? 0 : c >= GN ? GN - 1 : c; }
  function addCollider(minx, miny, minz, maxx, maxy, maxz) {
    const c = { minx, miny, minz, maxx, maxy, maxz, s: 0 };
    colliders.push(c);
    const x0 = cellOf(minx), x1 = cellOf(maxx), z0 = cellOf(minz), z1 = cellOf(maxz);
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      const k = z * GN + x; (grid[k] || (grid[k] = [])).push(c);
    }
    return c;
  }
  W.addCollider = addCollider;

  function forRect(minx, minz, maxx, maxz, fn) {
    const s = ++stamp;
    const x0 = cellOf(minx), x1 = cellOf(maxx), z0 = cellOf(minz), z1 = cellOf(maxz);
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      const arr = grid[z * GN + x]; if (!arr) continue;
      for (let i = 0; i < arr.length; i++) { const c = arr[i]; if (c.s !== s) { c.s = s; fn(c); } }
    }
  }
  function circleHits(x, z, r, c) {
    const cx = x < c.minx ? c.minx : x > c.maxx ? c.maxx : x;
    const cz = z < c.minz ? c.minz : z > c.maxz ? c.maxz : z;
    const dx = x - cx, dz = z - cz;
    return dx * dx + dz * dz < r * r;
  }

  // highest walkable surface under a circle (terrain or collider tops within step)
  W.groundAt = function (x, z, r, feetY, step) {
    let g = getHeight(x, z);
    const lim = feetY + step;
    forRect(x - r, z - r, x + r, z + r, c => {
      if (c.maxy <= lim && c.maxy > g && circleHits(x, z, r, c)) g = c.maxy;
    });
    return g;
  };
  W.ceilingAt = function (x, z, r, headY) {
    let ceil = Infinity;
    forRect(x - r, z - r, x + r, z + r, c => {
      if (c.miny >= headY - 0.35 && c.miny < ceil && circleHits(x, z, r, c)) ceil = c.miny;
    });
    return ceil;
  };
  // push a circle out of colliders that block between feet+step and head
  W.collideXZ = function (pos, r, feetY, height, step) {
    let hit = false;
    for (let it = 0; it < 2; it++) {
      forRect(pos.x - r, pos.z - r, pos.x + r, pos.z + r, c => {
        if (c.maxy <= feetY + step || c.miny >= feetY + height) return;
        const x = pos.x, z = pos.z;
        const cx = x < c.minx ? c.minx : x > c.maxx ? c.maxx : x;
        const cz = z < c.minz ? c.minz : z > c.maxz ? c.maxz : z;
        let dx = x - cx, dz = z - cz; const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) return;
        hit = true;
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2), push = (r - d) / d;
          pos.x += dx * push; pos.z += dz * push;
        } else {
          const l = x - c.minx, rr = c.maxx - x, b = z - c.minz, f = c.maxz - z;
          const m = Math.min(l, rr, b, f);
          if (m === l) pos.x = c.minx - r; else if (m === rr) pos.x = c.maxx + r;
          else if (m === b) pos.z = c.minz - r; else pos.z = c.maxz + r;
        }
      });
    }
    // cars (rotated boxes, can move so they are not in the grid)
    for (const car of W.cars) {
      if (car.y >= feetY + height || car.y + BR.CAR.H <= feetY + step) continue;
      if (Math.abs(pos.x - car.x) > 3.5 || Math.abs(pos.z - car.z) > 3.5) continue;
      const [lx, lz] = carLocal(car, pos.x, pos.z), hw = BR.CAR.HW, hl = BR.CAR.HL;
      const cx = clamp(lx, -hw, hw), cz = clamp(lz, -hl, hl);
      let dx = lx - cx, dz = lz - cz; const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      hit = true;
      let nx, nz;
      if (d2 > 1e-8) { const d = Math.sqrt(d2); nx = cx + dx / d * r; nz = cz + dz / d * r; }
      else if (hw - Math.abs(lx) < hl - Math.abs(lz)) { nx = Math.sign(lx || 1) * (hw + r); nz = lz; }
      else { nx = lx; nz = Math.sign(lz || 1) * (hl + r); }
      const [wx, wz] = carWorld(car, nx, nz); pos.x = wx; pos.z = wz;
    }
    return hit;
  };
  // car local <-> world (car forward is local +z)
  function carLocal(c, x, z) {
    const dx = x - c.x, dz = z - c.z, co = Math.cos(c.ang), si = Math.sin(c.ang);
    return [dx * co - dz * si, dx * si + dz * co];
  }
  function carWorld(c, lx, lz) {
    const co = Math.cos(c.ang), si = Math.sin(c.ang);
    return [c.x + lx * co + lz * si, c.z - lx * si + lz * co];
  }
  W.carLocal = carLocal; W.carWorld = carWorld;
  function circleHitsCar(car, x, z, r) {
    if (Math.abs(x - car.x) > 3.5 || Math.abs(z - car.z) > 3.5) return false;
    const [lx, lz] = carLocal(car, x, z);
    const dx = Math.max(0, Math.abs(lx) - BR.CAR.HW), dz = Math.max(0, Math.abs(lz) - BR.CAR.HL);
    return dx * dx + dz * dz < r * r;
  }
  // anything solid between heights y0..y1 overlapping the circle? (used by driving cars)
  W.circleBlocked = function (x, z, r, y0, y1, ignoreCar) {
    let b = false;
    forRect(x - r, z - r, x + r, z + r, c => { if (!b && c.maxy > y0 && c.miny < y1 && circleHits(x, z, r, c)) b = true; });
    if (b) return true;
    for (const car of W.cars) if (car !== ignoreCar && circleHitsCar(car, x, z, r)) return true;
    return false;
  };
  // is a spot free of tall colliders?
  W.isFree = function (x, z, r, y) {
    let free = true;
    forRect(x - r, z - r, x + r, z + r, c => {
      if (free && c.maxy > y + 0.4 && c.miny < y + 1.9 && circleHits(x, z, r, c)) free = false;
    });
    if (free) for (const car of W.cars) if (circleHitsCar(car, x, z, r)) return false;
    return free;
  };

  W.anyNear = function (x, z, r) {
    let any = false;
    forRect(x - r, z - r, x + r, z + r, c => { if (!any && circleHits(x, z, r, c)) any = true; });
    if (!any) for (const car of W.cars) if (circleHitsCar(car, x, z, r)) return true;
    return any;
  };

  function rayAABB(o, d, c) {
    let tmin = 0, tmax = Infinity;
    const ox = [o.x, o.y, o.z], dd = [d.x, d.y, d.z];
    const mn = [c.minx, c.miny, c.minz], mx = [c.maxx, c.maxy, c.maxz];
    for (let i = 0; i < 3; i++) {
      if (Math.abs(dd[i]) < 1e-9) { if (ox[i] < mn[i] || ox[i] > mx[i]) return -1; }
      else {
        let t1 = (mn[i] - ox[i]) / dd[i], t2 = (mx[i] - ox[i]) / dd[i];
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
        if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2;
        if (tmin > tmax) return -1;
      }
    }
    return tmin;
  }
  W.rayAABB = rayAABB;
  const _lo = new THREE.Vector3(), _ld = new THREE.Vector3(), _box = {};

  // raycast against colliders + terrain. returns {t, hit}
  W.raycast = function (o, d, maxT) {
    let best = maxT, hit = false;
    // colliders: march through grid cells
    const s = ++stamp, step = CELL * 0.25;
    let lastCell = -1;
    for (let t = 0; t <= best + CELL * 0.5; t += step) {
      const px = o.x + d.x * t, pz = o.z + d.z * t;
      if (px < -HALF || px > HALF || pz < -HALF || pz > HALF) break;
      const k = cellOf(pz) * GN + cellOf(px);
      if (k === lastCell) continue; lastCell = k;
      const arr = grid[k]; if (!arr) continue;
      for (let i = 0; i < arr.length; i++) {
        const c = arr[i]; if (c.s === s) continue; c.s = s;
        const tc = rayAABB(o, d, c);
        if (tc >= 0 && tc < best) { best = tc; hit = true; }
      }
    }
    // cars: body blocks bullets, the windows above it do not
    for (const car of W.cars) {
      const vx = car.x - o.x, vy = car.y + 0.8 - o.y, vz = car.z - o.z;
      const tc = vx * d.x + vy * d.y + vz * d.z;
      if (tc < -3 || tc > best + 3) continue;
      const px = vx - d.x * tc, py = vy - d.y * tc, pz = vz - d.z * tc;
      if (px * px + py * py + pz * pz > 9) continue;
      const co = Math.cos(car.ang), si = Math.sin(car.ang);
      const ox = o.x - car.x, oz = o.z - car.z;
      _lo.set(ox * co - oz * si, o.y, ox * si + oz * co);
      _ld.set(d.x * co - d.z * si, d.y, d.x * si + d.z * co);
      _box.minx = -BR.CAR.HW; _box.maxx = BR.CAR.HW; _box.minz = -BR.CAR.HL; _box.maxz = BR.CAR.HL;
      _box.miny = car.y + 0.35; _box.maxy = car.y + 1.1;
      const t = rayAABB(_lo, _ld, _box);
      if (t >= 0 && t < best) { best = t; hit = true; }
    }
    // terrain march
    const tstep = 1.5;
    let prevT = 0;
    for (let t = tstep; t <= best; t += tstep) {
      const y = o.y + d.y * t;
      if (d.y > 0 && y > 160) break;
      const px = o.x + d.x * t, pz = o.z + d.z * t;
      if (y < getHeight(px, pz)) {
        let a = prevT, b = t;
        for (let i = 0; i < 7; i++) {
          const m = (a + b) / 2;
          if (o.y + d.y * m < getHeight(o.x + d.x * m, o.z + d.z * m)) b = m; else a = m;
        }
        if (b < best) { best = b; hit = true; }
        break;
      }
      prevT = t;
    }
    return { t: best, hit };
  };
  const _d = new THREE.Vector3();
  W.lineOfSight = function (a, b) {
    _d.subVectors(b, a); const dist = _d.length(); if (dist < 0.01) return true;
    _d.multiplyScalar(1 / dist);
    return W.raycast(a, _d, dist).t >= dist - 0.3;
  };

  W.buildingAt = function (x, y, z) {
    for (const b of W.buildings) {
      if (x > b.minx + 0.1 && x < b.maxx - 0.1 && z > b.minz + 0.1 && z < b.maxz - 0.1 && y > b.f0 - 1.2 && y < b.top) return b;
    }
    return null;
  };

  // ---------------------------------------------------------------- navigation helpers
  function aroundRect(a, b, minx, minz, maxx, maxz) {
    const m = 2.2, im = 1.0;
    const C = [[minx - m, minz - m], [maxx + m, minz - m], [maxx + m, maxz + m], [minx - m, maxz + m]];
    const hit = (p, q) => segRect(p[0], p[1], q[0], q[1], minx - im, minz - im, maxx + im, maxz + im) >= 0;
    const A = [a.x, a.z], B = [b.x, b.z];
    const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    let best = null, bestC = Infinity;
    for (let i = 0; i < 4; i++) {
      if (!hit(A, C[i]) && !hit(C[i], B)) { const c = dist(A, C[i]) + dist(C[i], B); if (c < bestC) { bestC = c; best = [C[i]]; } }
      for (const j of [(i + 1) % 4, (i + 3) % 4]) {
        if (!hit(A, C[i]) && !hit(C[j], B)) { const c = dist(A, C[i]) + dist(C[i], C[j]) + dist(C[j], B); if (c < bestC) { bestC = c; best = [C[i], C[j]]; } }
      }
    }
    return best ? best.map(p => new THREE.Vector3(p[0], getHeight(p[0], p[1]), p[1])) : [];
  }
  function detour(a, b, depth) {
    if (depth > 3) return [];
    let bestB = null, bestT = 2;
    for (const bd of W.buildings) {
      if (a.x > bd.minx - 1.1 && a.x < bd.maxx + 1.1 && a.z > bd.minz - 1.1 && a.z < bd.maxz + 1.1) continue;
      if (b.x > bd.minx - 1.1 && b.x < bd.maxx + 1.1 && b.z > bd.minz - 1.1 && b.z < bd.maxz + 1.1) continue;
      const t = segRect(a.x, a.z, b.x, b.z, bd.minx - 0.8, bd.minz - 0.8, bd.maxx + 0.8, bd.maxz + 0.8);
      if (t >= 0 && t < bestT) { bestT = t; bestB = bd; }
    }
    if (!bestB) return [];
    const pts = aroundRect(a, b, bestB.minx, bestB.minz, bestB.maxx, bestB.maxz);
    if (!pts.length) return [];
    const out = [];
    let prev = a;
    for (const p of pts) { out.push(...detour(prev, p, depth + 1), p); prev = p; }
    out.push(...detour(prev, b, depth + 1));
    return out;
  }
  function nearestDoor(b, p) {
    let best = b.doors[0], bd = Infinity;
    for (const d of b.doors) { const dd = d.out.distanceToSquared(p); if (dd < bd) { bd = dd; best = d; } }
    return best;
  }
  // returns list of waypoints from 'from' to 'to'
  W.route = function (from, to) {
    const bf = W.buildingAt(from.x, from.y, from.z), bt = W.buildingAt(to.x, to.y, to.z);
    if (bf && bf === bt) return [to.clone()];
    const pts = [];
    let cur = from;
    if (bf) { const d = nearestDoor(bf, to); pts.push(d.inp, d.out); cur = d.out; }
    if (bt) {
      const d = nearestDoor(bt, cur);
      pts.push(...detour(cur, d.out, 0), d.out, d.inp);
    } else {
      pts.push(...detour(cur, to, 0));
    }
    pts.push(to.clone());
    return pts;
  };

  // ---------------------------------------------------------------- geometry helpers
  function pushBox(A, x0, y0, z0, x1, y1, z1, col) {
    const sx = x1 - x0, sy = y1 - y0, sz = z1 - z0;
    const faces = [
      [[x1, y0, z0], [0, sy, 0], [0, 0, sz], [1, 0, 0]],
      [[x0, y0, z0], [0, 0, sz], [0, sy, 0], [-1, 0, 0]],
      [[x0, y1, z0], [0, 0, sz], [sx, 0, 0], [0, 1, 0]],
      [[x0, y0, z0], [sx, 0, 0], [0, 0, sz], [0, -1, 0]],
      [[x0, y0, z1], [sx, 0, 0], [0, sy, 0], [0, 0, 1]],
      [[x0, y0, z0], [0, sy, 0], [sx, 0, 0], [0, 0, -1]],
    ];
    for (const [o, u, v, n] of faces) {
      const a = o, b = [o[0] + u[0], o[1] + u[1], o[2] + u[2]];
      const c = [b[0] + v[0], b[1] + v[1], b[2] + v[2]], d = [o[0] + v[0], o[1] + v[1], o[2] + v[2]];
      for (const p of [a, b, c, a, c, d]) { A.p.push(p[0], p[1], p[2]); A.n.push(n[0], n[1], n[2]); A.c.push(col.r, col.g, col.b); }
    }
  }
  function makeMesh(A, mat) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(A.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(A.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(A.c, 3));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.castShadow = true; m.receiveShadow = true;
    return m;
  }

  // ---------------------------------------------------------------- generation
  W.generate = function (scene, seed) {
    const rng = BR.mulberry32(seed);
    const noise = BR.makeNoise2D(rng), noise2 = BR.makeNoise2D(rng), noiseF = BR.makeNoise2D(rng);
    grid = new Array(GN * GN); colliders = W.colliders = [];
    W.buildings = []; W.towns = []; W.roads = []; W.lootSpots = []; W.trees = []; W.cars = []; W.windows = [];
    const towns = W.towns, roads = W.roads;

    function baseH(x, z) {
      let h = (noise.fbm(x * 0.0021 + 50, z * 0.0021 + 50, 5) - 0.5) * 170;
      h += (noise2(x * 0.012, z * 0.012) - 0.5) * 7;
      const e = Math.max(Math.abs(x), Math.abs(z)) / HALF;
      if (e > 0.82) h += Math.pow((e - 0.82) / 0.18, 2) * 95;
      return h;
    }
    // towns
    const addTown = (x, z, name) => towns.push({ x, z, r: 75 + rng() * 35, axis: rng() < 0.5 ? 0 : 1, name });
    addTown(-640, (rng() - 0.5) * 300, 'Blue Base');
    addTown(640, (rng() - 0.5) * 300, 'Red Base');
    const names = ['Pinewood', 'Dustvale', 'Hillcrest', 'Old Mill', 'Riverside', 'Stonegate', 'Ashford', 'Millbrook'];
    for (let tries = 0; towns.length < 9 && tries < 800; tries++) {
      const x = (rng() - 0.5) * 1500, z = (rng() - 0.5) * 1500;
      if (towns.every(t => Math.hypot(t.x - x, t.z - z) > 290)) addTown(x, z, names[towns.length - 2]);
    }
    for (const t of towns) t.h = baseH(t.x, t.z);

    function h1(x, z) {
      let h = baseH(x, z);
      for (const t of towns) {
        const d = Math.hypot(x - t.x, z - t.z);
        if (d < t.r * 1.8) h = lerp(h, t.h, 1 - smoothstep(t.r, t.r * 1.8, d));
      }
      return h;
    }
    // roads: MST between towns + extra links + main streets
    const inTree = [0], edges = [];
    while (inTree.length < towns.length) {
      let best = null, bd = Infinity;
      for (const i of inTree) for (let j = 0; j < towns.length; j++) {
        if (inTree.includes(j)) continue;
        const d = Math.hypot(towns[i].x - towns[j].x, towns[i].z - towns[j].z);
        if (d < bd) { bd = d; best = [i, j]; }
      }
      inTree.push(best[1]); edges.push(best);
    }
    const extra = [];
    for (let i = 0; i < towns.length; i++) for (let j = i + 1; j < towns.length; j++) {
      if (edges.some(e => (e[0] === i && e[1] === j) || (e[0] === j && e[1] === i))) continue;
      extra.push([i, j, Math.hypot(towns[i].x - towns[j].x, towns[i].z - towns[j].z)]);
    }
    extra.sort((a, b) => a[2] - b[2]);
    for (let k = 0; k < 3 && k < extra.length; k++) edges.push([extra[k][0], extra[k][1]]);
    for (const [i, j] of edges) roads.push({ ax: towns[i].x, az: towns[i].z, bx: towns[j].x, bz: towns[j].z, w: 8 });
    for (const t of towns) {
      const dx = t.axis === 0 ? 1 : 0, dz = 1 - dx, L = t.r * 1.15;
      roads.push({ ax: t.x - dx * L, az: t.z - dz * L, bx: t.x + dx * L, bz: t.z + dz * L, w: 7, street: true });
      // cross street
      const L2 = t.r * 0.6;
      roads.push({ ax: t.x - dz * L2, az: t.z - dx * L2, bx: t.x + dz * L2, bz: t.z + dx * L2, w: 6, street: true });
    }
    function h2(x, z) {
      let h = h1(x, z);
      for (const r of roads) {
        const s = distSeg(x, z, r.ax, r.az, r.bx, r.bz);
        if (s.d < 18) h = lerp(h, h1(s.x, s.z), 1 - smoothstep(r.w * 0.6, 18, s.d));
      }
      return h;
    }
    // height grid
    H = new Float32Array((N + 1) * (N + 1));
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) H[j * (N + 1) + i] = h2(-HALF + i * CS, -HALF + j * CS);

    // terrain mesh
    {
      const pos = new Float32Array((N + 1) * (N + 1) * 3), col = new Float32Array((N + 1) * (N + 1) * 3);
      for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
        const k = j * (N + 1) + i, x = -HALF + i * CS, z = -HALF + j * CS, h = H[k];
        pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
        const hl = H[j * (N + 1) + Math.max(0, i - 1)], hr = H[j * (N + 1) + Math.min(N, i + 1)];
        const hd = H[Math.max(0, j - 1) * (N + 1) + i], hu = H[Math.min(N, j + 1) * (N + 1) + i];
        const slope = Math.hypot(hr - hl, hu - hd) / (2 * CS);
        const v = noise2(x * 0.03, z * 0.03) * 0.15 - 0.07;
        let r = 0.32 + v, g = 0.52 + v, b = 0.2 + v * 0.5;
        const dry = noiseF(x * 0.004 + 9, z * 0.004);
        if (dry > 0.6) { r += 0.12; g += 0.04; }
        const rock = smoothstep(0.45, 0.8, slope);
        r = lerp(r, 0.45, rock); g = lerp(g, 0.42, rock); b = lerp(b, 0.36, rock);
        const snow = smoothstep(75, 95, h);
        r = lerp(r, 0.94, snow); g = lerp(g, 0.95, snow); b = lerp(b, 0.97, snow);
        col[k * 3] = r; col[k * 3 + 1] = g; col[k * 3 + 2] = b;
      }
      const idx = new Uint32Array(N * N * 6); let q = 0;
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const v00 = j * (N + 1) + i, v10 = v00 + 1, v01 = v00 + N + 1, v11 = v01 + 1;
        idx[q++] = v00; idx[q++] = v01; idx[q++] = v10;
        idx[q++] = v10; idx[q++] = v01; idx[q++] = v11;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
      m.receiveShadow = true;
      scene.add(m);
    }

    // road meshes
    {
      const A = { p: [], c: [] }, L = { p: [], c: [] };
      const asphalt = new THREE.Color(0x3b3d40), paint = new THREE.Color(0xd8cf9a);
      const strip = (T, r, half, off, colr, dashed) => {
        const dx = r.bx - r.ax, dz = r.bz - r.az, len = Math.hypot(dx, dz), ux = dx / len, uz = dz / len;
        const px = -uz, pz = ux, n = Math.ceil(len / 3);
        for (let i = 0; i < n; i++) {
          if (dashed && i % 3 === 2) continue;
          const t0 = i / n * len, t1 = (i + 1) / n * len;
          const pts = [];
          for (const [t, s] of [[t0, -1], [t0, 1], [t1, -1], [t1, 1]]) {
            const x = r.ax + ux * t + px * half * s, z = r.az + uz * t + pz * half * s;
            pts.push([x, getHeight(x, z) + off, z]);
          }
          for (const p of [pts[0], pts[2], pts[1], pts[1], pts[2], pts[3]]) { T.p.push(p[0], p[1], p[2]); T.c.push(colr.r, colr.g, colr.b); }
        }
      };
      for (const r of roads) { strip(A, r, r.w / 2, 0.14, asphalt, false); if (!r.street) strip(L, r, 0.15, 0.17, paint, true); }
      for (const [T, po] of [[A, -2], [L, -4]]) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(T.p, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(T.c, 3));
        g.computeVertexNormals();
        const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: po, polygonOffsetUnits: po, side: THREE.DoubleSide }));
        m.receiveShadow = true;
        scene.add(m);
      }
    }

    // ---------------------------------------------------------- buildings
    const bmat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const PAL = [0xd8c8a8, 0xe8e4dc, 0xa0523d, 0x9a9a9a, 0xa9bfcf, 0xd9c27a, 0xb7c9a8, 0xc98f6b];
    const rects = [];
    function rectFree(minx, minz, maxx, maxz, margin) {
      for (const r of rects) if (minx - margin < r[2] && maxx + margin > r[0] && minz - margin < r[3] && maxz + margin > r[1]) return false;
      for (const r of roads) {
        const cx = (minx + maxx) / 2, cz = (minz + maxz) / 2, hd = Math.hypot(maxx - minx, maxz - minz) / 2;
        if (distSeg(cx, cz, r.ax, r.az, r.bx, r.bz).d > hd + r.w / 2 + 3) continue;
        if (segRect(r.ax, r.az, r.bx, r.bz, minx - r.w / 2 - 2, minz - r.w / 2 - 2, maxx + r.w / 2 + 2, maxz + r.w / 2 + 2) >= 0) return false;
      }
      return true;
    }
    function rotK(x, z, k) { return k === 0 ? [x, z] : k === 1 ? [-z, x] : k === 2 ? [-x, -z] : [z, -x]; }
    function kFromDir(dx, dz) { return dz < -0.5 ? 0 : dx > 0.5 ? 1 : dz > 0.5 ? 2 : 3; }

    // wins (optional): collects window openings so players can vault through them
    function wallX(B, z0, z1, x0, x1, y0, h, ops, col, wins) {
      ops = ops.slice().sort((a, b) => a.c - b.c); let cur = x0;
      for (const o of ops) {
        const a = o.c - o.w / 2, b = o.c + o.w / 2;
        if (wins && o.b > 0) wins.push({ lx: o.c, lz: (z0 + z1) / 2, nx: 0, nz: 1, y0: y0 + o.b, y1: y0 + o.t, hw: o.w / 2 });
        if (a > cur) B.push([cur, y0, z0, a, y0 + h, z1, col]);
        if (o.b > 0) B.push([a, y0, z0, b, y0 + o.b, z1, col]);
        if (o.t < h) B.push([a, y0 + o.t, z0, b, y0 + h, z1, col]);
        cur = b;
      }
      if (cur < x1) B.push([cur, y0, z0, x1, y0 + h, z1, col]);
    }
    function wallZ(B, x0, x1, z0, z1, y0, h, ops, col, wins) {
      ops = ops.slice().sort((a, b) => a.c - b.c); let cur = z0;
      for (const o of ops) {
        const a = o.c - o.w / 2, b = o.c + o.w / 2;
        if (wins && o.b > 0) wins.push({ lx: (x0 + x1) / 2, lz: o.c, nx: 1, nz: 0, y0: y0 + o.b, y1: y0 + o.t, hw: o.w / 2 });
        if (a > cur) B.push([x0, y0, cur, x1, y0 + h, a, col]);
        if (o.b > 0) B.push([x0, y0, a, x1, y0 + o.b, b, col]);
        if (o.t < h) B.push([x0, y0 + o.t, a, x1, y0 + h, b, col]);
        cur = b;
      }
      if (cur < z1) B.push([x0, y0, cur, x1, y0 + h, z1, col]);
    }
    function windows(L, avoid, b, t) {
      const n = Math.max(1, Math.floor((L - 1.5) / 3.2)), out = [];
      for (let i = 0; i < n; i++) {
        const c = -L / 2 + (i + 0.5) * L / n;
        if (avoid.some(a => Math.abs(a - c) < 1.8)) continue;
        out.push({ c, w: 1.3, b, t });
      }
      return out;
    }

    function placeBuilding(type, cx, cz, k, inTown) {
      let w, d, floors, FH;
      if (type === 'warehouse') { w = 18 + rng() * 6; d = 13 + rng() * 4; floors = 1; FH = 6; }
      else { w = 10 + rng() * 4; d = 9 + rng() * 3; floors = type === 'house3' ? 3 : type === 'house2' ? 2 : 1; FH = 3.2; }
      w = Math.round(w * 2) / 2; d = Math.round(d * 2) / 2;
      const hx = (k % 2 ? d : w) / 2, hz = (k % 2 ? w : d) / 2;
      const minx = cx - hx, maxx = cx + hx, minz = cz - hz, maxz = cz + hz;
      if (Math.abs(cx) > HALF - 120 || Math.abs(cz) > HALF - 120) return false;
      if (!rectFree(minx, minz, maxx, maxz, inTown ? 3 : 6)) return false;
      let minH = Infinity, maxH = -Infinity;
      for (let a = 0; a <= 2; a++) for (let b = 0; b <= 2; b++) {
        const h = getHeight(lerp(minx, maxx, a / 2), lerp(minz, maxz, b / 2));
        minH = Math.min(minH, h); maxH = Math.max(maxH, h);
      }
      if (maxH - minH > (inTown ? 3 : 2.2)) return false;
      rects.push([minx, minz, maxx, maxz]);

      const f0 = maxH + 0.25, T = 0.3, B = [], wins = [];
      const wallCol = new THREE.Color(PAL[Math.floor(rng() * PAL.length)]);
      const innerCol = wallCol.clone().lerp(new THREE.Color(0xffffff), 0.35);
      const floorCol = new THREE.Color(type === 'warehouse' ? 0x7a7a76 : 0x8a6a48);
      const roofCol = new THREE.Color(type === 'warehouse' ? 0x6b7078 : 0x5a4a42);
      const baseCol = new THREE.Color(0x77736b);
      const crateCol = new THREE.Color(0x9a7442);
      const Htot = floors * FH;
      // foundation slab (top = floor)
      B.push([-w / 2, minH - 0.8 - f0, -d / 2, w / 2, -0.12, d / 2, baseCol]);
      B.push([-w / 2 + T, -0.12, -d / 2 + T, w / 2 - T, 0, d / 2 - T, floorCol]);
      const doors = [];
      let doorX, doorW, doorH, stair = null;
      if (type === 'warehouse') { doorX = 0; doorW = 4; doorH = 4.2; }
      else { doorX = -w / 4; doorW = 1.4; doorH = 2.3; }
      doors.push({ x: doorX, z: -1, w: doorW });
      // one stair flight per storey, alternating right wall / left wall so they don't overlap
      const flights = [];
      for (let f = 0; f < floors - 1; f++) {
        const right = f % 2 === 0, zs = -d / 2 + T + 2.0;
        const sx0 = right ? w / 2 - T - 1.3 : -w / 2 + T, sx1 = right ? w / 2 - T : -w / 2 + T + 1.3;
        flights.push({ sx0, sx1, zs, ze: zs + 3.6, right });
        for (let i = 0; i < 10; i++) B.push([sx0, f * FH, zs + i * 0.36, sx1, f * FH + (i + 1) * FH / 10, zs + (i + 1) * 0.36, floorCol]);
      }
      stair = flights[0] || null;
      const backDoorX = w / 4;
      for (let f = 0; f < floors; f++) {
        const y0 = f * FH;
        const wb = type === 'warehouse' ? 3.8 : 1.0, wt = type === 'warehouse' ? 5.2 : 2.1;
        const fo = windows(w, f === 0 ? [doorX] : [], wb, wt);
        if (f === 0) fo.push({ c: doorX, w: doorW, b: 0, t: doorH });
        wallX(B, -d / 2, -d / 2 + T, -w / 2, w / 2, y0, FH, fo, wallCol, wins);
        const bo = windows(w, f === 0 && type === 'warehouse' ? [backDoorX] : [], wb, wt);
        if (f === 0 && type === 'warehouse') bo.push({ c: backDoorX, w: 1.4, b: 0, t: 2.4 });
        wallX(B, d / 2 - T, d / 2, -w / 2, w / 2, y0, FH, bo, wallCol, wins);
        // no windows on a wall that has a stair flight running along it on this storey
        const leftStair = flights[f] && !flights[f].right, rightStair = !!stair;
        wallZ(B, -w / 2, -w / 2 + T, -d / 2 + T, d / 2 - T, y0, FH, leftStair ? [] : windows(d - 2 * T, [], wb, wt), wallCol, wins);
        wallZ(B, w / 2 - T, w / 2, -d / 2 + T, d / 2 - T, y0, FH, rightStair ? [] : windows(d - 2 * T, [], wb, wt), wallCol, wins);
        if (f > 0) {
          // floor slab with a hole above the flight coming up from below, plus railings around it
          const s = flights[f - 1], yA = y0 - 0.25;
          const IX0 = -w / 2 + T, IX1 = w / 2 - T, IZ0 = -d / 2 + T, IZ1 = d / 2 - T;
          const hx0 = s.right ? s.sx0 - 0.1 : IX0, hx1 = s.right ? IX1 : s.sx1 + 0.1;
          if (hx0 > IX0) B.push([IX0, yA, IZ0, hx0, y0, IZ1, floorCol]);
          if (hx1 < IX1) B.push([hx1, yA, IZ0, IX1, y0, IZ1, floorCol]);
          B.push([hx0, yA, IZ0, hx1, y0, s.zs - 0.1, floorCol]);
          B.push([hx0, yA, s.ze, hx1, y0, IZ1, floorCol]);
          if (s.right) B.push([hx0 - 0.15, y0, s.zs - 0.1, hx0, y0 + 1.0, s.ze, innerCol]);
          else B.push([hx1, y0, s.zs - 0.1, hx1 + 0.15, y0 + 1.0, s.ze, innerCol]);
          B.push([hx0, y0, s.zs - 0.25, hx1, y0 + 1.0, s.zs - 0.1, innerCol]);
          // upper floor partition with doorway
          const px = -w / 2 + w * 0.42;
          wallZ(B, px - 0.1, px + 0.1, -d / 2 + T, d / 2 - T, y0, FH, [{ c: 0, w: 1.2, b: 0, t: 2.2 }], innerCol);
        }
      }
      if (type === 'warehouse') doors.push({ x: backDoorX, z: 1, w: 1.4 });
      // roof
      B.push([-w / 2 - 0.25, Htot, -d / 2 - 0.25, w / 2 + 0.25, Htot + 0.3, d / 2 + 0.25, roofCol]);
      // furniture / cover
      const loot = [];
      if (type === 'warehouse') {
        const nC = 5 + Math.floor(rng() * 5);
        for (let i = 0; i < nC; i++) {
          const x = (rng() - 0.5) * (w - 4), z = (rng() - 0.3) * (d - 5) * 0.8;
          if (Math.abs(x) < 3 && z < -d / 2 + 5) continue;
          B.push([x - 0.6, 0, z - 0.6, x + 0.6, 1.2, z + 0.6, crateCol]);
          if (rng() < 0.4) B.push([x - 0.5, 1.2, z - 0.5, x + 0.5, 2.2, z + 0.5, crateCol]);
        }
        for (let i = 0; i < 5; i++) loot.push([(rng() - 0.5) * (w - 3), (rng() - 0.5) * (d - 3), 0]);
      } else {
        B.push([-w / 2 + T + 0.1, 0, d / 2 - T - 1.1, -w / 2 + T + 1.1, 1.0, d / 2 - T - 0.1, crateCol]);
        if (rng() < 0.6) B.push([-w / 2 + T + 1.2, 0, d / 2 - T - 1.0, -w / 2 + T + 2.0, 0.8, d / 2 - T - 0.2, crateCol]);
        const tx = -w / 8 + (rng() - 0.5) * 2;
        B.push([tx - 0.8, 0, 0.3, tx + 0.8, 0.8, 1.2, new THREE.Color(0x6b4a2e)]);
        loot.push([-w / 4, d / 4 - 0.5, 0], [w / 8, -d / 6, 0], [-w / 3, -d / 5 + 0.5, 0]);
        for (let f = 1; f < floors; f++) loot.push([-w / 2 + T + 2.3, d / 4, f * FH, true], [w / 6, d / 3 - 0.5, f * FH, true]);
        if (floors === 2) B.push([-w / 2 + T + 0.1, FH, -d / 2 + T + 0.1, -w / 2 + T + 1.1, FH + 1.0, -d / 2 + T + 1.1, crateCol]);
      }
      // door stoops
      const front = rotK(0, -1, k);
      for (const dr of doors) {
        const [ox, oz] = rotK(dr.x, dr.z * (d / 2 + 1.0), k);
        const gy = getHeight(cx + ox, cz + oz);
        const n = Math.floor((f0 - gy) / 0.3);
        for (let i = 1; i <= n && i < 12; i++) {
          const zz = dr.z * d / 2;
          const za = zz + dr.z * 0.4 * (i - 1), zb = zz + dr.z * 0.4 * i;
          B.push([dr.x - dr.w / 2 - 0.3, gy - 1 - f0, Math.min(za, zb), dr.x + dr.w / 2 + 0.3, -0.3 * i, Math.max(za, zb), baseCol]);
        }
      }
      // emit
      const A = { p: [], n: [], c: [] };
      for (const bx of B) {
        const [a0, a1] = rotK(bx[0], bx[2], k), [b0, b1] = rotK(bx[3], bx[5], k);
        const x0 = cx + Math.min(a0, b0), x1 = cx + Math.max(a0, b0), z0 = cz + Math.min(a1, b1), z1 = cz + Math.max(a1, b1);
        const y0 = f0 + bx[1], y1 = f0 + bx[4];
        const col = bx[6].clone().multiplyScalar(0.94 + rng() * 0.1);
        pushBox(A, x0, y0, z0, x1, y1, z1, col);
        addCollider(x0, y0, z0, x1, y1, z1);
      }
      scene.add(makeMesh(A, bmat));
      const bld = { minx, minz, maxx, maxz, f0, top: f0 + Htot + 0.3, type, doors: [], cx, cz };
      for (const dr of doors) {
        const [ox, oz] = rotK(dr.x, dr.z * (d / 2 + 2.6), k), [ix, iz] = rotK(dr.x, dr.z * (d / 2 - 1.6), k);
        bld.doors.push({
          out: new THREE.Vector3(cx + ox, getHeight(cx + ox, cz + oz), cz + oz),
          inp: new THREE.Vector3(cx + ix, f0, cz + iz),
        });
      }
      for (const l of loot) {
        const [lx, lz] = rotK(l[0], l[1], k);
        W.lootSpots.push({ x: cx + lx, y: f0 + l[2], z: cz + lz, upper: !!l[3] });
      }
      for (const wn of wins) {
        const [wx, wz] = rotK(wn.lx, wn.lz, k), [nx, nz] = rotK(wn.nx, wn.nz, k);
        W.windows.push({ x: cx + wx, z: cz + wz, nx, nz, y0: f0 + wn.y0, y1: f0 + wn.y1, hw: wn.hw });
      }
      W.buildings.push(bld);
      return true;
    }

    const pickType = () => { const r = rng(); return r < 0.16 ? 'warehouse' : r < 0.32 ? 'house3' : r < 0.62 ? 'house2' : 'house1'; };
    for (const t of towns) {
      const dx = t.axis === 0 ? 1 : 0, dz = 1 - dx, px = dz, pz = dx;
      let placed = 0;
      for (let i = 0; i < 60 && placed < 14; i++) {
        const along = (rng() * 2 - 1) * t.r, side = rng() < 0.5 ? -1 : 1, type = pickType();
        const depth = type === 'warehouse' ? 15 : 10.5;
        const off = 6 + depth / 2 + rng() * 5;
        const cx = t.x + dx * along + px * side * off, cz = t.z + dz * along + pz * side * off;
        const k = kFromDir(-px * side, -pz * side);
        if (placeBuilding(type, cx, cz, k, true)) placed++;
      }
      // second row facing the cross street / outward
      for (let i = 0; i < 40 && placed < 20; i++) {
        const a = rng() * Math.PI * 2, r = t.r * (0.5 + rng() * 0.6);
        const cx = t.x + Math.cos(a) * r, cz = t.z + Math.sin(a) * r;
        const ddx = t.x - cx, ddz = t.z - cz;
        const k = Math.abs(ddx) > Math.abs(ddz) ? kFromDir(Math.sign(ddx), 0) : kFromDir(0, Math.sign(ddz));
        if (placeBuilding(pickType(), cx, cz, k, true)) placed++;
      }
    }
    // lone buildings scattered around the map
    for (let i = 0, placed = 0; i < 400 && placed < 45; i++) {
      const cx = (rng() - 0.5) * 1650, cz = (rng() - 0.5) * 1650;
      if (towns.some(t => Math.hypot(t.x - cx, t.z - cz) < t.r * 1.3)) continue;
      const r = rng();
      if (placeBuilding(r < 0.15 ? 'warehouse' : r < 0.27 ? 'house3' : r < 0.6 ? 'house2' : 'house1', cx, cz, Math.floor(rng() * 4), false)) placed++;
    }

    // ---------------------------------------------------------- cars along roads
    {
      const cars = [];
      for (const r of roads) {
        const len = Math.hypot(r.bx - r.ax, r.bz - r.az);
        const n = Math.floor(len / (r.street ? 45 : 110));
        for (let i = 0; i < n; i++) {
          const t = 0.08 + rng() * 0.84, ux = (r.bx - r.ax) / len, uz = (r.bz - r.az) / len;
          const side = (rng() < 0.5 ? -1 : 1) * (r.w / 2 - 1.2);
          const x = r.ax + (r.bx - r.ax) * t - uz * side, z = r.az + (r.bz - r.az) * t + ux * side;
          const ang = Math.atan2(ux, uz) + (rng() - 0.5) * 0.5;
          if (cars.some(c => Math.hypot(c.x - x, c.z - z) < 7)) continue;
          cars.push({ x, z, ang, col: [0x8c1c1c, 0x2a4b7c, 0xd0d0d0, 0x2b2b2b, 0x5d6b3a, 0xc9a227][Math.floor(rng() * 6)] });
        }
      }
      // every car is its own object so it can be driven
      for (const c of cars) {
        const car = BR.makeCar(c.col);
        car.home = { x: c.x, z: c.z, ang: c.ang };
        scene.add(car.mesh);
        W.cars.push(car);
        BR.resetCar(car);
      }
    }

    // ---------------------------------------------------------- trees and rocks
    {
      const trees = [];
      for (let i = 0; i < 26000 && trees.length < 5000; i++) {
        const x = (rng() - 0.5) * (SIZE - 60), z = (rng() - 0.5) * (SIZE - 60);
        const f = noiseF.fbm(x * 0.003, z * 0.003, 3);
        if (rng() > (f > 0.55 ? 0.95 : f > 0.48 ? 0.35 : 0.05)) continue;
        if (towns.some(t => Math.hypot(t.x - x, t.z - z) < t.r * 0.95)) continue;
        if (roads.some(r => distSeg(x, z, r.ax, r.az, r.bx, r.bz).d < r.w / 2 + 4)) continue;
        const y = getHeight(x, z);
        if (y > 80) continue;
        if (W.anyNear(x, z, 3)) continue;
        const s = 0.8 + rng() * 0.7;
        trees.push({ x, y, z, s, pine: rng() < 0.6, rot: rng() * 6.28 });
        addCollider(x - 0.3 * s, y - 1, z - 0.3 * s, x + 0.3 * s, y + 6 * s, z + 0.3 * s);
      }
      W.trees = trees;
      const trunkG = new THREE.CylinderGeometry(0.22, 0.32, 4, 6); trunkG.translate(0, 2, 0);
      const pineG = new THREE.ConeGeometry(2.0, 6.5, 7); pineG.translate(0, 6.2, 0);
      const roundG = new THREE.IcosahedronGeometry(2.4, 0); roundG.translate(0, 5.6, 0);
      const pines = trees.filter(t => t.pine), rounds = trees.filter(t => !t.pine);
      const mT = new THREE.InstancedMesh(trunkG, new THREE.MeshLambertMaterial({ color: 0x5b4030 }), trees.length);
      const mP = new THREE.InstancedMesh(pineG, new THREE.MeshLambertMaterial({ color: 0xffffff }), pines.length);
      const mR = new THREE.InstancedMesh(roundG, new THREE.MeshLambertMaterial({ color: 0xffffff }), rounds.length);
      const mat = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), p = new THREE.Vector3();
      const c = new THREE.Color();
      const set = (m, i, t) => { q.setFromEuler(e.set(0, t.rot, 0)); mat.compose(p.set(t.x, t.y - 0.2, t.z), q, sc.set(t.s, t.s, t.s)); m.setMatrixAt(i, mat); };
      trees.forEach((t, i) => set(mT, i, t));
      pines.forEach((t, i) => { set(mP, i, t); mP.setColorAt(i, c.setHSL(0.3 + rng() * 0.06, 0.45, 0.2 + rng() * 0.08)); });
      rounds.forEach((t, i) => { set(mR, i, t); mR.setColorAt(i, c.setHSL(0.22 + rng() * 0.08, 0.45, 0.27 + rng() * 0.1)); });
      for (const m of [mT, mP, mR]) { m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; scene.add(m); }

      const rocks = [];
      for (let i = 0; i < 4000 && rocks.length < 700; i++) {
        const x = (rng() - 0.5) * (SIZE - 60), z = (rng() - 0.5) * (SIZE - 60);
        if (towns.some(t => Math.hypot(t.x - x, t.z - z) < t.r)) continue;
        if (roads.some(r => distSeg(x, z, r.ax, r.az, r.bx, r.bz).d < r.w / 2 + 3)) continue;
        const y = getHeight(x, z);
        if (W.anyNear(x, z, 2.5)) continue;
        const s = 0.6 + Math.pow(rng(), 2) * 2.2;
        rocks.push({ x, y, z, s, sx: s * (0.8 + rng() * 0.5), sy: s * (0.5 + rng() * 0.4), sz: s * (0.8 + rng() * 0.5), rot: rng() * 6.28 });
      }
      const rockG = new THREE.DodecahedronGeometry(1, 0);
      const mRk = new THREE.InstancedMesh(rockG, new THREE.MeshLambertMaterial({ color: 0xffffff }), rocks.length);
      rocks.forEach((r, i) => {
        q.setFromEuler(e.set(0, r.rot, 0));
        mat.compose(p.set(r.x, r.y - r.sy * 0.25, r.z), q, sc.set(r.sx, r.sy, r.sz));
        mRk.setMatrixAt(i, mat);
        mRk.setColorAt(i, c.setHSL(0.08, 0.05, 0.4 + rng() * 0.15));
        const hx = Math.max(r.sx, r.sz) * 0.72;
        addCollider(r.x - hx, r.y - 2, r.z - hx, r.x + hx, r.y + r.sy * 0.7, r.z + hx);
      });
      mRk.castShadow = true; mRk.receiveShadow = true; mRk.frustumCulled = false; scene.add(mRk);
    }
  };

  // ---------------------------------------------------------------- map image
  W.makeMapCanvas = function (px) {
    const cv = document.createElement('canvas'); cv.width = cv.height = px;
    const ctx = cv.getContext('2d'), img = ctx.createImageData(px, px), mpp = SIZE / px;
    for (let j = 0; j < px; j++) for (let i = 0; i < px; i++) {
      const x = -HALF + (i + 0.5) * mpp, z = -HALF + (j + 0.5) * mpp, h = getHeight(x, z);
      const sh = clamp(1 + ((getHeight(x - 3, z) - h) + (getHeight(x, z - 3) - h)) * 0.12, 0.6, 1.35);
      let r = 86, g = 128, b = 60;
      if (h > 70) { const s = smoothstep(70, 95, h); r = lerp(r, 235, s); g = lerp(g, 238, s); b = lerp(b, 240, s); }
      const k = (j * px + i) * 4;
      img.data[k] = clamp(r * sh, 0, 255); img.data[k + 1] = clamp(g * sh, 0, 255); img.data[k + 2] = clamp(b * sh, 0, 255); img.data[k + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const toP = v => (v + HALF) / mpp;
    ctx.fillStyle = 'rgba(30,60,25,0.55)';
    for (const t of W.trees) ctx.fillRect(toP(t.x) - 1, toP(t.z) - 1, 2, 2);
    ctx.strokeStyle = '#4a4a4a'; ctx.lineCap = 'round';
    for (const r of W.roads) { ctx.lineWidth = Math.max(2, r.w / mpp); ctx.beginPath(); ctx.moveTo(toP(r.ax), toP(r.az)); ctx.lineTo(toP(r.bx), toP(r.bz)); ctx.stroke(); }
    for (const b of W.buildings) {
      ctx.fillStyle = b.type === 'warehouse' ? '#6c7178' : '#8a6a5a';
      ctx.fillRect(toP(b.minx), toP(b.minz), (b.maxx - b.minx) / mpp, (b.maxz - b.minz) / mpp);
      ctx.strokeStyle = '#222'; ctx.lineWidth = 1;
      ctx.strokeRect(toP(b.minx), toP(b.minz), (b.maxx - b.minx) / mpp, (b.maxz - b.minz) / mpp);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.font = `bold ${Math.round(px / 70)}px sans-serif`; ctx.textAlign = 'center';
    for (const t of W.towns) ctx.fillText(t.name, toP(t.x), toP(t.z - t.r - 10));
    return cv;
  };
})();
