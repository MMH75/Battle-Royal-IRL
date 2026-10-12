'use strict';
// Shared namespace + small math / noise helpers
const BR = window.BR = {};

BR.mulberry32 = function (a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// 2D value noise in [0,1] with fbm helper
BR.makeNoise2D = function (rng) {
  const perm = new Uint8Array(512), vals = new Float32Array(256), p = [];
  for (let i = 0; i < 256; i++) { p.push(i); vals[i] = rng(); }
  for (let i = 255; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const fade = t => t * t * (3 - 2 * t);
  function n(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi, X = xi & 255, Y = yi & 255;
    const a = vals[perm[perm[X] + Y]], b = vals[perm[perm[X + 1] + Y]];
    const c = vals[perm[perm[X] + Y + 1]], d = vals[perm[perm[X + 1] + Y + 1]];
    const u = fade(xf), v = fade(yf);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  n.fbm = function (x, y, oct) {
    let s = 0, amp = 0.5, f = 1, norm = 0;
    for (let i = 0; i < oct; i++) { s += amp * n(x * f + i * 17.3, y * f - i * 9.1); norm += amp; amp *= 0.5; f *= 2.03; }
    return s / norm;
  };
  return n;
};

BR.clamp = (v, a, b) => v < a ? a : v > b ? b : v;
BR.lerp = (a, b, t) => a + (b - a) * t;
BR.smoothstep = (e0, e1, x) => { const t = BR.clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
BR.angDiff = (a, b) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; };
BR.gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

// distance from point to 2D segment, returns {d, t, x, z}
BR.distSeg = function (px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
  let t = L2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + dx * t, z = az + dz * t, ex = px - x, ez = pz - z;
  return { d: Math.sqrt(ex * ex + ez * ez), t, x, z };
};

// Liang-Barsky: does segment a->b intersect rect? returns entry t or -1
BR.segRect = function (ax, az, bx, bz, minx, minz, maxx, maxz) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dz = bz - az;
  const p = [-dx, dx, -dz, dz], q = [ax - minx, maxx - ax, az - minz, maxz - az];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return -1; }
    else {
      const r = q[i] / p[i];
      if (p[i] < 0) { if (r > t1) return -1; if (r > t0) t0 = r; }
      else { if (r < t0) return -1; if (r < t1) t1 = r; }
    }
  }
  return t0;
};
