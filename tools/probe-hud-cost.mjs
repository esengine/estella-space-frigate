import { chromium } from 'playwright';
import path from 'node:path';
import { serveHost } from '../../../tools/lib/staticServer.mjs';

const root = path.resolve('output/space-frigate');
const webs = (process.env.FRIGATE_WEB ?? 'web').split(',');
const frames = Number(process.argv[2] ?? 600);
const seed = Number(process.argv[3] ?? 1);
const watched = (process.argv[4] ?? 'space-frigate:hud,space-frigate:helm').split(',');
const throttles = (process.env.FRIGATE_THROTTLE ?? '1').split(',').map(Number);
const counted = Number(process.env.FRIGATE_COUNTED ?? 60);
const coverage = process.env.FRIGATE_COVERAGE === '1';
const bake = process.env.FRIGATE_BAKE ? `&bake=${process.env.FRIGATE_BAKE}` : '';
const angle = process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'swiftshader';
const READ = ['getBuiltin(', 'getBuiltinMethods('];
const servers = await Promise.all(webs.map((web) => serveHost(path.join(root, web))));
const browser = await chromium.launch({ headless: true, args: [`--use-angle=${angle}`, '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const problems = [];
const summary = (list) => {
    const sorted = [...list].sort((a, b) => a - b);
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
    const mean = sorted.reduce((sum, v) => sum + v, 0) / Math.max(1, sorted.length);
    return { median: +at(0.5).toFixed(4), mean: +mean.toFixed(4), p95: +at(0.95).toFixed(4), frames: sorted.length };
};
const open = async (web, server) => {
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const origin = `http://127.0.0.1:${server.address().port}`;
    page.on('pageerror', (e) => problems.push(`${web}: ${e}`));
    page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) problems.push(`${web}: ${m.text().slice(0, 300)}`); });
    if (coverage) {
        await page.goto(`${origin}/blank`, { waitUntil: 'load' });
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
    }
    await page.goto(`${origin}/?headless&seed=${seed}${bake}`, { waitUntil: 'load', timeout: 300000 });
    await page.waitForFunction(() => window.__estellaCooked?.facts().ready, null, { timeout: 1200000, polling: 1000 });
    await page.waitForFunction(() => window.__spaceHud?.ready, null, { timeout: 300000, polling: 1000 });
    await page.evaluate(() => { window.__spaceHud.foes.peace = true; });
    await page.evaluate(() => window.__estellaCooked.setPaused(true));
    return { web, page, cdp };
};
const reads = async ({ page, cdp }) => {
    await cdp.send('Profiler.takePreciseCoverage');
    await page.evaluate((n) => window.__estellaCooked.step(n), counted);
    const { result } = await cdp.send('Profiler.takePreciseCoverage');
    await cdp.send('Profiler.stopPreciseCoverage');
    let calls = 0;
    for (const script of result) {
        if (!script.url.startsWith('http')) continue;
        const source = await (await fetch(script.url)).text();
        for (const fn of script.functions) {
            const [whole] = fn.ranges;
            const body = source.slice(whole.startOffset, whole.endOffset);
            if (body.length < 600 && READ.every((mark) => body.includes(mark))) calls += whole.count;
        }
    }
    return +(calls / counted).toFixed(2);
};
try {
    const lanes = await Promise.all(webs.map((web, i) => open(web, servers[i])));
    for (const { page } of lanes) {
        const step = (n) => page.evaluate((k) => window.__estellaCooked.step(k), n);
        const tap = async (key) => { await page.keyboard.down(key); await step(2); await page.keyboard.up(key); await step(2); };
        await step(60);
        await tap('Digit1');
        await tap('KeyW');
        await step(240);
    }
    const phases = [];
    for (const throttle of frames > 0 ? throttles : []) {
        for (const { cdp } of lanes) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
        const each = lanes.map(() => Object.fromEntries(watched.map((name) => [name, []])));
        const total = lanes.map(() => []);
        for (const { page } of lanes) await page.evaluate(async () => { window.__estellaCooked.costs(); await window.__estellaCooked.step(2); });
        for (let f = 0; f < frames; f++) {
            const order = f % 2 === 0 ? lanes.map((_, i) => i) : lanes.map((_, i) => lanes.length - 1 - i);
            for (const i of order) {
                const got = await lanes[i].page.evaluate(async (names) => {
                    await window.__estellaCooked.step(1);
                    let sum = 0;
                    const mine = {};
                    for (const s of window.__estellaCooked.costs().systems) {
                        sum += s.ms;
                        if (names.includes(s.name)) mine[s.name] = s.ms;
                    }
                    return { sum, mine };
                }, watched);
                for (const name of watched) each[i][name].push(got.mine[name] ?? 0);
                total[i].push(got.sum);
            }
        }
        const builds = Object.fromEntries(lanes.map(({ web }, i) => [web, { systems: Object.fromEntries(watched.map((name) => [name, summary(each[i][name])])), allSystems: summary(total[i]) }]));
        const paired = lanes.length < 2 ? undefined : Object.fromEntries(watched.map((name) => [name, summary(each[1][name].map((ms, f) => ms - each[0][name][f]))]));
        phases.push({ throttle, builds, paired });
    }
    for (const { cdp } of lanes) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const builtinReadsPerFrame = {};
    if (coverage) for (const lane of lanes) builtinReadsPerFrame[lane.web] = await reads(lane);
    const where = await Promise.all(lanes.map(({ page }) => page.evaluate(() => { const f = window.__estellaCooked.facts(); return { system: f.systemName, kind: f.planetKind, speed: f.speed }; })));
    console.log(JSON.stringify({ webs, seed, frames, where, phases, builtinReadsPerFrame, counted, problems: [...new Set(problems)].slice(0, 10) }, null, 1));
} catch (err) {
    problems.push(String(err));
    console.log(JSON.stringify({ webs, seed, problems: [...new Set(problems)].slice(0, 10) }, null, 1));
} finally {
    await browser.close();
    for (const server of servers) server.close();
}
if (problems.length > 0) process.exitCode = 1;
