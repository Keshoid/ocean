// Meshes for the ruins of the drowned city: columns, blocks, arches. Same vertex format as meshes.js.
import { rng, fbm } from './math.js';
import { Mesh } from './meshes.js';

// Hexahedron from 8 corners (bit0 = x, bit1 = y, bit2 = z side), flat-shaded.
function hexa(m, c, shade = 1) {
  const ys = c.map((p) => p[1]), lo = Math.min(...ys), hi = Math.max(...ys);
  for (const f of [[0, 4, 6, 2], [1, 3, 7, 5], [0, 1, 5, 4], [2, 6, 7, 3], [0, 2, 3, 1], [4, 5, 7, 6]]) {
    const v = f.map((k) => m.vert(c[k][0], c[k][1], c[k][2], shade, shade, shade, 0, 0.6 + 0.4 * ((c[k][1] - lo) / (hi - lo + 1e-6))));
    m.quad(v[0], v[1], v[2], v[3]);
  }
}
function boxAt(m, R, cx, cy, cz, sx, sy, sz, skew = 0.05) {
  const c = [];
  for (let k = 0; k < 8; k++) {
    c.push([cx + (k & 1 ? 0.5 : -0.5) * sx * (1 + (R() - 0.5) * skew), cy + (k & 2 ? 0.5 : -0.5) * sy * (1 + (R() - 0.5) * skew), cz + (k & 4 ? 0.5 : -0.5) * sz * (1 + (R() - 0.5) * skew)]);
  }
  hexa(m, c, 0.9 + R() * 0.1);
}

// Fluted column, radius 0.5. Options: square base + ring, capital, jagged broken top, or a loose drum.
export function columnMesh(seed, h, base, capital, drum) {
  const R = rng(seed), m = new Mesh(), S = 24, off = R() * 50;
  const prof = [];                                   // [radius, y, fluted, jagged]
  if (base) prof.push([0.68, 0.2, 0, 0], [0.68, 0.4, 0, 0]);
  const y0 = base ? 0.46 : 0, y1 = capital ? h - 0.52 : h, rings = Math.max(3, Math.round((y1 - y0) / 0.36));
  for (let k = 0; k <= rings; k++) {
    const y = y0 + ((y1 - y0) * k) / rings;
    const seam = k % 3 === 0 && k > 0 && k < rings ? 0.95 : 1;          // joints between the drums
    prof.push([0.5 * seam * (1 - 0.14 * Math.pow(y / 6.5, 1.5)), y, 1, !capital && !drum && k === rings ? 1 : 0]);
  }
  if (capital) prof.push([0.74, h - 0.24, 0, 0]);
  const b0 = m.nv;
  for (const [pr, py, fl, jag] of prof) for (let s = 0; s < S; s++) {
    const a = (s / S) * 6.2832, ca = Math.cos(a), sa = Math.sin(a);
    const r = pr * (fl && s % 2 ? 0.89 : 1) * (1 + (fbm(ca * 1.5 + off, py * 0.9, sa * 1.5, 3) - 0.5) * 0.07);
    const y = py - (jag ? fbm(ca * 1.7 + off, 5, sa * 1.7, 2) * Math.min(1.4, h * 0.35) : 0);
    m.vert(ca * r, y, sa * r, 1, 1, 1, 0, 0.5 + 0.5 * Math.min(1, py / 1.4) - (capital && py > h - 0.6 ? 0.2 : 0));
  }
  for (let k = 0; k < prof.length - 1; k++) for (let s = 0; s < S; s++) {
    const s1 = (s + 1) % S, a0 = b0 + k * S, a1 = a0 + S;
    m.quad(a0 + s, a1 + s, a1 + s1, a0 + s1);
  }
  const top = b0 + (prof.length - 1) * S;
  if (!capital) {
    const c = m.vert(0, h - (drum ? 0 : 0.55), 0, 0.8, 0.8, 0.8, 0, 0.8);
    for (let s = 0; s < S; s++) m.tri(top + s, c, top + ((s + 1) % S));
  }
  if (!base) {
    const c = m.vert(0, 0, 0, 0.8, 0.8, 0.8, 0, 0.6);
    for (let s = 0; s < S; s++) m.tri(b0 + ((s + 1) % S), c, b0 + s);
  }
  if (base) boxAt(m, R, 0, 0.1, 0, 1.4, 0.24, 1.4, 0.03);
  if (capital) boxAt(m, R, 0, h - 0.12, 0, 1.55, 0.26, 1.55, 0.03);
  return m.normals();
}

// Weathered block, origin at the bottom centre.
export function blockMesh(seed, sx, sy, sz) {
  const R = rng(seed), m = new Mesh();
  boxAt(m, R, 0, sy / 2, 0, sx, sy, sz, 0.12);
  return m.normals();
}

// Arch between two piers carrying an entablature. `broken` drops part of the ring and of the beam.
export function archMesh(seed, broken) {
  const R = rng(seed), m = new Mesh();
  const pw = 0.95, ph = 3.3, dz = 1.0, ri = 1.55, ro = 2.5, cx = ri + pw / 2, sy = ph + 0.22, topY = sy + ro;
  for (const s of [-1, 1]) {
    const cut = broken && s > 0;
    for (let k = 0; k < 3; k++) boxAt(m, R, s * cx, (ph / 3) * (k + 0.5), 0, pw, ph / 3 - 0.02, dz, 0.05);
    boxAt(m, R, s * cx, ph + 0.11, 0, pw + 0.28, 0.22, dz + 0.22, 0.03);
    const n = cut ? 1 : 3, hh = (topY - sy) / 3;
    for (let k = 0; k < n; k++) boxAt(m, R, s * (cx + 0.05), sy + hh * (k + 0.5), 0, pw - 0.1, hh - 0.02, dz - 0.08, 0.06);
  }
  const n = 11;
  for (let k = 0; k < n; k++) {
    if (broken && k >= 1 && k <= 5) continue;        // angle 0 is the +x side
    const a0 = (Math.PI * k) / n + 0.012, a1 = (Math.PI * (k + 1)) / n - 0.012, key = k === 5 ? 0.14 : 0, c = [];
    for (let b = 0; b < 8; b++) {
      const a = b & 1 ? a0 : a1, r = b & 2 ? ro + key + (R() - 0.5) * 0.06 : ri, z = (b & 4 ? 0.5 : -0.5) * (dz - 0.06 + key);
      c.push([Math.cos(a) * r, sy + Math.sin(a) * r, z]);
    }
    hexa(m, c, 0.88 + R() * 0.12);
  }
  const full = 2 * cx + pw + 0.5;
  if (broken) {
    boxAt(m, R, -full * 0.27, topY + 0.3, 0, full * 0.46, 0.56, dz + 0.25, 0.05);
    boxAt(m, R, -full * 0.3, topY + 0.68, 0, full * 0.4 + 0.3, 0.2, dz + 0.55, 0.04);
  } else {
    boxAt(m, R, 0, topY + 0.3, 0, full, 0.56, dz + 0.25, 0.03);
    boxAt(m, R, 0, topY + 0.68, 0, full + 0.35, 0.2, dz + 0.55, 0.03);
  }
  return m.normals();
}
