// All render shaders (WGSL). The look of the water lives in the constants at the top of `common`.
const f = (v) => (+v).toFixed(4);

export const common = (C) => /* wgsl */ `
const SURF: f32 = ${f(C.SURF)};
const SHRES: f32 = ${f(C.SHRES)};
const GROT = vec3f(${f(C.grotto[0])}, ${f(C.grotto[1])}, ${f(C.grotto[2])});
const STRAD: f32 = 0.34;

// ---- the palette ----
const WCOL = vec3f(0.020, 0.25, 0.36);    // water looking up
const DCOL = vec3f(0.003, 0.034, 0.085);  // water looking down / far
const PCOL = vec3f(0.17, 0.10, 0.36);     // grotto water looking up
const PDCOL = vec3f(0.030, 0.012, 0.085); // grotto water looking down
const SUNC = vec3f(2.0, 1.85, 1.8);
const LAVAC = vec3f(1.0, 0.30, 0.05);     // light thrown by the lava
const TORCHC = vec3f(5.6, 5.2, 4.3);      // helmet lamp        // sunlight just under the surface
const SUNABS = vec3f(0.050, 0.0145, 0.0145);// how fast sunlight loses each colour with depth
const FOGABS = vec3f(0.036, 0.016, 0.0125);
const FOGDEN: f32 = 0.0155;

struct Globals {
  viewProj: mat4x4f,
  invViewProj: mat4x4f,
  lightVP: mat4x4f,
  shipInv: mat4x4f,
  cam: vec4f,   // xyz, time
  sun: vec4f,   // direction to the sun, exposure
  res: vec4f,   // scene w, h, 1/w, 1/h
  misc: vec4f,  // grotto mask at camera, depth dimming, ray strength, pixels per metre at distance 1
  cres: vec4f,  // canvas w, h, 1/w, 1/h
  fx: vec4f,    // bloom strength, unused...
  visor: vec4f, // helmet lag x, y, roll, visor on (0..1)
  vis2: vec4f,  // breath fog, heat at the diver
  vel: vec4f,   // diver velocity, speed
  krak: vec4f,  // kraken position, shown (0/1)
  krak2: vec4f, // kraken heading, its animation clock
  torch: vec4f, // helmet lamp position, on (0..1)
  torchD: vec4f,// helmet lamp direction
  env: vec4f,   // night (0..1)
  lava: array<vec4f, 16>,   // hot spots: xyz, radius
};
@group(0) @binding(0) var<uniform> G: Globals;
@group(0) @binding(1) var shadowTex: texture_depth_2d;
@group(0) @binding(2) var shadowSmp: sampler_comparison;
@group(0) @binding(3) var noiseTex: texture_3d<f32>;
@group(0) @binding(4) var repSmp: sampler;
@group(0) @binding(5) var causTex: texture_2d<f32>;
@group(0) @binding(6) var crackTex: texture_2d<f32>;

fn grotto(p: vec3f) -> f32 { return 1.0 - smoothstep(0.5, 1.0, length(p.xz - GROT.xy) / GROT.z); }

fn waterColor(dir: vec3f, m: f32) -> vec3f {
  let k = smoothstep(-0.55, 0.85, dir.y);
  var c = mix(mix(DCOL, PDCOL, m), mix(WCOL, PCOL, m), k);
  let s = max(dot(dir, G.sun.xyz), 0.0);
  c += mix(vec3f(0.10, 0.45, 0.42), vec3f(0.34, 0.26, 0.55), m) * (pow(s, 5.0) * 0.5 + pow(s, 48.0) * 0.5);
  return c * G.misc.y * mix(vec3f(1.0), vec3f(0.030, 0.055, 0.095), G.env.x);
}
fn fogT(d: f32) -> vec3f { return exp(-d * FOGABS); }
fn applyFog(col: vec3f, P: vec3f) -> vec3f {
  let v = P - G.cam.xyz; let d = length(v);
  let m = 0.5 * (G.misc.x + grotto(P));
  return col * fogT(d) + waterColor(v / max(d, 0.001), m) * (1.0 - exp(-d * FOGDEN));
}

fn shadowAt(P: vec3f) -> f32 {
  let q = G.lightVP * vec4f(P, 1.0);
  let uv = q.xy * vec2f(0.5, -0.5) + 0.5;
  let z = q.z - 0.0006;
  // wide 3x3 kernel: light under water is diffuse, so shadows are soft and never quite black
  let o = 2.3 / SHRES;
  var s = 0.0;
  for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    s += textureSampleCompareLevel(shadowTex, shadowSmp, uv + vec2f(f32(x), f32(y)) * o, z);
  } }
  return 0.1 + 0.1 * s;
}
fn sunAt(y: f32) -> vec3f { return SUNC * exp(-max(SURF - y, 0.0) * SUNABS) * mix(vec3f(1.0), vec3f(0.030, 0.045, 0.07), G.env.x); }
fn ambAt(N: vec3f, P: vec3f, m: f32) -> vec3f {
  let up = mix(vec3f(0.018, 0.105, 0.165), vec3f(0.20, 0.125, 0.40), m);
  let dn = mix(vec3f(0.006, 0.026, 0.038), vec3f(0.05, 0.02, 0.09), m);
  // sky dome + a soft side fill from the open water opposite the sun, so shaded rock keeps its shape
  let F = normalize(vec3f(-G.sun.x, 0.25, -G.sun.z));
  let a = mix(dn, up, smoothstep(-1.0, 1.0, N.y)) + up * (0.45 * max(dot(N, F), 0.0));
  return a * exp(-max(SURF - P.y, 0.0) * 0.015) * mix(1.0, 0.08, G.env.x);
}
fn causticAt(P: vec3f) -> f32 {
  let L = G.sun.xyz;
  let q = P.xz + L.xz * ((SURF - P.y) / L.y);
  return 0.45 + 0.9 * textureSample(causTex, repSmp, q / 11.0).r;
}
// Shared lighting: sun (shadowed, with caustics) + sky ambient + optional light coming through thin things.
// The helmet lamp: a soft-edged cone with a hot centre, fading with distance and with the water.
fn torchAt(P: vec3f) -> vec3f {
  let v = P - G.torch.xyz; let d2 = dot(v, v); let d = sqrt(d2);
  let ca = dot(v / max(d, 0.001), G.torchD.xyz);
  let cone = smoothstep(0.90, 0.985, ca);
  return TORCHC * (G.torch.w * (cone * cone + 0.05 * smoothstep(0.70, 0.95, ca)) / (1.0 + 0.012 * d2)) * exp(-d * FOGABS * 1.2);
}
// How volcanically active the ground is at p (<= 0 away from every hot spot).
fn lavaHeat(p: vec3f) -> f32 {
  var h = 0.0;
  for (var i = 0; i < 16; i++) {
    let s = G.lava[i]; let d = distance(p.xz, s.xz) / s.w;
    h = max(h, (1.0 - d * d) * smoothstep(16.0, 5.0, p.y - s.y));
  }
  return h;
}
// Glow of the lava fields on whatever is near them (unshadowed point lights from below).
fn lavaLight(P: vec3f, N: vec3f) -> vec3f {
  var a = 0.0;
  for (var i = 0; i < 16; i++) {
    let s = G.lava[i]; let v = s.xyz - P; let r2 = s.w * s.w; let d2 = dot(v, v);
    a += r2 / (d2 + r2 * 0.5) * smoothstep(r2 * 9.0, r2 * 0.8, d2) * max(dot(N, v) * inverseSqrt(d2 + 0.01) * 0.7 + 0.3, 0.0);
  }
  return LAVAC * (a * 0.45);
}
fn shade(P: vec3f, N: vec3f, alb: vec3f, ao: f32, tr: vec3f) -> vec3f {
  let L = G.sun.xyz; let ndl = dot(N, L);
  let sh = shadowAt(P + N * (0.2 * sign(ndl)) + L * 0.08);
  let sun = sunAt(P.y) * (sh * causticAt(P));
  let lamp = torchAt(P) * max(dot(N, normalize(G.torch.xyz - P)) * 0.8 + 0.2, 0.0);
  return alb * (sun * max(ndl, 0.0) + ambAt(N, P, grotto(P)) * ao + lavaLight(P, N) + lamp) + tr * sun * max(-ndl, 0.0);
}

fn kelpSway(base: vec3f, s: f32, seed: f32) -> vec3f {
  let t = G.cam.w;
  let k = s / 40.0;
  let a = k * k * 10.0 + k * 1.6;
  let ph = seed * 6.283 + base.x * 0.045 + base.z * 0.037;
  let sw = vec2f(sin(t * 0.33 + ph * 0.3 - s * 0.06) + 0.45 * sin(t * 0.71 + ph + s * 0.13),
                 cos(t * 0.27 + ph * 0.5 - s * 0.05) + 0.45 * sin(t * 0.63 + ph * 1.7 + s * 0.11));
  let me = vec2f(sin(s * 0.19 + ph * 3.0), cos(s * 0.15 + ph * 2.0)) * (0.25 + k * 1.6) * smoothstep(0.0, 4.0, s);
  return vec3f(sw.x * a * 0.4 + me.x, 0.0, sw.y * a * 0.4 + me.y);
}
fn qrot(q: vec4f, v: vec3f) -> vec3f { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
fn ign(p: vec2f) -> f32 { return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715)))); }

struct BB { clip: vec4f, k: f32 };
fn bill(p: vec3f, c: vec2f, size: f32, minPx: f32) -> BB {
  let cp = G.viewProj * vec4f(p, 1.0);
  let px = size * G.misc.w / max(cp.w, 0.05);
  let pxc = max(px, minPx);
  var o: BB;
  o.clip = vec4f(cp.xy + c * pxc * 2.0 * G.res.zw * cp.w, cp.zw);
  o.k = (px / pxc) * (px / pxc);
  return o;
}
fn corner(vi: u32) -> vec2f {
  var c = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, 1), vec2f(-1, 1));
  return c[vi];
}
`;

export const scene = /* wgsl */ `
struct FIn {
  @builtin(position) clip: vec4f,
  @location(0) wpos: vec3f,
  @location(1) nrm: vec3f,
  @location(2) col: vec4f,
  @location(3) ao: f32,
  @location(4) tpos: vec3f,
};

// ---------- static geometry: seabed, cliffs, ship, whale ----------
@vertex fn vsStatic(@location(0) pos: vec3f, @location(1) na: vec4f, @location(2) col: vec4f) -> FIn {
  var o: FIn;
  o.clip = G.viewProj * vec4f(pos, 1.0);
  o.wpos = pos; o.tpos = pos; o.nrm = na.xyz; o.ao = na.w; o.col = col;
  return o;
}

@fragment fn fsStatic(i: FIn) -> @location(0) vec4f {
  let P = i.wpos; let Ng = normalize(i.nrm);
  let mat = i.col.r * 255.0;
  let isWood = step(0.5, mat) * step(mat, 1.5);
  let isStone = step(1.5, mat);
  let lp = (G.shipInv * vec4f(P, 1.0)).xyz;
  let ln = (G.shipInv * vec4f(Ng, 0.0)).xyz;
  let n1 = textureSample(noiseTex, repSmp, P * 0.021);
  let n2 = textureSample(noiseTex, repSmp, P * 0.129 + 0.37);
  let n3 = textureSample(noiseTex, repSmp, mix(P * 0.67, lp * vec3f(0.09, 1.1, 1.1), isWood) + 0.11);
  let n4 = textureSample(noiseTex, repSmp, P * 2.7);
  var g = (n1.xyz - 0.5) * 1.2 + (n2.xyz - 0.5) * 1.7 + (n3.xyz - 0.5) * 1.1 + (n4.xyz - 0.5) * 0.5;
  let pm = grotto(P);

  // volcanic seabed: black basalt plates, with lava flowing in the channels between them
  let heat0 = lavaHeat(P);
  let heat = clamp(max(heat0 * (0.7 + 1.1 * n1.a), smoothstep(0.64, 0.78, n1.a) * 0.4), 0.0, 1.0) * (1.0 - pm * 0.6);
  let wuv = P.xz + (n2.xy - 0.5) * 0.9;
  let k1 = textureSample(crackTex, repSmp, wuv / 20.0);
  let k2 = textureSample(crackTex, repSmp, wuv / 5.3 + 0.31);
  let plate = smoothstep(0.40, 0.72, Ng.y);                   // plates on the floor, veins in the walls
  // streams: winding ribbons that follow the contour lines of a broad noise field
  let nr = textureSample(noiseTex, repSmp, vec3f(P.x, 0.0, P.z) * 0.027 + vec3f(0.13, 0.41, 0.77));
  let rd = abs(nr.a - 0.5);
  let rw = max(0.026 * smoothstep(0.12, 0.7, heat), 0.0004);  // half-width of a stream, in noise units
  let ron = step(0.001, rw);
  let river = (1.0 - smoothstep(rw * 0.55, rw, rd)) * ron;
  let wl = mix(0.05, 0.20, heat * heat * heat);               // how wide the molten part of a crack is
  let lava1 = max(1.0 - smoothstep(wl * 0.3, wl, k1.r), k1.a) * smoothstep(0.10, 0.30, heat);
  let lava2 = k2.a * smoothstep(0.40, 0.8, heat) * 0.6;
  let vein = (1.0 - smoothstep(0.0, 0.035, abs(n2.a - 0.5))) * smoothstep(0.25, 0.7, heat);
  // the melt moves: its cooled skin drifts along the stream (two samples, cross-faded as each one wraps)
  let fdir = normalize(vec2f(-(nr.z - 0.5), nr.x - 0.5) + vec2f(0.0003, 0.0));
  let ph0 = fract(G.cam.w * 0.11); let ph1 = fract(G.cam.w * 0.11 + 0.5);
  let fuv = P.xz * 0.42;
  let fa = textureSample(noiseTex, repSmp, vec3f(fuv.x - fdir.x * ph0 * 1.7, 0.31, fuv.y - fdir.y * ph0 * 1.7)).a;
  let fb = textureSample(noiseTex, repSmp, vec3f(fuv.x - fdir.x * ph1 * 1.7 + 0.37, 0.71, fuv.y - fdir.y * ph1 * 1.7 + 0.19)).a;
  let flow = mix(fa, fb, abs(2.0 * ph0 - 1.0));
  let crust = 0.10 + 0.90 * smoothstep(0.60, 0.40, flow * 0.7 + n4.a * 0.3);
  let molten = clamp(mix(vein, max(max(lava1, lava2), river), plate), 0.0, 1.0) * crust * (1.0 - isWood) * (1.0 - isStone);
  var bas = mix(vec3f(0.008, 0.009, 0.011), vec3f(0.052, 0.049, 0.047), smoothstep(0.2, 0.8, n3.a * 0.6 + n2.a * 0.4)) * (0.65 + 0.7 * n4.a);
  let crk = mix(1.0, (1.0 - 0.8 * k1.a) * (1.0 - 0.5 * k2.a), plate);
  bas *= crk;
  bas = mix(bas, vec3f(0.012, 0.035, 0.024), smoothstep(0.52, 0.72, n1.a * 0.6 + n3.a * 0.4) * (1.0 - heat) * 0.5 * (1.0 - pm));   // a little algae on cold rock
  bas = mix(bas, vec3f(0.14, 0.04, 0.14), pm * smoothstep(0.4, 0.62, n2.a) * 0.85);
  var alb = mix(bas, vec3f(0.0), molten);
  // plates dome up and fall away into the cracks and down the banks of the streams
  g -= vec3f(k1.g - 0.5, 0.0, k1.b - 0.5) * ((1.0 - smoothstep(0.0, 0.30, k1.r)) * 3.0 * plate);
  g -= vec3f(k2.g - 0.5, 0.0, k2.b - 0.5) * ((1.0 - smoothstep(0.0, 0.25, k2.r)) * 1.2 * plate);
  let bank = (1.0 - smoothstep(rw, rw * 2.4, rd)) * ron * (1.0 - river);
  g += vec3f(nr.x - 0.5, 0.0, nr.z - 0.5) * (sign(nr.a - 0.5) * bank * 5.0 * plate);
  var bump = mix(2.2, 1.9, plate);
  var ao = i.ao * mix(smoothstep(0.15, 0.7, n2.a) * 1.25, 0.5 + 0.5 * crk, plate) * (1.0 - 0.4 * bank);

  // ship timber
  let deckish = step(0.75, abs(ln.y));
  let pv = mix(lp.y / 0.44, lp.z / 0.36, deckish);
  let seam = smoothstep(0.5, 0.40, abs(fract(pv) - 0.5));
  let plankTint = 0.75 + 0.5 * fract(sin(floor(pv) * 12.9898) * 43758.5453);
  var wood = mix(vec3f(0.15, 0.10, 0.065), vec3f(0.36, 0.26, 0.16), n3.a) * plankTint * (0.35 + 0.65 * seam);
  wood = mix(wood, vec3f(0.08, 0.22, 0.14), smoothstep(0.45, 0.75, n2.a * 0.7 + Ng.y * 0.35) * 0.8);
  alb = mix(alb, wood, isWood);
  bump = mix(bump, 0.9, isWood);
  ao = mix(ao, i.ao * (0.6 + 0.4 * seam), isWood);

  // whale: pale weathered stone
  var stone = mix(vec3f(0.26, 0.29, 0.31), vec3f(0.50, 0.52, 0.51), n2.a * 0.6 + n3.a * 0.4);
  stone *= 0.8 + 0.4 * smoothstep(0.35, 0.65, n1.a);
  stone = mix(stone, vec3f(0.06, 0.17, 0.10), smoothstep(0.5, 0.8, n2.a * 0.6 + Ng.y * 0.5) * 0.7);
  alb = mix(alb, stone, isStone);
  bump = mix(bump, 0.7, isStone);
  ao = mix(ao, i.ao * (0.6 + 0.8 * n2.a), isStone);

  let N = normalize(Ng - (g - Ng * dot(g, Ng)) * bump);
  var c = shade(P, N, alb, ao, vec3f(0.0));
  let flick = 0.6 + 0.8 * textureSample(noiseTex, repSmp, P * 0.31 + vec3f(0.0, G.cam.w * 0.035, 0.0)).a;
  c += (vec3f(0.9, 0.09, 0.008) * molten * 1.2 + vec3f(1.0, 0.34, 0.04) * pow(molten, 3.0) * 2.1 + vec3f(1.0, 0.72, 0.28) * pow(molten, 9.0) * 1.3) * flick;
  c += vec3f(0.75, 0.10, 0.01) * (bank * plate * 0.22 * (1.0 - isWood) * (1.0 - isStone));       // the banks glow dull red
  return vec4f(applyFog(c, P), 1.0);
}

// ---------- instanced props: rocks, corals, sponges ----------
@vertex fn vsProp(@location(0) pos: vec3f, @location(1) na: vec4f, @location(2) col: vec4f,
                  @location(3) ps: vec4f, @location(4) q: vec4f, @location(5) tint: vec4f) -> FIn {
  var o: FIn;
  let lp = qrot(q, pos * ps.w);
  var p = lp + ps.xyz;
  o.tpos = p + ps.xyz * 0.37;
  p.y += sin(G.cam.w * 0.21 + ps.x * 0.7 + ps.z * 0.3) * 0.7 * step(0.75, tint.a);       // floating boulders bob
  o.clip = G.viewProj * vec4f(p, 1.0);
  o.wpos = p; o.nrm = qrot(q, na.xyz); o.ao = na.w;
  o.col = vec4f(col.rgb * tint.rgb, mix(col.a, 2.0, step(0.25, tint.a) * step(tint.a, 0.75)));     // alpha 2 marks carved stone
  return o;
}

@fragment fn fsProp(i: FIn) -> @location(0) vec4f {
  let P = i.wpos; let Ng = normalize(i.nrm);
  let isRuin = step(1.5, i.col.a);
  let org = i.col.a * (1.0 - isRuin);     // 0 = rock, >0 = living thing (glows a little)
  let isRock = step(org, 0.01);
  let n2 = textureSample(noiseTex, repSmp, i.tpos * 0.19);
  let n3 = textureSample(noiseTex, repSmp, i.tpos * 0.83);
  let g = ((n2.xyz - 0.5) * 1.3 + (n3.xyz - 0.5) * 1.1) * mix(0.9, 1.5, isRock);
  let N = normalize(Ng - (g - Ng * dot(g, Ng)));
  var rock = mix(vec3f(0.010, 0.011, 0.013), vec3f(0.070, 0.066, 0.062), smoothstep(0.25, 0.75, n2.a * 0.6 + n3.a * 0.4)) * i.col.rgb * 2.0;
  let pm = grotto(P);
  rock = mix(rock, vec3f(0.018, 0.05, 0.03), smoothstep(0.5, 0.75, n2.a * 0.6 + Ng.y * 0.4) * 0.4 * (1.0 - pm));
  rock = mix(rock, vec3f(0.26, 0.07, 0.25), pm * smoothstep(0.42, 0.62, n2.a) * 0.8);
  // carved stone of the drowned city: pale, streaked, mossy on top, sooty where the lava is close
  var ruin = mix(vec3f(0.16, 0.15, 0.125), vec3f(0.34, 0.32, 0.27), smoothstep(0.25, 0.75, n2.a * 0.55 + n3.a * 0.45)) * i.col.rgb;
  ruin *= 0.7 + 0.3 * smoothstep(0.3, 0.6, textureSample(noiseTex, repSmp, i.tpos * vec3f(0.6, 0.07, 0.6)).a);
  ruin = mix(ruin, vec3f(0.05, 0.11, 0.07), smoothstep(0.58, 0.84, n2.a * 0.55 + Ng.y * 0.45) * 0.25);
  ruin = mix(ruin, vec3f(0.03, 0.025, 0.02), clamp(lavaHeat(P), 0.0, 1.0) * 0.55);
  rock = mix(rock, ruin, isRuin);
  let alb = mix(i.col.rgb * (0.25 + 0.75 * smoothstep(0.25, 0.7, n3.a)) * 0.8, rock, isRock);
  let ao = i.ao * mix(1.0, smoothstep(0.15, 0.7, n2.a) * 1.25, isRock);
  var c = shade(P, N, alb, ao, alb * org * 0.4);
  c += alb * org * (0.30 + 0.30 * pm) * exp(-max(SURF - P.y, 0.0) * 0.012) * (1.0 + 3.5 * G.env.x);
  return vec4f(applyFog(c, P), 1.0);
}

// ---------- ground cover ----------
@vertex fn vsGrass(@location(0) pos: vec3f, @location(1) na: vec4f, @location(2) col: vec4f,
                   @location(3) ps: vec4f, @location(4) ic: vec4f) -> FIn {
  var o: FIn;
  let t = G.cam.w;
  let yaw = ic.a * 6.2831853; let c = cos(yaw); let s = sin(yaw);
  var lp = vec3f(c * pos.x + s * pos.z, pos.y, -s * pos.x + c * pos.z) * ps.w;
  let h = col.r;
  let ph = ps.x * 0.31 + ps.z * 0.27;
  lp += vec3f(sin(t * 1.1 + ph) + 0.4 * sin(t * 2.3 + ph * 2.1), 0.0, cos(t * 0.9 + ph * 1.3)) * (h * h * 0.13 * ps.w);
  let p = lp + ps.xyz;
  o.clip = G.viewProj * vec4f(p, 1.0);
  o.wpos = p; o.tpos = vec3f(h, col.g, col.b);
  let n = vec3f(c * na.x + s * na.z, na.y, -s * na.x + c * na.z);
  o.nrm = n; o.ao = na.w;
  o.col = vec4f(ic.rgb, 1.0);
  return o;
}

@fragment fn fsGrass(i: FIn, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  var N = normalize(i.nrm); if (!ff) { N = -N; }
  N = normalize(N + vec3f(0.0, 1.3, 0.0));
  let h = i.tpos.x;
  let var_ = 0.7 + 0.6 * i.tpos.y;
  let alb = i.col.rgb * var_ * (0.18 + 0.62 * h) * (1.0 - 0.25 * smoothstep(0.35, 0.0, abs(i.tpos.z - 0.5)));
  var c = shade(i.wpos, N, alb, i.ao, alb * 0.8);
  let glow = max(max(i.col.r, i.col.b) - i.col.g, 0.0);    // magenta/violet covers fluoresce, green ones don't
  c += alb * glow * (0.15 + 0.7 * h * h) * (1.0 + grotto(i.wpos)) * exp(-max(SURF - i.wpos.y, 0.0) * 0.01);
  c += i.col.rgb * ((h * h * 1.2 + 0.08) * G.env.x * 0.9);          // the whole carpet glows at night
  return vec4f(applyFog(c, i.wpos), 1.0);
}

// ---------- kelp ----------
struct KOut {
  @builtin(position) clip: vec4f,
  @location(0) wpos: vec3f,
  @location(1) nrm: vec3f,
  @location(2) uvh: vec3f,
  @location(3) par: vec3f,
};

@vertex fn vsLeaf(@location(0) uv: vec2f, @location(1) a: vec4f, @location(2) b: vec4f, @location(3) c: vec4f) -> KOut {
  let t = G.cam.w; let seed = a.w; let s = b.x; let len = b.z;
  let u = uv.x;
  let sw = kelpSway(a.xyz, s, seed);
  let stA = c.w * 6.2831853 + s * 0.35;
  let attach = a.xyz + vec3f(0.0, s, 0.0) + sw + vec3f(cos(stA), 0.0, sin(stA)) * (STRAD * smoothstep(0.0, 3.0, s));
  let fl = sin(t * 0.8 + seed * 40.0 + s * 0.7 + b.y * 3.0);
  let fl2 = sin(t * 1.7 + b.y * 11.0 + s * 1.3);
  let th = b.y + fl * 0.10;
  let dOut = vec3f(cos(th), 0.0, sin(th)); let side = vec3f(-dOut.z, 0.0, dOut.x);
  let phi0 = 0.85 + 0.12 * fl + (c.z - 0.5) * 0.7;
  let k = 1.7 + 1.1 * c.x + 0.25 * fl2;
  let phi = phi0 - k * u;
  let ctr = len * (dOut * ((sin(phi0) - sin(phi)) / k) + vec3f(0.0, 1.0, 0.0) * ((cos(phi) - cos(phi0)) / k));
  let T = dOut * cos(phi) + vec3f(0.0, sin(phi), 0.0);
  let Nn = -dOut * sin(phi) + vec3f(0.0, cos(phi), 0.0);
  let tw = (c.z - 0.5) * 2.4 + u * 2.2 * (c.x - 0.5) + fl2 * 0.35 * u;
  let sd = side * cos(tw) + Nn * sin(tw);
  let nn = Nn * cos(tw) - side * sin(tw);
  let dist = distance(a.xz, G.cam.xz);
  let widen = 1.0 + smoothstep(45.0, 140.0, dist) * 0.9;
  let shape = max(pow(sin(3.14159 * pow(u, 0.6)), 0.75), 0.07) * (1.0 - smoothstep(0.9, 1.0, u));
  let wd = len * 0.085 * shape * widen;
  let ruf = sin(u * 19.0 + seed * 50.0 + b.y * 9.0) * 0.05 * len * 0.5;
  let p = attach + ctr + sd * (uv.y * wd) + nn * (ruf * uv.y);
  var o: KOut;
  o.clip = G.viewProj * vec4f(p, 1.0);
  o.wpos = p;
  o.nrm = normalize(nn + sd * (uv.y * 0.35) + T * (ruf * 3.0 * uv.y));
  o.uvh = vec3f(u, uv.y, c.x);
  o.par = vec3f(c.y, 0.5 + 0.5 * u, s);
  return o;
}

@fragment fn fsLeaf(i: KOut, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  var N = normalize(i.nrm); if (!ff) { N = -N; }
  let u = i.uvh.x; let hue = i.uvh.z;
  var base = mix(vec3f(0.026, 0.042, 0.016), vec3f(0.21, 0.165, 0.030), hue * (0.3 + 0.7 * u));
  let pur = mix(vec3f(0.15, 0.045, 0.32), vec3f(0.36, 0.27, 0.05), smoothstep(0.66, 0.82, hue));
  base = mix(base, pur, i.par.x);
  base *= 1.0 - 0.45 * smoothstep(0.28, 0.0, abs(i.uvh.y));
  base *= 0.6 + 0.8 * textureSample(noiseTex, repSmp, i.wpos * 0.61).a;
  var c = shade(i.wpos, N, base, i.par.y, base * vec3f(2.2, 1.55, 0.5));
  c += base * i.par.x * 0.35 * exp(-max(SURF - i.wpos.y, 0.0) * 0.012);
  // at night the blades light up along their edges and midrib, in slow waves that climb the stalk
  let pulse = 0.22 + 0.78 * pow(0.5 + 0.5 * sin(G.cam.w * 1.1 - i.par.z * 0.32 + hue * 9.0), 3.0);
  let vein = smoothstep(0.5, 1.0, abs(i.uvh.y)) + 0.7 * smoothstep(0.12, 0.0, abs(i.uvh.y)) * smoothstep(0.0, 0.3, u);
  let gcol = mix(mix(vec3f(0.05, 1.0, 0.5), vec3f(0.1, 0.7, 1.0), hue), vec3f(0.85, 0.22, 1.0), i.par.x);
  c += gcol * (vein * pulse * G.env.x * 0.9 * (0.3 + 0.7 * u) * step(0.55, fract(hue * 7.31)));
  return vec4f(applyFog(c, i.wpos), 1.0);
}

@vertex fn vsStipe(@location(0) m: vec2f, @location(1) a: vec4f, @location(2) b: vec4f) -> KOut {
  let s = m.x * b.x;
  let sw = kelpSway(a.xyz, s, a.w);
  let stA = b.y * 6.2831853 + s * 0.35;
  let ctr = a.xyz + vec3f(0.0, s, 0.0) + sw + vec3f(cos(stA), 0.0, sin(stA)) * (STRAD * smoothstep(0.0, 3.0, s));
  let n = vec3f(cos(m.y), 0.0, sin(m.y));
  let dist = distance(a.xz, G.cam.xz);
  let p = ctr + n * (b.z * (1.0 - 0.55 * m.x) * (1.0 + smoothstep(30.0, 120.0, dist) * 1.5));
  var o: KOut;
  o.clip = G.viewProj * vec4f(p, 1.0);
  o.wpos = p; o.nrm = n; o.uvh = vec3f(m.x, 0.0, 0.0); o.par = vec3f(b.w, 0.6, s);
  return o;
}
@fragment fn fsStipe(i: KOut) -> @location(0) vec4f {
  let base = mix(vec3f(0.07, 0.07, 0.02), vec3f(0.14, 0.05, 0.20), i.par.x);
  var c = shade(i.wpos, normalize(i.nrm), base, 0.7, vec3f(0.0));
  c += mix(vec3f(0.05, 0.8, 0.5), vec3f(0.7, 0.2, 0.9), i.par.x) * (G.env.x * 0.10 * (0.4 + 0.6 * sin(G.cam.w * 1.1 - i.par.z * 0.32) * sin(G.cam.w * 1.1 - i.par.z * 0.32)));
  return vec4f(applyFog(c, i.wpos), 1.0);
}

// ---------- animals ----------
fn fishPos(a: vec4f, b: vec4f, t: f32) -> vec3f {
  let c = a.xyz + vec3f(sin(t * 0.05 + a.w * 9.0) * 9.0, sin(t * 0.04 + a.w * 5.0) * 2.5, cos(t * 0.045 + a.w * 7.0) * 9.0);
  let ang = b.w + t * b.z;
  let r = b.x * (1.0 + 0.22 * sin(ang * 3.0 + b.y * 4.0));
  return c + vec3f(cos(ang) * r, b.y + sin(ang * 2.0 + b.w * 3.0) * 0.5, sin(ang) * r * 0.75);
}
@vertex fn vsFish(@location(0) pos: vec3f, @location(1) na: vec4f, @location(2) col: vec4f,
                  @location(3) a: vec4f, @location(4) b: vec4f, @location(5) ic: vec4f) -> FIn {
  let t = G.cam.w;
  let p0 = fishPos(a, b, t);
  let fw = normalize(fishPos(a, b, t + 0.08) - p0);
  let rt = normalize(cross(vec3f(0.0, 1.0, 0.0), fw));
  let up = cross(fw, rt);
  let sc = 0.28 + ic.a * 0.3;
  var lp = pos;
  lp.x += sin(t * 11.0 + b.w * 17.0 - pos.z * 5.0) * 0.09 * col.r;
  let p = p0 + (rt * lp.x + up * lp.y + fw * lp.z) * sc;
  var o: FIn;
  o.clip = G.viewProj * vec4f(p, 1.0);
  o.wpos = p; o.tpos = pos; o.nrm = rt * na.x + up * na.y + fw * na.z; o.ao = 1.0;
  o.col = vec4f(ic.rgb, col.g);
  return o;
}
@fragment fn fsFish(i: FIn, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  var N = normalize(i.nrm); if (!ff) { N = -N; }
  let V = normalize(G.cam.xyz - i.wpos);
  let belly = smoothstep(0.05, -0.1, i.tpos.y);
  let alb = mix(i.col.rgb * 0.45, vec3f(0.5, 0.55, 0.57), belly);
  var c = shade(i.wpos, N, alb, 1.0, vec3f(0.0));
  let H = normalize(V + G.sun.xyz);
  c += sunAt(i.wpos.y) * pow(max(dot(N, H), 0.0), 24.0) * 0.25;
  // night: a bright lateral line and a soft glow over the whole body
  let lat = smoothstep(0.05, 0.0, abs(i.tpos.y - 0.01)) * smoothstep(-0.36, -0.1, i.tpos.z);
  c += mix(normalize(i.col.rgb + 0.02), vec3f(0.2, 0.9, 1.0), 0.4) * ((lat * 2.6 + 0.3) * G.env.x);       // scales flash in the sun
  return vec4f(applyFog(c, i.wpos), 1.0);
}

fn mantaPos(a: vec4f, b: vec4f, t: f32) -> vec3f {
  let ang = b.y + t * b.x;
  return a.xyz + vec3f(cos(ang) * a.w, sin(ang * 2.0 + b.y) * 2.2, sin(ang) * a.w * 0.8);
}
@vertex fn vsManta(@location(0) pos: vec3f, @location(1) na: vec4f, @location(2) col: vec4f,
                   @location(3) a: vec4f, @location(4) b: vec4f) -> FIn {
  let t = G.cam.w;
  let p0 = mantaPos(a, b, t);
  let fw = normalize(mantaPos(a, b, t + 0.2) - p0);
  var rt = normalize(cross(vec3f(0.0, 1.0, 0.0), fw));
  rt = normalize(rt + vec3f(0.0, 0.22 * sign(b.x), 0.0));    // bank into the turn
  let up = cross(fw, rt);
  var lp = pos;
  let sp = col.r;
  let w = sin(t * 1.5 + b.y * 5.0 - sp * 1.6 + pos.z * 0.15);
  let wd = cos(t * 1.5 + b.y * 5.0 - sp * 1.6 + pos.z * 0.15);
  lp.y += w * pow(sp, 1.5) * 1.15 * (1.0 - col.b);
  lp.x *= 1.0 - 0.10 * w * w * sp;
  lp.x += sin(t * 1.1 + pos.z * 0.8) * 0.12 * col.b * (-pos.z - 1.3);     // tail trails
  let sc = b.z;
  let p = p0 + (rt * lp.x + up * lp.y + fw * lp.z) * sc;
  var n = na.xyz;
  n = normalize(n - vec3f(sign(pos.x) * wd * pow(sp, 0.5) * 0.9, 0.0, 0.0) * (1.0 - col.b));
  var o: FIn;
  o.clip = G.viewProj * vec4f(p, 1.0);
  o.wpos = p; o.tpos = pos; o.nrm = rt * n.x + up * n.y + fw * n.z; o.ao = na.w;
  o.col = col;
  return o;
}
@fragment fn fsManta(i: FIn) -> @location(0) vec4f {
  let N = normalize(i.nrm);
  let n = textureSample(noiseTex, repSmp, i.tpos * 0.11);
  let top = mix(vec3f(0.035, 0.045, 0.065), vec3f(0.10, 0.12, 0.15), n.a);
  var belly = vec3f(0.62, 0.66, 0.68) * (0.75 + 0.5 * n.a);
  belly = mix(belly, vec3f(0.08, 0.09, 0.11), smoothstep(0.60, 0.66, n.a * 0.6 + i.col.r * 0.4));   // belly blotches
  let alb = mix(top, belly, i.col.g);
  var c = shade(i.wpos, N, alb, i.ao, vec3f(0.0));
  // night: glowing wing tips and a scatter of spots on the back
  c += vec3f(0.12, 0.55, 1.0) * ((smoothstep(0.78, 1.0, i.col.r) * 1.3 + smoothstep(0.60, 0.68, n.a) * (1.0 - i.col.g) * 0.9) * G.env.x * (1.0 - i.col.b));
  return vec4f(applyFog(c, i.wpos), 1.0);
}

// ---------- the kraken ----------
fn krakBasis() -> mat3x3f {
  let fw = normalize(G.krak2.xyz);
  let rt = normalize(cross(vec3f(0.0, 1.0, 0.0), fw));
  return mat3x3f(rt, cross(fw, rt), fw);
}
@vertex fn vsKrakBody(@location(0) pos: vec3f, @location(1) na: vec4f, @location(2) col: vec4f) -> FIn {
  let pulse = 1.0 + 0.055 * sin(G.krak2.w * 0.8 + pos.z * 0.22) * smoothstep(-1.0, 4.0, pos.z);    // the mantle breathes
  let M = krakBasis();
  let p = G.krak.xyz + M * vec3f(pos.xy * pulse, pos.z);
  var o: FIn;
  o.clip = G.viewProj * vec4f(p, 1.0);
  o.wpos = p; o.nrm = M * na.xyz; o.ao = na.w; o.tpos = pos; o.col = vec4f(col.rgb, 0.0);
  return o;
}
// Centre line of arm k at t (0 at the crown, 1 at the tip), in the kraken's own space.
fn armCentre(k: f32, t: f32, len: f32, ph: f32, splay: f32) -> vec3f {
  let tm = G.krak2.w;
  let a = k * 0.7854 + 0.39;
  let rad = vec3f(cos(a), sin(a), 0.0); let tng = vec3f(-sin(a), cos(a), 0.0);
  let s = t * len;
  let stroke = 0.5 + 0.5 * sin(tm * 0.8 - t * 2.2);                     // the arms open, then sweep shut
  var c = rad * (2.1 + s * (splay + 0.13 * stroke) * (1.0 - 0.5 * t)) + vec3f(0.0, 0.0, -3.0 - s * 0.93);
  let w = tm * 1.05 - s * 0.17 + ph;                                    // waves run down to the tip, growing as they go
  let amp = 0.5 + 5.0 * t * t;
  return c + rad * (sin(w) * amp) + tng * (cos(w * 0.83 + ph * 2.0) * amp * 0.8);
}
@vertex fn vsKrakArm(@location(0) m: vec2f, @location(1) a: vec4f, @location(2) b: vec4f) -> FIn {
  let t = m.x; let k = a.x; let len = a.y;
  let c0 = armCentre(k, t, len, a.z, b.x);
  let T = normalize(armCentre(k, t + 0.012, len, a.z, b.x) - c0);
  let aa = k * 0.7854 + 0.39;
  let B = normalize(cross(T, vec3f(cos(aa), sin(aa), 0.0))); let Nn = cross(B, T);      // Nn points away from the body axis
  let r = a.w * pow(1.0 - t, 0.85) + 0.05;
  let dir = Nn * cos(m.y) + B * sin(m.y);
  let M = krakBasis();
  let p = G.krak.xyz + M * (c0 + dir * r);
  var o: FIn;
  o.clip = G.viewProj * vec4f(p, 1.0);
  o.wpos = p; o.nrm = M * dir; o.ao = 1.0;
  o.tpos = vec3f(t, m.y, r); o.col = vec4f(k / 8.0, len / 64.0, 0.0, 1.0);
  return o;
}
@fragment fn fsKrak(i: FIn) -> @location(0) vec4f {
  let P = i.wpos; let Ng = normalize(i.nrm); let arm = i.col.a;
  let t = i.tpos.x; let ang = i.tpos.y; let r = i.tpos.z; let len = i.col.g * 64.0;
  // skin pattern in the animal's own coordinates, so it travels with it
  let tp = mix(i.tpos * 0.085, vec3f(t * len * 0.085, ang * 0.25, i.col.r * 8.0), arm);
  let n = textureSample(noiseTex, repSmp, tp);
  let nf = textureSample(noiseTex, repSmp, tp * 4.3 + 0.2);
  let g = (n.xyz - 0.5) * 1.3 + (nf.xyz - 0.5) * 1.0;
  let N = normalize(Ng - (g - Ng * dot(g, Ng)) * 1.3);
  var alb = mix(vec3f(0.10, 0.12, 0.15), vec3f(0.40, 0.45, 0.48), smoothstep(0.3, 0.7, n.a * 0.6 + nf.a * 0.4));
  alb = mix(alb, vec3f(0.50, 0.44, 0.44), smoothstep(-0.15, -0.8, Ng.y) * 0.55);            // paler underneath
  // two rows of suckers along the inner side of each arm
  let cnt = 54.0;
  let da = (fract(t * cnt) - 0.5) * (len / cnt);
  let dc = (abs(abs(ang - 3.14159) - 0.30)) * r;
  let dsk = length(vec2f(da, dc)) / (0.34 * r + 0.035);
  let disc = smoothstep(1.0, 0.8, dsk) * arm * smoothstep(0.015, 0.05, t);
  let suck = disc * (1.0 - 0.75 * smoothstep(0.5, 0.3, dsk));
  // eyes on the sides of the head: a glowing iris with a dark horizontal slit
  let ep = vec2f(i.tpos.y - 0.9, i.tpos.z + 1.0) / 1.1;
  let de = length(ep);
  let eye = smoothstep(1.0, 0.86, de) * step(2.0, abs(i.tpos.x)) * (1.0 - arm);
  let slit = smoothstep(0.17, 0.10, abs(ep.x)) * smoothstep(0.78, 0.62, abs(ep.y));
  let iris = eye * (1.0 - slit) * (0.45 + 0.9 * smoothstep(0.45, 0.95, de));
  alb *= 1.0 - 0.6 * disc - 0.9 * eye;
  var c = shade(P, N, alb, i.ao, vec3f(0.0));
  let glow = vec3f(0.12, 0.85, 1.0);
  let beat = 0.8 + 0.2 * sin(G.krak2.w * 1.6 - t * 9.0);
  c += glow * (suck * 2.4 * beat + iris * 4.0);
  // night: slow waves of light wash over the skin
  let wave = sin(G.krak2.w * 0.7 - mix(i.tpos.z * 0.35, -t * len * 0.3, arm));
  let V = normalize(G.cam.xyz - P);
  c += (mix(glow, vec3f(0.55, 0.25, 1.0), n.a) * (smoothstep(0.50, 0.75, n.a + 0.12 * wave) * 0.22) + glow * (pow(1.0 - abs(dot(N, V)), 3.0) * 0.30)) * G.env.x;
  return vec4f(applyFog(c, P), 1.0);
}

// ---------- sky, surface ----------
struct SkyOut { @builtin(position) clip: vec4f, @location(0) ndc: vec2f };
@vertex fn vsSky(@builtin(vertex_index) vi: u32) -> SkyOut {
  var o: SkyOut;
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u)) * 2.0 - 1.0;
  o.clip = vec4f(p, 1.0, 1.0); o.ndc = p;
  return o;
}
@fragment fn fsSky(i: SkyOut) -> @location(0) vec4f {
  let a = G.invViewProj * vec4f(i.ndc, 0.2, 1.0); let b = G.invViewProj * vec4f(i.ndc, 0.9, 1.0);
  let dir = normalize(b.xyz / b.w - a.xyz / a.w);
  return vec4f(waterColor(dir, G.misc.x), 1.0);
}

struct SurfOut { @builtin(position) clip: vec4f, @location(0) wpos: vec3f };
@vertex fn vsSurf(@builtin(vertex_index) vi: u32) -> SurfOut {
  var o: SurfOut;
  let c = corner(vi) * 1500.0;
  o.wpos = vec3f(G.cam.x + c.x, SURF, G.cam.z + c.y);
  o.clip = G.viewProj * vec4f(o.wpos, 1.0);
  return o;
}
@fragment fn fsSurf(i: SurfOut) -> @location(0) vec4f {
  let P = i.wpos; let t = G.cam.w;
  let vv = P - G.cam.xyz; let d = length(vv); let V = vv / d;
  let g1 = textureSample(noiseTex, repSmp, vec3f(P.xz * 0.021 + t * vec2f(0.006, 0.004), t * 0.016)).xyz - 0.5;
  let g2 = textureSample(noiseTex, repSmp, vec3f(P.zx * 0.083 - t * vec2f(0.011, 0.014), t * 0.037 + 0.5)).xyz - 0.5;
  let sl = g1.xy * 0.62 + g2.xy * 0.42;
  let N = normalize(vec3f(sl.x, -1.0, sl.y));
  // looking up through the surface: refract into air, or reflect the deep when beyond the critical angle
  let ci = max(dot(-V, N), 0.0);
  let k = 1.0 - 1.33 * 1.33 * (1.0 - ci * ci);
  let R = 1.33 * V + (1.33 * ci - sqrt(max(k, 0.0))) * N;
  let Rn = normalize(R);
  let sd = max(dot(Rn, G.sun.xyz), 0.0);
  var sky = mix(vec3f(0.22, 0.66, 0.84), vec3f(0.62, 0.92, 1.0), smoothstep(0.0, 1.0, Rn.y)) * 1.15;
  sky += vec3f(1.0, 0.95, 0.8) * (pow(sd, 60.0) * 2.5 + pow(sd, 900.0) * 40.0);
  let refl = reflect(V, N);
  let m = G.misc.x;
  let rc = waterColor(vec3f(refl.x, -abs(refl.y), refl.z), m) * 1.25 + mix(WCOL, PCOL, m) * 0.10;
  let win = smoothstep(0.0, 0.30, k);
  var c = mix(rc, sky * mix(vec3f(1.0), vec3f(0.9, 0.75, 1.1), m), win);
  // night: a dark sky with the moon glittering through the window
  c = mix(c, c * vec3f(0.035, 0.055, 0.10) + vec3f(0.75, 0.88, 1.0) * (win * pow(sd, 700.0) * 0.9), G.env.x);
  c = c * fogT(d * 0.55) + waterColor(V, m) * (1.0 - exp(-d * FOGDEN * 0.8));
  return vec4f(c, 1.0);
}

// ---------- particles ----------
struct POut { @builtin(position) clip: vec4f, @location(0) uv: vec2f, @location(1) col: vec4f, @location(2) seed: f32 };

@vertex fn vsSpark(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) b: vec4f) -> POut {
  let t = G.cam.w; let c = corner(vi);
  let sw = kelpSway(a.xyz, b.x, a.w);
  let ang = b.z + t * 0.2 * (fract(b.z * 7.0) - 0.5);
  let p = a.xyz + vec3f(0.0, b.x + sin(t * 0.37 + b.z * 5.0) * 0.35, 0.0) + sw + vec3f(cos(ang), 0.0, sin(ang)) * b.y;
  let tw = pow(0.5 + 0.5 * sin(t * (1.2 + fract(b.z * 3.3) * 2.6) + b.z * 40.0), 5.0);
  let bb = bill(p, c, 0.028 + 0.03 * fract(b.z * 13.0), 1.15);
  var o: POut;
  o.clip = bb.clip; o.uv = c;
  let d = distance(p, G.cam.xyz);
  let colr = mix(vec3f(1.0, 0.78, 0.25), vec3f(0.35, 1.0, 0.45), step(0.5, b.w));
  let colp = mix(vec3f(1.0, 0.45, 0.9), vec3f(0.5, 0.7, 1.0), step(0.5, b.w));
  o.col = vec4f(mix(colr, colp, grotto(p)) * fogT(d) * (bb.k * (0.25 + 2.6 * tw) * 2.4 * G.misc.y * (1.0 + 1.6 * G.env.x)), 0.0);
  return o;
}
@fragment fn fsSpark(i: POut) -> @location(0) vec4f {
  let r = length(i.uv);
  let a = smoothstep(1.0, 0.0, r);
  return vec4f(i.col.rgb * (a * a * 1.6 + smoothstep(0.45, 0.0, r) * 1.2), 0.0);
}

@vertex fn vsBubble(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) b: vec4f) -> POut {
  let t = G.cam.w; let c = corner(vi);
  let maxH = SURF - a.y;
  let y = fract(a.w + t * b.x / maxH) * maxH;
  let wob = b.z * (0.25 + y * 0.03);
  let p = a.xyz + vec3f(sin(y * 1.3 + a.w * 40.0) * wob, y, cos(y * 1.1 + a.w * 31.0) * wob);
  let bb = bill(p, c, b.y * (0.5 + 0.6 * y / maxH), 1.2);
  var o: POut;
  o.clip = bb.clip; o.uv = c;
  let d = distance(p, G.cam.xyz);
  let fade = smoothstep(0.0, 1.5, y) * smoothstep(maxH, maxH - 2.0, y) * bb.k;
  let light = sunAt(p.y) * (0.25 + 0.75 * shadowAt(p)) + ambAt(vec3f(0.0, 1.0, 0.0), p, grotto(p)) * 2.0 + torchAt(p) * 0.8;
  o.col = vec4f(light * fogT(d) * 0.55, fade);
  return o;
}
@fragment fn fsBubble(i: POut) -> @location(0) vec4f {
  let r = length(i.uv);
  if (r > 1.0) { discard; }
  let rim = smoothstep(0.55, 0.96, r) * smoothstep(1.0, 0.94, r);
  let hl = smoothstep(0.32, 0.0, length(i.uv - vec2f(-0.35, -0.42)));
  let a = (rim * 0.75 + hl * 1.4 + 0.06) * i.col.a;
  return vec4f(i.col.rgb * a, a * 0.25);
}

// smoke and steam over the lava: big soft puffs, lit orange from below
@vertex fn vsPlume(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) b: vec4f) -> POut {
  let t = G.cam.w; let c = corner(vi);
  let u = fract(a.w + t * b.x / b.w);
  let y = u * b.w;
  let p = a.xyz + vec3f(sin(y * 0.33 + a.w * 40.0 + t * 0.21), 0.0, cos(y * 0.29 + a.w * 31.0 + t * 0.17)) * ((0.15 + y * 0.09) * b.z)
        + vec3f(0.016 * y * y, y, 0.009 * y * y);
  let bb = bill(p, c, b.y * (0.35 + 2.4 * u), 1.0);
  var o: POut;
  o.clip = bb.clip; o.uv = c;
  let d = distance(p, G.cam.xyz);
  let smoke = ambAt(vec3f(0.0, 1.0, 0.0), p, grotto(p)) * 1.1 + sunAt(p.y) * (shadowAt(p) * 0.10) + torchAt(p) * 0.06;
  let col = applyFog(smoke * 0.7 + LAVAC * (exp(-y * 0.5) * 1.0), p);
  o.col = vec4f(col, smoothstep(0.0, 0.05, u) * (1.0 - u) * (1.0 - u) * 0.17 * smoothstep(0.6, 3.0, d));
  o.seed = a.w;
  return o;
}
@fragment fn fsPlume(i: POut) -> @location(0) vec4f {
  let r = length(i.uv);
  let n = textureSample(noiseTex, repSmp, vec3f(i.uv * 0.27 + i.seed * 7.0, i.seed * 3.0 + G.cam.w * 0.015)).a;
  let k = smoothstep(1.0, 0.1, r) * smoothstep(0.36, 0.6, n + (1.0 - r) * 0.22) * i.col.a;
  return vec4f(i.col.rgb * k, k);
}
// embers drifting up from the cracks
@vertex fn vsEmber(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) b: vec4f) -> POut {
  let t = G.cam.w; let c = corner(vi);
  let u = fract(b.w + t * b.x / b.z);
  let y = u * b.z;
  let ang = a.w * 44.0; let r0 = b.y * fract(a.w * 13.7);
  let p = a.xyz + vec3f(cos(ang) * r0, y, sin(ang) * r0)
        + vec3f(sin(t * 0.9 + a.w * 50.0 + y), 0.0, cos(t * 0.7 + a.w * 37.0 + y * 1.3)) * (0.1 + 0.13 * y);
  let bb = bill(p, c, 0.018 + 0.022 * fract(a.w * 5.3), 1.1);
  var o: POut;
  o.clip = bb.clip; o.uv = c;
  let life = (1.0 - u) * (1.0 - u) * smoothstep(0.0, 0.03, u);
  let glow = life * (0.6 + 0.4 * sin(t * 9.0 + a.w * 90.0));
  o.col = vec4f(mix(vec3f(1.0, 0.22, 0.03), vec3f(1.0, 0.7, 0.25), life * life) * fogT(distance(p, G.cam.xyz)) * (bb.k * glow * 6.0), 0.0);
  return o;
}

// the diver's own exhaled bubbles (simulated on the CPU, they have to follow the helmet)
@vertex fn vsBreath(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) b: vec4f) -> POut {
  let c = corner(vi);
  let wob = vec3f(sin(G.cam.w * 9.0 + b.y * 40.0), 0.0, cos(G.cam.w * 8.0 + b.y * 31.0)) * 0.006;
  let bb = bill(a.xyz + wob, c, a.w, 1.0);
  var o: POut;
  o.clip = bb.clip; o.uv = c;
  let light = sunAt(a.y) * 0.5 + ambAt(vec3f(0.0, 1.0, 0.0), a.xyz, grotto(a.xyz)) * 2.5 + lavaLight(a.xyz, vec3f(0.0, -1.0, 0.0)) * 0.5 + torchAt(a.xyz) * 0.5;
  o.col = vec4f(light * 0.7, b.x);
  return o;
}

@vertex fn vsSnow(@builtin(vertex_index) vi: u32, @location(0) a: vec4f) -> POut {
  let t = G.cam.w; let c = corner(vi);
  let BOX = 46.0;
  let w = a.xyz * BOX + vec3f(t * 0.06, -t * 0.035, t * 0.045) + 0.35 * vec3f(sin(t * 0.3 + a.w * 30.0), sin(t * 0.23 + a.w * 17.0), cos(t * 0.27 + a.w * 23.0));
  let rel = fract((w - G.cam.xyz) / BOX + 0.5) - 0.5;
  let p = G.cam.xyz + rel * BOX;
  let d = length(rel) * BOX;
  // at speed each mote smears along the way it passes the eye
  let cp = G.viewProj * vec4f(p, 1.0);
  let cq = G.viewProj * vec4f(p - G.vel.xyz * (0.012 + 0.04 * smoothstep(8.0, 20.0, G.vel.w)), 1.0);
  let w1 = max(cp.w, 0.05);
  let sv = (cq.xy / max(cq.w, 0.05) - cp.xy / w1) * G.res.xy * 0.5;
  let sl = min(length(sv), 70.0);
  let sd = select(vec2f(1.0, 0.0), sv / max(length(sv), 0.001), sl > 0.5);
  let px = (0.008 + 0.014 * a.w) * G.misc.w / w1; let prad = max(px, 0.9);
  let off = sd * (c.x * (prad + sl * 0.5)) + vec2f(-sd.y, sd.x) * (c.y * prad);
  var bb: BB;
  bb.clip = vec4f(cp.xy + off * 2.0 * G.res.zw * cp.w, cp.zw);
  bb.k = (px / prad) * (px / prad) * prad / (prad + sl * 0.1);
  var o: POut;
  o.clip = bb.clip; o.uv = c;
  let fade = smoothstep(0.6, 2.5, d) * smoothstep(BOX * 0.5, BOX * 0.36, d) * step(p.y, SURF - 0.2);
  let light = sunAt(p.y) * shadowAt(p) * 0.55 + ambAt(vec3f(0.0, 1.0, 0.0), p, grotto(p)) * 0.6 + torchAt(p) * 0.9;
  o.col = vec4f(light * fogT(d) * (fade * bb.k * 0.5), 0.0);
  return o;
}
@fragment fn fsSnow(i: POut) -> @location(0) vec4f {
  let a = smoothstep(1.0, 0.1, length(i.uv));
  return vec4f(i.col.rgb * a, 0.0);
}
`;

// Post-processing. DEPTH_T is swapped for the multisampled type when MSAA is on.
export const post = (msaa) => /* wgsl */ `
@group(1) @binding(0) var depthTex: ${msaa > 1 ? 'texture_depth_multisampled_2d' : 'texture_depth_2d'};

struct VO { @builtin(position) clip: vec4f, @location(0) uv: vec2f };
@vertex fn vsFull(@builtin(vertex_index) vi: u32) -> VO {
  var o: VO;
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  o.clip = vec4f(p * 2.0 - 1.0, 0.0, 1.0); o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}

// Light shafts: march the view ray through the sun's shadow map (half resolution).
@fragment fn fsRays(i: VO) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(depthTex));
  let pix = min(vec2i(i.uv * dims), vec2i(dims) - 1);
  let depth = textureLoad(depthTex, pix, 0);
  let w4 = G.invViewProj * vec4f(i.uv.x * 2.0 - 1.0, 1.0 - i.uv.y * 2.0, depth, 1.0);
  let v = w4.xyz / w4.w - G.cam.xyz;
  let far = length(v); let dir = v / far;
  let dist = min(far, 95.0);
  let L = G.sun.xyz;
  const STEPS = 32;
  let dt = dist / f32(STEPS);
  let jit = ign(i.clip.xy);
  var acc = 0.0;
  for (var s = 0; s < STEPS; s++) {
    let tt = (f32(s) + jit) * dt;
    let p = G.cam.xyz + dir * tt;
    let q = G.lightVP * vec4f(p, 1.0);
    let sh = textureSampleCompareLevel(shadowTex, shadowSmp, q.xy * vec2f(0.5, -0.5) + 0.5, q.z - 0.0004);
    let cq = p.xz + L.xz * ((SURF - p.y) / L.y);
    let ck = textureSampleLevel(causTex, repSmp, cq / 27.0, 0.0).g;
    let dp = max(SURF - p.y, 0.0);
    acc += sh * ck * exp(-dp * 0.030 - tt * 0.021) * dt * step(p.y, SURF);
  }
  let cs = max(dot(dir, L), 0.0);
  let phase = 0.30 + 0.9 * pow(cs, 3.0) + 1.6 * pow(cs, 14.0);
  // g: how much hot water over the lava this ray looks through (drives the shimmer)
  var hz = 0.0;
  let ixz = 1.0 / max(dot(dir.xz, dir.xz), 0.0001);
  for (var k = 0; k < 16; k++) {
    let sp = G.lava[k];
    let tc = clamp(dot(sp.xz - G.cam.xz, dir.xz) * ixz, 0.0, far);
    let pc = G.cam.xyz + dir * tc;
    let hy = pc.y - sp.y;
    hz = max(hz, smoothstep(1.15, 0.3, distance(pc.xz, sp.xz) / sp.w) * smoothstep(-1.5, 0.3, hy) * smoothstep(13.0, 2.0, hy) * smoothstep(70.0, 12.0, tc));
  }
  // b: light scattered back from the helmet lamp's beam
  var tv = 0.0;
  if (G.torch.w > 0.01) {
    let td = min(far, 34.0) / 14.0;
    for (var j = 0; j < 14; j++) {
      let pp = G.cam.xyz + dir * ((f32(j) + jit) * td);
      let lv = pp - G.torch.xyz; let l2 = dot(lv, lv);
      let ca = dot(lv * inverseSqrt(l2 + 0.0001), G.torchD.xyz);
      let cone = smoothstep(0.90, 0.985, ca);
      tv += (cone * cone + 0.04 * smoothstep(0.70, 0.95, ca)) / (1.0 + 0.012 * l2) * exp(-sqrt(l2) * 0.03) * td;
    }
  }
  return vec4f(acc * phase * 0.10, hz, tv, 1.0);
}

@group(1) @binding(1) var sceneTex: texture_2d<f32>;
@group(1) @binding(2) var raysTex: texture_2d<f32>;
@group(1) @binding(3) var bloomTex: texture_2d<f32>;
@group(1) @binding(4) var linSmp: sampler;

// Edge of the visor opening in helmet space: < 0 on the glass, > 0 on the helmet body.
fn visorField(p: vec2f, asp: f32) -> f32 {
  var q = p;
  q.y -= 0.26 * exp(-(p.x * p.x) / 0.14) * smoothstep(0.0, -1.0, p.y);     // the nose bridge lifts the lower edge
  return pow(pow(abs(q.x) / (asp * 1.07), 4.0) + pow(abs(q.y) / 1.13, 4.0), 0.25) - 1.0;
}
fn hash22(p: vec2f) -> vec2f { return fract(sin(vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)))) * 43758.5453); }

@fragment fn fsComp(i: VO) -> @location(0) vec4f {
  let uv = i.uv; let t = G.cam.w;
  let asp = G.cres.x / G.cres.y;
  let p = (uv - 0.5) * vec2f(2.0 * asp, -2.0);
  let on = G.visor.w;
  // helmet space: the helmet lags a little behind the head and rolls with the stroke
  let cr = cos(G.visor.z); let sr = sin(G.visor.z);
  var pv = p - G.visor.xy;
  pv = vec2f(cr * pv.x - sr * pv.y, sr * pv.x + cr * pv.y);
  let f = visorField(pv, asp);
  let pix = vec2f(1.0 / asp, 1.0);

  // heat shimmer over the lava
  let hz = textureSampleLevel(raysTex, linSmp, uv, 0.0).g;
  let wob = textureSampleLevel(noiseTex, repSmp, vec3f(p.x * 1.7, p.y * 1.2 - t * 0.55, t * 0.27), 0.0).xy - 0.5;
  var suv = uv + wob * (hz * 0.024) * pix;

  // beads of condensation near the lower rim bend the picture
  let gc = pv * 8.0; let id = floor(gc); let hh = hash22(id);
  let rad = (0.10 + 0.22 * hh.x) * step(0.5, fract(hh.y * 13.7));
  let dd = (gc - id - 0.3 - 0.4 * hh) / max(rad, 0.001); let dl = length(dd);
  let zone = on * smoothstep(-0.34, -0.03, f) * smoothstep(0.35, -0.6, pv.y);
  let drop = smoothstep(1.0, 0.75, dl) * step(0.001, rad) * zone;
  suv -= dd * (drop * 0.011) * pix;

  // curved glass: the picture squeezes and splits into colours towards the rim
  let r2 = dot(pv, pv) / (asp * asp + 1.0);
  let qc = suv - 0.5;
  let bend = on * 0.05 * r2 * r2; let ca = on * 0.005 * r2;
  var c = vec3f(textureSampleLevel(sceneTex, linSmp, 0.5 + qc * (1.0 - bend - ca), 0.0).r,
                textureSampleLevel(sceneTex, linSmp, 0.5 + qc * (1.0 - bend), 0.0).g,
                textureSampleLevel(sceneTex, linSmp, 0.5 + qc * (1.0 - bend + ca), 0.0).b);
  // breath fogging the glass from the bottom up
  let fnz = textureSampleLevel(noiseTex, repSmp, vec3f(pv * 0.9, t * 0.05), 0.0).a;
  let fog = on * G.vis2.x * smoothstep(-0.42, -1.05, pv.y - (fnz - 0.5) * 0.5) * 0.75;
  let bo = pix * 0.012;
  let blur = 0.25 * (textureSampleLevel(sceneTex, linSmp, suv + bo, 0.0).rgb + textureSampleLevel(sceneTex, linSmp, suv - bo, 0.0).rgb
    + textureSampleLevel(sceneTex, linSmp, suv + vec2f(bo.x, -bo.y) * 1.7, 0.0).rgb + textureSampleLevel(sceneTex, linSmp, suv - vec2f(bo.x, -bo.y) * 1.7, 0.0).rgb);
  let m = G.misc.x;
  c = mix(c, blur * 0.9 + mix(WCOL, PCOL, m) * 0.10, fog);

  // light shafts and bloom
  let o = G.res.zw * 2.2;
  var r = textureSampleLevel(raysTex, linSmp, suv, 0.0).r * 0.28;
  r += (textureSampleLevel(raysTex, linSmp, suv + vec2f(o.x, o.y * 0.5), 0.0).r + textureSampleLevel(raysTex, linSmp, suv + vec2f(-o.x * 0.5, o.y), 0.0).r
      + textureSampleLevel(raysTex, linSmp, suv + vec2f(-o.x, -o.y * 0.5), 0.0).r + textureSampleLevel(raysTex, linSmp, suv + vec2f(o.x * 0.5, -o.y), 0.0).r) * 0.18;
  c += r * G.misc.z * mix(vec3f(0.42, 1.0, 0.88), vec3f(0.85, 0.62, 1.0), m) * G.misc.y;
  c += TORCHC * (textureSampleLevel(raysTex, linSmp, suv, 0.0).b * G.torch.w * 0.0011);
  let bl = textureSampleLevel(bloomTex, linSmp, suv, 0.0).rgb;
  c += bl * G.fx.x;
  // fine scratches in the glass only show against bright light; the beads catch a highlight
  let blum = dot(bl, vec3f(0.3, 0.6, 0.1));
  let s1 = textureSampleLevel(noiseTex, repSmp, vec3f(dot(pv, vec2f(0.93, 0.37)) * 0.33, dot(pv, vec2f(-0.37, 0.93)) * 8.0, 0.3), 0.0).a;
  let s2 = textureSampleLevel(noiseTex, repSmp, vec3f(dot(pv, vec2f(-0.5, 0.87)) * 0.29, dot(pv, vec2f(-0.87, -0.5)) * 11.0, 0.7), 0.0).a;
  c += vec3f(0.8, 0.95, 1.0) * ((smoothstep(0.70, 0.77, s1) + 0.7 * smoothstep(0.71, 0.78, s2)) * on * (0.004 + blum * 0.05));
  c += vec3f(0.7, 0.9, 1.0) * (drop * smoothstep(0.5, 0.1, length(dd - vec2f(-0.3, 0.35))) * (0.03 + 0.25 * dot(c, vec3f(0.33))));

  c *= G.sun.w;
  // filmic curve (ACES fit), a little saturation, vignette
  c = clamp((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
  let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  c = mix(vec3f(l), c, 1.12);
  let q = uv - 0.5;
  c *= 1.0 - dot(q, q) * 0.55;

  // the helmet itself: dark, out of focus, with a thin glowing seam that turns red in the heat
  let hot = G.vis2.y;
  let seam = mix(vec3f(0.18, 0.80, 1.0), vec3f(1.0, 0.20, 0.03), hot) * (0.85 + 0.15 * sin(t * 2.1));
  let env = bl / (1.0 + bl);
  let rim = vec3f(0.008, 0.011, 0.016) + env * (0.4 * smoothstep(0.18, 0.0, f)) + seam * (0.045 * smoothstep(0.30, 0.0, f))
          + vec3f(0.035, 0.05, 0.065) * exp(-abs(f - 0.075) / 0.004);
  c = mix(c, rim, on * smoothstep(-0.010, 0.012, f));
  c += seam * (on * (exp(-abs(f - 0.002) / 0.0035) * 0.85 + exp(-abs(f) / 0.03) * 0.15));

  c = pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.2));
  c += (ign(i.clip.xy) - 0.5) / 255.0;
  return vec4f(c, 1.0);
}
`;

// Small standalone passes: caustics generator, bloom down/up-sampling.
export const blit = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var<uniform> T: vec4f;

struct VO { @builtin(position) clip: vec4f, @location(0) uv: vec2f };
@vertex fn vsFull(@builtin(vertex_index) vi: u32) -> VO {
  var o: VO;
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  o.clip = vec4f(p * 2.0 - 1.0, 0.0, 1.0); o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
fn box(uv: vec2f, k: f32) -> vec4f {
  let e = k / vec2f(textureDimensions(src));
  return 0.25 * (textureSampleLevel(src, smp, uv + vec2f(-e.x, -e.y), 0.0) + textureSampleLevel(src, smp, uv + vec2f(e.x, -e.y), 0.0)
               + textureSampleLevel(src, smp, uv + vec2f(-e.x, e.y), 0.0) + textureSampleLevel(src, smp, uv + vec2f(e.x, e.y), 0.0));
}
@fragment fn fsDown(i: VO) -> @location(0) vec4f { return box(i.uv, 1.0); }
@fragment fn fsBright(i: VO) -> @location(0) vec4f {
  let c = min(box(i.uv, 1.0).rgb, vec3f(24.0));
  let l = max(c.r, max(c.g, c.b));
  return vec4f(c * smoothstep(0.75, 2.2, l), 1.0);
}
@fragment fn fsUp(i: VO) -> @location(0) vec4f { return vec4f(box(i.uv, 0.75).rgb * T.y, 1.0); }

// Cracked-plate pattern (tiling Voronoi): r = distance to the nearest crack, gb = direction to it, a = thin crack mask.
fn h2(p: vec2f) -> vec2f { return fract(sin(vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)))) * 43758.5453); }
@fragment fn fsCrack(i: VO) -> @location(0) vec4f {
  let NC = 12.0;
  let x = i.uv * NC; let n = floor(x); let f = fract(x);
  var mr = vec2f(0.0); var mg = vec2f(0.0); var md = 8.0;
  for (var j = -1; j <= 1; j++) { for (var k = -1; k <= 1; k++) {
    let g = vec2f(f32(k), f32(j));
    let r = g + h2((n + g + NC) % NC) - f; let d = dot(r, r);
    if (d < md) { md = d; mr = r; mg = g; }
  } }
  md = 8.0; var dir = vec2f(0.0);
  for (var j = -2; j <= 2; j++) { for (var k = -2; k <= 2; k++) {
    let g = mg + vec2f(f32(k), f32(j));
    let r = g + h2((n + g + NC) % NC) - f;
    if (dot(mr - r, mr - r) > 0.00001) { let e = normalize(r - mr); let d = dot(0.5 * (mr + r), e); if (d < md) { md = d; dir = e; } }
  } }
  let rr = clamp(md * 2.0, 0.0, 1.0);
  return vec4f(rr, dir * 0.5 + 0.5, 1.0 - smoothstep(0.0, 0.07, rr));
}

// Caustics from first principles: the surface is a sum of ripples h; a ray landing at x has been shifted by grad h,
// so a bundle of rays is squeezed by det(I + Hessian h) and its brightness is 1 / |det|. Bright lines are where det -> 0.
// Whole-number wave vectors make the pattern tile.
fn ripple(uv: vec2f, t: f32) -> f32 {
  var kw = array<vec2f, 8>(vec2f(7, 3), vec2f(-5, 8), vec2f(2, -11), vec2f(11, 4), vec2f(-8, -7), vec2f(13, -2), vec2f(4, 12), vec2f(-12, 5));
  var hxx = 0.0; var hyy = 0.0; var hxy = 0.0;
  for (var n = 0; n < 8; n++) {
    let k = kw[n]; let k2 = dot(k, k);
    let dir = f32(n % 2) * 2.0 - 1.0;
    let s = sin(6.2831853 * dot(k, uv) + t * (0.35 + 0.11 * sqrt(k2)) * dir + f32(n) * 1.7) * 0.55 / k2;
    hxx -= s * k.x * k.x; hyy -= s * k.y * k.y; hxy -= s * k.x * k.y;
  }
  return 0.12 / (abs((1.0 + hxx) * (1.0 + hyy) - hxy * hxy) + 0.06);
}

// r = caustic network, g = broad light-shaft cookie. Both tile.
@fragment fn fsCaustic(i: VO) -> @location(0) vec4f {
  let t = T.x;
  let TAU = 6.28318530718;
  let ca = min(ripple(i.uv, t) + 0.7 * ripple(i.uv.yx + 0.37, t * 1.13 + 5.0), 4.0);
  let u = i.uv * TAU;
  let a = sin(u.x * 2.0 + t * 0.21 + 2.0 * sin(u.y + t * 0.13)) + sin(u.y * 3.0 - t * 0.17 + 2.0 * sin(u.x * 2.0 - t * 0.11));
  let b = sin(u.x * 5.0 - t * 0.31 + 1.5 * sin(u.y * 4.0 + t * 0.23)) * sin(u.y * 6.0 + t * 0.27 + 1.5 * sin(u.x * 3.0 - t * 0.19));
  let cookie = smoothstep(-0.3, 1.6, a + b * 0.9);
  return vec4f(ca, cookie * cookie * (0.6 + 0.8 * ca), 0.0, 1.0);
}
`;
