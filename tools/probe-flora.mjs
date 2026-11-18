// What grows on a world, looked at: puts her low over the ground of the first world of a kind and takes pictures, with what is drawn and what a frame costs.
//   node examples/space-frigate/tools/probe-flora.mjs [kind=6] [seed=1]
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { serveHost } from '../../../tools/lib/staticServer.mjs';

const root = path.resolve('output/space-frigate');
const kind = Number(process.argv[2] ?? 6), seed = Number(process.argv[3] ?? 1);
const out = path.join(root, `flora-${kind}-${seed}`);
const angle = process.env.FLORA_ANGLE ?? process.platform === 'win32' ? process.env.FLORA_ANGLE ?? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'swiftshader';
await mkdir(out, { recursive: true });
const server = await serveHost(path.join(root, process.env.SPACE_WEB ?? 'web'));
const browser = await chromium.launch({ headless: true, args: [`--use-angle=${angle}`, '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const problems = [], shots = [];
try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => problems.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning' || /worldgen|planet|shader|foliage/i.test(m.text())) problems.push(`${m.type()}: ${m.text().slice(0, 500)}`); });
    // The graphics choices she has kept, to look at one level: FLORA_STORE='{"mode":"high"}'.
    if (process.env.FLORA_STORE) await page.addInitScript((choices) => { try { localStorage.setItem('space-frigate:graphics', choices); } catch { /* no storage */ } }, process.env.FLORA_STORE);
    // FLORA_GL=1: the state every draw of the foliage material is made under, for one frame (what the depth test, the masks and the
    // draw buffers were), with how many draws of anything came before it. For finding why a pass draws a thing wrong.
    if (process.env.FLORA_FORCE === 'nomulti') await page.addInitScript(() => { globalThis.__glNoMulti = true; const real = WebGL2RenderingContext.prototype.getSupportedExtensions; WebGL2RenderingContext.prototype.getSupportedExtensions = function () { return real.call(this).filter((n) => !/multi_draw/i.test(n)); }; });
    if (process.env.FLORA_GL) await page.addInitScript(() => {
        const take = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
            const gl = take.call(this, kind, ...rest);
            if (!gl || gl.__watched || !/webgl2/.test(kind)) return gl;
            gl.__watched = true;
            const state = { depthFunc: 'LESS', depthMask: true, colorMask: '1111', a2c: false, depthTest: false, blend: false, program: null, buffers: '', fbo: 0, draws: 0 };
            const foliage = new WeakSet(), sources = new WeakMap(), names = new WeakMap();
            const sizes = new WeakMap(), bufIds = new WeakMap(); let bufs = 0;
            const texIds = new WeakMap(); let texes = 0;
            const sized = (target, w, h) => { const tex = gl.getParameter(target === gl.TEXTURE_2D ? gl.TEXTURE_BINDING_2D : gl.TEXTURE_BINDING_2D_ARRAY); if (tex && !sizes.has(tex)) sizes.set(tex, `${w}x${h}`); };
            { const real = gl.texStorage2D; gl.texStorage2D = function (t, l, f, w, h) { const r = real.call(gl, t, l, f, w, h); sized(t, w, h); return r; }; }
            { const real = gl.texImage2D; gl.texImage2D = function (...args) { const r = real.apply(gl, args); if (args[1] === 0) { if (typeof args[3] === 'number' && typeof args[4] === 'number' && args.length >= 9) sized(args[0], args[3], args[4]); else sized(args[0], args[5]?.width ?? '?', args[5]?.height ?? '?'); } return r; }; }
            const log = (globalThis.__glLog = { on: false, lines: [] });
            const wrap = (name, before) => { const real = gl[name]; gl[name] = function (...args) { before(...args); return real.apply(gl, args); }; };
            wrap('shaderSource', (shader, text) => { sources.set(shader, text); });
            wrap('attachShader', (program, shader) => { const text = sources.get(shader) ?? ''; if (/u_windStrength/.test(text)) foliage.add(program); const m = /SHADOW_DEPTH|PREPASS_COVERAGE/.exec(text); names.set(program, `${names.get(program) ?? ''}${/u_windStrength/.test(text) ? 'F' : ''}${/u_planetCenter/.test(text) ? 'P' : ''}${m ? 'D' : ''}`); });
            wrap('useProgram', (program) => { state.program = program; });
            wrap('depthFunc', (f) => { state.depthFunc = f === gl.LEQUAL ? 'LEQUAL' : f === gl.LESS ? 'LESS' : String(f); });
            wrap('depthMask', (on) => { state.depthMask = !!on; });
            wrap('colorMask', (r, g, b, a) => { state.colorMask = `${+r}${+g}${+b}${+a}`; });
            wrap('enable', (cap) => { if (cap === gl.SAMPLE_ALPHA_TO_COVERAGE) state.a2c = true; if (cap === gl.DEPTH_TEST) state.depthTest = true; if (cap === gl.BLEND) state.blend = true; });
            wrap('disable', (cap) => { if (cap === gl.SAMPLE_ALPHA_TO_COVERAGE) state.a2c = false; if (cap === gl.DEPTH_TEST) state.depthTest = false; if (cap === gl.BLEND) state.blend = false; });
            wrap('drawBuffers', (list) => { state.buffers = list.map((b) => (b === gl.NONE ? '-' : b === gl.BACK ? 'B' : String(b - gl.COLOR_ATTACHMENT0))).join(''); });
            let fbos = 0; const ids = new WeakMap();
            wrap('bindFramebuffer', (target, fbo) => { if (fbo && !ids.has(fbo)) ids.set(fbo, ++fbos); state.fbo = fbo ? ids.get(fbo) : 0; });
            // FLORA_FORCE: what is taken off a foliage draw, to see which test turns it away: nodepth, noa2c.
            const forced = (tag) => {
                const how = globalThis.__glForce;
                if (!how || !/F/.test(tag) || /D/.test(tag)) return;
                if (how === 'nodepth') gl.disable(gl.DEPTH_TEST);
                if (how === 'noa2c') gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
            };
            // FLORA_FORCE=readback: what is in the picture just after the foliage is drawn, read from the framebuffer it was drawn to
            // (one that is not multisampled: FLORA_STORE='{"mode":"low"}'): how many of the pixels in the middle are dark green.
            let pending = 0, after = 0;
            const readback = (tag) => {
                if (globalThis.__glForce !== 'readback' || !log.on) return;
                const leaf = /F/.test(tag) && !/D/.test(tag) && state.colorMask === '1111';
                if (leaf) { pending = state.fbo; after = 0; return; }
                if (!pending) return;
                if (state.fbo !== pending && after < 14) return;
                // Before each of the draws that follow the foliage into the same picture: how much of it is still there, and what the draw is.
                if (++after > 70) pending = 0;
                if (after > 14 && state.fbo === 0) return;
                const vp = gl.getParameter(gl.VIEWPORT), px = new Float32Array(600 * 300 * 4);
                while (gl.getError()) { /* what was there before */ }
                gl.readPixels(Math.floor(vp[2] * 0.45), Math.floor(vp[3] * 0.15), 600, 300, gl.RGBA, gl.FLOAT, px);
                const err = `${gl.getError()} viewport ${vp[2]}x${vp[3]} samples ${gl.getParameter(gl.SAMPLES)}`;
                let green = 0, lit = 0;
                // Dark and green beside the ground's bright green: a leaf (linear light, before the lens).
                for (let i = 0; i < px.length; i += 4) { if (px[i] + px[i + 1] + px[i + 2] > 0) lit++; if (px[i + 1] > px[i] * 1.3 && px[i + 1] > px[i + 2] * 1.3 && px[i + 1] < 0.12) green++; }
                const uniforms = []; { const n = gl.getProgramParameter(state.program, gl.ACTIVE_UNIFORMS); for (let i = 0; i < Math.min(n, 40); i++) { const u = gl.getActiveUniform(state.program, i); if (u && /^u_/.test(u.name) && !/u_textures|u_instanceData/.test(u.name)) uniforms.push(u.name); } }
                log.lines.push({ line: `READBACK ${after}: fbo${state.fbo} ${err} dark green ${green} before a draw [${tag}] depth:${state.depthTest ? state.depthFunc : 'off'} write:${+state.depthMask} colour:${state.colorMask} blend:${+state.blend} uniforms ${uniforms.slice(0, 6).join(' ')}`, n: 1, at: state.draws });
            };
            const draw = (name) => wrap(name, () => {
                readback(names.get(state.program) ?? '');
                forced(names.get(state.program) ?? '');
                state.draws++;
                if (!log.on) return;
                let tag = names.get(state.program) ?? '';
                if (!tag && globalThis.__glForce === 'order') tag = 'U';
                if (!tag) return;
                // What the foliage material's picture is at this draw: the unit its sampler names, and the size of the texture bound there.
                let albedo = '';
                if (/F/.test(tag) && !/D/.test(tag)) {
                    const at = gl.getUniformLocation(state.program, 'u_albedo');
                    const unit = at ? gl.getUniform(state.program, at) : -1;
                    const was = gl.getParameter(gl.ACTIVE_TEXTURE);
                    if (unit >= 0) { gl.activeTexture(gl.TEXTURE0 + unit); const tex = gl.getParameter(gl.TEXTURE_BINDING_2D); albedo = ` albedo:unit${unit}=${tex ? sizes.get(tex) ?? '?' : 'none'}`; gl.activeTexture(was); }
                    { const inst = gl.getUniformLocation(state.program, 'u_instanceData'); const u = inst ? gl.getUniform(state.program, inst) : -1; if (u >= 0) { gl.activeTexture(gl.TEXTURE0 + u); const tex = gl.getParameter(gl.TEXTURE_BINDING_2D); albedo += ` records:unit${u}=${tex ? `${sizes.get(tex) ?? '?'}#${texIds.get(tex) ?? (texIds.set(tex, ++texes), texes)}` : 'none'}`; gl.activeTexture(was); } }
                    if (globalThis.__glForce === 'blocks' && !log.dumped) {
                        log.dumped = true;
                        const was = gl.getParameter(gl.UNIFORM_BUFFER_BINDING);
                        const blocks = gl.getProgramParameter(state.program, gl.ACTIVE_UNIFORM_BLOCKS);
                        for (let b = 0; b < blocks; b++) {
                            const name = gl.getActiveUniformBlockName(state.program, b), at = gl.getActiveUniformBlockParameter(state.program, b, gl.UNIFORM_BLOCK_BINDING), need = gl.getActiveUniformBlockParameter(state.program, b, gl.UNIFORM_BLOCK_DATA_SIZE);
                            const buf = gl.getIndexedParameter(gl.UNIFORM_BUFFER_BINDING, at), start = gl.getIndexedParameter(gl.UNIFORM_BUFFER_START, at), size = gl.getIndexedParameter(gl.UNIFORM_BUFFER_SIZE, at);
                            let head = 'none';
                            if (buf) { const data = new Float32Array(Math.min(need, 96) / 4); gl.bindBuffer(gl.UNIFORM_BUFFER, buf); gl.getBufferSubData(gl.UNIFORM_BUFFER, start, data); const ints = new Uint32Array(data.buffer); head = [...data].map((v, i) => (Math.abs(v) > 1e-30 && Math.abs(v) < 1e9 ? +v.toPrecision(4) : `i${ints[i]}`)).join(','); }
                            log.lines.push({ line: `BLOCK ${name} binding ${at} needs ${need} start ${start} size ${size}: ${head}`, n: 1, at: state.draws });
                        }
                        gl.bindBuffer(gl.UNIFORM_BUFFER, was);
                    }
                    { let on = ''; for (let i = 0; i < 8; i++) { const loc = gl.getActiveAttrib(state.program, i); if (!loc) break; const at = gl.getAttribLocation(state.program, loc.name); on += `${loc.name.replace('a_', '')}@${at}${gl.getVertexAttrib(at, gl.VERTEX_ATTRIB_ARRAY_ENABLED) ? (gl.getVertexAttrib(at, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING) ? '+' : '0') : '-'}s${gl.getVertexAttrib(at, gl.VERTEX_ATTRIB_ARRAY_STRIDE)}o${gl.getVertexAttribOffset(at, gl.VERTEX_ATTRIB_ARRAY_POINTER)} `; } albedo += ` attribs:${on}`; }
                    if (globalThis.__glForce === 'raster') {
                        const bufsNow = []; for (let i = 0; i < 4; i++) { const b = gl.getParameter(gl.DRAW_BUFFER0 + i); bufsNow.push(b === gl.NONE ? '-' : b === gl.BACK ? 'B' : b - gl.COLOR_ATTACHMENT0); }
                        albedo += ` cover:${+gl.isEnabled(gl.SAMPLE_COVERAGE)}/${gl.getParameter(gl.SAMPLE_COVERAGE_VALUE)} scissor:${+gl.isEnabled(gl.SCISSOR_TEST)} stencil:${+gl.isEnabled(gl.STENCIL_TEST)} cull:${+gl.isEnabled(gl.CULL_FACE)} offset:${+gl.isEnabled(gl.POLYGON_OFFSET_FILL)} discard:${+gl.isEnabled(gl.RASTERIZER_DISCARD)} range:${[...gl.getParameter(gl.DEPTH_RANGE)]} vp:${[...gl.getParameter(gl.VIEWPORT)]} bufs:${bufsNow.join('')} samples:${gl.getParameter(gl.SAMPLES)} mask:${gl.getParameter(gl.COLOR_WRITEMASK).map(Number).join('')}`;
                    }
                    const ubo = gl.getIndexedParameter(gl.UNIFORM_BUFFER_BINDING, 1);
                    albedo += ` ubo1:${ubo ? (bufIds.get(ubo) ?? (bufIds.set(ubo, ++bufs), bufs)) : 'none'}`;
                }
                const line = `${tag} fbo${state.fbo} depth:${state.depthTest ? state.depthFunc : 'off'} write:${+state.depthMask} colour:${state.colorMask} a2c:${+state.a2c}${albedo}`;
                const last = log.lines[log.lines.length - 1];
                if (last && last.line === line) last.n++; else log.lines.push({ line, n: 1, at: state.draws });
            });
            for (const name of ['drawElements', 'drawElementsInstanced', 'drawArrays', 'drawArraysInstanced', 'drawRangeElements']) draw(name);
            // FLORA_FORCE=targets: what is done to the framebuffers in a frame (bound, cleared, copied, thrown away), with how many draws went to each.
            { let since = 0; const note = (text) => { if (globalThis.__glForce === 'targets' && log.on) { log.lines.push({ line: `T ${since ? `(${since} draws) ` : ''}${text}`, n: 1, at: state.draws }); since = 0; } };
              const count = (name) => { const real = gl[name]; gl[name] = function (...args) { since++; return real.apply(gl, args); }; };
              for (const name of ['drawElements', 'drawElementsInstanced', 'drawArrays', 'drawArraysInstanced', 'drawRangeElements']) count(name);
              const fboOf = (target) => { const f = gl.getParameter(target === gl.READ_FRAMEBUFFER ? gl.READ_FRAMEBUFFER_BINDING : gl.DRAW_FRAMEBUFFER_BINDING); return f ? ids.get(f) ?? '?' : 0; };
              wrap('clear', (mask) => note(`clear fbo${fboOf(gl.DRAW_FRAMEBUFFER)} ${mask & gl.COLOR_BUFFER_BIT ? 'C' : ''}${mask & gl.DEPTH_BUFFER_BIT ? 'D' : ''}${mask & gl.STENCIL_BUFFER_BIT ? 'S' : ''}`));
              wrap('clearBufferfv', (buffer, index) => note(`clearBuffer fbo${fboOf(gl.DRAW_FRAMEBUFFER)} ${buffer === gl.COLOR ? `C${index}` : 'D'}`));
              wrap('clearBufferfi', () => note(`clearBuffer fbo${fboOf(gl.DRAW_FRAMEBUFFER)} DS`));
              wrap('blitFramebuffer', (...a) => note(`blit fbo${fboOf(gl.READ_FRAMEBUFFER)} -> fbo${fboOf(gl.DRAW_FRAMEBUFFER)} ${a[8] & gl.COLOR_BUFFER_BIT ? 'C' : ''}${a[8] & gl.DEPTH_BUFFER_BIT ? 'D' : ''} ${a[2]}x${a[3]}`));
              wrap('invalidateFramebuffer', (target, list) => note(`invalidate fbo${fboOf(target === gl.READ_FRAMEBUFFER ? gl.READ_FRAMEBUFFER : gl.DRAW_FRAMEBUFFER)} ${list.map((x) => (x === gl.DEPTH_ATTACHMENT || x === gl.DEPTH_STENCIL_ATTACHMENT ? 'D' : `C${x - gl.COLOR_ATTACHMENT0}`)).join('')}`));
              wrap('readBuffer', (b) => note(`readBuffer ${b === gl.NONE ? '-' : b - gl.COLOR_ATTACHMENT0}`));
            }
            const ext = gl.getExtension.bind(gl);
            gl.getExtension = (name) => { if (globalThis.__glNoMulti && /multi_draw/i.test(name)) return null; const e = ext(name); if (e && /multi_draw/i.test(name) && !e.__watched) { e.__watched = true; for (const k of Object.keys(Object.getPrototypeOf(e))) if (/^multiDraw/.test(k)) { const real = e[k]; e[k] = function (...args) { state.draws++; if (log.on) { const tag = names.get(state.program) ?? ''; if (tag) log.lines.push({ line: `${tag} MULTI fbo${state.fbo} bufs:${state.buffers} depth:${state.depthTest ? state.depthFunc : 'off'} write:${+state.depthMask} colour:${state.colorMask} a2c:${+state.a2c}`, n: 1, at: state.draws }); } return real.apply(e, args); }; } } return e; };
            return gl;
        };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/?headless&seed=${seed}`, { waitUntil: 'load', timeout: 300000 });
    await page.waitForFunction(() => window.__estellaCooked?.facts().ready, null, { timeout: 600000, polling: 1000 });
    await page.waitForFunction(() => window.__spaceHud?.ready, null, { timeout: 300000, polling: 1000 });
    await page.evaluate(() => { window.__spaceHud.foes.peace = true; });
    if (process.env.FLORA_FORCE) await page.evaluate((how) => { globalThis.__glForce = how; }, process.env.FLORA_FORCE);
    const system = await page.evaluate((k) => { for (let i = 1; i < 400; i++) if (window.__spaceHud.kindAt(i) === k) return i; return -1; }, kind);
    await page.evaluate(() => window.__estellaCooked.setPaused(true));
    const step = (n) => page.evaluate((frames) => window.__estellaCooked.step(frames), n);
    const fall = () => page.evaluate(() => { const f = window.__spaceHud.fall; return { stage: f.stage, altitude: Math.round(f.altitude), ground: Math.round(f.ground), flora: f.flora }; });
    const tap = async (key) => { await page.keyboard.down(key); await step(2); await page.keyboard.up(key); await step(2); };
    const shoot = async (name) => {
        await step(2);
        await page.screenshot({ path: path.join(out, `${name}.png`), timeout: 60000 });
        const f = await page.evaluate(() => { const f = window.__estellaCooked.facts(); return { gpuMs: +f.gpuMs.toFixed(2), draws: f.gpuDraws }; });
        shots.push({ shot: name, ...(await fall()), ...f });
    };
    const until = async (test, most) => { for (let frames = 0; frames < most; frames += 15) { if (test(await fall())) return true; await step(15); } return false; };
    await page.mouse.move(960, 540);
    await step(60);
    await tap('Digit2');
    await page.evaluate((to) => { const s = window.__spaceHud.ship; s.bound = to; s.jump = 0; s.jumps++; }, system);
    for (let frames = 0; frames < 900 && (await page.evaluate(() => window.__spaceHud.ship.jump)) >= 0; frames += 30) await step(30);
    await tap('KeyW');
    await tap('KeyP');
    if (!(await until((f) => f.stage === 'surface', 60 * 400))) problems.push('never reached the surface');
    // Down to a height over the ground, by hand: the planet is moved, as flying moves it.
    const lower = (above) => page.evaluate((h) => {
        const f = window.__spaceHud.fall, c = f.centre, d = Math.hypot(c.x, c.y, c.z);
        const k = (d - (f.altitude - h)) / d;
        f.centre = { x: c.x * k, y: c.y * k, z: c.z * k };
    }, above);
    // FLORA_CLOCK=1: how long, by the clock and with the game running as a player has it, the ground takes to fill once she is under the cloud.
    if (process.env.FLORA_CLOCK) {
        await lower(300);
        await page.evaluate(() => window.__estellaCooked.setPaused(false));
        const began = Date.now(), seen = [];
        for (let n = 0; n < 40; n++) { await page.waitForTimeout(500); if (n % 6 === 0) await lower(300); seen.push(`${((Date.now() - began) / 1000).toFixed(1)}s:${(await fall()).flora}`); }
        await page.evaluate(() => window.__estellaCooked.setPaused(true));
        problems.push(`pieces by the clock ${seen.filter((_, i) => i % 2 === 1).join(' ')}`);
    }
    await tap('KeyZ');
    await step(120);
    for (const above of [900, 320, 130]) {
        await lower(above);
        await step(240);
        await shoot(`a-${above}`);
    }
    const view = (to) => page.evaluate((v) => window.__spaceView(v), to);
    if (process.env.FLORA_QUICK) {
        await lower(72); await step(300); await lower(72);
        // Low and level, from astern and from abeam: the ground and what stands on it fill the picture, not her.
        for (const [name, to] of [['q-astern', { yaw: 0.5, pitch: 0.06, distance: 150, height: 30, along: 0 }], ['q-abeam', { yaw: 1.9, pitch: 0.03, distance: 190, height: 20, along: 0 }], ['q-high', { yaw: 2.6, pitch: 0.5, distance: 420, height: 0, along: 0 }]]) {
            await view(to); await page.evaluate(() => window.__spaceCounters?.()); await step(90);
            // FLORA_DBG: a number handed to an engine built with a switch to try (Module.esDbg), for looking for a fault in it.
            if (process.env.FLORA_DBG) { await page.evaluate((v) => { window.__spaceEngine.esDbg = v; }, Number(process.env.FLORA_DBG)); await step(20); }
            await shoot(name);
            if (process.env.FLORA_GL === 'frames' && name === 'q-astern') {
                for (let k = 0; k < 6; k++) {
                    await page.evaluate(() => { globalThis.__glLog.lines = []; globalThis.__glLog.on = true; });
                    await step(1);
                    const lines = await page.evaluate(() => { globalThis.__glLog.on = false; return globalThis.__glLog.lines; });
                    const count = (test) => lines.filter((l) => test(l.line)).reduce((n, l) => n + l.n, 0);
                    problems.push(`FRAME ${k}: foliage colour ${count((l) => /^F+ /.test(l) && /colour:1111/.test(l))} foliage depth-only ${count((l) => /^(FD)+ /.test(l))} planet colour ${count((l) => /^P+ /.test(l))} prepass ${count((l) => /colour:0000/.test(l))} lines ${lines.length}`);
                }
            }
            if (process.env.FLORA_GL && name === 'q-astern') { await page.evaluate(() => { globalThis.__glLog.lines = []; globalThis.__glLog.on = true; }); await step(1); const lines = await page.evaluate(() => { globalThis.__glLog.on = false; return globalThis.__glLog.lines; }); problems.push(...lines.map((l) => `GL @${l.at} x${l.n} ${l.line}`)); }
            if (process.env.FLORA_COUNTERS) { const all = JSON.parse(await page.evaluate(() => window.__spaceCounters?.() || '{}')); problems.push(`${name} ${JSON.stringify(Object.fromEntries(Object.entries(all).filter(([k]) => /prepass|skipped|placements/.test(k))))}`); }
        }
        throw new Error('quick');
    }
    // Flying on at that height: what is laid out ahead must stand on the ground as it comes.
    for (let n = 0; n < 4; n++) {
        for (let k = 0; k < 6; k++) { await step(60); await lower(150); }
        await shoot(`b-flying-${n}`);
    }
    await tap('Digit1');
    await step(120);
    await shoot('c-view-1');
    // On round the planet to where the ground goes under the sea, and back to the shore: the planet is turned under her a little at a time.
    const turn = (angle) => page.evaluate((a) => {
        const f = window.__spaceHud.fall, c = f.centre, cos = Math.cos(a), sin = Math.sin(a);
        f.centre = { x: c.x, y: c.y * cos - c.z * sin, z: c.y * sin + c.z * cos };
    }, angle);
    let found = false;
    let turned = 0;
    for (let n = 0; n < 500 && !found; n++) { await turn(0.004); turned += 0.004; await step(1); await lower(400); found = (await fall()).ground < -4; }
    if (!found) problems.push('no sea was found');
    await lower(260);
    await step(300);
    await shoot('d-shore-1');
    await tap('Digit2');
    await step(120);
    await shoot('d-shore-2');
    // Just out over the water, low, the eye near it: its waves, its shallows and where it breaks.
    await lower(60);
    await step(240);
    await lower(60);
    for (const [name, to] of [['d-sea-low', { yaw: 0.2, pitch: 0.07, distance: 170, height: 16, along: 0 }], ['d-sea-back', { yaw: 3.3, pitch: 0.1, distance: 190, height: 10, along: 0 }], ['d-sea-down', { yaw: 2.4, pitch: 0.6, distance: 320, height: 0, along: 0 }]]) {
        await view(to); await step(40); await shoot(name);
    }
    await tap('Digit3');
    await step(120);
    await shoot('c-view-3');
} catch (e) { if (e.message !== 'quick') throw e; } finally {
    await browser.close();
    server.close();
}
console.log(JSON.stringify({ shots, problems }, null, 1));
