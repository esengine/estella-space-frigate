import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { serveHost } from '../../../tools/lib/staticServer.mjs';

const root = path.resolve('output/space-frigate');
const out = path.join(root, 'frames');
const script = JSON.parse(await readFile(process.argv[2], 'utf8'));
const [width, height] = (process.argv[3] ?? '1600x900').split('x').map(Number);

await mkdir(out, { recursive: true });
const server = await serveHost(path.join(root, 'web'));
const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-webgl', '--ignore-gpu-blocklist'] });
const problems = [];
try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => problems.push(String(e)));
    let baked = false;
    page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text().slice(0, 300));
        if (/^\[model-bake\] \d+ model\(s\) at /.test(m.text())) baked = true;
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/?headless`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.__estellaCooked?.facts().ready, null, { timeout: 600000 });
    await page.waitForFunction(() => window.__spaceHud?.ready || window.__spaceHud?.error, null, { timeout: 120000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 120000 }).catch(() => {});
    await page.evaluate(() => window.__estellaCooked.setPaused(true));
    for (const until = Date.now() + 300000; !baked && Date.now() < until;) await page.waitForTimeout(500);
    if (!baked) problems.push('the models were not baked within five minutes; the shots show placeholders');
    const facts = () => page.evaluate(() => window.__estellaCooked.facts());
    let reel = 0;
    let kills = 0;
    const film = async () => {
        await page.screenshot({ path: path.join(out, `film-${String(++reel).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 92, timeout: 60000 });
        const now = await facts();
        if ((now.kills ?? 0) !== kills) { kills = now.kills; console.log(JSON.stringify({ kill: kills, frame: reel, time: +now.time.toFixed(2) })); }
    };
    const step = async (frames) => {
        for (let left = frames; left > 0; left -= 120) {
            await page.evaluate((k) => window.__estellaCooked.step(k), Math.min(120, left));
            await page.waitForTimeout(25);
        }
    };
    for (const [verb, a, b, extra] of script) {
        if (verb === 'run') await step(Math.max(0, Math.round((a - (await facts()).time) * 60)));
        else if (verb === 'step') await step(a);
        else if (verb === 'hold') {
            await page.keyboard.down(a);
            await step(b);
            await page.keyboard.up(a);
            await step(1);
        } else if (verb === 'drag') {
            const [x0, y0, x1, y1] = a;
            await page.mouse.move(x0, y0);
            await page.mouse.down();
            for (let k = 1; k <= b; k++) { await page.mouse.move(x0 + ((x1 - x0) * k) / b, y0 + ((y1 - y0) * k) / b); await step(1); if (extra && k % extra === 0) await film(); }
            await page.mouse.up();
            await step(1);
        } else if (verb === 'press') {
            const spots = await page.evaluate(() => window.__spaceHud.guns.spots);
            const at = spots[a];
            await page.mouse.move((at.left * height) / 900, (at.top * height) / 900);
            await page.mouse.down();
            await step(b);
            await page.mouse.up();
            await step(1);
        } else if (verb === 'summon') {
            await page.evaluate(() => { window.__spaceHud.foes.due = 0; });
            await step(2);
        } else if (verb === 'film') {
            for (let done = 0; done < a; done += b) { await step(b); await film(); }
        } else if (verb === 'shot') {
            const f = await facts();
            await page.screenshot({ path: path.join(out, `${a}.png`), timeout: 60000 });
            console.log(JSON.stringify({ shot: a, time: +f.time.toFixed(2), throttle: +f.throttle.toFixed(2), tour: f.tour, eye: [f.eyeX, f.eyeY, f.eyeZ].map((v) => Math.round(v)), gate: Math.round(f.gate), transits: f.transits, system: f.systemName, jump: +(f.jump ?? -1).toFixed(2), fov: +(f.fov ?? 0).toFixed(1), planets: f.planets, gun: [f.gunView, f.gunSource, f.gunBearing, f.gunReady, f.gunShots, f.gunHits, Math.round(f.gunRange ?? 0), f.gunTrain, f.gunAuto, +(f.gunSpread ?? 0).toFixed(2), +(f.gunLead ?? 0).toFixed(2)] }));
        }
    }
} finally {
    await browser.close();
    server.close();
}
console.log(JSON.stringify({ problems: [...new Set(problems)].slice(0, 12) }, null, 1));
