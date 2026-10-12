// Record the companion alerting on one demo page per movie, headless, with no
// screen-recording permission: the companion's getDisplayMedia is replaced by a
// canvas stream that is fed live screenshots of the demo page, so the runtime
// analyses exactly what the page shows. Playwright records the companion tab.
// Usage: node demo/video/record-companion.mjs host[=label] ...   (hosts are *.localhost:8099)
import { chromium } from 'playwright';
import { mkdir, rename } from 'node:fs/promises';

const out = new URL('./pieces/', import.meta.url).pathname;
await mkdir(out, { recursive: true });
const pieces = process.argv.slice(2).map((a) => { const [host, label] = a.split('='); return { host, label: label ?? host }; });
const SETTLED = /concern|signs|pressure|caution|could not tell|no configured|not enough|no warning/i;

for (const { host, label } of pieces) {
  const started = Date.now();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: out, size: { width: 1280, height: 800 } } });
  const target = await context.newPage();
  await target.goto(`http://${host}.localhost:8099/`, { waitUntil: 'load' });
  const companion = await context.newPage();
  await companion.addInitScript(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280; canvas.height = 800;
    Object.defineProperty(window, '__shepherdCanvas', { value: canvas });
    navigator.mediaDevices.getDisplayMedia = async () => canvas.captureStream(5);
  });
  companion.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) console.log(`${host} console: ${m.text().slice(0, 120)}`); });
  await companion.goto('http://127.0.0.1:4317/companion', { waitUntil: 'load' });
  await companion.waitForTimeout(1500);
  // Feed the canvas with the page as it is now, before Start, then keep it fresh.
  const feed = async () => {
    const png = (await target.screenshot({ type: 'png' })).toString('base64');
    await companion.evaluate((data) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { const c = window.__shepherdCanvas; c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); resolve(); };
      img.src = `data:image/png;base64,${data}`;
    }), png);
  };
  await feed();
  try { if (await companion.isEnabled('#grant')) await companion.click('#grant'); } catch {}
  await companion.waitForTimeout(800);
  await companion.click('#start');
  // "Not sure" can be provisional: the cloud judge may still answer. Stop early
  // only on a concern or a clean result; otherwise give the judge up to ~45 s.
  let outcome = 'timeout';
  for (let i = 0; i < 65; i++) {
    await feed();
    await companion.waitForTimeout(700);
    const state = (await companion.textContent('#state')) ?? '';
    const message = (await companion.textContent('#message')) ?? '';
    const seen = `${state} ${message}`;
    if (SETTLED.test(seen)) outcome = `${state.trim()} | ${message.trim().slice(0, 90)}`;
    if (/concern|signs of|no warning|no configured/i.test(seen) && !/could not tell/i.test(seen)) break;
  }
  for (let i = 0; i < 8; i++) { await feed(); await companion.waitForTimeout(700); }
  const video = companion.video();
  await context.close();
  const path = await video.path();
  await rename(path, `${out}${label}.webm`);
  await browser.close();
  console.log(`${label}: ${Math.round((Date.now() - started) / 1000)} s -> pieces/${label}.webm | ${outcome}`);
}
