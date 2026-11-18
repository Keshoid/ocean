// Small math helpers: RNG, noise, matrices. No per-call allocations in the hot paths.

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function h3(x, y, z) {
  let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

export function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let fx = x - xi, fy = y - yi, fz = z - zi;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const a = h3(xi, yi, zi), b = h3(xi + 1, yi, zi), c = h3(xi, yi + 1, zi), d = h3(xi + 1, yi + 1, zi);
  const e = h3(xi, yi, zi + 1), f = h3(xi + 1, yi, zi + 1), g = h3(xi, yi + 1, zi + 1), h = h3(xi + 1, yi + 1, zi + 1);
  const ab = a + (b - a) * fx, cd = c + (d - c) * fx, ef = e + (f - e) * fx, gh = g + (h - g) * fx;
  const lo = ab + (cd - ab) * fy, hi = ef + (gh - ef) * fy;
  return lo + (hi - lo) * fz;
}

export function fbm(x, y, z, oct = 4) {
  let a = 0.5, s = 0, n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise(x, y, z); n += a;
    x = x * 2.03 + 17.1; y = y * 2.03 + 3.7; z = z * 2.03 + 9.2; a *= 0.5;
  }
  return s / n;
}

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const mix = (a, b, t) => a + (b - a) * t;

// ---- mat4 (column-major, WebGPU clip z in [0,1]) ----
export function perspective(o, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  o.fill(0);
  o[0] = f / aspect; o[5] = f; o[10] = far / (near - far); o[11] = -1; o[14] = (near * far) / (near - far);
}

export function ortho(o, l, r, b, t, n, f) {
  o.fill(0);
  o[0] = 2 / (r - l); o[5] = 2 / (t - b); o[10] = 1 / (n - f);
  o[12] = (l + r) / (l - r); o[13] = (t + b) / (b - t); o[14] = n / (n - f); o[15] = 1;
}

export function lookAt(o, ex, ey, ez, tx, ty, tz, ux, uy, uz) {
  let zx = ex - tx, zy = ey - ty, zz = ez - tz;
  let l = 1 / Math.hypot(zx, zy, zz); zx *= l; zy *= l; zz *= l;
  let xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
  l = 1 / Math.hypot(xx, xy, xz); xx *= l; xy *= l; xz *= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  o[0] = xx; o[1] = yx; o[2] = zx; o[3] = 0;
  o[4] = xy; o[5] = yy; o[6] = zy; o[7] = 0;
  o[8] = xz; o[9] = yz; o[10] = zz; o[11] = 0;
  o[12] = -(xx * ex + xy * ey + xz * ez);
  o[13] = -(yx * ex + yy * ey + yz * ez);
  o[14] = -(zx * ex + zy * ey + zz * ez);
  o[15] = 1;
}

export function mul(o, a, b) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    T[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    T[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    T[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    T[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  o.set(T);
}
const T = new Float32Array(16);

export function invert(o, m) {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3], a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11], a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  det = 1 / det;
  T[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  T[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  T[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  T[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  T[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  T[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  T[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  T[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  T[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  T[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  T[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  T[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  T[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  T[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  T[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  T[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  o.set(T);
}

// Model matrix: translate * rotY(yaw) * rotX(pitch) * rotZ(roll) * scale
export function trs(o, x, y, z, yaw, pitch, roll, s) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
  // R = Ry * Rx * Rz
  const r00 = cy * cr + sy * sp * sr, r01 = -cy * sr + sy * sp * cr, r02 = sy * cp;
  const r10 = cp * sr, r11 = cp * cr, r12 = -sp;
  const r20 = -sy * cr + cy * sp * sr, r21 = sy * sr + cy * sp * cr, r22 = cy * cp;
  o[0] = r00 * s; o[1] = r10 * s; o[2] = r20 * s; o[3] = 0;
  o[4] = r01 * s; o[5] = r11 * s; o[6] = r21 * s; o[7] = 0;
  o[8] = r02 * s; o[9] = r12 * s; o[10] = r22 * s; o[11] = 0;
  o[12] = x; o[13] = y; o[14] = z; o[15] = 1;
}

// Quaternion that rotates +Y onto (nx,ny,nz), then spins by `yaw` around it. Writes 4 floats.
export function quatFromUp(o, i, nx, ny, nz, yaw) {
  // q1: shortest arc from (0,1,0) to n  => axis = (nz, 0, -nx), w = 1 + ny
  let ax = nz, ay = 0, az = -nx, aw = 1 + ny;
  if (aw < 1e-4) { ax = 1; ay = 0; az = 0; aw = 0; }
  let l = 1 / Math.hypot(ax, ay, az, aw); ax *= l; ay *= l; az *= l; aw *= l;
  // q2: yaw about Y (applied first)
  const by = Math.sin(yaw / 2), bw = Math.cos(yaw / 2);
  // q = q1 * q2
  o[i] = ax * bw - az * by;
  o[i + 1] = aw * by + ay * bw;
  o[i + 2] = az * bw + ax * by;
  o[i + 3] = aw * bw - ay * by;
}
