// World sculpting: signed distance fields evaluated on the GPU (compute), meshed on the CPU (surface nets).
const f = (v) => (+v).toFixed(4);

const NOISE = /* wgsl */ `
fn hash3(p: vec3f) -> f32 {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.x + q.y) * q.z);
}
fn vn(p: vec3f) -> f32 {
  let i = floor(p); let w = fract(p); let u = w * w * (3.0 - 2.0 * w);
  return mix(mix(mix(hash3(i), hash3(i + vec3f(1, 0, 0)), u.x), mix(hash3(i + vec3f(0, 1, 0)), hash3(i + vec3f(1, 1, 0)), u.x), u.y),
             mix(mix(hash3(i + vec3f(0, 0, 1)), hash3(i + vec3f(1, 0, 1)), u.x), mix(hash3(i + vec3f(0, 1, 1)), hash3(i + vec3f(1, 1, 1)), u.x), u.y), u.z);
}
fn fbm(p: vec3f) -> f32 {
  var a = 0.5; var s = 0.0; var q = p;
  for (var i = 0; i < 4; i++) { s += a * vn(q); q = q * 2.03 + vec3f(17.1, 3.7, 9.2); a *= 0.5; }
  return s;
}
fn smin(a: f32, b: f32, k: f32) -> f32 { let h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }
fn smax(a: f32, b: f32, k: f32) -> f32 { return -smin(-a, -b, k); }
fn cap(p: vec3f, a: vec3f, b: vec3f, r: f32) -> f32 {
  let pa = p - a; let ba = b - a; let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}
`;

export function sdfShader(C) {
  const flats = C.flats.map((z) => `vec4f(${f(z[0])}, ${f(z[1])}, ${f(z[2])}, ${f(z[3])})`).join(', ');
  return /* wgsl */ `
struct SP { origin: vec4f, dims: vec4u, info: vec4u };
@group(0) @binding(0) var<uniform> U: SP;
@group(0) @binding(1) var<storage, read_write> outB: array<f32>;
@group(0) @binding(2) var<storage, read> prims: array<vec4f>;
${NOISE}
const NFLAT = ${C.flats.length};
const FLATS = array<vec4f, NFLAT>(${flats});
const RIM: f32 = ${f(C.RIM)};

fn bedH(xz: vec2f) -> f32 {
  var h = 1.5 + 8.0 * fbm(vec3f(xz.x * 0.011, 1.7, xz.y * 0.011)) + 1.6 * vn(vec3f(xz.x * 0.055, 9.1, xz.y * 0.055));
  for (var i = 0; i < NFLAT; i++) {
    let z = FLATS[i];
    h = mix(h, z.w, 1.0 - smoothstep(z.z * 0.45, z.z, distance(xz, z.xy)));
  }
  return h;
}

fn sdTerrain(p: vec3f) -> f32 {
  let wv = vec3f(vn(p * 0.027 + 7.0), vn(p * 0.027 + 19.0), vn(p * 0.027 + 31.0)) - 0.5;
  let pw = p + wv * vec3f(15.0, 6.0, 15.0);
  var dr = 1e9; var dcut = 1e9;
  let n = U.info.y;
  for (var i = 0u; i < n; i++) {
    let a = prims[2u * i]; let b = prims[2u * i + 1u];
    let t = u32(b.w);
    if (t == 0u) {
      let q = (pw - a.xyz) / b.xyz;
      dr = smin(dr, (length(q) - 1.0) * min(b.x, min(b.y, b.z)), 7.0);
    } else if (t == 1u) {
      dr = smin(dr, cap(pw, a.xyz, b.xyz, a.w), 5.0);
    } else if (t == 2u) {
      let c = cos(b.y); let s = sin(b.y);
      var q = pw - a.xyz;
      q = vec3f(c * q.x + s * q.z, q.y / b.z, -s * q.x + c * q.z);
      dr = smin(dr, length(vec2f(length(q.xy) - a.w, q.z)) - b.x, 4.0);
    } else {
      dcut = min(dcut, cap(pw, a.xyz, b.xyz, a.w));
    }
  }
  // world rim: solid outside a wobbly circle
  dr = smin(dr, RIM + (fbm(vec3f(p.x * 0.018, 3.0, p.z * 0.018)) - 0.5) * 34.0 - length(p.xz), 9.0);
  // rock surface: big lumps, medium lumps, horizontal strata
  let n1 = fbm(pw * 0.05 + 3.0) - 0.47;
  let n2 = fbm(pw * 0.17 + 11.0) - 0.47;
  let strat = abs(fract(pw.y * 0.21 + n1 * 1.6) - 0.5) - 0.25;
  dr += n1 * 12.0 + n2 * 3.6 - strat * 1.3;
  dr = smax(dr, -dcut, 3.0);
  let h = bedH(p.xz);
  let db = (p.y - h - 0.7 * vn(p * 0.31)) * 0.8;
  return smin(db, dr, 3.5);
}

fn sdShip(p: vec3f) -> f32 {
  let L = 16.0;
  let xn = clamp(p.x / L, -1.0, 1.0);
  let ax = abs(xn);
  let bx = select(pow(max(1.0 - pow(ax, 3.2), 0.0), 0.5), pow(max(1.0 - pow(ax, 1.9), 0.0), 0.75), xn > 0.0);
  let hb = 4.0 * bx + 0.05;
  let sheer = 2.0 + 1.5 * xn * xn + 1.9 * smoothstep(-8.0, -9.2, p.x) + 0.9 * smoothstep(10.5, 11.5, p.x);
  let keel = -3.3 + 1.2 * pow(ax, 3.0);
  let hgt = sheer - keel;
  let t = clamp((p.y - keel) / hgt, 0.0, 1.0);
  let w = hb * pow(t, 0.4);
  let dwdy = hb * 0.4 * pow(max(t, 0.04), -0.6) / hgt;
  var hull = (abs(p.z) - w) / sqrt(1.0 + dwdy * dwdy);
  hull = max(hull, p.y - sheer);
  hull = max(hull, abs(p.x) - L);
  var d = abs(hull + 0.2) - 0.18;
  // rot: the deck is far more eaten away than the sides
  let n = fbm(p * 0.33 + 4.0);
  let n2 = fbm(p * 0.21 + 40.0);
  let deck = smoothstep(sheer - 1.3, sheer - 0.45, p.y);
  d = max(d, (n - mix(0.61, 0.43, deck)) * 3.0);
  d = max(d, -(length(p - vec3f(5.0, -0.4, 3.7)) - 3.1 + (n - 0.47) * 2.5));
  d = max(d, -(length(p - vec3f(-6.5, 1.0, -3.9)) - 2.2 + (n2 - 0.47) * 2.5));
  // ribs + deck beams
  let band = abs(fract(p.x / 1.6) - 0.5) * 1.6 - 0.15;
  var rib = max(abs(hull + 0.56) - 0.2, band);
  rib = max(rib, (n2 - 0.68) * 3.0);
  d = min(d, rib);
  // keel, stem and stern posts
  d = min(d, max(max(abs(p.z) - 0.28, abs(p.y - keel - 0.05) - 0.45), abs(p.x) - L - 0.3));
  d = min(d, cap(p, vec3f(L - 0.4, -2.2, 0.0), vec3f(L + 1.3, 6.0, 0.0), 0.3));
  d = min(d, cap(p, vec3f(-L + 0.3, -2.2, 0.0), vec3f(-L - 0.7, 7.2, 0.0), 0.3));
  // masts and spars
  d = min(d, cap(p, vec3f(0.5, -2.8, 0.0), vec3f(-0.5, 19.0, 0.5), 0.36));
  d = min(d, cap(p, vec3f(-0.3, 13.6, -5.2), vec3f(-0.2, 12.9, 5.2), 0.2));
  d = min(d, cap(p, vec3f(-0.1, 8.2, -5.8), vec3f(0.0, 8.9, 5.8), 0.22));
  d = min(d, max(length(p.xz - vec2f(-0.35, 0.4)) - 0.95, abs(p.y - 15.8) - 0.28));
  d = min(d, cap(p, vec3f(9.5, -2.0, 0.0), vec3f(10.3, 7.8, -0.7), 0.33));
  d = min(d, cap(p, vec3f(10.4, 5.0, -1.0), vec3f(15.2, 3.3, -5.4), 0.3));
  d = min(d, cap(p, vec3f(-11.0, 0.0, 0.0), vec3f(-11.9, 14.2, -0.4), 0.29));
  d = min(d, cap(p, vec3f(-11.6, 10.2, -3.4), vec3f(-11.5, 9.7, 3.4), 0.2));
  d = min(d, cap(p, vec3f(14.5, 3.7, 0.0), vec3f(22.0, 6.4, 0.2), 0.25));
  return d;
}

fn sdWhale(p0: vec3f) -> f32 {
  var p = p0;
  p.z -= 1.7 * sin(clamp(p.y, -6.0, 14.0) * 0.14);
  let h = clamp((p.y + 6.0) / 19.0, 0.0, 1.0);
  let r = mix(3.4, 1.15, pow(h, 0.75));
  let q = vec3f(p.x / 0.82, p.y - clamp(p.y, -6.0, 13.0), p.z / 1.15);
  var d = (length(q) - r) * 0.82;
  let pf = vec3f(abs(p.x), p.y, p.z);
  var fl = 1e9;
  for (var i = 0; i <= 30; i++) {
    let t = f32(i) / 30.0;
    let c = mix(mix(vec2f(0.0, 12.8), vec2f(7.2, 11.4), t), mix(vec2f(7.2, 11.4), vec2f(12.4, 18.6), t), t);
    let w = mix(3.3, 0.45, pow(t, 0.9));
    let th = mix(0.85, 0.15, pow(t, 0.7));
    let e = vec2f(length(pf.xy - c) / w, pf.z / th);
    fl = min(fl, (length(e) - 1.0) * th);
  }
  d = smin(d, fl, 1.6);
  // notch between the flukes
  d = smax(d, -(length(vec2f(p.x * 1.4, p.y - 17.0)) - 1.7), 0.6);
  d += (fbm(p0 * 0.9) - 0.47) * 0.4 + (fbm(p0 * 3.1) - 0.47) * 0.09;
  return d;
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let c = vec3u(id.x, id.y, id.z + U.info.x);
  if (any(c >= U.dims.xyz)) { return; }
  let p = U.origin.xyz + vec3f(c) * U.origin.w;
  var d = 0.0;
  if (U.dims.w == 0u) { d = sdTerrain(p); } else if (U.dims.w == 1u) { d = sdShip(p); } else { d = sdWhale(p); }
  outB[c.x + U.dims.x * (c.y + U.dims.y * c.z)] = d;
}
`;
}

// Runs the field on the GPU and reads it back as a Float32Array (x + nx*(y + ny*z)).
export function makeSdfRunner(dev, C) {
  const module = dev.createShaderModule({ code: sdfShader(C) });
  const pipe = dev.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  return async function run(origin, cell, n, kind, prims) {
    const total = n[0] * n[1] * n[2];
    const out = dev.createBuffer({ size: total * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const ub = dev.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const pd = prims && prims.length ? prims : new Float32Array(8);
    const pb = dev.createBuffer({ size: pd.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(pb, 0, pd);
    const bg = dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ub } }, { binding: 1, resource: { buffer: out } }, { binding: 2, resource: { buffer: pb } }] });
    const u = new ArrayBuffer(48), uf = new Float32Array(u), uu = new Uint32Array(u);
    uf.set([origin[0], origin[1], origin[2], cell]);
    uu.set([n[0], n[1], n[2], kind], 4);
    const slab = 16;
    for (let z0 = 0; z0 < n[2]; z0 += slab) {
      uu[8] = z0; uu[9] = prims ? prims.length / 8 : 0;
      dev.queue.writeBuffer(ub, 0, u);
      const enc = dev.createCommandEncoder(), pass = enc.beginComputePass();
      pass.setPipeline(pipe); pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(Math.ceil(n[0] / 4), Math.ceil(n[1] / 4), Math.ceil(Math.min(slab, n[2] - z0) / 4));
      pass.end();
      dev.queue.submit([enc.finish()]);
    }
    const rb = dev.createBuffer({ size: total * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = dev.createCommandEncoder();
    enc.copyBufferToBuffer(out, 0, rb, 0, total * 4);
    dev.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const g = new Float32Array(rb.getMappedRange().slice(0));
    rb.unmap(); rb.destroy(); out.destroy(); ub.destroy(); pb.destroy();
    return g;
  };
}

// A sampled field with world-space lookups.
export class Grid {
  constructor(g, origin, cell, n) {
    this.g = g; this.o = origin; this.cell = cell; this.n = n;
    this.sy = n[0]; this.sz = n[0] * n[1];
  }
  // trilinear sample at grid coordinates
  at(x, y, z) {
    const n = this.n, g = this.g;
    x = x < 0 ? 0 : x > n[0] - 1.001 ? n[0] - 1.001 : x;
    y = y < 0 ? 0 : y > n[1] - 1.001 ? n[1] - 1.001 : y;
    z = z < 0 ? 0 : z > n[2] - 1.001 ? n[2] - 1.001 : z;
    const xi = x | 0, yi = y | 0, zi = z | 0, fx = x - xi, fy = y - yi, fz = z - zi;
    const c = xi + this.sy * yi + this.sz * zi, sy = this.sy, sz = this.sz;
    const a = g[c] + (g[c + 1] - g[c]) * fx, b = g[c + sy] + (g[c + sy + 1] - g[c + sy]) * fx;
    const d = g[c + sz] + (g[c + sz + 1] - g[c + sz]) * fx, e = g[c + sz + sy] + (g[c + sz + sy + 1] - g[c + sz + sy]) * fx;
    const lo = a + (b - a) * fy, hi = d + (e - d) * fy;
    return lo + (hi - lo) * fz;
  }
  // world-space distance
  sd(x, y, z) { const o = this.o, k = 1 / this.cell; return this.at((x - o[0]) * k, (y - o[1]) * k, (z - o[2]) * k); }
  // lowest floor in a column, scanning upward from the bottom of the grid; returns world y
  floorY(x, z, from = -1e9) {
    const o = this.o, k = 1 / this.cell, gx = (x - o[0]) * k, gz = (z - o[2]) * k;
    let j = Math.max(0, Math.floor((from - o[1]) * k)), prev = this.at(gx, j, gz);
    for (j++; j < this.n[1]; j++) {
      const v = this.at(gx, j, gz);
      if (prev <= 0 && v > 0) return o[1] + (j - 1 + prev / (prev - v)) * this.cell;
      prev = v;
    }
    return 1e9;
  }
  // first ceiling above (x, y, z), world y
  ceilY(x, y, z) {
    const o = this.o, k = 1 / this.cell, gx = (x - o[0]) * k, gz = (z - o[2]) * k;
    let j = Math.ceil((y - o[1]) * k) + 1, prev = this.at(gx, j, gz);
    for (j++; j < this.n[1]; j++) {
      const v = this.at(gx, j, gz);
      if (prev > 0 && v <= 0) return o[1] + (j - 1 + prev / (prev - v)) * this.cell;
      prev = v;
    }
    return 1e9;
  }
}

// Naive surface nets. Returns world positions, gradient normals, AO and triangle indices.
export function surfaceNets(grid, aoScale) {
  const g = grid.g, [nx, ny, nz] = grid.n, sy = grid.sy, sz = grid.sz;
  const vidx = new Int32Array(nx * ny * nz);
  let pos = new Float32Array(1 << 18), nv = 0;
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) {
    let c = j * sy + k * sz;
    for (let i = 0; i < nx - 1; i++, c++) {
      const v0 = g[c], v1 = g[c + 1], v2 = g[c + sy], v3 = g[c + sy + 1], v4 = g[c + sz], v5 = g[c + sz + 1], v6 = g[c + sz + sy], v7 = g[c + sz + sy + 1];
      const s0 = v0 < 0, s1 = v1 < 0, s2 = v2 < 0, s3 = v3 < 0, s4 = v4 < 0, s5 = v5 < 0, s6 = v6 < 0, s7 = v7 < 0;
      const cnt = s0 + s1 + s2 + s3 + s4 + s5 + s6 + s7;
      if (cnt === 0 || cnt === 8) continue;
      let x = 0, y = 0, z = 0, n = 0;
      if (s0 !== s1) { x += v0 / (v0 - v1); n++; }
      if (s2 !== s3) { x += v2 / (v2 - v3); y++; n++; }
      if (s4 !== s5) { x += v4 / (v4 - v5); z++; n++; }
      if (s6 !== s7) { x += v6 / (v6 - v7); y++; z++; n++; }
      if (s0 !== s2) { y += v0 / (v0 - v2); n++; }
      if (s1 !== s3) { y += v1 / (v1 - v3); x++; n++; }
      if (s4 !== s6) { y += v4 / (v4 - v6); z++; n++; }
      if (s5 !== s7) { y += v5 / (v5 - v7); x++; z++; n++; }
      if (s0 !== s4) { z += v0 / (v0 - v4); n++; }
      if (s1 !== s5) { z += v1 / (v1 - v5); x++; n++; }
      if (s2 !== s6) { z += v2 / (v2 - v6); y++; n++; }
      if (s3 !== s7) { z += v3 / (v3 - v7); x++; y++; n++; }
      if (nv * 3 + 3 > pos.length) { const np = new Float32Array(pos.length * 2); np.set(pos); pos = np; }
      pos[nv * 3] = i + x / n; pos[nv * 3 + 1] = j + y / n; pos[nv * 3 + 2] = k + z / n;
      vidx[c] = ++nv;
    }
  }
  let idx = new Uint32Array(1 << 19), ni = 0;
  const quad = (a, b, c, d, flip) => {
    if (ni + 6 > idx.length) { const n2 = new Uint32Array(idx.length * 2); n2.set(idx); idx = n2; }
    a--; b--; c--; d--;
    if (flip) { idx[ni++] = a; idx[ni++] = c; idx[ni++] = b; idx[ni++] = a; idx[ni++] = d; idx[ni++] = c; }
    else { idx[ni++] = a; idx[ni++] = b; idx[ni++] = c; idx[ni++] = a; idx[ni++] = c; idx[ni++] = d; }
  };
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) {
    let c = 1 + j * sy + k * sz;
    for (let i = 1; i < nx - 1; i++, c++) {
      const a = g[c] < 0;
      if (a !== g[c + 1] < 0) quad(vidx[c], vidx[c - sy], vidx[c - sy - sz], vidx[c - sz], !a);
      if (a !== g[c + sy] < 0) quad(vidx[c], vidx[c - sz], vidx[c - sz - 1], vidx[c - 1], !a);
      if (a !== g[c + sz] < 0) quad(vidx[c], vidx[c - 1], vidx[c - 1 - sy], vidx[c - sy], !a);
    }
  }
  // normals from the field gradient, AO from the field itself
  const nrm = new Float32Array(nv * 4), cell = grid.cell, o = grid.o;
  const s1 = aoScale / cell, s2 = (aoScale * 3.2) / cell;
  for (let v = 0; v < nv; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    let gx = grid.at(x + 0.6, y, z) - grid.at(x - 0.6, y, z), gy = grid.at(x, y + 0.6, z) - grid.at(x, y - 0.6, z), gz = grid.at(x, y, z + 0.6) - grid.at(x, y, z - 0.6);
    const l = 1 / (Math.hypot(gx, gy, gz) || 1); gx *= l; gy *= l; gz *= l;
    const a1 = Math.min(1, Math.max(0, grid.at(x + gx * s1, y + gy * s1, z + gz * s1) / aoScale));
    const a2 = Math.min(1, Math.max(0, grid.at(x + gx * s2, y + gy * s2, z + gz * s2) / (aoScale * 3.2)));
    nrm[v * 4] = gx; nrm[v * 4 + 1] = gy; nrm[v * 4 + 2] = gz; nrm[v * 4 + 3] = 0.25 + 0.75 * (0.45 * a1 + 0.55 * a2);
    pos[v * 3] = o[0] + x * cell; pos[v * 3 + 1] = o[1] + y * cell; pos[v * 3 + 2] = o[2] + z * cell;
  }
  return { pos: pos.subarray(0, nv * 3), nrm, idx: idx.subarray(0, ni), nv };
}

// 128^3 tiling gradient-noise texture: rgb = gradient, a = value. Used for all surface detail.
export function buildNoiseTex(dev) {
  const N = 128, levels = 6;
  const tex = dev.createTexture({ size: [N, N, N], dimension: '3d', format: 'rgba8unorm', mipLevelCount: levels, usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
  const gen = dev.createShaderModule({ code: /* wgsl */ `
@group(0) @binding(0) var dst: texture_storage_3d<rgba8unorm, write>;
fn hg(i: vec3i, per: i32, oct: u32) -> vec3f {
  let w = ((i % per) + per) % per;
  var h = (u32(w.x) * 1597334677u) ^ (u32(w.y) * 3812015801u) ^ (u32(w.z) * 2798796415u) ^ (oct * 668265263u);
  h = h * 0x27d4eb2du; h ^= h >> 15u; h = h * 0x85ebca6bu; h ^= h >> 13u;
  let a = f32(h & 0xffffu) / 65535.0 * 6.2831853; let z = f32((h >> 16u) & 0xffffu) / 65535.0 * 2.0 - 1.0;
  let r = sqrt(max(1.0 - z * z, 0.0));
  return vec3f(r * cos(a), r * sin(a), z);
}
fn pn(p: vec3f, per: i32, oct: u32) -> f32 {
  let i = vec3i(floor(p)); let w = fract(p); let u = w * w * w * (w * (w * 6.0 - 15.0) + 10.0);
  let a = dot(hg(i, per, oct), w); let b = dot(hg(i + vec3i(1, 0, 0), per, oct), w - vec3f(1, 0, 0));
  let c = dot(hg(i + vec3i(0, 1, 0), per, oct), w - vec3f(0, 1, 0)); let d = dot(hg(i + vec3i(1, 1, 0), per, oct), w - vec3f(1, 1, 0));
  let e = dot(hg(i + vec3i(0, 0, 1), per, oct), w - vec3f(0, 0, 1)); let g = dot(hg(i + vec3i(1, 0, 1), per, oct), w - vec3f(1, 0, 1));
  let h = dot(hg(i + vec3i(0, 1, 1), per, oct), w - vec3f(0, 1, 1)); let k = dot(hg(i + vec3i(1, 1, 1), per, oct), w - vec3f(1, 1, 1));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
}
fn nf(q: vec3f) -> f32 {
  var s = 0.0; var a = 0.5; var fr = 4;
  for (var o = 0u; o < 4u; o++) { s += a * pn(q * f32(fr), fr, o); fr *= 2; a *= 0.55; }
  return s;
}
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let e = 1.0 / ${N}.0; let q = (vec3f(id) + 0.5) * e;
  let v = nf(q);
  let g = vec3f(nf(q + vec3f(e, 0, 0)) - v, nf(q + vec3f(0, e, 0)) - v, nf(q + vec3f(0, 0, e)) - v) * 9.0;
  textureStore(dst, id, vec4f(clamp(g * 0.5 + 0.5, vec3f(0), vec3f(1)), clamp(v * 1.25 + 0.5, 0.0, 1.0)));
}` });
  const mip = dev.createShaderModule({ code: /* wgsl */ `
@group(0) @binding(0) var src: texture_3d<f32>;
@group(0) @binding(1) var dst: texture_storage_3d<rgba8unorm, write>;
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id >= textureDimensions(dst))) { return; }
  var s = vec4f(0);
  for (var k = 0u; k < 8u; k++) { s += textureLoad(src, id * 2u + vec3u(k & 1u, (k >> 1u) & 1u, k >> 2u), 0); }
  textureStore(dst, id, s / 8.0);
}` });
  const p0 = dev.createComputePipeline({ layout: 'auto', compute: { module: gen, entryPoint: 'main' } });
  const p1 = dev.createComputePipeline({ layout: 'auto', compute: { module: mip, entryPoint: 'main' } });
  const view = (l) => tex.createView({ baseMipLevel: l, mipLevelCount: 1 });
  const enc = dev.createCommandEncoder();
  let pass = enc.beginComputePass();
  pass.setPipeline(p0);
  pass.setBindGroup(0, dev.createBindGroup({ layout: p0.getBindGroupLayout(0), entries: [{ binding: 0, resource: view(0) }] }));
  pass.dispatchWorkgroups(N / 4, N / 4, N / 4);
  pass.end();
  for (let l = 1; l < levels; l++) {
    pass = enc.beginComputePass();
    pass.setPipeline(p1);
    pass.setBindGroup(0, dev.createBindGroup({ layout: p1.getBindGroupLayout(0), entries: [{ binding: 0, resource: view(l - 1) }, { binding: 1, resource: view(l) }] }));
    const s = Math.max(1, (N >> l) / 4);
    pass.dispatchWorkgroups(s, s, s);
    pass.end();
  }
  dev.queue.submit([enc.finish()]);
  return tex;
}
