import { chromium } from 'playwright';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serveHost } from '../../../tools/lib/staticServer.mjs';

// What the wait before the game is spent on, as a player has it: a first visit (nothing kept by the browser) and a second
// (whatever the game and the browser keep, kept). For each: what was downloaded, when each part of fitting out began, when the
// models were all made, when the scene's shaders were ready, and when the loading screen lifted.
const root = path.resolve('output/space-frigate');
const out = path.join(root, 'frames');
const angle = process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'swiftshader';
await mkdir(out, { recursive: true });
const server = await serveHost(path.join(root, process.env.SPACE_WEB ?? 'web'));
const profileDir = await mkdtemp(path.join(tmpdir(), 'space-load-'));
const context = await chromium.launchPersistentContext(profileDir, { headless: true, viewport: { width: 1920, height: 1080 }, args: [`--use-angle=${angle}`, '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'] });
const report = [];
for (const visit of ['first visit', 'second visit']) {
    const page = await context.newPage();
    let bytes = 0, files = 0;
    // What came over the wire, as the browser counted it: a body served in ranges or without a length is still counted.
    page.on('requestfinished', (request) => { void request.sizes().then((sizes) => { bytes += sizes.responseBodySize; files++; }, () => undefined); });
    const began = Date.now();
    await page.goto(`http://127.0.0.1:${server.address().port}/?seed=1`, { waitUntil: 'load', timeout: 300000 });
    const loadedAt = Date.now() - began;
    await page.waitForFunction(() => (globalThis.__spaceLoad?.settledAt ?? 0) > 0, null, { timeout: 900000, polling: 250 });
    const total = Date.now() - began;
    const log = await page.evaluate(() => ({ ...globalThis.__spaceLoad, navToScreen: Math.round(globalThis.__spaceLoad.began) }));
    // How long each part of fitting out stood on the loading screen.
    const parts = log.subjects.map((s, i) => ({ label: s.label, ms: (log.subjects[i + 1]?.at ?? log.bakedAt) - s.at })).filter((p) => p.ms > 0).sort((a, b) => b.ms - a.ms);
    const byKind = {};
    for (const p of parts) { const kind = p.label.replace(/[-_ ]?\d+$/, '').replace(/-[abc]$/, ''); byKind[kind] = (byKind[kind] ?? 0) + p.ms; }
    const line = {
        visit, downloadedMB: +(bytes / 1048576).toFixed(2), files, pageLoadedMs: loadedAt, loadingScreenUpMs: log.navToScreen,
        modelsMadeMs: log.bakedAt, sceneAndShadersReadyMs: log.stagedAt, screenLiftedMs: log.settledAt, wallClockToPlayableMs: total,
        longestParts: parts.slice(0, 8), byKind: Object.fromEntries(Object.entries(byKind).sort((a, b) => b[1] - a[1]).slice(0, 10)),
    };
    report.push(line);
    console.log(JSON.stringify(line));
    await page.close();
}
await context.close();
server.close();
await writeFile(path.join(out, 'load.json'), JSON.stringify(report, null, 1));
