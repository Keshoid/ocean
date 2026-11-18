// Smoke test of the real page (no test hooks): menu screenshot, then a few seconds of live animation.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser = await puppeteer.launch({ executablePath: exe, headless: true, ignoreDefaultArgs: ['--disable-gpu'], args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
let errors = 0;
page.on('console', (m) => { if (m.type() === 'error') { errors++; console.log('[error]', m.text().slice(0, 800)); } });
page.on('pageerror', (e) => { errors++; console.log('[pageerror]', e.message); });
await page.goto(pathToFileURL('index.html').href);
await page.waitForFunction('window.__ready', { timeout: 120000 });
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: 'shots/menu.jpg', type: 'jpeg', quality: 88 });
// "dive" without pointer lock (headless), swim forward for a while with sound on
await page.evaluate(() => { document.body.classList.add('dive'); document.getElementById('go').click(); });
await page.keyboard.down('KeyW'); await page.keyboard.down('ShiftLeft'); await page.keyboard.press('KeyH');
await new Promise((r) => setTimeout(r, 1500));
await page.screenshot({ path: 'shots/fast.jpg', type: 'jpeg', quality: 88 });
await page.evaluate(() => { const s = window.__sound; s.breath(0); s.breath(1); s.update({ y: 5 }, 46, 0.9, 1); s.update({ y: 5 }, 46, 0.2, 0); });
await page.keyboard.up('ShiftLeft');
await new Promise((r) => setTimeout(r, 2500));
console.log('audio:', await page.evaluate(() => window.__sound.ctx ? window.__sound.ctx.state : 'none'));
await page.keyboard.up('KeyW');
await page.screenshot({ path: 'shots/live.jpg', type: 'jpeg', quality: 88 });
console.log('hud:', await page.evaluate(() => document.getElementById('hud').textContent), '| errors:', errors);
await browser.close();
process.exit(errors ? 2 : 0);
