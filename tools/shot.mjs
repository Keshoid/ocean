// Renders screenshots of the built index.html in headless Edge/Chrome with real WebGPU.
//   node tools/shot.mjs 1 2 3            fixed viewpoints
//   node tools/shot.mjs cam=0,10,40,0,0.1  free camera (x,y,z,yaw,pitch)
//   options: --t=20 (scene time) --w=1600 --h=900 --q=high --out=name
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const shots = args.filter((a) => !a.startsWith('--'));
const W = +opt('w', 1600), H = +opt('h', 900), t = opt('t', '20'), q = opt('q', 'high'), prefix = opt('out', 'v');
const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
mkdirSync('shots', { recursive: true });

const browser = await puppeteer.launch({
  executablePath: exe, headless: true, ignoreDefaultArgs: ['--disable-gpu'],
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11', '--no-first-run', `--window-size=${W},${H}`],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
let errors = 0;
page.on('console', (m) => { const s = m.text(); if (s.includes('powerPreference')) return; if (m.type() === 'error' || m.type() === 'warn') { errors++; console.log(`[${m.type()}]`, s.slice(0, 1500)); } else if (!s.includes('powerPreference')) console.log('[log]', s.slice(0, 600)); });
page.on('pageerror', (e) => { errors++; console.log('[pageerror]', e.message); });
const t0 = Date.now();
await page.goto(`${pathToFileURL('index.html').href}?shot=1&t=${t}&q=${q}`);
try {
  await page.waitForFunction('window.__ready', { timeout: 120000 });
} catch (e) {
  console.log('not ready:', await page.evaluate(() => document.getElementById('status').textContent));
  await page.screenshot({ path: 'shots/fail.png' });
  await browser.close(); process.exit(1);
}
console.log(`ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`, JSON.stringify(await page.evaluate(() => window.__stats)));
for (const s of shots) {
  if (s.startsWith('cam=')) await page.evaluate((c) => window.__cam(...c), s.slice(4).split(',').map(Number));
  else await page.evaluate((i) => window.__view(i), +s - 1);
  if (opt('vel', '')) await page.evaluate((v) => window.__vel(...v), opt('vel', '').split(',').map(Number));
  await page.evaluate((N) => new Promise((r) => { let n = 0; const f = () => (++n > N ? r() : requestAnimationFrame(f)); f(); }), +opt('frames', 6));
  const name = `shots/${prefix}${s.startsWith('cam=') ? 'cam' + shots.indexOf(s) : s}.jpg`;
  await page.screenshot({ path: name, type: 'jpeg', quality: 88 });
  console.log('wrote', name);
}
if (args.includes('--map')) {
  const url = await page.evaluate(() => window.__map());
  (await import('node:fs')).writeFileSync('shots/map.png', Buffer.from(url.split(',')[1], 'base64'));
  console.log('wrote shots/map.png');
}
if (opt('perf', '')) {
  const r = await page.evaluate(() => new Promise((res) => { const ts = []; let last = performance.now(); const f = (now) => { ts.push(now - last); last = now; ts.length < 240 ? requestAnimationFrame(f) : res(ts); }; requestAnimationFrame(f); }));
  r.sort((a, b) => a - b);
  console.log(`frame ms: avg ${(r.reduce((a, b) => a + b) / r.length).toFixed(2)}  p50 ${r[120].toFixed(2)}  p99 ${r[237].toFixed(2)}  max ${r[239].toFixed(2)}`);
}
await browser.close();
process.exit(errors ? 2 : 0);
