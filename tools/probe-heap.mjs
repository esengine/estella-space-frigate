import { chromium } from 'playwright';
import path from 'node:path';
import { serveHost } from '../../../tools/lib/staticServer.mjs';

const root = path.resolve('output/space-frigate');
const server = await serveHost(path.join(root, 'web'));
const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-webgl', '--ignore-gpu-blocklist'] });
try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${server.address().port}/?headless`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.__estellaCooked?.facts().ready, null, { timeout: 120000 });
    await page.waitForFunction(() => window.__spaceHud?.ready || window.__spaceHud?.error, null, { timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(6000);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('HeapProfiler.enable');
    const before = await page.evaluate(() => window.__estellaCooked.facts().frame);
    await cdp.send('HeapProfiler.startSampling', { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    await page.waitForTimeout(8000);
    const { profile } = await cdp.send('HeapProfiler.stopSampling');
    const frames = (await page.evaluate(() => window.__estellaCooked.facts().frame)) - before;
    const rows = new Map();
    const walk = (node, chain) => {
        const f = node.callFrame;
        const here = `${f.functionName || '(anonymous)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}:${f.columnNumber + 1}`;
        if (node.selfSize > 0) {
            const key = here + ' <- ' + chain.slice(-3).reverse().join(' <- ');
            rows.set(key, (rows.get(key) ?? 0) + node.selfSize);
        }
        for (const child of node.children ?? []) walk(child, [...chain, here]);
    };
    walk(profile.head, []);
    const total = [...rows.values()].reduce((a, b) => a + b, 0);
    console.log(JSON.stringify({ frames, totalMB: +(total / 1048576).toFixed(1), perFrameKB: Math.round(total / 1024 / frames) }));
    for (const [key, size] of [...rows.entries()].sort((a, b) => b[1] - a[1]).slice(0, 28)) console.log(`${(size / 1024 / frames).toFixed(0).padStart(6)} KB/帧  ${key.slice(0, 330)}`);
} finally {
    await browser.close();
    server.close();
}
