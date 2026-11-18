// The world layout: where the rock, kelp, corals, animals and set pieces go. A good place to start tweaking.
import { rng, fbm, sstep, clamp, trs, invert, quatFromUp } from './math.js';
import { makeSdfRunner, Grid, surfaceNets } from './sdf.js';
import { packVerts, mergeMeshes, rockMesh, coralMesh, spongeMesh, tuftMesh, mantaMesh, fishMesh, leafMesh, stipeMesh } from './meshes.js';
import { columnMesh, blockMesh, archMesh } from './ruins.js';

export const POI = {
  start: [2, 22], whale: [-4, -16], ship: [82, 14], sponge: [50, -74], boulders: [-58, -66],
  grotA: [-46, 44], grotB: [-108, 78], temple: [22, 31], arcade: [-25, 9],
};
export const C = {
  SURF: 46, RIM: 138, SHRES: 4096,
  grotto: [-77, 61, 48],
  // [x, z, radius, height] patches of seabed that are levelled out
  flats: [[POI.whale[0], POI.whale[1], 17, 3.5], [POI.ship[0], POI.ship[1], 26, 2.5], [POI.start[0], POI.start[1], 12, 4], [-77, 61, 30, 3], [POI.temple[0], POI.temple[1], 18, 4.2], [POI.arcade[0], POI.arcade[1], 12, 4]],
};
// Fixed viewpoints (keys 1-6): x, y, z, yaw, pitch
export const VIEWS = [
  [2, 7.5, 23, -0.15, 0.15],
  [58, 10, 36, 0.86, 0.08],
  [3, 7.6, 43, 1.02, 0.06],
  [36, 15, -58, 0.75, -0.12],
  [-36, 7, -46, -0.95, 0.5],
  [-50, 7.5, 46, -2.07, 0.12],
];

const grotMask = (x, z) => 1 - sstep(0.5, 1, Math.hypot(x - C.grotto[0], z - C.grotto[1]) / C.grotto[2]);
const near = (x, z, p, r0, r1) => sstep(r0, r1, Math.hypot(x - p[0], z - p[1]));   // 0 inside r0, 1 beyond r1
function segDist(x, z, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], t = clamp(((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz), 0, 1);
  return Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t);
}

// ---- rock layout: blobs, spires, arches and tunnels that the terrain field is built from ----
function layoutPrims() {
  const R = rng(20251), P = [];
  const blob = (x, y, z, rx, ry, rz) => P.push(x, y, z, 0, rx, ry, rz, 0);
  const spire = (x1, y1, z1, x2, y2, z2, r) => P.push(x1, y1, z1, r, x2, y2, z2, 1);
  const arch = (x, y, z, Rr, r, yaw, sq = 1) => P.push(x, y, z, Rr, r, yaw, sq, 2);
  const tunnel = (x1, y1, z1, x2, y2, z2, r) => P.push(x1, y1, z1, r, x2, y2, z2, 3);

  // the big rock behind the whale, with a swim-through
  blob(-12, 6, -44, 22, 27, 13); blob(-36, 5, -36, 12, 19, 12); blob(18, 4, -56, 12, 16, 11);
  tunnel(-10, 9, -68, -11, 8, -30, 5.5);
  // gate towards the wreck
  arch(42, 1, 8, 13.5, 3.3, Math.PI / 2, 1.1); blob(43, 4, -14, 9, 17, 9); blob(45, 4, 31, 10, 15, 9);
  blob(108, 6, -10, 17, 23, 19); blob(112, 5, 34, 14, 17, 15);
  // lone arch and spires in the kelp
  arch(24, 1, -34, 10, 2.7, 0.3, 1.25);
  spire(-30, 0, 18, -27, 27, 21, 4.8); spire(28, 0, 56, 31, 22, 53, 4.2); spire(-14, 0, 70, -16, 17, 73, 5);
  // the grotto: a canyon with a broken roof
  const A = POI.grotA, B = POI.grotB, len = Math.hypot(B[0] - A[0], B[1] - A[1]);
  const dx = (B[0] - A[0]) / len, dz = (B[1] - A[1]) / len, px = -dz, pz = dx;
  for (let t = 0; t <= 5; t++) {
    const cx = A[0] + dx * t * 13.5, cz = A[1] + dz * t * 13.5;
    for (const s of [-1, 1]) blob(cx + px * s * (25 + R() * 3), 8, cz + pz * s * (25 + R() * 3), 11 + R() * 3, 24 + R() * 8, 11 + R() * 3);
  }
  blob(B[0] + dx * 14, 8, B[1] + dz * 14, 19, 28, 19);
  const yawP = Math.atan2(pz, px);
  arch(A[0] + dx * 17, 3, A[1] + dz * 17, 17, 3.4, yawP, 1.35);
  arch(A[0] + dx * 50, 3, A[1] + dz * 50, 16, 3.6, yawP + 0.2, 1.5);
  {
    const cx = A[0] + dx * 34, cz = A[1] + dz * 34;
    spire(cx - px * 22, 30, cz - pz * 22, cx + px * 22, 33, cz + pz * 22, 4.2);
  }
  // sponge plateau and its gate
  blob(POI.sponge[0], -3, POI.sponge[1], 27, 11, 23); arch(27, 2, -62, 11, 2.8, 0.85, 1.2);
  blob(78, 5, -92, 14, 22, 13); blob(30, 4, -100, 13, 18, 12);
  // low rim around the floating-boulder basin
  for (let k = 0; k < 6; k++) { const a = k * 1.05 + 0.4; blob(POI.boulders[0] + Math.cos(a) * 33, 2, POI.boulders[1] + Math.sin(a) * 33, 9 + R() * 4, 7 + R() * 9, 9 + R() * 4); }
  // wall behind the start
  blob(-24, 6, 88, 17, 21, 13); blob(24, 6, 96, 15, 25, 13); blob(62, 6, 72, 13, 19, 15);
  // scattered massifs further out
  for (let k = 0, tries = 0; k < 26 && tries < 2000; tries++) {
    const a = R() * 6.283, r = 72 + R() * 62, x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (Math.hypot(x, z) < 66 || Math.hypot(x - POI.ship[0], z - POI.ship[1]) < 34 || segDist(x, z, A, B) < 44 ||
        Math.hypot(x - POI.sponge[0], z - POI.sponge[1]) < 34 || Math.hypot(x - POI.boulders[0], z - POI.boulders[1]) < 30) continue;
    const big = R();
    blob(x, 4 + R() * 5, z, 9 + big * 12 + R() * 4, 12 + big * 20 + R() * 8, 9 + big * 12 + R() * 4);
    if (R() < 0.3) spire(x + 8, 0, z + 6, x + 12 * (R() - 0.5), 30 + R() * 10, z + 12 * (R() - 0.5), 4 + R() * 2);
    k++;
  }
  return new Float32Array(P);
}

class Recs {
  constructor(stride) { this.s = stride; this.f = new Float32Array(4096 * stride); this.u = new Uint32Array(this.f.buffer); this.n = 0; }
  add() {
    if ((this.n + 1) * this.s > this.f.length) { const f = new Float32Array(this.f.length * 2); f.set(this.f); this.f = f; this.u = new Uint32Array(f.buffer); }
    return this.n++ * this.s;
  }
}
const rgba = (r, g, b, a) => (((clamp(a, 0, 1) * 255) << 24) | ((clamp(b, 0, 1) * 255) << 16) | ((clamp(g, 0, 1) * 255) << 8) | (clamp(r, 0, 1) * 255)) >>> 0;

// Sort records into square cells (for culling) and order them inside a cell by `prio` so a prefix is a valid LOD.
function cellSort(recs, cs, prio, pad) {
  const { s, f, u, n } = recs, key = new Int32Array(n), order = new Uint32Array(n);
  for (let i = 0; i < n; i++) { key[i] = (Math.floor(f[i * s] / cs) + 512) * 1024 + Math.floor(f[i * s + 2] / cs) + 512; order[i] = i; }
  order.sort((a, b) => key[a] - key[b] || prio[a] - prio[b]);
  const out = new Uint32Array(n * s), of = new Float32Array(out.buffer), cells = [];
  let start = 0, mnx = 1e9, mny = 1e9, mnz = 1e9, mxx = -1e9, mxy = -1e9, mxz = -1e9;
  for (let i = 0; i <= n; i++) {
    if (i === n || (i > 0 && key[order[i]] !== key[order[i - 1]])) {
      if (i > start) cells.push(mnx - pad[0], mny + pad[1], mnz - pad[0], mxx + pad[0], mxy + pad[2], mxz + pad[0], start, i - start);
      start = i; mnx = mny = mnz = 1e9; mxx = mxy = mxz = -1e9;
    }
    if (i < n) {
      const o = order[i] * s;
      for (let k = 0; k < s; k++) out[i * s + k] = u[o + k];
      const x = of[i * s], y = of[i * s + 1], z = of[i * s + 2];
      if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y; if (z < mnz) mnz = z; if (z > mxz) mxz = z;
    }
  }
  return { data: out, cells: new Float32Array(cells), count: n };
}
const randPrio = (n, R) => { const p = new Float32Array(n); for (let i = 0; i < n; i++) p[i] = R(); return p; };

export async function buildWorld(dev, Q, progress) {
  const run = makeSdfRunner(dev, C);
  const R = rng(7);
  const W = {};

  // ---------- terrain ----------
  await progress(0.05, 'Поднимаем скалы со дна');
  const cell = Q.cell, half = 160, y0 = -8, y1 = 58;
  const n = [Math.round((half * 2) / cell) + 1, Math.round((y1 - y0) / cell) + 1, Math.round((half * 2) / cell) + 1];
  const grid = new Grid(await run([-half, y0, -half], cell, n, 0, layoutPrims()), [-half, y0, -half], cell, n);
  W.grid = grid;
  await progress(0.25, 'Обтёсываем камень');
  const terr = surfaceNets(grid, 1.3);
  const tp = terr.pos, tn = terr.nrm;

  // ---------- set pieces ----------
  await progress(0.4, 'Топим корабль');
  const parts = [{ pos: tp, nrm: tn, idx: terr.idx, mat: 0 }];
  const M = new Float32Array(16);
  const place = (mesh, mat) => {
    const p = mesh.pos, nr = mesh.nrm;
    for (let v = 0; v < mesh.nv; v++) {
      const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2], a = nr[v * 4], b = nr[v * 4 + 1], c = nr[v * 4 + 2];
      p[v * 3] = M[0] * x + M[4] * y + M[8] * z + M[12]; p[v * 3 + 1] = M[1] * x + M[5] * y + M[9] * z + M[13]; p[v * 3 + 2] = M[2] * x + M[6] * y + M[10] * z + M[14];
      nr[v * 4] = M[0] * a + M[4] * b + M[8] * c; nr[v * 4 + 1] = M[1] * a + M[5] * b + M[9] * c; nr[v * 4 + 2] = M[2] * a + M[6] * b + M[10] * c;
    }
    parts.push({ pos: p, nrm: nr, idx: mesh.idx, mat });
  };
  {
    const sc = Q.cell > 0.9 ? 0.18 : 0.14, o = [-18.2, -4.4, -6.4], sn = [Math.ceil(41.4 / sc), Math.ceil(24.8 / sc), Math.ceil(12.8 / sc)];
    const ship = surfaceNets(new Grid(await run(o, sc, sn, 1, null), o, sc, sn), 0.45);
    const fy = grid.floorY(POI.ship[0], POI.ship[1]);
    trs(M, POI.ship[0], fy + 2.3, POI.ship[1], 2.5, 0.05, 0.27, 1);
    W.shipInv = new Float32Array(16); invert(W.shipInv, M);
    place(ship, 1);
  }
  await progress(0.5, 'Ставим хвост кита');
  {
    const sc = Q.cell > 0.9 ? 0.2 : 0.16, o = [-14.5, -6.5, -5.5], sn = [Math.ceil(29 / sc), Math.ceil(27.5 / sc), Math.ceil(11 / sc)];
    const whale = surfaceNets(new Grid(await run(o, sc, sn, 2, null), o, sc, sn), 0.6);
    const fy = grid.floorY(POI.whale[0], POI.whale[1]);
    trs(M, POI.whale[0], fy + 2.5, POI.whale[1], 0.2, -0.12, 0.05, 1.25);
    place(whale, 2);
    for (let v = 0; v < whale.nv; v++) { const l = 1 / 1.25; whale.nrm[v * 4] *= l; whale.nrm[v * 4 + 1] *= l; whale.nrm[v * 4 + 2] *= l; }
  }
  {
    let nv = 0, ni = 0;
    for (const p of parts) { nv += p.pos.length / 3; ni += p.idx.length; }
    const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 4), col = new Float32Array(nv * 4), idx = new Uint32Array(ni);
    let v0 = 0, i0 = 0;
    for (const p of parts) {
      pos.set(p.pos, v0 * 3); nrm.set(p.nrm, v0 * 4);
      for (let v = 0; v < p.pos.length / 3; v++) col[(v0 + v) * 4] = p.mat / 255;
      for (let i = 0; i < p.idx.length; i++) idx[i0 + i] = p.idx[i] + v0;
      v0 += p.pos.length / 3; i0 += p.idx.length;
    }
    W.staticVB = packVerts(pos, nrm, col); W.staticIB = idx;
  }

  // ---------- helpers for scattering ----------
  await progress(0.6, 'Сажаем водоросли');
  const nvT = terr.nv, RIMR = C.RIM - 4;
  const D = Q.density;
  const floorAt = (x, z) => { const y = grid.floorY(x, z); return y - grid.sd(x, y, z) * 0.8; };

  // ---------- lava hot spots: where the cracks glow, smoke rises and nothing grows ----------
  const spots = [];
  const addSpot = (x, z, r) => { const y = floorAt(x, z); if (y < 22 && spots.length < 16) spots.push([x, y + 0.4, z, r]); };
  for (const s of [[2, 13, 7.5], [-6, 6, 5.5], [3, -4, 5], [14, 40, 5.5], [37, 33, 5], [-18, 2, 5], [-32, 16, 4.5]]) addSpot(...s);
  for (let tries = 0; spots.length < 16 && tries < 600; tries++) {
    const a = R() * 6.283, r = 30 + R() * 82, x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (Math.hypot(x - POI.sponge[0], z - POI.sponge[1]) < 30 || Math.hypot(x - POI.ship[0], z - POI.ship[1]) < 16 || spots.some((s) => Math.hypot(x - s[0], z - s[2]) < 28)) continue;
    addSpot(x, z, 4 + R() * 4.5);
  }
  W.lava = new Float32Array(64);
  for (let i = 0; i < 16; i++) W.lava.set(spots[i] || [0, -1000, 0, 1], i * 4);
  // 1 at a spot's centre, 0 at its radius, negative outside
  const heatAt = (x, z) => { let h = -9; for (const s of spots) { const d = Math.hypot(x - s[0], z - s[2]) / s[3]; h = Math.max(h, 1 - d * d); } return h; };

  // ---------- kelp ----------
  const leaves = new Recs(9), stipes = new Recs(8), sparks = new Recs(8);
  const kelpDensity = (x, z) => {
    const r = Math.hypot(x, z);
    let d = sstep(0.40, 0.56, fbm(x * 0.014 + 3, 0, z * 0.014 + 7, 3)) * 0.85 + 0.55 * (1 - sstep(25, 70, r));
    d *= near(x, z, POI.whale, 12, 20) * near(x, z, POI.ship, 15, 26) * near(x, z, POI.start, 5, 11) * near(x, z, POI.sponge, 14, 26) * near(x, z, POI.boulders, 8, 30);
    d *= sstep(4.5, 9, segDist(x, z, POI.start, POI.whale));      // keep the first view of the whale open
    d *= near(x, z, POI.temple, 14, 21) * near(x, z, POI.arcade, 8, 14);
    d *= 1 - 0.8 * grotMask(x, z);
    return Math.min(d, 1) * sstep(RIMR, RIMR - 20, r);
  };
  const addKelp = (x, z, Hwant, nst, lf) => {
    const fy = floorAt(x, z);
    if (fy > 17 || heatAt(x, z) > -0.7) return;
    const top = Math.min(grid.ceilY(x, fy, z) - 2.5, C.SURF - 0.3);
    const H = Math.min(Hwant, top - fy);
    if (H < Hwant * 0.4 || H < 2.5) return;
    const s0 = stipes.n, l0 = leaves.n, k0 = sparks.n;
    const seed = R(), purple = grotMask(x, z) > 0.45 ? 1 : 0, hueBase = R();
    for (let st = 0; st < nst; st++) {
      const ph = (st + R() * 0.5) / nst;
      let o = stipes.add();
      stipes.f.set([x, fy - 0.3, z, seed, H + 0.3, ph, 0.05 + 0.02 * nst, purple], o);
      for (let s = 0.8 + R(); s < H; s += (0.05 + R() * 0.075) / lf) {
        const k = s / H, len = (0.9 + R() * 1.1) * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, k * 1.15 + 0.08))) * (Hwant < 10 ? 0.6 : 1);
        o = leaves.add();
        leaves.f.set([x, fy - 0.3, z, seed, s + 0.3, R() * 6.283, len, H], o);
        leaves.u[o + 8] = rgba(clamp(hueBase * 0.5 + R() * 0.6, 0, 1), purple, R(), ph);
      }
    }
    const ns = Math.round(H * 4.5 * Math.sqrt(D) * (purple ? 1.5 : 1) * (Hwant < 10 ? 0.4 : 1));
    for (let i = 0; i < ns; i++) { const o = sparks.add(); sparks.f.set([x, fy, z, seed, 1 + R() * (H - 1), 0.4 + R() * R() * 3.2, R() * 6.283, R()], o); }
    // keep the sightline of the grotto viewpoint clear (drop the plant, but only after it has used its random numbers)
    if (segDist(x, z, GV, GV2) < 6.5) { stipes.n = s0; leaves.n = l0; sparks.n = k0; }
  };
  const GV = [VIEWS[5][0], VIEWS[5][2]], GV2 = [GV[0] + Math.sin(VIEWS[5][3]) * 22, GV[1] - Math.cos(VIEWS[5][3]) * 22];
  for (let gx = -RIMR; gx < RIMR; gx += 6.5) for (let gz = -RIMR; gz < RIMR; gz += 6.5) {
    const x = gx + R() * 6.5, z = gz + R() * 6.5;
    if (R() < kelpDensity(x, z)) addKelp(x, z, 20 + R() * 24, 2 + (R() * 2.4 | 0), D);
  }
  for (let gx = -RIMR; gx < RIMR; gx += 3.6) for (let gz = -RIMR; gz < RIMR; gz += 3.6) {
    const x = gx + R() * 3.6, z = gz + R() * 3.6;
    if (R() < kelpDensity(x, z) * 0.3 + 0.03 * sstep(RIMR, RIMR - 20, Math.hypot(x, z))) addKelp(x, z, 2.5 + R() * R() * 9, 1, D);
  }
  // a few purple giants inside the grotto
  for (let i = 0; i < 26; i++) {
    const t = R(), x = POI.grotA[0] + (POI.grotB[0] - POI.grotA[0]) * t + (R() - 0.5) * 18, z = POI.grotA[1] + (POI.grotB[1] - POI.grotA[1]) * t + (R() - 0.5) * 18;
    addKelp(x, z, 12 + R() * 22, 2, D);
  }
  W.leaves = cellSort(leaves, 40, randPrio(leaves.n, R), [9, -1, 0]);
  for (let i = 5; i < W.leaves.cells.length; i += 8) W.leaves.cells[i - 1] = C.SURF + 1;     // kelp reaches for the surface
  W.stipes = { data: stipes.u.subarray(0, stipes.n * 8), count: stipes.n };
  W.sparks = { data: sparks.u.subarray(0, sparks.n * 8), count: sparks.n };
  W.leafMesh = leafMesh(Q.leafSegs); W.stipeMesh = stipeMesh(26, 4);

  // ---------- ground cover ----------
  await progress(0.72, 'Стелем ковёр');
  const grassA = new Recs(5), grassB = new Recs(5);
  const PAL = [[0.7, 0.08, 0.5], [0.75, 0.2, 0.4], [0.4, 0.15, 0.75], [0.05, 0.3, 0.27], [0.1, 0.24, 0.5], [0.12, 0.27, 0.07], [0.8, 0.16, 0.85]];
  const addGrass = (x, y, z, gm) => {
    const m1 = fbm(x * 0.045 + 31, 0, z * 0.045 + 5, 3), m2 = fbm(x * 0.05 + 77, 0, z * 0.05 + 41, 3);
    const d = Math.max(sstep(0.50, 0.60, m1), sstep(0.52, 0.62, m2) * 0.8, gm * 0.95, 0.04);
    if (R() > d * (gm > 0.2 ? 1 : 0.4) || heatAt(x, z) > -1.2) return;
    let ci = gm > 0.3 ? (R() < 0.6 ? 0 : R() < 0.5 ? 6 : 1) : m1 > m2 ? (R() < 0.7 ? 0 : R() < 0.5 ? 1 : 2) : (R() < 0.6 ? 3 : R() < 0.6 ? 4 : 5);
    if (R() < 0.06) ci = (R() * PAL.length) | 0;
    const c = PAL[ci], broad = gm > 0.3 && fbm(x * 0.11, 3, z * 0.11, 2) > 0.58 && R() < 0.5, g = broad ? grassB : grassA, o = g.add();
    const v = 0.75 + R() * 0.5;
    g.f.set([x, y - 0.05, z, (broad ? 0.32 : 0.28) + R() * R() * 0.6], o);
    g.u[o + 4] = rgba(c[0] * v, c[1] * v, c[2] * v, R());
  };
  const gs = 0.36 / Math.sqrt(D);
  for (let gx = -RIMR; gx < RIMR; gx += gs) for (let gz = -RIMR; gz < RIMR; gz += gs) {
    const x = gx + R() * gs, z = gz + R() * gs;
    if (x * x + z * z > RIMR * RIMR) continue;
    const gm = grotMask(x, z);
    // cheap early-out before touching the grid
    if (gm < 0.05 && fbm(x * 0.045 + 31, 0, z * 0.045 + 5, 3) < 0.47 && fbm(x * 0.05 + 77, 0, z * 0.05 + 41, 3) < 0.49 && R() > 0.06) continue;
    const y = grid.floorY(x, z);
    if (y > 26 || Math.abs(grid.floorY(x + 0.5, z + 0.3) - y) > 0.7) continue;
    addGrass(x, y - grid.sd(x, y, z) * 0.8, z, gm);
  }
  for (let i = 0; i < 60000 * D; i++) {      // moss gardens on top of the rocks
    const v = (R() * nvT) | 0;
    if (tn[v * 4 + 1] < 0.78 || tp[v * 3 + 1] < 9 || tp[v * 3 + 1] > C.SURF - 3) continue;
    addGrass(tp[v * 3] + (R() - 0.5) * cell, tp[v * 3 + 1], tp[v * 3 + 2] + (R() - 0.5) * cell, grotMask(tp[v * 3], tp[v * 3 + 2]));
  }
  W.grass = [cellSort(grassA, 32, randPrio(grassA.n, R), [1.5, -0.5, 1.5]), cellSort(grassB, 32, randPrio(grassB.n, R), [1.5, -0.5, 1.5])];
  W.grassMeshes = mergeMeshes([tuftMesh(11, 9, false), tuftMesh(12, 6, true)]);

  // ---------- rocks, corals, sponges ----------
  await progress(0.82, 'Растим кораллы');
  const meshes = [rockMesh(1, 1), rockMesh(2, 1), rockMesh(3, 2), rockMesh(4, 2), rockMesh(5, 3), rockMesh(6, 3),
    coralMesh(21), coralMesh(22), coralMesh(23), coralMesh(24, 1), coralMesh(25, 1), spongeMesh(31, 1), spongeMesh(32, 1), spongeMesh(33, 4), spongeMesh(34, 6),
    // ruins: whole column, broken column, stump, drum, block, beam, slab, arch, broken arch
    columnMesh(41, 6.5, true, true), columnMesh(42, 4.3, true, false), columnMesh(43, 1.9, true, false), columnMesh(44, 1.0, false, false, true),
    blockMesh(45, 1.2, 0.8, 0.9), blockMesh(46, 4.7, 0.7, 0.95), blockMesh(47, 2.6, 0.3, 1.6), archMesh(48, false), archMesh(49, true),
    // lengths of fallen shaft, snapped off at one end
    columnMesh(50, 3.4, false, false, false), columnMesh(51, 5.4, false, false, false)];
  const RU = 15; W.ruinStart = RU;
  const props = meshes.map(() => new Recs(9));
  const addProp = (mi, x, y, z, sc, nx, ny, nz, r, g, b, fl = 0, yaw = R() * 6.283) => {
    const p = props[mi], o = p.add();
    p.f[o] = x; p.f[o + 1] = y; p.f[o + 2] = z; p.f[o + 3] = sc;
    quatFromUp(p.f, o + 4, nx, ny, nz, yaw);
    p.u[o + 8] = rgba(r, g, b, fl);
  };
  const rndDir = () => { const a = R() * 6.283, y = R() * 2 - 1, r = Math.sqrt(1 - y * y); return [r * Math.cos(a), y, r * Math.sin(a)]; };
  // pebbles and boulders
  for (let i = 0; i < 60000 * D; i++) {
    const v = (R() * nvT) | 0, x = tp[v * 3], y = tp[v * 3 + 1], z = tp[v * 3 + 2], ny = tn[v * 4 + 1];
    if (y > C.SURF - 2) continue;
    const big = fbm(x * 0.03 + 9, y * 0.03, z * 0.03, 2) > 0.55 && ny > -0.1;
    if (!big && ny < 0.45) continue;
    const u = R(), sc = big && u < 0.22 ? 0.9 + R() * R() * 3.2 : 0.1 + R() * R() * 0.6, d = rndDir(), g = 0.4 + R() * 0.25;
    const mi = sc > 1.6 ? 4 + (R() * 2 | 0) : sc > 0.45 ? 2 + (R() * 2 | 0) : (R() * 2) | 0;
    addProp(mi, x + (R() - 0.5) * cell, y - sc * 0.25, z + (R() - 0.5) * cell, sc, d[0], d[1], d[2], g, g, g);
  }
  // floating boulders
  const floatAt = (cx, cz, rad, count, big) => {
    for (let i = 0; i < count; i++) {
      const a = R() * 6.283, r = Math.sqrt(R()) * rad, x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      const sc = big ? 0.8 + R() * R() * R() * 5.5 : 0.12 + R() * 0.4, fy = grid.floorY(x, z);
      const y = Math.min(fy + 11 + R() * 24, C.SURF - 3 - sc);
      if (grid.sd(x, y, z) < sc + 1.5 || segDist(x, z, POI.start, POI.whale) < 16 || Math.hypot(x - POI.ship[0], z - POI.ship[1]) < 20) continue;
      const d = rndDir(), g = 0.42 + R() * 0.2;
      addProp(sc > 1.6 ? 4 + (R() * 2 | 0) : 2 + (R() * 2 | 0), x, y, z, sc, d[0], d[1], d[2], g, g, g, 1);
    }
  };
  floatAt(POI.boulders[0], POI.boulders[1], 30, 60, true); floatAt(POI.boulders[0], POI.boulders[1], 32, 160, false);
  floatAt(0, 0, 120, 40, true);
  // corals
  const CPAL = [[1.0, 0.42, 0.58], [0.86, 0.80, 1.0], [1.0, 0.55, 0.22], [0.62, 0.36, 1.0], [0.96, 0.85, 0.30], [0.28, 0.9, 0.8], [1.0, 0.25, 0.75]];
  for (let i = 0; i < 110000 * D; i++) {
    const v = (R() * nvT) | 0, x = tp[v * 3], y = tp[v * 3 + 1], z = tp[v * 3 + 2], nx = tn[v * 4], ny = tn[v * 4 + 1], nz = tn[v * 4 + 2];
    if (ny < 0.1 || y > C.SURF - 4 || heatAt(x, z) > -0.3) continue;
    const gm = grotMask(x, z), reef = sstep(0.5, 0.6, fbm(x * 0.028 + 50, y * 0.05, z * 0.028 + 13, 3));
    const d = Math.max(reef * 0.5, gm * 0.45, (1 - near(x, z, POI.sponge, 20, 34)) * 0.5, (1 - near(x, z, POI.whale, 12, 22)) * 0.3, 0.03);
    if (R() > d) continue;
    const fan = R() < (ny < 0.7 ? 0.6 : 0.2), mi = fan ? 9 + (R() * 2 | 0) : 6 + (R() * 3 | 0);
    let c = CPAL[(R() * CPAL.length) | 0]; if (gm > 0.3 && R() < 0.6) c = CPAL[R() < 0.5 ? 6 : 0];
    const ux = nx * 0.6, uy = ny * 0.6 + 0.5, uz = nz * 0.6, l = 1 / Math.hypot(ux, uy, uz), sc = (fan ? 0.5 : 0.3) + R() * R() * 0.8;
    addProp(mi, x, y - 0.05, z, sc, ux * l, uy * l, uz * l, c[0], c[1], c[2]);
  }
  // sponges
  const SPAL = [[0.95, 0.42, 0.18], [0.9, 0.22, 0.2], [0.6, 0.28, 0.85], [1.0, 0.75, 0.15], [0.3, 0.5, 1.0], [1.0, 0.35, 0.6]];
  for (let i = 0; i < 70000 * D; i++) {
    const v = (R() * nvT) | 0, x = tp[v * 3], y = tp[v * 3 + 1], z = tp[v * 3 + 2], ny = tn[v * 4 + 1];
    if (ny < 0.5 || y > C.SURF - 5 || heatAt(x, z) > -0.3) continue;
    const d = Math.max((1 - near(x, z, POI.sponge, 18, 30)) * 0.5, sstep(0.56, 0.66, fbm(x * 0.03 + 150, 0, z * 0.03 + 90, 3)) * 0.2, grotMask(x, z) * 0.1, 0.004);
    if (R() > d) continue;
    const barrel = R() < 0.5, mi = barrel ? 11 + (R() * 2 | 0) : 13 + (R() * 2 | 0);
    const c = SPAL[(R() * 6) | 0], sc = barrel ? 0.35 + R() * R() * 1.5 : 0.4 + R() * 0.8;
    addProp(mi, x, y - 0.05, z, sc, tn[v * 4] * 0.3, 1, tn[v * 4 + 2] * 0.3, c[0], c[1], c[2]);
  }
  // ---------- the drowned city ----------
  const ruin = (k, x, y, z, sc, yaw, ux = 0, uy = 1, uz = 0) => {
    const l = 1 / Math.hypot(ux, uy, uz), v = 0.8 + R() * 0.2;
    addProp(RU + k, x, y, z, sc, ux * l, uy * l, uz * l, v, v * 0.97, v * 0.9, 0.5, yaw);
  };
  const tilt = (k) => (R() - 0.5) * 0.08 * k;
  // one column in whatever state time left it; returns the height of its top if it still stands whole
  const column = (x, z, base, sc, fate) => {
    if (fate < 0.48) { ruin(0, x, base, z, sc, R() * 6.283, tilt(1), 1, tilt(1)); return base + 6.5 * sc; }
    if (fate < 0.70) ruin(1, x, base, z, sc, R() * 6.283, tilt(2), 1, tilt(2));
    else {
      ruin(2, x, base, z, sc, R() * 6.283, tilt(3), 1, tilt(3));
      if (fate > 0.84) {        // toppled: its drums lie in a row
        const a = R() * 6.283, dx = Math.cos(a), dz = Math.sin(a);
        for (let k = 0; k < 5; k++) {
          const px = x + dx * (1.7 + k * 1.15) * sc + (R() - 0.5) * 0.4, pz = z + dz * (1.7 + k * 1.15) * sc + (R() - 0.5) * 0.4;
          if (R() < 0.8) ruin(3, px, floorAt(px, pz) + 0.4 * sc, pz, sc, R() * 6.283, dx + (R() - 0.5) * 0.3, 0.04 + R() * 0.12, dz + (R() - 0.5) * 0.3);
        }
      }
    }
    return 0;
  };
  // columns 4.4 * sc apart, with beams still resting on neighbours that both stand
  const colonnade = (x0, z0, dx, dz, n, sc, intact) => {
    const pts = [];
    for (let i = 0; i < n; i++) pts.push([x0 + dx * i * 4.4 * sc, z0 + dz * i * 4.4 * sc]);
    const base = Math.min(...pts.map((p) => floorAt(p[0], p[1]))) - 0.15;
    const tops = pts.map((p) => column(p[0], p[1], base, sc, R() < intact ? 0 : 0.48 + R() * 0.52));
    for (let i = 0; i + 1 < n; i++) {
      if (tops[i] && tops[i + 1] && R() < 0.75) ruin(5, (pts[i][0] + pts[i + 1][0]) / 2, tops[i] - 0.03, (pts[i][1] + pts[i + 1][1]) / 2, sc, Math.atan2(-dz, dx), tilt(0.5), 1, tilt(0.5));
    }
    return base;
  };
  const rubble = (cx, cz, rad, count, sc) => {
    for (let i = 0; i < count; i++) {
      const a = R() * 6.283, r = Math.sqrt(R()) * rad, x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r, y = floorAt(x, z), u = R(), s = sc * (0.7 + R() * 0.6);
      if (y > 20) continue;
      if (u < 0.45) ruin(4, x, y - 0.25 * s, z, s, R() * 6.283, tilt(9), 1, tilt(9));
      else if (u < 0.62) ruin(6, x, y - 0.1 * s, z, s, R() * 6.283, tilt(5), 1, tilt(5));
      else if (u < 0.8) ruin(3, x, y + 0.36 * s, z, s, R() * 6.283, R() - 0.5, 0.1 * R(), R() - 0.5);
      else if (u < 0.85) ruin(2, x, y - 0.2, z, s, R() * 6.283, tilt(4), 1, tilt(4));
      else if (u < 0.93) { const d = R() * 6.283; ruin(R() < 0.5 ? 9 : 10, x, y + 0.44 * s, z, s, R() * 6.283, Math.cos(d), R() * 0.12, Math.sin(d)); }
      else ruin(5, x, y - 0.2 * s, z, s, R() * 6.283, tilt(4), 1, tilt(4));
    }
  };
  {
    // processional avenue from the start to the whale
    const S0 = POI.start, Wh = POI.whale, al = Math.hypot(Wh[0] - S0[0], Wh[1] - S0[1]), ax = (Wh[0] - S0[0]) / al, az = (Wh[1] - S0[1]) / al;
    // The first view is composed like a painting. Positions are (metres ahead of the start, metres to the right).
    const at = (f, r) => [S0[0] + ax * f - az * r, S0[1] + az * f + ax * r];
    const stand = (k, f, r, sc, lean = 1) => { const p = at(f, r); ruin(k, p[0], floorAt(p[0], p[1]) - 0.2, p[1], sc, R() * 6.283, tilt(lean), 1, tilt(lean)); };
    // a shaft lying on its side, pointing along `dir` (0 = away from the viewer); `lift` props one end up on its neighbours
    const lay = (k, f, r, dir, sc, lift = 0) => {
      const p = at(f, r), dx = ax * Math.cos(dir) - az * Math.sin(dir), dz = az * Math.cos(dir) + ax * Math.sin(dir);
      ruin(k, p[0], floorAt(p[0], p[1]) + (lift ? 0.2 : 0.44) * sc, p[1], sc, R() * 6.283, dx, lift, dz);
    };
    const faceYaw = Math.atan2(-ax, -az);            // turns an arch square to the viewer
    // left: a heap of toppled shafts, one propped across the others, stumps behind
    lay(10, 13, -8, 0.5, 1.1); lay(9, 11.5, -10.5, -0.9, 1.1); lay(10, 14.5, -11, 1.9, 1.0, 0.34); lay(3, 10, -7.2, 2.4, 1.2);
    lay(3, 12.6, -5.8, 0.3, 1.1); lay(9, 16.5, -7, -0.3, 1.0, 0.2); lay(0, 19, -13, 1.2, 1.0);
    stand(2, 14.5, -13.5, 1.1, 4); stand(1, 18.5, -9.5, 1.0, 5);
    // middle distance: one column still whole, the stub of an arch beyond the lava
    stand(0, 27, 3.5, 1.05, 1.5); stand(2, 23, 0.5, 1.0, 5);
    { const p = at(25, -4.5); ruin(8, p[0], floorAt(p[0], p[1]) - 0.5, p[1], 1.05, faceYaw + 0.5, tilt(3), 1, tilt(3)); }
    // right: the great gate, leaning, with what fell from it at its feet
    { const p = at(20, 12); ruin(7, p[0], floorAt(p[0], p[1]) - 0.6, p[1], 1.55, faceYaw - 0.35, 0.05, 1, -0.03); }
    stand(1, 17.5, 7.5, 1.1, 4); stand(2, 22.5, 17, 1.2, 5);
    lay(10, 15, 9.5, 2.7, 1.1); lay(3, 13.5, 12.5, 1.2, 1.2); lay(9, 17.5, 15, 0.8, 1.0, 0.25);
    // foreground: carved blocks half sunk into the plates
    for (const [k, f, r, sc] of [[5, 7.5, 5.5, 1.0], [6, 6, -2.8, 1.1], [4, 9.5, 2, 1.3], [4, 5.5, 7.8, 1.1], [6, 10.5, -3.5, 0.9], [4, 12, 5.5, 1.0], [5, 16, 2.5, 0.9]]) {
      const p = at(f, r); ruin(k, p[0], floorAt(p[0], p[1]) - 0.22 * sc, p[1], sc, R() * 6.283, tilt(6), 1, tilt(6));
    }
    rubble(S0[0] + ax * 17, S0[1] + az * 17, 17, 34, 1);
    // nearer the whale a few columns of the old avenue are left
    for (const sd of [-1, 1]) { const p = at(29, 9 * sd); colonnade(p[0], p[1], ax, az, 2, 1, 0.5); }
    // temple: a ring of columns on a paved floor, broken walls inside
    const T = POI.temple, ty = 0.45, c = Math.cos(ty), sn = Math.sin(ty), sc = 1.05, st = 4.4 * sc;
    const tw = (lx, lz) => [T[0] + lx * c + lz * sn, T[1] - lx * sn + lz * c];
    let base = 1e9;
    for (const lz of [-1, 1]) { const p = tw(-2 * st, lz * st); base = Math.min(base, colonnade(p[0], p[1], c, -sn, 5, sc, 0.6)); }
    for (const lx of [-2, 2]) { const p = tw(lx * st, 0); column(p[0], p[1], base, sc, R() < 0.5 ? 0.6 : 0); }
    for (let lx = -11.5; lx <= 11.5; lx += 2.75) for (let lz = -6.6; lz <= 6.6; lz += 1.72) {
      if (R() < 0.22) continue;
      const p = tw(lx * sc + (R() - 0.5) * 0.15, lz * sc + (R() - 0.5) * 0.15);
      ruin(6, p[0], Math.max(floorAt(p[0], p[1]) - 0.22, base - 0.2), p[1], sc, ty + (R() - 0.5) * 0.06, tilt(1), 1, tilt(1));
    }
    for (const lz of [-1.9, 1.9]) for (let lx = -6; lx <= 6; lx += 1.25) {
      const hgt = Math.floor(fbm(lx * 0.35 + 9, lz, 3, 2) * 6 - 0.6), p = tw(lx * sc, lz * sc);
      for (let k = 0; k < hgt; k++) ruin(4, p[0], base + 0.25 + k * 0.8 * sc, p[1], sc, ty + (R() - 0.5) * 0.08);
    }
    rubble(T[0], T[1], 19, 60, 1);
    // arcade: three arches in a row
    const A = POI.arcade, ay = 1.15, ac = Math.cos(ay), as = Math.sin(ay), asc = 1.45;
    const ab = Math.min(floorAt(A[0], A[1]), floorAt(A[0] + ac * 6, A[1] - as * 6), floorAt(A[0] - ac * 6, A[1] + as * 6)) - 0.2;
    for (let k = -1; k <= 1; k++) ruin(k === 0 ? 7 : 8, A[0] + ac * k * 4.04 * asc, ab, A[1] - as * k * 4.04 * asc, asc, ay + (k > 0 ? Math.PI : 0), tilt(0.6), 1, tilt(0.6));
    rubble(A[0], A[1], 13, 40, 1);
    colonnade(A[0] + as * 7 - ac * 7, A[1] + ac * 7 + as * 7, ac, -as, 4, 0.9, 0.4);
    // scattered remains of the rest of the city
    for (let i = 0, tries = 0; i < 16 && tries < 300; tries++) {
      const a = R() * 6.283, r = 28 + R() * 88, x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (floorAt(x, z) > 11 || segDist(x, z, POI.grotA, POI.grotB) < 20) continue;
      const d = R() * 6.283, n = 2 + ((R() * 4) | 0), sc2 = 0.8 + R() * 0.5;
      colonnade(x, z, Math.cos(d), Math.sin(d), n, sc2, 0.35);
      if (R() < 0.4) ruin(R() < 0.5 ? 7 : 8, x + Math.sin(d) * 7, floorAt(x + Math.sin(d) * 7, z - Math.cos(d) * 7) - 0.3, z - Math.cos(d) * 7, 1 + R() * 0.5, R() * 6.283, tilt(1.5), 1, tilt(1.5));
      rubble(x + Math.cos(d) * n * 2, z + Math.sin(d) * n * 2, 9 + n * 2, 14 + n * 4, sc2);
      i++;
    }
  }
  W.propMeshes = mergeMeshes(meshes);
  W.props = props.map((p) => {
    const prio = new Float32Array(p.n);
    for (let i = 0; i < p.n; i++) prio[i] = -p.f[i * 9 + 3];        // biggest first: LOD drops the small ones
    return cellSort(p, 40, prio, [6, -6, 6]);
  });

  // ---------- animals and particles ----------
  await progress(0.93, 'Выпускаем рыб');
  const fish = new Recs(9);
  const FPAL = [[0.42, 0.58, 0.72], [0.95, 0.78, 0.22], [1.0, 0.5, 0.18], [0.3, 0.75, 0.8], [0.7, 0.75, 0.8]];
  const school = (x, z, h, rad, count) => {
    const fy = grid.floorY(x, z), y = Math.min(fy + h, C.SURF - 6), sseed = R(), c = FPAL[(R() * FPAL.length) | 0], dir = R() < 0.5 ? -1 : 1;
    for (let i = 0; i < count; i++) {
      const r = rad * (0.35 + 0.65 * Math.sqrt(R())), o = fish.add();
      fish.f.set([x, y, z, sseed, r, (R() - 0.5) * rad * 0.8, (dir * (1.2 + R() * 0.6)) / r, R() * 6.283], o);
      const v = 0.8 + R() * 0.4;
      fish.u[o + 8] = rgba(c[0] * v, c[1] * v, c[2] * v, R());
    }
  };
  school(POI.whale[0] + 17, POI.whale[1] + 8, 12, 6, 200); school(POI.ship[0] - 4, POI.ship[1] + 5, 9, 6, 220);
  school(POI.start[0] + 9, POI.start[1] - 16, 8, 4, 140); school(POI.grotA[0] - 8, POI.grotA[1] + 5, 12, 5, 200);
  school(POI.sponge[0], POI.sponge[1], 9, 6, 200); school(POI.boulders[0], POI.boulders[1], 16, 8, 220);
  for (let i = 0; i < 12; i++) { const a = R() * 6.283, r = 20 + R() * 95; school(Math.cos(a) * r, Math.sin(a) * r, 6 + R() * 14, 3 + R() * 5, 120 + (R() * 120 | 0)); }
  W.fish = { data: fish.u.subarray(0, fish.n * 9), count: fish.n };
  W.fishMesh = mergeMeshes([fishMesh()]);

  W.mantas = { count: 6, data: new Float32Array([
    0, 30, -6, 36, 0.05, 0.4, 1.3, 0,
    -8, 24, -18, 21, -0.075, 2.0, 1.0, 0,
    14, 35, 20, 48, 0.04, 3.6, 1.5, 0,
    POI.ship[0], 26, POI.ship[1], 24, -0.06, 1.0, 1.1, 0,
    POI.boulders[0], 33, POI.boulders[1], 26, 0.055, 5.0, 1.2, 0,
    -20, 38, 40, 60, -0.035, 4.4, 1.6, 0]) };
  W.mantaMesh = mergeMeshes([mantaMesh()]);

  const bub = new Recs(8);
  for (let v = 0; v < 60; v++) {
    const a = R() * 6.283, r = Math.sqrt(R()) * 115, sp = spots[v % 32], x = sp ? sp[0] + (R() - 0.5) * sp[3] : Math.cos(a) * r, z = sp ? sp[2] + (R() - 0.5) * sp[3] : Math.sin(a) * r;
    const y = grid.floorY(x, z);
    if (y > 30) continue;
    for (let i = 0; i < 34; i++) { const o = bub.add(); bub.f.set([x + (R() - 0.5) * 0.6, y, z + (R() - 0.5) * 0.6, R(), 1.3 + R() * 1.4, 0.025 + R() * R() * 0.09, 0.3 + R() * 0.6, 0], o); }
  }
  W.bubbles = { data: bub.u.subarray(0, bub.n * 8), count: bub.n };
  const snow = new Float32Array(Math.round(22000 * D) * 4);
  for (let i = 0; i < snow.length; i++) snow[i] = R();
  W.snow = { data: snow, count: snow.length / 4 };
  // smoke columns and embers over every hot spot
  const plumes = new Recs(8), embers = new Recs(8);
  for (const s of spots) {
    for (let k = 0; k < 3; k++) {
      const a = R() * 6.283, r = R() * s[3] * 0.6, px = s[0] + Math.cos(a) * r, pz = s[2] + Math.sin(a) * r, hgt = 11 + R() * 10;
      for (let i = 0; i < 22; i++) { const o = plumes.add(); plumes.f.set([px, s[1], pz, R(), 0.55 + R() * 0.35, s[3] * (0.26 + R() * 0.12), 0.7 + R() * 0.8, hgt], o); }
    }
    for (let i = 0; i < 90; i++) { const o = embers.add(); embers.f.set([s[0], s[1] - 0.2, s[2], R(), 0.35 + R() * 0.7, s[3] * 0.95, 2.5 + R() * 7, R()], o); }
  }
  W.plumes = { data: plumes.u.subarray(0, plumes.n * 8), count: plumes.n };
  W.embers = { data: embers.u.subarray(0, embers.n * 8), count: embers.n };
  W.stats = { terrainTris: terr.idx.length / 3, staticTris: W.staticIB.length / 3, leaves: leaves.n, grass: grassA.n + grassB.n, props: props.reduce((a, p) => a + p.n, 0), fish: fish.n, sparks: sparks.n };
  return W;
}
