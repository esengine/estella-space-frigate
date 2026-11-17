import { build } from 'esbuild';
import { chromium } from 'playwright';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const engine = path.resolve(root, '../..');
const host = path.join(engine, 'build/render-host');
if (!existsSync(path.join(host, 'host.js'))) {
    console.error('probe-shimmer: build the render host first: node tools/render-host/build.mjs');
    process.exit(2);
}
const [tag = 'now', ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.map((a) => a.split('=')));
const W = Number(opt.w ?? 1600), H = Number(opt.h ?? 900);
const list = (value, fallback) => (value ?? fallback).split(',').filter(Boolean);
const cases = list(opt.cases, 'authored,k0,k1,k2,k3,k4,k5,k6');
const radii = list(opt.radii, '320,160,80,48').map(Number);
const ringRadii = list(opt.ringRadii, '160,80,48').map(Number);
const shots = new Set(list(opt.shots, 'authored'));
const movies = new Set(list(opt.movie, ''));
const ticks = Number(opt.ticks ?? 16), crop = Number(opt.crop ?? 400), reference = opt.ref4 === '1';
const out = path.resolve('output/space-frigate/shimmer', tag);
const stage = path.join(root, '.esengine/cache/shimmer');
const angle = process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'swiftshader';

const worlds = path.join(root, '.esengine/cache/shimmer-worlds.mjs');
await build({ entryPoints: [path.join(root, 'src/worlds.ts')], outfile: worlds, bundle: true, format: 'esm', platform: 'node', logLevel: 'warning' });
const { systemAt, KIND_SWITCHES } = await import(pathToFileURL(worlds).href);
const kinds = new Map();
for (let i = 0; i < 400 && kinds.size < KIND_SWITCHES.length; i++) {
    const system = systemAt(i);
    if (!kinds.has(system.surface.kind)) kinds.set(system.surface.kind, system.surface);
}

await rm(stage, { recursive: true, force: true });
for (const file of ['models/planet.esmesh', 'models/shell.esmesh', 'models/gate-field.esmesh', 'materials/world-planet.esmaterial', 'materials/world-air.esmaterial',
    'materials/world-ring.esmaterial', 'materials/planet.esshader', 'materials/atmosphere.esshader', 'materials/ring.esshader']) {
    await mkdir(path.dirname(path.join(stage, 'assets', file)), { recursive: true });
    await copyFile(path.join(root, 'assets', file), path.join(stage, 'assets', file));
}
const scene = JSON.parse(await readFile(path.join(root, 'assets/scenes/main.esscene'), 'utf8'));
const kept = scene.entities.filter((e) => ['Camera', 'Sun', 'Sky', 'PlanetShine', 'Planet', 'Atmosphere', 'Ring'].includes(e.name));
const ids = Object.fromEntries(kept.map((e) => [e.name, e.id]));
const part = (name, type) => kept.find((e) => e.name === name).components.find((c) => c.type === type).data;
const volume = part('Camera', 'PostProcessVolume');
volume.effects = volume.effects.filter((e) => e.type !== 'nebula').map((e) => (e.type === 'filmGrain' ? { ...e, enabled: false } : e));
const ringAt = part('Ring', 'Transform');
const ringLook = JSON.parse(await readFile(path.join(root, 'assets/materials/world-ring.esmaterial'), 'utf8'));
const ring = { q: ['x', 'y', 'z', 'w'].map((k) => ringAt.rotation[k]), scale: ringAt.scale.x, inner: ringLook.properties.u_inner };
const planet = { at: part('Planet', 'Transform').position, radius: part('Planet', 'Transform').scale.x, air: part('Atmosphere', 'Transform').scale.x };
const saveScene = (name, entities) => writeFile(path.join(stage, 'assets/scenes', `${name}.esscene`), JSON.stringify({ ...scene, name, entities }));
await mkdir(path.join(stage, 'assets/scenes'), { recursive: true });
await saveScene('authored', kept);
const ground = JSON.parse(await readFile(path.join(root, 'assets/materials/world-planet.esmaterial'), 'utf8'));
const tone = (t) => ({ r: t.r, g: t.g, b: t.b, a: 1 });
for (const [kind, s] of kinds) {
    const properties = { ...ground.properties, u_accent: tone(s.accent), u_pole: tone(s.pole), u_glow: tone(s.glow),
        u_seed: [s.seed.x, s.seed.y, s.seed.z], u_shape: [s.shape.x, s.shape.y, s.shape.z, s.shape.w], u_spot: [s.spot.x, s.spot.y, s.spot.z, s.spot.w] };
    s.palette.forEach((c, i) => { properties[`u_c${i}`] = tone(c); });
    await writeFile(path.join(stage, `assets/materials/kind-${kind}.esmaterial`), JSON.stringify({ ...ground, switches: { [KIND_SWITCHES[kind]]: true }, properties }));
    await saveScene(`k${kind}`, kept.map((e) => (e.name !== 'Planet' ? e : { ...e, components: e.components.map((c) => (c.type !== 'MeshRenderer' ? c
        : { ...c, data: { ...c.data, material: `assets/materials/kind-${kind}.esmaterial` } })) })));
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.map': 'application/json' };
const server = http.createServer(async (req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = url.startsWith('/assets/') ? path.join(stage, url) : path.join(host, url === '/' ? '/index.html' : url);
    try {
        const body = await readFile(file);
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(body);
    } catch {
        res.writeHead(404);
        res.end();
    }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

function installProbe({ W, H, ids, ring, planet, volume }) {
    const api = window.__estellaHeadless.api;
    const TAN = Math.tan(Math.PI / 6), R = planet.radius, RA = planet.air;
    const lin = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const c = i / 255; lin[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    const enc = (l) => { const c = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055; return c <= 0 ? 0 : c >= 1 ? 255 : Math.round(c * 255); };
    const D = (h) => h / TAN - planet.at.z;
    const radiusPx = (h) => Math.tan(Math.asin(R / D(h))) * (H / 2) / TAN;
    const hFor = (r) => (R / Math.sin(Math.atan(r * TAN / (H / 2))) + planet.at.z) * TAN;
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    const rot = (q, v) => {
        const [x, y, z, w] = q, [vx, vy, vz] = v;
        const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
        return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
    };
    const qi = [-ring.q[0], -ring.q[1], -ring.q[2], ring.q[3]], N = rot(ring.q, [0, 0, 1]);
    let size = [W, H];
    async function show(h, w = W, hh = H) {
        if (size[0] !== w || size[1] !== hh) { api.resizeViewport(w, hh); size = [w, hh]; }
        api.setField(ids.Camera, 'Camera', 'orthoSize', 'float', h);
        api.useEditorView(true);
        await api.step(3, 1 / 60);
    }
    const frame = () => api.captureViewport();
    function down(f, s) {
        const w = Math.floor(f.width / s), h = Math.floor(f.height / s), src = f.rgba, o = new Uint8Array(w * h * 4), inv = 1 / (s * s);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            let r = 0, g = 0, b = 0;
            for (let yy = 0; yy < s; yy++) {
                for (let xx = 0, idx = ((y * s + yy) * f.width + x * s) * 4; xx < s; xx++, idx += 4) { r += lin[src[idx]]; g += lin[src[idx + 1]]; b += lin[src[idx + 2]]; }
            }
            const t = (y * w + x) * 4;
            o[t] = enc(r * inv); o[t + 1] = enc(g * inv); o[t + 2] = enc(b * inv); o[t + 3] = 255;
        }
        return { rgba: o, width: w, height: h };
    }
    const ray = (i, j) => [(2 * (i + 0.5) / W - 1) * TAN * (W / H), (2 * (j + 0.5) / H - 1) * TAN];
    function sphere(nx, ny, Dz, radius) {
        const a = nx * nx + ny * ny + 1, b = -2 * Dz, disc = b * b - 4 * a * (Dz * Dz - radius * radius);
        return disc <= 0 ? null : { t: (-b - Math.sqrt(disc)) / (2 * a), a };
    }
    const hits = {
        planet(i, j, Dz) {
            const [nx, ny] = ray(i, j), s = sphere(nx, ny, Dz, R);
            if (!s) return null;
            const P = [nx * s.t, ny * s.t, Dz - s.t];
            return (-P[0] * nx - P[1] * ny + P[2]) / (R * Math.sqrt(s.a)) < 0.35 ? null : P;
        },
        ring(i, j, Dz) {
            const [nx, ny] = ray(i, j);
            if (sphere(nx, ny, Dz, RA)) return null;
            const dn = nx * N[0] + ny * N[1] - N[2], t = Math.abs(dn) < 1e-9 ? -1 : -(Dz * N[2]) / dn;
            if (t <= 0) return null;
            const P = [nx * t, ny * t, Dz - t], L = rot(qi, P);
            const k = (Math.hypot(L[0], L[1]) / ring.scale - ring.inner) / (1 - ring.inner);
            return k < 0.02 || k > 0.98 ? null : P;
        },
    };
    function project(P, Dz) {
        const depth = Dz - P[2];
        return [(P[0] / depth / (TAN * (W / H)) + 1) * W / 2 - 0.5, (P[1] / depth / TAN + 1) * H / 2 - 0.5];
    }
    function sample(f, x, y, ch) {
        const x0 = Math.max(0, Math.min(W - 2, Math.floor(x))), y0 = Math.max(0, Math.min(H - 2, Math.floor(y)));
        const fx = Math.min(1, Math.max(0, x - x0)), fy = Math.min(1, Math.max(0, y - y0)), p = (yy, xx) => f.rgba[(yy * W + xx) * 4 + ch];
        return (p(y0, x0) * (1 - fx) + p(y0, x0 + 1) * fx) * (1 - fy) + (p(y0 + 1, x0) * (1 - fx) + p(y0 + 1, x0 + 1) * fx) * fy;
    }
    function region(Dz, kind) {
        const reach = kind === 'planet' ? R : ring.scale;
        const r = Dz > reach * 1.05 ? Math.tan(Math.asin(reach / Dz)) * (H / 2) / TAN + 2 : W;
        return [Math.max(0, Math.floor(W / 2 - r)), Math.min(W - 1, Math.ceil(W / 2 + r)), Math.max(0, Math.floor(H / 2 - r)), Math.min(H - 1, Math.ceil(H / 2 + r))];
    }
    function compare(A, Da, B, Db, kind, moved) {
        const [x0, x1, y0, y1] = region(Db, kind), values = [];
        for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
            const P = hits[kind](i, j, Db);
            if (!P) continue;
            const [x, y] = moved ? project(P, Da) : [i, j];
            let e = 0;
            for (let ch = 0; ch < 3; ch++) e += Math.abs(B.rgba[(j * W + i) * 4 + ch] - (moved ? sample(A, x, y, ch) : A.rgba[(j * W + i) * 4 + ch]));
            values.push(e / 3);
        }
        const sorted = Float32Array.from(values).sort(), n = sorted.length;
        return { mean: mean(values), p99: n ? sorted[Math.floor(n * 0.99)] : 0, pixels: n };
    }
    async function toPng(f, crop) {
        const s = Math.min(crop, f.width, f.height), x0 = Math.round(f.width / 2 - s / 2), y0 = Math.round(f.height / 2 - s / 2), img = new ImageData(s, s);
        for (let y = 0; y < s; y++) {
            const sy = f.height - 1 - (y0 + y);
            img.data.set(f.rgba.subarray((sy * f.width + x0) * 4, (sy * f.width + x0 + s) * 4), y * s * 4);
        }
        const canvas = new OffscreenCanvas(s, s);
        canvas.getContext('2d').putImageData(img, 0, 0);
        const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
        let text = '';
        for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(text);
    }
    window.__shimmer = {
        hFor,
        async setup() {
            api.setField(ids.Camera, 'Transform', 'position', 'vec3', [planet.at.x, planet.at.y, 0]);
            api.setField(ids.Camera, 'Camera', 'orthoSize', 'float', hFor(160));
            api.useEditorView(true);
            api.setViewPerspective(true);
            await show(hFor(160));
        },
        ring(on) { api.setField(ids.Ring, 'MeshRenderer', 'enabled', 'bool', on); },
        stars(on) { api.setComponent(ids.Camera, 'PostProcessVolume', { ...volume, effects: volume.effects.map((e) => (e.type === 'starfield' ? { ...e, enabled: on } : e)) }); },
        async shot(h, crop, scale = 1) { await show(h); return toPng(scale > 1 ? down(frame(), scale) : frame(), crop); },
        async measure(r, kind) {
            const h0 = hFor(r), hs = Array.from({ length: 8 }, (_, j) => h0 * Math.pow(1.003, j)), ones = [], refs = [];
            for (const h of hs) { await show(h); ones.push(frame()); }
            for (const h of hs) { await show(h, 2 * W, 2 * H); refs.push(down(frame(), 2)); }
            await show(h0);
            const one = [], ref = [];
            for (let j = 0; j + 1 < hs.length; j++) {
                one.push(compare(ones[j], D(hs[j]), ones[j + 1], D(hs[j + 1]), kind, true));
                ref.push(compare(refs[j], D(hs[j]), refs[j + 1], D(hs[j + 1]), kind, true));
            }
            const off = hs.map((h, j) => compare(refs[j], D(h), ones[j], D(h), kind, false));
            return { kind, r, pixels: one[0]?.pixels ?? 0, flicker: mean(one.map((x) => x.mean)), flickerP99: mean(one.map((x) => x.p99)),
                floor: mean(ref.map((x) => x.mean)), offReference: mean(off.map((x) => x.mean)) };
        },
    };
}

async function open(browser, scale, sceneName, problems) {
    const page = await (await browser.newContext({ viewport: { width: 640, height: 480 } })).newPage();
    page.on('pageerror', (e) => problems.push(String(e).slice(0, 300)));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text().slice(0, 300)); });
    await page.goto(`http://127.0.0.1:${port}/index.html?w=${W * scale}&h=${H * scale}&colorSpace=linear&outputTransform=aces&seed=1${scale > 1 ? '&msaa=1' : ''}`, { waitUntil: 'load', timeout: 180000 });
    await page.waitForFunction(() => !!window.__estellaHeadless, null, { timeout: 180000 });
    await page.evaluate(() => window.__estellaHeadless.ready);
    const load = await page.evaluate((s) => window.__estellaHeadless.api.loadScene(s), `/assets/scenes/${sceneName}.esscene`);
    if (load.missing.length) throw new Error(`${sceneName}: missing ${load.missing.join(', ')}`);
    await page.evaluate(installProbe, { W: W * scale, H: H * scale, ids, ring, planet, volume });
    await page.evaluate(() => window.__shimmer.setup());
    await page.evaluate(() => window.__estellaHeadless.api.warm(180000));
    return page;
}

await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: [`--use-angle=${angle}`, '--enable-webgl', '--ignore-gpu-blocklist'] });
const results = {};
const save = (name, base64) => writeFile(path.join(out, `${name}.png`), Buffer.from(base64, 'base64'));
try {
    for (const name of cases) {
        const problems = [], rows = [];
        const page = await open(browser, 1, name, problems);
        const at = (r) => page.evaluate((r) => window.__shimmer.hFor(r), r);
        await save(`${name}-near`, await page.evaluate(([h]) => window.__shimmer.shot(h, 900), [await at(360)]));
        await page.evaluate(() => { window.__shimmer.stars(false); window.__shimmer.ring(false); });
        for (const r of radii) rows.push(await page.evaluate(([r]) => window.__shimmer.measure(r, 'planet'), [r]));
        if (name === 'authored') {
            await page.evaluate(() => window.__shimmer.ring(true));
            for (const r of ringRadii) rows.push(await page.evaluate(([r]) => window.__shimmer.measure(r, 'ring'), [r]));
        }
        await page.evaluate(() => { window.__shimmer.stars(true); window.__shimmer.ring(true); });
        const zooms = [];
        if (shots.has(name)) for (let k = 0, h0 = await at(180); k < ticks && h0 * Math.pow(1.1, k) <= 40000; k++) zooms.push([`${name}-t${String(k).padStart(2, '0')}`, h0 * Math.pow(1.1, k), crop]);
        if (movies.has(name)) for (let j = 0, h0 = await at(110); j < 60; j++) zooms.push([`${name}-m${String(j).padStart(2, '0')}`, h0 * Math.pow(1.01, j), 300]);
        for (const [file, h, size] of zooms) await save(file, await page.evaluate(([h, size]) => window.__shimmer.shot(h, size), [h, size]));
        await page.context().close();
        if (reference && zooms.length) {
            const big = await open(browser, 4, name, problems);
            for (const [file, h, size] of zooms) await save(`${file}-ref4`, await big.evaluate(([h, size]) => window.__shimmer.shot(h, size, 4), [h, size]));
            await big.context().close();
        }
        results[name] = { rows, problems: [...new Set(problems)] };
        for (const row of rows) console.log(`${tag} ${name} ${row.kind} r=${row.r} flicker ${row.flicker.toFixed(2)} (1% ${row.flickerP99.toFixed(1)}) floor ${row.floor.toFixed(2)} off ${row.offReference.toFixed(2)}`);
        if (problems.length) console.log(`${tag} ${name} problems ${JSON.stringify(results[name].problems.slice(0, 4))}`);
        await writeFile(path.join(out, 'shimmer.json'), JSON.stringify({ tag, W, H, results }, null, 1));
    }
} finally {
    await browser.close();
    server.close();
}
