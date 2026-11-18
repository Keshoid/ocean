// Renderer, camera and controls.
import { common, scene, post, blit } from './shaders.js';
import { C, VIEWS, buildWorld } from './world.js';
import { buildNoiseTex } from './sdf.js';
import { perspective, ortho, lookAt, mul, invert, clamp, sstep } from './math.js';
import { Sound } from './audio.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const QUALITY = {
  low: { cell: 1.25, density: 0.35, leafSegs: 4, msaa: 1, scale: 0.75, shres: 2048, shadowEvery: 3, rays: true },
  medium: { cell: 1.0, density: 0.65, leafSegs: 5, msaa: 4, scale: 1, shres: 2048, shadowEvery: 2, rays: true },
  high: { cell: 0.8, density: 1, leafSegs: 6, msaa: 4, scale: 1, shres: 4096, shadowEvery: 2, rays: true },
};
const qName = params.get('q') || localStorage.getItem('ocean-q') || ((navigator.deviceMemory || 8) <= 4 ? 'low' : 'high');
const Q = QUALITY[qName] || QUALITY.high;
const SHOT = params.get('shot');                // test hook: fixed viewpoint, no menu
const FIXED_T = params.has('t') ? +params.get('t') : null;
const EXPOSURE = 1.0, RAYS = 1.0, BLOOM = 0.07, FOV = (64 * Math.PI) / 180, NEAR = 0.25, FAR = 1400;

const canvas = $('c');
const fail = (msg) => { $('status').textContent = msg; document.body.classList.add('err'); console.error(msg); };

async function main() {
  if (!navigator.gpu) return fail('Нужен браузер с WebGPU (свежий Chrome или Edge).');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return fail('WebGPU-адаптер не найден.');
  const dev = await adapter.requestDevice({ requiredLimits: {
    maxBufferSize: Math.min(adapter.limits.maxBufferSize, 1 << 30),
    maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, 1 << 30) } });
  dev.addEventListener('uncapturederror', (e) => console.error('GPU: ' + e.error.message));
  dev.lost.then((i) => fail('Графическое устройство потеряно: ' + i.message));
  const ctx = canvas.getContext('webgpu'), cfmt = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device: dev, format: cfmt, alphaMode: 'opaque' });
  C.SHRES = Q.shres;

  const progress = (p, text) => { $('bar').style.transform = `scaleX(${p})`; $('status').textContent = text; return new Promise((r) => setTimeout(r, 16)); };
  await progress(0.02, 'Наливаем воду');

  // ---------- shader modules ----------
  const HDR = 'rgba16float', DEPTH = 'depth32float', MS = Q.msaa;
  const mod = async (label, code) => {
    const m = dev.createShaderModule({ label, code });
    const info = await m.getCompilationInfo();
    for (const msg of info.messages) if (msg.type === 'error') console.error(`WGSL ${label}:${msg.lineNum}:${msg.linePos} ${msg.message}\n> ${code.split('\n')[msg.lineNum - 1]}`);
    return m;
  };
  const com = common(C);
  const mScene = await mod('scene', com + scene), mPost = await mod('post', com + post(MS)), mBlit = await mod('blit', blit);

  // ---------- layouts ----------
  const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, FR = GPUShaderStage.FRAGMENT;
  const bgl0 = dev.createBindGroupLayout({ entries: [
    { binding: 0, visibility: VF, buffer: {} },
    { binding: 1, visibility: VF, texture: { sampleType: 'depth' } },
    { binding: 2, visibility: VF, sampler: { type: 'comparison' } },
    { binding: 3, visibility: FR, texture: { viewDimension: '3d' } },
    { binding: 4, visibility: FR, sampler: {} },
    { binding: 5, visibility: FR, texture: {} },
    { binding: 6, visibility: FR, texture: {} }] });
  const bgl0s = dev.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: {} }] });
  const bglRays = dev.createBindGroupLayout({ entries: [{ binding: 0, visibility: FR, texture: { sampleType: 'depth', multisampled: MS > 1 } }] });
  const bglComp = dev.createBindGroupLayout({ entries: [
    { binding: 1, visibility: FR, texture: {} }, { binding: 2, visibility: FR, texture: {} }, { binding: 3, visibility: FR, texture: {} }, { binding: 4, visibility: FR, sampler: {} }] });
  const bglBlit = dev.createBindGroupLayout({ entries: [{ binding: 0, visibility: FR, texture: {} }, { binding: 1, visibility: FR, sampler: {} }, { binding: 2, visibility: FR, buffer: {} }] });
  const plMain = dev.createPipelineLayout({ bindGroupLayouts: [bgl0] }), plShadow = dev.createPipelineLayout({ bindGroupLayouts: [bgl0s] });

  const att = (loc, offset, format) => ({ shaderLocation: loc, offset, format });
  const VB = {
    mesh: { arrayStride: 20, attributes: [att(0, 0, 'float32x3'), att(1, 12, 'snorm8x4'), att(2, 16, 'unorm8x4')] },
    uv: { arrayStride: 8, attributes: [att(0, 0, 'float32x2')] },
    leaf: { arrayStride: 36, stepMode: 'instance', attributes: [att(1, 0, 'float32x4'), att(2, 16, 'float32x4'), att(3, 32, 'unorm8x4')] },
    stipe: { arrayStride: 32, stepMode: 'instance', attributes: [att(1, 0, 'float32x4'), att(2, 16, 'float32x4')] },
    prop: { arrayStride: 36, stepMode: 'instance', attributes: [att(3, 0, 'float32x4'), att(4, 16, 'float32x4'), att(5, 32, 'unorm8x4')] },
    grass: { arrayStride: 20, stepMode: 'instance', attributes: [att(3, 0, 'float32x4'), att(4, 16, 'unorm8x4')] },
    manta: { arrayStride: 32, stepMode: 'instance', attributes: [att(3, 0, 'float32x4'), att(4, 16, 'float32x4')] },
    p2: { arrayStride: 32, stepMode: 'instance', attributes: [att(0, 0, 'float32x4'), att(1, 16, 'float32x4')] },
    p1: { arrayStride: 16, stepMode: 'instance', attributes: [att(0, 0, 'float32x4')] },
  };
  const ADD = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } };
  const PRE = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } };
  const pipe = (vs, fs, buffers, o = {}) => dev.createRenderPipeline({
    label: vs, layout: plMain,
    vertex: { module: mScene, entryPoint: vs, buffers },
    fragment: { module: mScene, entryPoint: fs, targets: [{ format: HDR, blend: o.blend }] },
    primitive: { topology: 'triangle-list', cullMode: o.cull || 'none' },
    depthStencil: { format: DEPTH, depthWriteEnabled: o.write !== false, depthCompare: o.compare || 'less' },
    multisample: { count: MS },
  });
  const spipe = (vs, buffers, cull = 'none') => dev.createRenderPipeline({
    label: vs + '-shadow', layout: plShadow,
    vertex: { module: mScene, entryPoint: vs, buffers },
    primitive: { topology: 'triangle-list', cullMode: cull },
    depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2.0 },
  });
  const P = {
    sky: pipe('vsSky', 'fsSky', [], { write: false, compare: 'always' }),
    stat: pipe('vsStatic', 'fsStatic', [VB.mesh], { cull: 'back' }),
    prop: pipe('vsProp', 'fsProp', [VB.mesh, VB.prop], { cull: 'back' }),
    grass: pipe('vsGrass', 'fsGrass', [VB.mesh, VB.grass]),
    leaf: pipe('vsLeaf', 'fsLeaf', [VB.uv, VB.leaf]),
    stipe: pipe('vsStipe', 'fsStipe', [VB.uv, VB.stipe]),
    fish: pipe('vsFish', 'fsFish', [VB.mesh, VB.prop]),
    manta: pipe('vsManta', 'fsManta', [VB.mesh, VB.manta]),
    surf: pipe('vsSurf', 'fsSurf', []),
    spark: pipe('vsSpark', 'fsSpark', [VB.p2], { write: false, blend: ADD }),
    bubble: pipe('vsBubble', 'fsBubble', [VB.p2], { write: false, blend: PRE }),
    snow: pipe('vsSnow', 'fsSnow', [VB.p1], { write: false, blend: ADD }),
    plume: pipe('vsPlume', 'fsPlume', [VB.p2], { write: false, blend: PRE }),
    breath: pipe('vsBreath', 'fsBubble', [VB.p2], { write: false, blend: PRE }),
    ember: pipe('vsEmber', 'fsSpark', [VB.p2], { write: false, blend: ADD }),
  };
  const S = {
    stat: spipe('vsStatic', [VB.mesh], 'back'), prop: spipe('vsProp', [VB.mesh, VB.prop], 'back'),
    leaf: spipe('vsLeaf', [VB.uv, VB.leaf]), stipe: spipe('vsStipe', [VB.uv, VB.stipe]), manta: spipe('vsManta', [VB.mesh, VB.manta]),
  };
  const fullPipe = (module, fs, layout, format, blend) => dev.createRenderPipeline({
    label: fs, layout, vertex: { module, entryPoint: 'vsFull' }, fragment: { module, entryPoint: fs, targets: [{ format, blend }] }, primitive: { topology: 'triangle-list' } });
  const plBlit = dev.createPipelineLayout({ bindGroupLayouts: [bglBlit] });
  const pRays = fullPipe(mPost, 'fsRays', dev.createPipelineLayout({ bindGroupLayouts: [bgl0, bglRays] }), HDR);
  const pComp = fullPipe(mPost, 'fsComp', dev.createPipelineLayout({ bindGroupLayouts: [bgl0, bglComp] }), cfmt);
  const pDown = fullPipe(mBlit, 'fsDown', plBlit, HDR), pBright = fullPipe(mBlit, 'fsBright', plBlit, HDR);
  const pUp = fullPipe(mBlit, 'fsUp', plBlit, HDR, { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } });
  const pCaus = fullPipe(mBlit, 'fsCaustic', plBlit, HDR), pCrack = fullPipe(mBlit, 'fsCrack', plBlit, HDR);

  // ---------- fixed resources ----------
  const buf = (data, usage) => {
    const b = dev.createBuffer({ size: Math.max(16, (data.byteLength + 3) & ~3), usage: usage | GPUBufferUsage.COPY_DST });
    if (data.byteLength) dev.queue.writeBuffer(b, 0, data.buffer || data, data.byteOffset || 0, data.byteLength);
    return b;
  };
  const VTX = GPUBufferUsage.VERTEX, IDX = GPUBufferUsage.INDEX, TEX = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;
  const UB = new Float32Array(164), UBS = new Float32Array(164);
  const ubo = dev.createBuffer({ size: UB.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const uboS = dev.createBuffer({ size: UB.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const TB = new Float32Array(4), tbo = dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const noiseTex = buildNoiseTex(dev);
  const shadowTex = dev.createTexture({ size: [Q.shres, Q.shres], format: DEPTH, usage: TEX });
  const CAUS = 512, causMips = 5;
  const causTex = dev.createTexture({ size: [CAUS, CAUS], format: HDR, mipLevelCount: causMips, usage: TEX });
  const repSmp = dev.createSampler({ addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: 4 });
  const linSmp = dev.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  const cmpSmp = dev.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' });
  const CRACK = 1024, crackMips = 7;
  const crackTex = dev.createTexture({ size: [CRACK, CRACK], format: HDR, mipLevelCount: crackMips, usage: TEX });
  const bg0 = dev.createBindGroup({ layout: bgl0, entries: [
    { binding: 0, resource: { buffer: ubo } }, { binding: 1, resource: shadowTex.createView() }, { binding: 2, resource: cmpSmp },
    { binding: 3, resource: noiseTex.createView() }, { binding: 4, resource: repSmp }, { binding: 5, resource: causTex.createView() }, { binding: 6, resource: crackTex.createView() }] });
  const bg0s = dev.createBindGroup({ layout: bgl0s, entries: [{ binding: 0, resource: { buffer: uboS } }] });
  const blitBG = (view) => dev.createBindGroup({ layout: bglBlit, entries: [{ binding: 0, resource: view }, { binding: 1, resource: linSmp }, { binding: 2, resource: { buffer: tbo } }] });
  const colorPass = (view, load) => ({ colorAttachments: [{ view, loadOp: load ? 'load' : 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
  const causViews = [...Array(causMips)].map((_, l) => causTex.createView({ baseMipLevel: l, mipLevelCount: 1 }));
  const causPasses = causViews.map((v) => colorPass(v)), causBGs = causViews.map((v, l) => blitBG(l ? causViews[l - 1] : causViews[1]));
  {   // the cracked-plate texture never changes: draw it and its mips once
    const views = [...Array(crackMips)].map((_, l) => crackTex.createView({ baseMipLevel: l, mipLevelCount: 1 }));
    const enc = dev.createCommandEncoder();
    for (let l = 0; l < crackMips; l++) {
      const pass = enc.beginRenderPass(colorPass(views[l]));
      pass.setPipeline(l ? pDown : pCrack); pass.setBindGroup(0, blitBG(l ? views[l - 1] : causViews[0])); pass.draw(3); pass.end();
    }
    dev.queue.submit([enc.finish()]);
  }
  const shadowPass = { colorAttachments: [], depthStencilAttachment: { view: shadowTex.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } };

  // ---------- the world ----------
  const W = await buildWorld(dev, Q, progress);
  await progress(0.97, 'Включаем солнце');
  const batches = [], extras = [];
  // cells: 8 floats each = aabb min, aabb max, first instance, instance count
  const batch = (p, sp, vb, ib, ifmt, range, set, inst, o) => batches.push({ p, sp, vb, ib, ifmt, n: range.indexCount, first: range.firstIndex, base: range.baseVertex,
    inst: buf(set.data, VTX), cells: set.cells, maxDist: o.maxDist, lod0: o.lod0, lod1: o.lod1, minLod: o.minLod, shadowLod: o.shadowLod });
  const staticVB = buf(W.staticVB, VTX), staticIB = buf(W.staticIB, IDX), staticN = W.staticIB.length;
  const propVB = buf(W.propMeshes.vb, VTX), propIB = buf(W.propMeshes.ib, IDX);
  W.props.forEach((set, i) => {
    if (!set.count) return;
    const rock = i < 6, small = i < 2, ruin = i >= W.ruinStart;
    batch(P.prop, S.prop, propVB, propIB, 'uint32', W.propMeshes.ranges[i], set, null, ruin ? { maxDist: 320, lod0: 120, lod1: 320, minLod: 1, shadowLod: 1 } :
      { maxDist: small ? 70 : 210, lod0: small ? 18 : 60, lod1: small ? 70 : 200, minLod: small ? 0 : rock ? 0.5 : 0.25, shadowLod: small ? 0 : 1 });
  });
  const leafVB = buf(W.leafMesh.v, VTX), leafIB = buf(W.leafMesh.i, IDX);
  batch(P.leaf, S.leaf, leafVB, leafIB, 'uint16', { indexCount: W.leafMesh.i.length, firstIndex: 0, baseVertex: 0 }, W.leaves, null,
    { maxDist: 260, lod0: 45, lod1: 150, minLod: 0.28, shadowLod: 0.4 });
  const grassVB = buf(W.grassMeshes.vb, VTX), grassIB = buf(W.grassMeshes.ib, IDX);
  W.grass.forEach((set, i) => set.count && batch(P.grass, null, grassVB, grassIB, 'uint32', W.grassMeshes.ranges[i], set, null, { maxDist: 105, lod0: 24, lod1: 100, minLod: 0.1, shadowLod: 0 }));
  // things drawn whole, without culling
  const extra = (p, sp, vb, ib, ifmt, n, set, vertsOnly) => extras.push({ p, sp, vb, ib, ifmt, n, inst: buf(set.data, VTX), count: set.count, vertsOnly });
  const stipeVB = buf(W.stipeMesh.v, VTX), stipeIB = buf(W.stipeMesh.i, IDX);
  extra(P.stipe, S.stipe, stipeVB, stipeIB, 'uint16', W.stipeMesh.i.length, W.stipes);
  extra(P.fish, null, buf(W.fishMesh.vb, VTX), buf(W.fishMesh.ib, IDX), 'uint32', W.fishMesh.ib.length, W.fish);
  extra(P.manta, S.manta, buf(W.mantaMesh.vb, VTX), buf(W.mantaMesh.ib, IDX), 'uint32', W.mantaMesh.ib.length, W.mantas);
  const particles = [
    { p: P.plume, inst: buf(W.plumes.data, VTX), count: W.plumes.count },
    { p: P.ember, inst: buf(W.embers.data, VTX), count: W.embers.count },
    { p: P.bubble, inst: buf(W.bubbles.data, VTX), count: W.bubbles.count },
    { p: P.spark, inst: buf(W.sparks.data, VTX), count: W.sparks.count },
    { p: P.snow, inst: buf(W.snow.data, VTX), count: W.snow.count }];
  const grid = W.grid;

  // ---------- size-dependent resources ----------
  let sw = 0, sh = 0, mainPass, raysPass, compPass, bgRays, bgComp, bloom = [], sized = [];
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.max(2, Math.round(canvas.clientWidth * dpr)), ch = Math.max(2, Math.round(canvas.clientHeight * dpr));
    if (cw === canvas.width && ch === canvas.height && sw) return;
    canvas.width = cw; canvas.height = ch;
    sw = Math.max(2, Math.round(cw * Q.scale)); sh = Math.max(2, Math.round(ch * Q.scale));
    for (const t of sized) t.destroy();
    const tex = (w, h, format, sampleCount = 1) => { const t = dev.createTexture({ size: [w, h], format, sampleCount, usage: TEX }); sized.push(t); return t; };
    sized = [];
    const sceneTex = tex(sw, sh, HDR), depthTex = tex(sw, sh, DEPTH, MS), raysTex = tex((sw + 1) >> 1, (sh + 1) >> 1, HDR);
    const msTex = MS > 1 ? tex(sw, sh, HDR, MS) : null;
    mainPass = {
      colorAttachments: [MS > 1 ? { view: msTex.createView(), resolveTarget: sceneTex.createView(), loadOp: 'clear', storeOp: 'discard', clearValue: [0, 0, 0, 1] }
        : { view: sceneTex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      depthStencilAttachment: { view: depthTex.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } };
    raysPass = colorPass(raysTex.createView());
    bloom = [];
    let w = sw, h = sh, prev = sceneTex.createView();
    for (let l = 0; l < 5; l++) {
      w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
      const view = tex(w, h, HDR).createView();
      bloom.push({ view, down: colorPass(view), up: colorPass(view, true), fromPrev: blitBG(prev), self: blitBG(view) });
      prev = view;
    }
    bgRays = dev.createBindGroup({ layout: bglRays, entries: [{ binding: 0, resource: depthTex.createView() }] });
    bgComp = dev.createBindGroup({ layout: bglComp, entries: [{ binding: 1, resource: sceneTex.createView() }, { binding: 2, resource: raysTex.createView() }, { binding: 3, resource: bloom[0].view }, { binding: 4, resource: linSmp }] });
    compPass = colorPass(null);
  }

  // ---------- camera + input ----------
  const cam = { x: VIEWS[0][0], y: VIEWS[0][1], z: VIEWS[0][2], yaw: VIEWS[0][3], pitch: VIEWS[0][4], vx: 0, vy: 0, vz: 0 };
  const setView = (i) => { const v = VIEWS[i]; if (!v) return; cam.x = v[0]; cam.y = v[1]; cam.z = v[2]; cam.yaw = v[3]; cam.pitch = v[4]; cam.vx = cam.vy = cam.vz = 0; };
  const keys = Object.create(null);
  let diving = false, hud = false, visorOn = params.get('visor') !== '0', gaugesOn = params.get('gauges') !== '0';
  const sound = new Sound();
  addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (e.code.startsWith('Digit')) setView(+e.code.slice(5) - 1);
    if (e.code === 'KeyM') sound.toggle();
    if (e.code === 'KeyV') visorOn = !visorOn;
    if (e.code === 'KeyG') gaugesOn = !gaugesOn;
    if (e.code === 'KeyH') { hud = !hud; $('hud').style.display = hud ? 'block' : 'none'; }
  });
  addEventListener('keyup', (e) => { keys[e.code] = false; });
  addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
  const TOUCH = matchMedia('(pointer: coarse)').matches;
  const setDiving = (on) => { diving = on; document.body.classList.toggle('dive', on); $('go').textContent = 'Продолжить'; };
  const dive = () => {
    sound.start();
    if (TOUCH) setDiving(true);
    else { try { canvas.requestPointerLock()?.catch?.(() => {}); } catch (e) { /* browser not ready for another lock yet */ } }
  };
  $('go').addEventListener('click', dive);
  canvas.addEventListener('click', () => { if (!diving) dive(); });
  document.addEventListener('pointerlockchange', () => setDiving(document.pointerLockElement === canvas));
  // touch: hold to swim forward, slide to steer, second finger to go faster
  let touchFwd = 0, touchFast = false, lastTX = 0, lastTY = 0;
  const onTouch = (e) => {
    e.preventDefault();
    const t = e.touches[0];
    touchFwd = t ? 1 : 0; touchFast = e.touches.length > 1;
    if (!t) return;
    if (e.type === 'touchmove') { cam.yaw += (t.clientX - lastTX) * 0.005; cam.pitch = clamp(cam.pitch - (t.clientY - lastTY) * 0.005, -1.5, 1.5); }
    lastTX = t.clientX; lastTY = t.clientY;
  };
  for (const ev of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) canvas.addEventListener(ev, onTouch, { passive: false });
  $('burger').addEventListener('click', () => setDiving(false));
  addEventListener('mousemove', (e) => {
    if (!diving) return;
    cam.yaw += e.movementX * 0.0021;
    cam.pitch = clamp(cam.pitch - e.movementY * 0.0021, -1.5, 1.5);
  });
  for (const b of document.querySelectorAll('[data-q]')) {
    b.classList.toggle('on', b.dataset.q === qName);
    b.addEventListener('click', () => { localStorage.setItem('ocean-q', b.dataset.q); location.search = ''; });
  }

  function moveCamera(dt) {
    const cp = Math.cos(cam.pitch), fx = Math.sin(cam.yaw) * cp, fy = Math.sin(cam.pitch), fz = -Math.cos(cam.yaw) * cp;
    const rx = Math.cos(cam.yaw), rz = Math.sin(cam.yaw);
    const f = Math.min(1, (keys.KeyW || keys.ArrowUp ? 1 : 0) + (diving ? touchFwd : 0)) - (keys.KeyS || keys.ArrowDown ? 1 : 0), r = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0), u = (keys.KeyE || keys.Space ? 1 : 0) - (keys.KeyQ ? 1 : 0);
    const sp = keys.ShiftLeft || keys.ShiftRight || touchFast ? 22 : 6.5;
    let tx = fx * f + rx * r, ty = fy * f + u, tz = fz * f + rz * r;
    const l = Math.hypot(tx, ty, tz);
    if (l > 0) { tx *= sp / l; ty *= sp / l; tz *= sp / l; }
    const k = 1 - Math.exp(-dt * 3.2);
    cam.vx += (tx - cam.vx) * k; cam.vy += (ty - cam.vy) * k; cam.vz += (tz - cam.vz) * k;
    cam.x += cam.vx * dt; cam.y += cam.vy * dt; cam.z += cam.vz * dt;
    // slide along rock: push out along the field gradient
    const RAD = 1.3;
    for (let it = 0; it < 3; it++) {
      const d = grid.sd(cam.x, cam.y, cam.z);
      if (d >= RAD) break;
      let gx = grid.sd(cam.x + 0.5, cam.y, cam.z) - grid.sd(cam.x - 0.5, cam.y, cam.z), gy = grid.sd(cam.x, cam.y + 0.5, cam.z) - grid.sd(cam.x, cam.y - 0.5, cam.z), gz = grid.sd(cam.x, cam.y, cam.z + 0.5) - grid.sd(cam.x, cam.y, cam.z - 0.5);
      const gl = Math.hypot(gx, gy, gz) || 1, push = Math.min(RAD - d, 2);
      cam.x += (gx / gl) * push; cam.y += (gy / gl) * push; cam.z += (gz / gl) * push;
    }
    cam.y = Math.min(cam.y, C.SURF - 0.9);
    const rr = Math.hypot(cam.x, cam.z);
    if (rr > C.RIM + 10) { cam.x *= (C.RIM + 10) / rr; cam.z *= (C.RIM + 10) / rr; }
  }

  // ---------- per-frame state (all preallocated) ----------
  const proj = new Float32Array(16), view = new Float32Array(16), vp = new Float32Array(16), ivp = new Float32Array(16);
  const lview = new Float32Array(16), lproj = new Float32Array(16), lvp = new Float32Array(16);
  const planes = new Float32Array(24);
  let sx = -0.32, sy = 1.0, sz = 0.38; { const l = Math.hypot(sx, sy, sz); sx /= l; sy /= l; sz /= l; }
  lookAt(lview, sx * 220, 22 + sy * 220, sz * 220, 0, 22, 0, 0, 0, 1);
  ortho(lproj, -165, 165, -165, 165, 60, 380);
  mul(lvp, lproj, lview);

  function frustum(m) {
    for (let i = 0; i < 6; i++) {
      const r = i >> 1, s = i & 1 ? -1 : 1;
      let a = m[3] + s * m[r], b = m[7] + s * m[4 + r], c = m[11] + s * m[8 + r], d = m[15] + s * m[12 + r];
      if (i === 4) { a = m[2]; b = m[6]; c = m[10]; d = m[14]; }
      planes[i * 4] = a; planes[i * 4 + 1] = b; planes[i * 4 + 2] = c; planes[i * 4 + 3] = d;
    }
  }
  function visible(c, o) {
    for (let i = 0; i < 24; i += 4) {
      const a = planes[i], b = planes[i + 1], d = planes[i + 2];
      if (a * (a > 0 ? c[o + 3] : c[o]) + b * (b > 0 ? c[o + 4] : c[o + 1]) + d * (d > 0 ? c[o + 5] : c[o + 2]) + planes[i + 3] < 0) return false;
    }
    return true;
  }
  let drawn = 0;
  function drawBatches(pass, shadow) {
    for (let bi = 0; bi < batches.length; bi++) {
      const b = batches[bi], c = b.cells;
      if (shadow && (!b.sp || b.shadowLod <= 0)) continue;
      pass.setPipeline(shadow ? b.sp : b.p);
      pass.setVertexBuffer(0, b.vb); pass.setVertexBuffer(1, b.inst); pass.setIndexBuffer(b.ib, b.ifmt);
      for (let o = 0; o < c.length; o += 8) {
        let n = c[o + 7];
        if (shadow) n = Math.ceil(n * b.shadowLod);
        else {
          if (!visible(c, o)) continue;
          const dx = Math.max(c[o] - cam.x, 0, cam.x - c[o + 3]), dy = Math.max(c[o + 1] - cam.y, 0, cam.y - c[o + 4]), dz = Math.max(c[o + 2] - cam.z, 0, cam.z - c[o + 5]);
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (dist > b.maxDist) continue;
          const lod = clamp(1 - ((dist - b.lod0) / (b.lod1 - b.lod0)) * (1 - b.minLod), b.minLod, 1);
          n = Math.ceil(n * lod);
          drawn += n;
        }
        if (n > 0) pass.drawIndexed(b.n, n, b.first, b.base, c[o + 6]);
      }
    }
    for (let i = 0; i < extras.length; i++) {
      const e = extras[i];
      if (shadow && !e.sp) continue;
      pass.setPipeline(shadow ? e.sp : e.p);
      pass.setVertexBuffer(0, e.vb); pass.setVertexBuffer(1, e.inst); pass.setIndexBuffer(e.ib, e.ifmt);
      pass.drawIndexed(e.n, e.count);
    }
  }

  // ---------- the helmet: head lag, swim sway, breathing, instruments on the glass ----------
  const NB = 40, BREATH = 5.2;
  const breathData = new Float32Array(NB * 8), breathVel = new Float32Array(NB * 3), breathLife = new Float32Array(NB);
  const breathBuf = dev.createBuffer({ size: breathData.byteLength, usage: VTX | GPUBufferUsage.COPY_DST });
  const hel = { k: visorOn ? 1 : 0, lx: 0, ly: 0, roll: 0, yaw: cam.yaw, pitch: cam.pitch, stroke: 0, ph: 0, spawn: 0, heat: 0, hudT: 0, air: 98, tx: 0, ty: 0 };
  const vBox = $('visor'), vDepth = $('v-depth'), vTemp = $('v-temp'), vAir = $('v-air'), vHead = $('v-head');
  const CARD = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];

  let last = performance.now(), time = FIXED_T ?? 0, frameNo = 0, fpsT = 0, fpsN = 0, ready = 0, slow = 0;
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05); last = now;
    if (FIXED_T === null) time += dt;
    resize();
    moveCamera(dt);

    // uniforms
    perspective(proj, FOV, sw / sh, NEAR, FAR);
    const cp = Math.cos(cam.pitch), fx = Math.sin(cam.yaw) * cp, fy = Math.sin(cam.pitch), fz = -Math.cos(cam.yaw) * cp, rx = Math.cos(cam.yaw), rz = Math.sin(cam.yaw);
    const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;       // camera up = right x forward
    // helmet: it trails the head a little, and the whole view sways with each stroke and breath
    hel.k += ((visorOn ? 1 : 0) - hel.k) * (1 - Math.exp(-dt * 6));
    let dyaw = cam.yaw - hel.yaw, dpitch = cam.pitch - hel.pitch;
    hel.yaw = cam.yaw; hel.pitch = cam.pitch;
    if (Math.abs(dyaw) > 1 || Math.abs(dpitch) > 1) dyaw = dpitch = 0;          // jumped to a viewpoint
    const idt = dt > 0.001 ? 1 / dt : 0, lagK = 1 - Math.exp(-dt * 7);
    hel.lx += (clamp(-dyaw * idt * 0.045, -0.12, 0.12) - hel.lx) * lagK;
    hel.ly += (clamp(-dpitch * idt * 0.045, -0.1, 0.1) - hel.ly) * lagK;
    hel.roll += (clamp(-dyaw * idt * 0.03, -0.06, 0.06) - hel.roll) * (1 - Math.exp(-dt * 5));
    const speed = Math.hypot(cam.vx, cam.vy, cam.vz), sk = Math.min(speed / 6.5, 1.6) * hel.k;
    if (speed > 0.3) hel.stroke += dt * (1.1 + speed * 0.22);
    const ph = (time / BREATH) % 1;
    const fog = 1 - 0.55 * sstep(0, 0.35, ph) + 0.55 * sstep(0.48, 0.8, ph);     // clears as you breathe in, mists as you breathe out
    if (hel.k > 0.5 && diving) {
      if (ph < hel.ph) sound.breath(0);
      if (hel.ph < 0.48 && ph >= 0.48) sound.breath(1);
    }
    hel.ph = ph;
    // exhaled bubbles stream up past the visor
    if (hel.k > 0.5 && ph > 0.5 && ph < 0.8) hel.spawn = Math.min(hel.spawn + dt * 16, 4);
    for (let i = 0; i < NB; i++) {
      const o = i * 8, v = i * 3;
      if (breathLife[i] <= 0 && hel.spawn >= 1) {
        hel.spawn--; breathLife[i] = 1.7;
        const side = i & 1 ? 1 : -1, a = side * (0.15 + Math.random() * 0.07), b = -0.2 - Math.random() * 0.05, c = 0.42 + Math.random() * 0.14;
        breathData[o] = cam.x + rx * a + ux * b + fx * c; breathData[o + 1] = cam.y + uy * b + fy * c; breathData[o + 2] = cam.z + rz * a + uz * b + fz * c;
        breathData[o + 3] = 0.006 + Math.random() * Math.random() * 0.022; breathData[o + 5] = Math.random();
        breathVel[v] = cam.vx * 0.7 + rx * side * 0.25 + (Math.random() - 0.5) * 0.3;
        breathVel[v + 1] = cam.vy * 0.7 + 0.5 + Math.random() * 0.5;
        breathVel[v + 2] = cam.vz * 0.7 + rz * side * 0.25 + (Math.random() - 0.5) * 0.3;
      }
      if (breathLife[i] > 0) {
        const dmp = Math.exp(-dt * 1.5);
        breathVel[v] *= dmp; breathVel[v + 2] *= dmp; breathVel[v + 1] += (1.3 - breathVel[v + 1]) * (1 - dmp);
        breathData[o] += breathVel[v] * dt; breathData[o + 1] += breathVel[v + 1] * dt; breathData[o + 2] += breathVel[v + 2] * dt;
        const life = (breathLife[i] -= dt);
        breathData[o + 4] = life > 0 ? Math.min(1, life * 3) * Math.min(1, (1.7 - life) * 10) : 0;
      }
    }
    dev.queue.writeBuffer(breathBuf, 0, breathData);
    // how hot it is where the diver is
    let heat = 0;
    for (let i = 0; i < 64; i += 4) {
      const L = W.lava, rr = L[i + 3] * 1.7, dx = cam.x - L[i], dy = cam.y - L[i + 1], dz = cam.z - L[i + 2];
      heat = Math.max(heat, 1 - (dx * dx + dy * dy + dz * dz) / (rr * rr));
    }
    hel.heat += (heat - hel.heat) * (1 - Math.exp(-dt * 2));
    const roll = Math.sin(hel.stroke) * 0.014 * sk + hel.roll * 0.5 * hel.k, bob = Math.sin(hel.stroke * 2) * 0.03 * sk + Math.sin(ph * 6.2832) * 0.012 * hel.k;
    const sr = Math.sin(roll), cr = Math.cos(roll), ex = cam.x + ux * bob, ey = cam.y + uy * bob, ez = cam.z + uz * bob;
    lookAt(view, ex, ey, ez, ex + fx, ey + fy, ez + fz, ux * cr + rx * sr, uy * cr, uz * cr + rz * sr);
    mul(vp, proj, view); invert(ivp, vp); frustum(vp);
    UB.set(vp, 0); UB.set(ivp, 16); UB.set(lvp, 32); UB.set(W.shipInv, 48);
    UB[64] = cam.x; UB[65] = cam.y; UB[66] = cam.z; UB[67] = time;
    UB[68] = sx; UB[69] = sy; UB[70] = sz; UB[71] = EXPOSURE;
    UB[72] = sw; UB[73] = sh; UB[74] = 1 / sw; UB[75] = 1 / sh;
    const gd = Math.hypot(cam.x - C.grotto[0], cam.z - C.grotto[1]) / C.grotto[2], gt = clamp((gd - 0.5) / 0.5, 0, 1);
    UB[76] = 1 - gt * gt * (3 - 2 * gt);
    UB[77] = clamp(Math.exp(-(C.SURF - cam.y) * 0.010), 0.5, 1);
    UB[78] = RAYS; UB[79] = (0.5 * sh) / Math.tan(FOV / 2);
    UB[80] = canvas.width; UB[81] = canvas.height; UB[82] = 1 / canvas.width; UB[83] = 1 / canvas.height;
    UB[84] = BLOOM;
    UB[88] = hel.lx; UB[89] = hel.ly; UB[90] = hel.roll; UB[91] = hel.k;
    UB[92] = fog; UB[93] = clamp(hel.heat, 0, 1);
    UB[96] = cam.vx; UB[97] = cam.vy; UB[98] = cam.vz; UB[99] = speed;
    UB.set(W.lava, 100);
    dev.queue.writeBuffer(ubo, 0, UB);
    TB[0] = time; TB[1] = 1;
    dev.queue.writeBuffer(tbo, 0, TB);

    const enc = dev.createCommandEncoder();
    // caustics texture + its mips
    for (let l = 0; l < causMips; l++) {
      const pass = enc.beginRenderPass(causPasses[l]);
      pass.setPipeline(l ? pDown : pCaus); pass.setBindGroup(0, causBGs[l]); pass.draw(3); pass.end();
    }
    // sun shadow map (not every frame: nothing in it moves fast)
    if (frameNo % Q.shadowEvery === 0) {
      UBS.set(UB); UBS.set(lvp, 0);
      dev.queue.writeBuffer(uboS, 0, UBS);
      const pass = enc.beginRenderPass(shadowPass);
      pass.setBindGroup(0, bg0s);
      pass.setPipeline(S.stat); pass.setVertexBuffer(0, staticVB); pass.setIndexBuffer(staticIB, 'uint32'); pass.drawIndexed(staticN);
      drawBatches(pass, true);
      pass.end();
    }
    // scene
    {
      drawn = 0;
      const pass = enc.beginRenderPass(mainPass);
      pass.setBindGroup(0, bg0);
      pass.setPipeline(P.sky); pass.draw(3);
      pass.setPipeline(P.stat); pass.setVertexBuffer(0, staticVB); pass.setIndexBuffer(staticIB, 'uint32'); pass.drawIndexed(staticN);
      drawBatches(pass, false);
      pass.setPipeline(P.surf); pass.draw(6);
      for (let i = 0; i < particles.length; i++) { const q = particles[i]; pass.setPipeline(q.p); pass.setVertexBuffer(0, q.inst); pass.draw(6, q.count); }
      pass.setPipeline(P.breath); pass.setVertexBuffer(0, breathBuf); pass.draw(6, NB);
      pass.end();
    }
    // light shafts
    {
      const pass = enc.beginRenderPass(raysPass);
      pass.setPipeline(pRays); pass.setBindGroup(0, bg0); pass.setBindGroup(1, bgRays); pass.draw(3); pass.end();
    }
    // bloom
    for (let l = 0; l < bloom.length; l++) {
      const pass = enc.beginRenderPass(bloom[l].down);
      pass.setPipeline(l ? pDown : pBright); pass.setBindGroup(0, bloom[l].fromPrev); pass.draw(3); pass.end();
    }
    for (let l = bloom.length - 2; l >= 0; l--) {
      const pass = enc.beginRenderPass(bloom[l].up);
      pass.setPipeline(pUp); pass.setBindGroup(0, bloom[l + 1].self); pass.draw(3); pass.end();
    }
    // composite to the canvas
    {
      compPass.colorAttachments[0].view = ctx.getCurrentTexture().createView();
      const pass = enc.beginRenderPass(compPass);
      pass.setPipeline(pComp); pass.setBindGroup(0, bg0); pass.setBindGroup(1, bgComp); pass.draw(3); pass.end();
    }
    dev.queue.submit([enc.finish()]);

    frameNo++;
    sound.update(cam, C.SURF, hel.heat, hel.k);
    // instruments: faint readouts that ride on the glass
    hel.hudT -= dt;
    if (hel.hudT <= 0) {
      hel.hudT = 0.16;
      const show = hel.k > 0.5 && gaugesOn && (diving || !!SHOT);
      vBox.classList.toggle('on', show); vBox.classList.toggle('hot', hel.heat > 0.4);
      if (show) {
        if (diving) hel.air = Math.max(21, hel.air - 0.16 / 55);
        const deg = (((cam.yaw * 57.2958) % 360) + 360) % 360;
        vDepth.textContent = (C.SURF - cam.y).toFixed(1);
        vTemp.textContent = Math.round(6 + (9 * cam.y) / C.SURF + 85 * Math.pow(clamp(hel.heat, 0, 1), 1.5));
        vAir.textContent = Math.round(hel.air);
        vHead.textContent = CARD[Math.round(deg / 45) % 8] + ' ' + String(Math.round(deg) % 360).padStart(3, '0') + '°';
      }
    }
    const tx = Math.round(hel.lx * innerHeight * 0.5), ty = Math.round(-hel.ly * innerHeight * 0.5);
    if (tx !== hel.tx || ty !== hel.ty) { hel.tx = tx; hel.ty = ty; vBox.style.transform = 'translate(' + tx + 'px,' + ty + 'px)'; }
    fpsT += dt; fpsN++;
    if (fpsT > 0.5) {
      // too slow for this machine: render fewer pixels
      slow = fpsN / fpsT < 42 && frameNo > 120 ? slow + 1 : 0;
      if (slow >= 4 && Q.scale > 0.5 && !SHOT) { Q.scale *= 0.85; sw = 0; slow = 0; }
      if (hud) $('hud').textContent = `${Math.round(fpsN / fpsT)} fps · ${sw}×${sh} · ${(drawn / 1000) | 0}k inst · ${cam.x.toFixed(0)}, ${cam.y.toFixed(0)}, ${cam.z.toFixed(0)}`;
      fpsT = 0; fpsN = 0;
    }
    if (++ready === 12) { document.body.classList.add('ready'); window.__ready = true; }
    requestAnimationFrame(frame);
  }

  // test hooks
  window.__cam = (x, y, z, yaw, pitch) => { cam.x = x; cam.y = y; cam.z = z; cam.yaw = yaw; cam.pitch = pitch; cam.vx = cam.vy = cam.vz = 0; };
  window.__view = setView;
  window.__sound = sound;
  window.__vel = (x, y, z) => { cam.vx = x; cam.vy = y; cam.vz = z; };
  window.__map = (S = 800) => {      // debug: top-down height map with kelp and viewpoints
    const cv = document.createElement('canvas'); cv.width = cv.height = S;
    const g = cv.getContext('2d'), im = g.createImageData(S, S), n = grid.n, o = grid.o, cell = grid.cell;
    for (let py = 0; py < S; py++) for (let px = 0; px < S; px++) {
      const x = (px / S - 0.5) * 320, z = (py / S - 0.5) * 320, gx = Math.round((x - o[0]) / cell), gz = Math.round((z - o[2]) / cell);
      let top = o[1];
      for (let j = n[1] - 1; j >= 0; j--) if (grid.g[gx + n[0] * (j + n[1] * gz)] < 0) { top = o[1] + j * cell; break; }
      const fl = grid.floorY(x, z), b = ((top - o[1]) / 66) * 255, i = (py * S + px) * 4;
      im.data[i] = b + (top - fl > 3 ? 90 : 0); im.data[i + 1] = b; im.data[i + 2] = b + (top > C.SURF ? 120 : 0); im.data[i + 3] = 255;
    }
    g.putImageData(im, 0, 0);
    const X = (x) => (x / 320 + 0.5) * S;
    const st = new Float32Array(W.stipes.data.buffer, W.stipes.data.byteOffset, W.stipes.count * 8);
    g.fillStyle = '#3f6';
    for (let i = 0; i < W.stipes.count; i++) if (st[i * 8 + 4] > 12) g.fillRect(X(st[i * 8]) - 1, X(st[i * 8 + 2]) - 1, 3, 3);
    g.strokeStyle = '#ff0'; g.fillStyle = '#ff0'; g.font = '14px sans-serif'; g.lineWidth = 2;
    VIEWS.forEach((v, i) => { g.beginPath(); g.arc(X(v[0]), X(v[2]), 5, 0, 7); g.moveTo(X(v[0]), X(v[2])); g.lineTo(X(v[0] + Math.sin(v[3]) * 14), X(v[2] - Math.cos(v[3]) * 14)); g.stroke(); g.fillText(i + 1, X(v[0]) + 7, X(v[2]) - 7); });
    g.strokeStyle = '#0ff'; for (let r = 40; r <= 120; r += 40) { g.beginPath(); g.arc(S / 2, S / 2, (r / 320) * S, 0, 7); g.stroke(); }
    return cv.toDataURL('image/png');
  };
  window.__stats = W.stats;
  window.__grid = grid;
  if (SHOT) { setView(+SHOT - 1); document.body.classList.add('dive', 'shot'); }
  await progress(1, '');
  requestAnimationFrame(frame);
}

main().catch((e) => fail(String(e.stack || e)));
