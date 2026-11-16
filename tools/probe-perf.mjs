import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { serveHost } from '../../../tools/lib/staticServer.mjs';

const root = path.resolve('output/space-frigate');
const seconds = Number(process.argv[2] ?? 100);
const script = process.argv[3] ? JSON.parse(process.argv[3]) : [];
const trace = process.argv[4] ?? '';
const server = await serveHost(path.join(root, 'web'));
const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-precise-memory-info'] });
try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    const problems = [];
    page.on('pageerror', (e) => problems.push(String(e)));
    await page.goto(`http://127.0.0.1:${server.address().port}/?headless`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.__estellaCooked?.facts().ready, null, { timeout: 120000 });
    await page.waitForFunction(() => window.__spaceHud?.ready || window.__spaceHud?.error, null, { timeout: 120000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(3000);
    if (trace) await browser.startTracing(page, { path: trace, categories: ['devtools.timeline', 'v8', 'disabled-by-default-v8.gc', 'gpu', 'toplevel'] });
    await page.evaluate(() => {
        const perf = { frames: [], long: [] };
        window.__perf = perf;
        let last = performance.now();
        const tick = (now) => {
            const f = window.__estellaCooked.facts();
            perf.frames.push([Math.round(now), +(now - last).toFixed(2), +f.time.toFixed(2), f.shot, f.soundCues, f.gunShots, f.transits, Math.round(performance.memory.usedJSHeapSize / 1048576), f.tour ? 1 : 0, f.gunView ? 1 : 0]);
            last = now;
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        new PerformanceObserver((list) => { for (const e of list.getEntries()) perf.long.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ entryTypes: ['longtask'] });
    });
    const began = Date.now();
    for (const [at, verb, a, b] of script) {
        await page.waitForTimeout(Math.max(0, at * 1000 - (Date.now() - began)));
        if (verb === 'tap') { await page.keyboard.down(a); await page.waitForTimeout(b ?? 60); await page.keyboard.up(a); }
        else if (verb === 'drag') { await page.mouse.move(a[0], a[1]); await page.mouse.down(); await page.mouse.move(a[2], a[3], { steps: 20 }); await page.mouse.up(); }
    }
    await page.waitForTimeout(Math.max(0, seconds * 1000 - (Date.now() - began)));
    if (trace) await browser.stopTracing();
    const perf = await page.evaluate(() => window.__perf);
    await writeFile(path.join(root, 'perf.json'), JSON.stringify(perf));
    const dts = perf.frames.slice(5).map((f) => f[1]).sort((a, b) => a - b);
    const at = (q) => dts[Math.min(dts.length - 1, Math.floor(dts.length * q))];
    console.log(JSON.stringify({ frames: dts.length, median: at(0.5), p95: at(0.95), p99: at(0.99), worst: dts[dts.length - 1], over25: dts.filter((d) => d > 25).length, over50: dts.filter((d) => d > 50).length, longTasks: perf.long.length, problems: problems.slice(0, 3) }));
} finally {
    await browser.close();
    server.close();
}
