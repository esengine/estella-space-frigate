import { chromium } from 'playwright';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serveHost } from '../../../tools/lib/staticServer.mjs';
const server = await serveHost(path.resolve('output/space-frigate/' + (process.env.SPACE_WEB ?? 'web')));
const ctx = await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(), 'bake-log-')), { headless: true, viewport: { width: 1920, height: 1080 }, args: ['--use-angle=d3d11', '--enable-webgl', '--ignore-gpu-blocklist'] });
const page = await ctx.newPage();
page.on('console', (m) => { if (/model-bake\] \d+ model/.test(m.text())) console.log(m.text().slice(0, 900)); });
await page.goto(`http://127.0.0.1:${server.address().port}/?seed=1`, { waitUntil: 'load' });
await page.waitForFunction(() => (globalThis.__spaceLoad?.settledAt ?? 0) > 0, null, { timeout: 900000, polling: 250 });
if (process.argv[2]) { await page.waitForTimeout(3000); await page.screenshot({ path: process.argv[2] }); }
await ctx.close(); server.close();

