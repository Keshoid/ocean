// The kraken: a mantle mesh built here, and arms that are plain tube grids bent entirely in the vertex shader.
import { rng, fbm } from './math.js';
import { Mesh, mergeMeshes } from './meshes.js';

// Mantle and head, lathed along Z. +Z is the way it swims (mantle first), the arms trail from the crown at z = -3.4.
function bodyMesh() {
  const m = new Mesh(), S = 28, N = 30, zTip = 14, zEnd = -3.4, R = rng(77), off = R() * 40;
  // [distance along the body 0..1, radius]
  const prof = [[0, 0], [0.05, 1.9], [0.18, 4.3], [0.36, 5.4], [0.54, 4.7], [0.67, 3.4], [0.76, 3.0], [0.86, 3.7], [0.94, 3.3], [1, 2.5]];
  const radius = (u) => {
    let k = 0;
    while (k < prof.length - 2 && u > prof[k + 1][0]) k++;
    const a = prof[k], b = prof[k + 1], t = (u - a[0]) / (b[0] - a[0]), s = t * t * (3 - 2 * t);
    return a[1] + (b[1] - a[1]) * s;
  };
  for (let i = 0; i <= N; i++) {
    const u = i / N, z = zTip + (zEnd - zTip) * u, r = radius(u);
    for (let s = 0; s < S; s++) {
      const a = (s / S) * 6.2832, ca = Math.cos(a), sa = Math.sin(a);
      const warts = 1 + (fbm(ca * 2 + off, sa * 2, z * 0.35, 3) - 0.5) * 0.22 + (fbm(ca * 6 + off, sa * 6, z * 1.1, 2) - 0.5) * 0.06;
      const wide = u > 0.7 ? 1.12 : 1;                      // the head is broader than it is tall
      m.vert(ca * r * warts * wide, sa * r * warts * 0.86, z, u, 0, 0, 0, 0.75 + 0.25 * Math.min(1, r / 3));
    }
  }
  for (let i = 0; i < N; i++) for (let s = 0; s < S; s++) {
    const s1 = (s + 1) % S, a0 = i * S, a1 = a0 + S;
    m.quad(a0 + s, a1 + s, a1 + s1, a0 + s1);
  }
  return m.normals();
}

// A tube as a grid of (distance along 0..1, angle around). The seam vertex is doubled so the angle never wraps inside a face.
function armGrid(segs, sides) {
  const v = new Float32Array((segs + 1) * (sides + 1) * 2), i = new Uint16Array(segs * sides * 6);
  for (let s = 0; s <= segs; s++) for (let k = 0; k <= sides; k++) v.set([Math.pow(s / segs, 1.15), (k / sides) * 6.2832], (s * (sides + 1) + k) * 2);
  let o = 0;
  for (let s = 0; s < segs; s++) for (let k = 0; k < sides; k++) {
    const a = s * (sides + 1) + k, b = a + sides + 1;
    i.set([a, b, b + 1, a, b + 1, a + 1], o); o += 6;
  }
  return { v, i };
}

export function krakenParts() {
  const R = rng(4242), arms = new Float32Array(8 * 8);
  // per arm: index, length, wave phase, thickness | how far it splays out
  for (let k = 0; k < 8; k++) arms.set([k, 34 + R() * 12, k * 1.9 + R(), 1.7 + R() * 0.4, k % 3 === 0 ? 0.26 : 0.07 + R() * 0.08, 0, 0, 0], k * 8);
  return { body: mergeMeshes([bodyMesh()]), arm: armGrid(46, 10), arms };
}
