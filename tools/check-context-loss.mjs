import { chromium } from 'playwright';
import path from 'node:path';
import { serveHost } from '../../../tools/lib/staticServer.mjs';

// What the game does when the browser takes its drawing context away and gives it back, which a browser does when the GPU is
// short of memory or its process restarts. The context is lost on purpose with WEBGL_lose_context, held lost for two seconds,
// and restored; the page's errors, and whether the game and its HUD are running afterwards, are kept.
const root = path.resolve('output/space-frigate');
const angle = process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'swiftshader';
const server = await serveHost(path.join(root, process.env.SPACE_WEB ?? 'web'));
const browser = await chromium.launch({ headless: true, args: [`--use-angle=${angle}`, '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'] });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const said = [];
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => said.push(`pageerror: ${String(e).slice(0, 240)}`));
page.on('console', (m) => { if (m.type() === 'error' || /\[ERROR\]|threw an error/i.test(m.text())) said.push(`${m.type()}: ${m.text().slice(0, 240)}`); });
await page.goto(`http://127.0.0.1:${server.address().port}/?headless&seed=1`, { waitUntil: 'load', timeout: 300000 });
await page.waitForFunction(() => window.__estellaCooked?.facts().ready, null, { timeout: 600000, polling: 1000 });
await page.waitForFunction(() => window.__spaceHud?.ready, null, { timeout: 120000 });
await wait(3000);
const clock = () => page.evaluate(() => ({ hud: window.__spaceHud.ship.time, frame: window.__estellaCooked.facts().frame }));
const before = await clock();
const errorsBefore = said.length;
await page.evaluate(() => { const gl = document.querySelector('canvas').getContext('webgl2'); window.__lose = gl.getExtension('WEBGL_lose_context'); window.__lose.loseContext(); });
await wait(2000);
const during = await clock();
const whileLost = [...new Set(said.slice(errorsBefore))];
const lost = await page.evaluate(() => document.querySelector('canvas').getContext('webgl2').isContextLost());
await page.evaluate(() => window.__lose.restoreContext());
await wait(6000);
const errorsAfterRestore = said.length;
const after = await clock();
await wait(3000);
const later = await clock();
const stillThrowing = [...new Set(said.slice(errorsAfterRestore))];
await page.screenshot({ path: path.join(root, 'context-loss-after.png') }).catch(() => undefined);
const report = {
    lost, hudRanWhileLost: during.hud > before.hud, hudThrewWhileLost: whileLost.filter((line) => /space-frigate:hud/.test(line)).length > 0,
    errorsWhileLost: whileLost.slice(0, 5), restored: !(await page.evaluate(() => document.querySelector('canvas').getContext('webgl2').isContextLost())),
    framesAfterRestore: later.frame - after.frame, hudRunsAfterRestore: later.hud > after.hud, errorsAfterRestore: stillThrowing.slice(0, 5),
};
console.log(JSON.stringify(report, null, 1));
await browser.close();
server.close();
process.exit(report.hudThrewWhileLost || !report.hudRunsAfterRestore || stillThrowing.length > 0 ? 1 : 0);
