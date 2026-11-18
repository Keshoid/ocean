// CPU mesh builders. Every mesh uses the same 20-byte vertex:
//   float32x3 position | snorm8x4 normal.xyz + ao | unorm8x4 color.rgb + material/param
import { rng, fbm, clamp } from './math.js';

export class Mesh {
  constructor() { this.p = []; this.n = []; this.c = []; this.i = []; }
  get nv() { return this.p.length / 3; }
  vert(x, y, z, r = 1, g = 1, b = 1, a = 0, ao = 1) {
    this.p.push(x, y, z); this.n.push(0, 0, 0, ao); this.c.push(r, g, b, a);
    return this.p.length / 3 - 1;
  }
  tri(a, b, c) { this.i.push(a, b, c); }
  quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
  // Smooth normals from faces (area weighted).
  normals() {
    const { p, n, i } = this;
    for (let k = 0; k < n.length; k += 4) n[k] = n[k + 1] = n[k + 2] = 0;
    for (let k = 0; k < i.length; k += 3) {
      const a = i[k] * 3, b = i[k + 1] * 3, c = i[k + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const q of [i[k], i[k + 1], i[k + 2]]) { n[q * 4] += nx; n[q * 4 + 1] += ny; n[q * 4 + 2] += nz; }
    }
    for (let k = 0; k < n.length; k += 4) {
      const l = Math.hypot(n[k], n[k + 1], n[k + 2]) || 1;
      n[k] /= l; n[k + 1] /= l; n[k + 2] /= l;
    }
    return this;
  }
}

export function packVerts(pos, nrm4, col4) {
  const nv = pos.length / 3, buf = new ArrayBuffer(nv * 20);
  const f = new Float32Array(buf), s = new Int8Array(buf), u = new Uint8Array(buf);
  for (let v = 0; v < nv; v++) {
    f[v * 5] = pos[v * 3]; f[v * 5 + 1] = pos[v * 3 + 1]; f[v * 5 + 2] = pos[v * 3 + 2];
    const o = v * 20 + 12;
    s[o] = Math.round(clamp(nrm4[v * 4], -1, 1) * 127);
    s[o + 1] = Math.round(clamp(nrm4[v * 4 + 1], -1, 1) * 127);
    s[o + 2] = Math.round(clamp(nrm4[v * 4 + 2], -1, 1) * 127);
    s[o + 3] = Math.round(clamp(nrm4[v * 4 + 3], 0, 1) * 127);
    u[o + 4] = Math.round(clamp(col4[v * 4], 0, 1) * 255);
    u[o + 5] = Math.round(clamp(col4[v * 4 + 1], 0, 1) * 255);
    u[o + 6] = Math.round(clamp(col4[v * 4 + 2], 0, 1) * 255);
    u[o + 7] = Math.round(clamp(col4[v * 4 + 3], 0, 1) * 255);
  }
  return buf;
}

// Concatenate meshes into one vertex/index buffer; returns draw ranges.
export function mergeMeshes(list) {
  let nv = 0, ni = 0;
  for (const m of list) { nv += m.nv; ni += m.i.length; }
  const vb = new Uint8Array(nv * 20), ib = new Uint32Array(ni), ranges = [];
  let v0 = 0, i0 = 0;
  for (const m of list) {
    vb.set(new Uint8Array(packVerts(m.p, m.n, m.c)), v0 * 20);
    ib.set(m.i, i0);
    ranges.push({ baseVertex: v0, firstIndex: i0, indexCount: m.i.length });
    v0 += m.nv; i0 += m.i.length;
  }
  return { vb, ib, ranges };
}

function icosphere(sub) {
  const t = (1 + Math.sqrt(5)) / 2;
  let v = [-1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0, 0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1];
  let f = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
  for (let s = 0; s < sub; s++) {
    const cache = new Map(), nf = [];
    const mid = (a, b) => {
      const k = a < b ? a * 65536 + b : b * 65536 + a;
      let m = cache.get(k);
      if (m === undefined) { m = v.length / 3; v.push((v[a * 3] + v[b * 3]) / 2, (v[a * 3 + 1] + v[b * 3 + 1]) / 2, (v[a * 3 + 2] + v[b * 3 + 2]) / 2); cache.set(k, m); }
      return m;
    };
    for (let k = 0; k < f.length; k += 3) {
      const a = f[k], b = f[k + 1], c = f[k + 2], ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      nf.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    f = nf;
  }
  for (let k = 0; k < v.length; k += 3) { const l = Math.hypot(v[k], v[k + 1], v[k + 2]); v[k] /= l; v[k + 1] /= l; v[k + 2] /= l; }
  return { v, f };
}

export function rockMesh(seed, sub) {
  const R = rng(seed), { v, f } = icosphere(sub), m = new Mesh();
  const sx = 0.8 + R() * 0.5, sy = 0.55 + R() * 0.4, sz = 0.8 + R() * 0.5, off = R() * 100;
  // random chopping planes give a faceted, broken look
  const planes = [];
  for (let k = 0; k < 5; k++) {
    const a = R() * 6.283, y = R() * 1.6 - 0.8, r = Math.sqrt(1 - y * y);
    planes.push([r * Math.cos(a), y, r * Math.sin(a), 0.62 + R() * 0.3]);
  }
  for (let k = 0; k < v.length; k += 3) {
    let x = v[k], y = v[k + 1], z = v[k + 2];
    const d = fbm(x * 1.4 + off, y * 1.4, z * 1.4, 3) - 0.5, d2 = fbm(x * 4 + off, y * 4 + 7, z * 4, 2) - 0.5;
    let r = 1 + d * 0.9 + d2 * 0.22;
    x *= r; y *= r; z *= r;
    for (const p of planes) {
      const h = x * p[0] + y * p[1] + z * p[2] - p[3];
      if (h > 0) { x -= p[0] * h * 0.85; y -= p[1] * h * 0.85; z -= p[2] * h * 0.85; }
    }
    m.vert(x * sx, y * sy, z * sz, 1, 1, 1, 0, clamp(0.75 + d * 1.2 + d2, 0.35, 1));
  }
  m.i = f;
  return m.normals();
}

// Tube between two points (appends to mesh). `col` = [r,g,b,a] at start/end.
function tube(m, a, b, ra, rb, sides, ca, cb, cap) {
  let dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
  let ux = 0, uy = 1, uz = 0; if (Math.abs(dy) > 0.9) { ux = 1; uy = 0; }
  let sx = dy * uz - dz * uy, sy = dz * ux - dx * uz, sz = dx * uy - dy * ux;
  let sl = Math.hypot(sx, sy, sz); sx /= sl; sy /= sl; sz /= sl;
  const tx = sy * dz - sz * dy, ty = sz * dx - sx * dz, tz = sx * dy - sy * dx;
  const base = m.nv;
  for (let ring = 0; ring < 2; ring++) {
    const p = ring ? b : a, r = ring ? rb : ra, c = ring ? cb : ca;
    for (let s = 0; s < sides; s++) {
      const an = (s / sides) * 6.2832, co = Math.cos(an) * r, si = Math.sin(an) * r;
      m.vert(p[0] + sx * co + tx * si, p[1] + sy * co + ty * si, p[2] + sz * co + tz * si, c[0], c[1], c[2], c[3], c[4] ?? 1);
    }
  }
  for (let s = 0; s < sides; s++) {
    const s1 = (s + 1) % sides;
    m.quad(base + s, base + sides + s, base + sides + s1, base + s1);
  }
  if (cap) {
    const tip = m.vert(b[0] + dx * rb * 1.2, b[1] + dy * rb * 1.2, b[2] + dz * rb * 1.2, cb[0], cb[1], cb[2], cb[3], cb[4] ?? 1);
    for (let s = 0; s < sides; s++) m.tri(base + sides + s, tip, base + sides + ((s + 1) % sides));
  }
}

// Branching staghorn coral. `flat` > 0 squashes it into a sea fan.
export function coralMesh(seed, flat = 0) {
  const R = rng(seed), m = new Mesh();
  const maxD = flat ? 5 : 4, sides = flat ? 4 : 5;
  const grow = (p, d, r, len, depth) => {
    const e = [p[0] + d[0] * len, p[1] + d[1] * len, p[2] + d[2] * len];
    const h0 = clamp(p[1] / 1.6, 0, 1), h1 = clamp(e[1] / 1.6, 0, 1);
    const c0 = 0.45 + 0.45 * h0, c1 = 0.45 + 0.45 * h1, last = depth >= maxD;
    const tipGlow = last ? 0.9 : 0.35 + 0.3 * h1;
    tube(m, p, e, r, r * (last ? 0.55 : 0.72), sides, [c0, c0, c0, 0.3 + 0.3 * h0, 0.55 + 0.45 * h0], [last ? 1 : c1, last ? 1 : c1, last ? 1 : c1, tipGlow, 0.6 + 0.4 * h1], last);
    if (last) return;
    const kids = flat ? 2 : 2 + (R() < 0.45 ? 1 : 0);
    for (let k = 0; k < kids; k++) {
      const spread = flat ? 0.5 : 0.75;
      let nx = d[0] + (R() - 0.5) * 2 * spread, ny = d[1] + (R() - 0.2) * spread * 0.9, nz = d[2] + (R() - 0.5) * 2 * spread * (flat ? 0.12 : 1);
      const l = Math.hypot(nx, ny, nz);
      grow(e, [nx / l, ny / l, nz / l], r * 0.72, len * (0.72 + R() * 0.2), depth + 1);
    }
  };
  const stems = flat ? 1 : 2 + (R() * 2 | 0);
  for (let s = 0; s < stems; s++) {
    const a = R() * 6.283, t = flat ? 0.15 : 0.45;
    grow([Math.cos(a) * 0.08, -0.1, Math.sin(a) * 0.08 * (flat ? 0.2 : 1)], norm3(Math.cos(a) * t, 1, Math.sin(a) * t * (flat ? 0.2 : 1)), flat ? 0.05 : 0.085, flat ? 0.42 : 0.5, 0);
  }
  return m.normals();
}
const norm3 = (x, y, z) => { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; };

// Lathe: barrel sponge (count = 1) or a cluster of tube sponges.
export function spongeMesh(seed, count) {
  const R = rng(seed), m = new Mesh(), sides = count > 1 ? 9 : 14;
  for (let c = 0; c < count; c++) {
    const a = R() * 6.283, d = count > 1 ? 0.22 + R() * 0.25 : 0;
    const ox = Math.cos(a) * d, oz = Math.sin(a) * d;
    const h = count > 1 ? 0.7 + R() * 0.9 : 1, w = count > 1 ? 0.2 + R() * 0.1 : 0.62;
    const lean = count > 1 ? 0.25 : 0.05, lx = Math.cos(a) * lean, lz = Math.sin(a) * lean;
    // profile: [radius, height, shade, ao]
    const prof = count > 1
      ? [[0.75, -0.1, 0.5, 0.6], [0.9, 0.3, 0.7, 0.8], [1.0, 0.75, 0.9, 1], [0.95, 1.0, 1, 1], [0.7, 0.99, 0.6, 0.6], [0.6, 0.6, 0.25, 0.25], [0.0, 0.5, 0.15, 0.15]]
      : [[0.45, -0.1, 0.5, 0.55], [0.8, 0.12, 0.65, 0.75], [1.0, 0.45, 0.85, 0.95], [0.97, 0.75, 0.95, 1], [0.8, 1.0, 1, 1], [0.62, 0.98, 0.6, 0.6], [0.55, 0.65, 0.3, 0.3], [0.42, 0.35, 0.18, 0.2], [0.0, 0.3, 0.12, 0.15]];
    const base = m.nv, ph = R() * 6;
    for (let k = 0; k < prof.length; k++) {
      const [pr, py, sh, ao] = prof[k];
      for (let s = 0; s < sides; s++) {
        const an = (s / sides) * 6.2832;
        const rr = pr * w * (1 + 0.07 * Math.sin(an * (count > 1 ? 3 : 7) + py * 3 + ph) * (k < 5 ? 1 : 0.3));
        m.vert(ox + lx * py * h + Math.cos(an) * rr, py * h, oz + lz * py * h + Math.sin(an) * rr, sh, sh, sh, 0.25 + 0.3 * sh, ao);
      }
    }
    for (let k = 0; k < prof.length - 1; k++) for (let s = 0; s < sides; s++) {
      const s1 = (s + 1) % sides, a0 = base + k * sides, a1 = a0 + sides;
      m.quad(a0 + s, a1 + s, a1 + s1, a0 + s1);
    }
  }
  return m.normals();
}

// Ground cover tuft: a handful of curved blades. color.r = height along blade, color.g = per-blade random.
export function tuftMesh(seed, blades, broad) {
  const R = rng(seed), m = new Mesh(), segs = 4;
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * 6.283 + R() * 0.8, lean = 0.25 + R() * (broad ? 0.9 : 0.6), h = 0.6 + R() * 0.5;
    const w = (broad ? 0.13 : 0.035) * (0.8 + R() * 0.5), rnd = R();
    const dx = Math.cos(a), dz = Math.sin(a), sx = -dz, sz = dx, r0 = R() * 0.08;
    const base = m.nv;
    for (let s = 0; s <= segs; s++) {
      const t = s / segs, out = r0 + lean * t * t * h, y = h * t * (1 - 0.25 * lean * t);
      const ww = w * (broad ? Math.sin(Math.PI * Math.pow(t, 0.7)) * 0.95 + 0.08 : 1 - t * 0.85);
      m.vert(dx * out - sx * ww, y, dz * out - sz * ww, t, rnd, 0, 0, 0.35 + 0.65 * t);
      m.vert(dx * out + sx * ww, y, dz * out + sz * ww, t, rnd, 1, 0, 0.35 + 0.65 * t);
    }
    for (let s = 0; s < segs; s++) m.quad(base + s * 2, base + s * 2 + 1, base + s * 2 + 3, base + s * 2 + 2);
  }
  return m.normals();
}

// Manta ray. +Z forward, X span. color.r = |span| (for the flap), color.g = belly flag, color.b = tail flag.
export function mantaMesh() {
  const m = new Mesh(), NA = 20, NB = 8;
  const le = (a) => 1.55 - 1.85 * Math.pow(Math.abs(a), 1.25);
  const te = (a) => -1.45 + 1.15 * Math.pow(Math.abs(a), 0.75);
  for (let side = 0; side < 2; side++) {
    const base = m.nv;
    for (let ia = 0; ia <= NA; ia++) {
      const a = (ia / NA) * 2 - 1, aa = Math.abs(a);
      for (let ib = 0; ib <= NB; ib++) {
        const b = ib / NB, z = le(a) + (te(a) - le(a)) * b;
        const th = (0.42 * Math.pow(1 - aa, 1.6) + 0.03) * Math.pow(Math.sin(Math.PI * Math.pow(b, 0.55)), 0.8);
        const y = side ? -th * 0.55 : th;
        m.vert(a * 3.3, y, z, aa, side, 0, 0, side ? 0.7 : 1);
      }
    }
    for (let ia = 0; ia < NA; ia++) for (let ib = 0; ib < NB; ib++) {
      const p = base + ia * (NB + 1) + ib, q = p + NB + 1;
      if (side) m.quad(p, p + 1, q + 1, q); else m.quad(p, q, q + 1, p + 1);
    }
  }
  // cephalic fins
  for (const s of [-1, 1]) tube(m, [s * 0.34, 0, 1.3], [s * 0.42, -0.12, 2.0], 0.11, 0.04, 4, [0, 0, 0, 0], [0, 0, 0, 0], true);
  // tail
  tube(m, [0, 0.02, -1.3], [0, 0.0, -3.0], 0.07, 0.035, 4, [0, 0, 1, 0], [0, 0, 1, 0], false);
  tube(m, [0, 0.0, -3.0], [0, 0.0, -5.2], 0.035, 0.008, 4, [0, 0, 1, 0], [0, 0, 1, 0], true);
  return m.normals();
}

// Tiny fish: +Z forward. color.r = tail weight for the wiggle.
export function fishMesh() {
  const m = new Mesh(), S = 6;
  const Z = [0.5, 0.4, 0.22, 0.02, -0.18, -0.34], HY = [0.012, 0.085, 0.145, 0.16, 0.11, 0.04];
  const w = (z) => clamp((0.25 - z) / 0.85, 0, 1);
  for (let r = 0; r < Z.length; r++) for (let s = 0; s < S; s++) {
    const a = (s / S) * 6.2832;
    m.vert(Math.sin(a) * HY[r] * 0.42, Math.cos(a) * HY[r] - 0.01, Z[r], w(Z[r]), 0, 0);
  }
  for (let r = 0; r < Z.length - 1; r++) for (let s = 0; s < S; s++) {
    const a = r * S + s, b = r * S + ((s + 1) % S);
    m.quad(a, a + S, b + S, b);
  }
  // tail and dorsal fins (flat, drawn two-sided)
  const tb = m.vert(0, 0, -0.33, w(-0.33), 0, 0), t1 = m.vert(0, 0.19, -0.62, 1, 0, 0), tm = m.vert(0, 0, -0.5, 1, 0, 0), t2 = m.vert(0, -0.19, -0.62, 1, 0, 0);
  m.tri(tb, t1, tm); m.tri(tb, tm, t2);
  const d0 = m.vert(0, 0.14, 0.14, w(0.14), 0, 0), d1 = m.vert(0, 0.25, -0.06, w(-0.06), 0, 0), d2 = m.vert(0, 0.11, -0.2, w(-0.2), 0, 0);
  m.tri(d0, d1, d2);
  return m.normals();
}

// Kelp blade: (u along, v across) strip.
export function leafMesh(segs) {
  const v = new Float32Array((segs + 1) * 4), i = new Uint16Array(segs * 6);
  for (let s = 0; s <= segs; s++) { const u = Math.pow(s / segs, 0.85); v.set([u, -1, u, 1], s * 4); }
  for (let s = 0; s < segs; s++) i.set([s * 2, s * 2 + 1, s * 2 + 3, s * 2, s * 2 + 3, s * 2 + 2], s * 6);
  return { v, i };
}

// Kelp stipe: (s along 0..1, ring corner index) tube.
export function stipeMesh(segs, sides) {
  const v = new Float32Array((segs + 1) * sides * 2), i = new Uint16Array(segs * sides * 6);
  for (let s = 0; s <= segs; s++) for (let k = 0; k < sides; k++) v.set([s / segs, (k / sides) * 6.2832], (s * sides + k) * 2);
  let o = 0;
  for (let s = 0; s < segs; s++) for (let k = 0; k < sides; k++) {
    const a = s * sides + k, b = s * sides + ((k + 1) % sides);
    i.set([a, a + sides, b + sides, a, b + sides, b], o); o += 6;
  }
  return { v, i };
}
