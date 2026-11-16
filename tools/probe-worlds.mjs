import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { serveHost } from '../../../tools/lib/staticServer.mjs';

const root = path.resolve('output/space-frigate');
const out = path.join(root, process.env.FRIGATE_SHOTS ?? 'worlds');
const seeds = (process.argv[2] ?? '1,2,3,4,5,6').split(',').map(Number);
const [width, height] = (process.argv[3] ?? '1280x720').split('x').map(Number);
const angle = process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'swiftshader';
const FIRST = { yaw: 0.72, pitch: 0.17 };

await mkdir(out, { recursive: true });
const server = await serveHost(path.join(root, process.env.FRIGATE_WEB ?? 'web'));
const browser = await chromium.launch({ headless: true, args: [`--use-angle=${angle}`, '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const problems = [];
try {
    for (const seed of seeds) {
      try {
        const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
        page.on('pageerror', (e) => problems.push(`${seed}: ${String(e)}`));
        page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`${seed}: ${m.text().slice(0, 300)}`); });
        await page.goto(`http://127.0.0.1:${server.address().port}/?headless&seed=${seed}`, { waitUntil: 'load', timeout: 120000 });
        await page.waitForFunction(() => window.__estellaCooked?.facts().ready, null, { timeout: 600000 });
        await page.waitForFunction(() => window.__spaceHud?.ready || window.__spaceHud?.error, null, { timeout: 600000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 120000 }).catch(() => {});
        await page.evaluate(() => window.__estellaCooked.setPaused(true));
        const step = (n) => page.evaluate((k) => window.__estellaCooked.step(k), n);
        const facts = () => page.evaluate(() => window.__estellaCooked.facts());
        await step(30);
        await page.keyboard.down('Digit1');
        await step(2);
        await page.keyboard.up('Digit1');
        await step(2);
        const f = await facts();
        const far = Math.hypot(f.planetX, f.planetY, f.planetZ) || 1;
        const yaw = Math.atan2(-f.planetX, -f.planetZ), pitch = Math.max(-1.15, Math.min(1.15, Math.asin(-f.planetY / far) * 0.85));
        let turn = FIRST.yaw - yaw;
        turn -= Math.round(turn / (Math.PI * 2)) * Math.PI * 2;
        const dx = turn / 0.005, dy = (pitch - FIRST.pitch) / 0.004;
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 15));
        const x0 = width / 2, y0 = height / 2;
        await page.mouse.move(x0, y0);
        await page.mouse.down();
        await step(1);
        for (let k = 1; k <= steps; k++) { await page.mouse.move(x0 + (dx * k) / steps, y0 + (dy * k) / steps); await step(1); }
        await page.mouse.up();
        await step(90);
        const now = await facts();
        const file = path.join(out, `world-${seed}.jpg`);
        await page.screenshot({ path: file, type: 'jpeg', quality: 90, timeout: 60000 });
        console.log(JSON.stringify({ seed, file, system: now.systemName, kind: now.planetKind, planets: now.planets, tour: now.tour }));
        await page.close();
      } catch (err) {
        console.log(JSON.stringify({ seed, failed: String(err).slice(0, 300), problems: problems.filter((p) => p.startsWith(`${seed}:`)).slice(0, 8) }));
      }
    }
} finally {
    await browser.close();
    server.close();
}
console.log(JSON.stringify({ problems: [...new Set(problems)].slice(0, 30) }, null, 1));
if (problems.length > 0) process.exitCode = 1;
