import { Device, Material, MeshRenderer, Quality, TextAlign, UIVisual } from 'esengine';
import type { App, QualityController, QualityLevel, QualityMode, QualityPreferences } from 'esengine';
import { AMBER, EDGE, HAZE, ICE, rgb, type Frame, type Kit } from './hudKit';

const STORE = 'space-frigate:graphics';
const PANEL = { w: 560, row: 36, top: 70 };
const LABEL_W = 210;
const BUTTON = { w: 104, h: 24 };
const OPENER = { right: EDGE + 170, top: 34 };
const LOOKS = ['bloom', 'sharpen', 'filmGrain', 'vignette'] as const;

type Look = typeof LOOKS[number];

interface Choices {
    mode: QualityMode;
    renderScale?: number;
    antialiasing?: QualityPreferences['antialiasing'];
    ssao?: boolean;
    off: Look[];
}

interface Option { caption: string; pick(c: Choices): void; on(c: Choices): boolean }
interface Row { title: string; options: Option[] }

const read = (): Choices => {
    try {
        const raw = JSON.parse(globalThis.localStorage?.getItem(STORE) ?? 'null') as Partial<Choices> | null;
        if (raw && typeof raw === 'object') return { mode: raw.mode ?? 'auto', renderScale: raw.renderScale, antialiasing: raw.antialiasing, ssao: raw.ssao, off: (raw.off ?? []).filter((l): l is Look => (LOOKS as readonly string[]).includes(l)) };
    } catch {
        void 0;
    }
    return { mode: 'auto', off: [] };
};

const keep = (c: Choices): void => {
    try {
        globalThis.localStorage?.setItem(STORE, JSON.stringify(c));
    } catch {
        void 0;
    }
};

const applyChoices = (q: QualityController, c: Choices): void => {
    q.setMode(c.mode);
    q.setPreferences({
        ...(c.renderScale !== undefined ? { renderScale: c.renderScale } : {}),
        ...(c.antialiasing !== undefined ? { antialiasing: c.antialiasing } : {}),
        ...(c.ssao !== undefined ? { ssao: c.ssao } : {}),
        skipEffects: [...c.off],
    });
};

export function applyStoredGraphics(app: App): void {
    const q = app.getResource(Quality);
    if (q) applyChoices(q, read());
}

const FINISH = ['u_clearcoat', 'u_detailSize'] as const;

const RESCAN_FRAMES = 30;

const finisher = (app: App): ((plain: boolean) => number) => {
    const authored = new Map<number, [string, number][]>();
    let current: boolean | null = null, trimmed = 0, since = RESCAN_FRAMES;
    const set = (material: number, plain: boolean): void => {
        for (const [name, value] of authored.get(material) ?? []) Material.setUniform(material, name, plain ? 0 : value);
    };
    return (plain) => {
        const changed = plain !== current;
        if (!changed && (!plain || ++since < RESCAN_FRAMES)) return trimmed;
        since = 0;
        for (const e of app.world.getEntitiesWithComponents([MeshRenderer])) {
            const material = app.world.get(e, MeshRenderer).material;
            if (!material || authored.has(material)) continue;
            authored.set(material, FINISH.flatMap((name) => {
                const value = Material.getUniform(material, name);
                return typeof value === 'number' && value > 0 ? [[name, value] as [string, number]] : [];
            }));
            if (!changed && plain) set(material, true);
        }
        if (changed) for (const material of authored.keys()) set(material, plain);
        current = plain;
        trimmed = plain ? [...authored.values()].reduce((sum, layers) => sum + layers.length, 0) : 0;
        return trimmed;
    };
};

const look = (name: Look): Option[] => [
    { caption: 'ON', pick: (c) => { c.off = c.off.filter((l) => l !== name); }, on: (c) => !c.off.includes(name) },
    { caption: 'OFF', pick: (c) => { if (!c.off.includes(name)) c.off.push(name); }, on: (c) => c.off.includes(name) },
];

const ROWS: Row[] = [
    { title: 'QUALITY', options: (['auto', 'low', 'medium', 'high'] as const).map((mode) => ({ caption: mode.toUpperCase(), pick: (c) => { c.mode = mode; }, on: (c) => c.mode === mode })) },
    {
        title: 'RESOLUTION', options: [undefined, 0.5, 0.75, 1].map((scale) => ({
            caption: scale === undefined ? 'AUTO' : `${Math.round(scale * 100)} %`, pick: (c) => { c.renderScale = scale; }, on: (c) => c.renderScale === scale,
        })),
    },
    {
        title: 'ANTI-ALIASING', options: ([undefined, 'off', 'msaa', 'temporal'] as const).map((aa) => ({
            caption: aa === undefined ? 'AUTO' : aa === 'temporal' ? 'TAA' : aa.toUpperCase(), pick: (c) => { c.antialiasing = aa; }, on: (c) => c.antialiasing === aa,
        })),
    },
    {
        title: 'AMBIENT OCCLUSION', options: ([undefined, true, false] as const).map((on) => ({
            caption: on === undefined ? 'AUTO' : on ? 'ON' : 'OFF', pick: (c) => { c.ssao = on; }, on: (c) => c.ssao === on,
        })),
    },
    { title: 'BLOOM', options: look('bloom') },
    { title: 'SHARPEN', options: look('sharpen') },
    { title: 'FILM GRAIN', options: look('filmGrain') },
    { title: 'VIGNETTE', options: look('vignette') },
];

export const graphics = { open: false, level: '', scale: 1, msaa: 1, antialiasing: '', ssao: false, skipped: [] as readonly string[], trimmed: 0 };
(globalThis as { __spaceGraphics?: typeof graphics }).__spaceGraphics = graphics;

const LEVEL_NAMES: Record<QualityLevel, string> = { low: 'LOW', medium: 'MEDIUM', high: 'HIGH' };

export function buildSettings(app: App, kit: Kit): (frame: Frame) => void {
    const { root, node, sliced, solid, label, fade, place, say, ink } = kit;
    const textures = kit.textures;
    const choices = read();
    const quality = () => app.getResource(Quality);
    const finish = finisher(app);
    const apply = (): void => {
        const q = quality();
        if (q) applyChoices(q, choices);
    };
    apply();

    const opener = node(root, 'SettingsOpen', { right: OPENER.right, top: OPENER.top, width: BUTTON.w, height: BUTTON.h });
    const openerCap = sliced(opener, 'SettingsOpenCap', { left: 0, top: 0, width: BUTTON.w, height: BUTTON.h }, textures.keycap, 9, rgb(ICE, 0.55));
    const openerText = label(opener, 'SettingsOpenText', { left: 0, top: 0, width: BUTTON.w, height: BUTTON.h - 2 }, { size: 10, color: rgb(HAZE), align: TextAlign.Center, spacing: 1.4, content: 'SETTINGS' });

    const height = PANEL.row * (ROWS.length + 2) + 24;
    const panel = node(root, 'Settings', { left: 0, top: PANEL.top, width: PANEL.w, height });
    solid(panel, 'SettingsBack', { left: 0, top: 0, width: PANEL.w, height }, rgb(0x050a10, 0.92));
    solid(panel, 'SettingsEdge', { left: 0, top: 0, width: 3, height }, rgb(ICE, 0.9));
    label(panel, 'SettingsTitle', { left: 24, top: 14, width: 260, height: 22 }, { size: 16, color: rgb(ICE), spacing: 4, content: 'GRAPHICS' });
    const status = label(panel, 'SettingsStatus', { left: 260, top: 16, width: PANEL.w - 284, height: 18 }, { size: 10, color: rgb(HAZE, 0.9), spacing: 1.6, align: TextAlign.Right, strong: false });
    const cells: { row: number; index: number; x: number; y: number; w: number; cap: ReturnType<typeof sliced>; text: ReturnType<typeof label> }[] = [];
    ROWS.forEach((row, r) => {
        const y = PANEL.row * (r + 1) + 12;
        label(panel, `Settings${r}Title`, { left: 24, top: y, width: LABEL_W, height: BUTTON.h }, { size: 11, color: rgb(HAZE), spacing: 2, content: row.title, strong: false });
        const w = Math.min(BUTTON.w, (PANEL.w - LABEL_W - 48 - (row.options.length - 1) * 6) / row.options.length);
        row.options.forEach((option, i) => {
            const x = LABEL_W + 24 + i * (w + 6);
            const cap = sliced(panel, `Settings${r}_${i}`, { left: x, top: y, width: w, height: BUTTON.h }, textures.keycap, 9, rgb(ICE, 0.55));
            const text = label(panel, `Settings${r}_${i}Text`, { left: x, top: y, width: w, height: BUTTON.h - 2 }, { size: 10, color: rgb(HAZE), align: TextAlign.Center, spacing: 1.2, content: option.caption });
            cells.push({ row: r, index: i, x, y, w, cap, text });
        });
    });
    const closeY = PANEL.row * (ROWS.length + 1) + 18;
    const closeCap = sliced(panel, 'SettingsClose', { left: PANEL.w - BUTTON.w - 24, top: closeY, width: BUTTON.w, height: BUTTON.h }, textures.keycap, 9, rgb(ICE, 0.55));
    const closeText = label(panel, 'SettingsCloseText', { left: PANEL.w - BUTTON.w - 24, top: closeY, width: BUTTON.w, height: BUTTON.h - 2 }, { size: 10, color: rgb(HAZE), align: TextAlign.Center, spacing: 1.4, content: 'CLOSE' });
    fade(panel, 0);

    let open = false, escape = false, key = false;
    const inside = (p: { left: number; top: number } | null, x: number, y: number, w: number, h: number): boolean => !!p && p.left >= x && p.left <= x + w && p.top >= y && p.top <= y + h;
    const show = (on: boolean): void => {
        open = on;
        graphics.open = on;
        fade(panel, on ? 1 : 0);
        if (on && Device.state().pointerLocked) void Device.pointerLock(false);
    };

    return (frame) => {
        const q = quality();
        if (q) {
            const p = q.profile;
            graphics.level = q.report().level;
            graphics.scale = q.renderScale;
            graphics.msaa = p.msaaSamples;
            graphics.antialiasing = p.antialiasing;
            graphics.ssao = p.ssao;
            graphics.skipped = p.skipEffects;
            graphics.trimmed = finish(graphics.level === 'low');
        }
        const openerX = frame.across - OPENER.right - BUTTON.w;
        const overOpener = inside(frame.pointer, openerX, OPENER.top, BUTTON.w, BUTTON.h);
        ink(openerCap, open ? rgb(AMBER, 0.95) : rgb(ICE, overOpener ? 0.95 : 0.55), UIVisual);
        ink(openerText, open ? rgb(AMBER) : overOpener ? rgb(ICE) : rgb(HAZE));
        if (frame.click && inside(frame.click, openerX, OPENER.top, BUTTON.w, BUTTON.h)) { show(!open); frame.click = null; }
        const esc = frame.held('Escape'), o = frame.held('KeyO');
        if (esc && !escape && open) show(false);
        if (o && !key) show(!open);
        escape = esc;
        key = o;
        if (!open) return;
        const left = (frame.across - PANEL.w) / 2;
        place(panel, left, PANEL.top);
        say(status, q ? `${LEVEL_NAMES[q.report().level]} LEVEL  ·  ${Math.round(q.renderScale * 100)} % PIXELS` : '');
        const click = frame.click;
        for (const cell of cells) {
            const option = ROWS[cell.row]!.options[cell.index]!;
            const over = inside(frame.pointer, left + cell.x, PANEL.top + cell.y, cell.w, BUTTON.h);
            if (click && inside(click, left + cell.x, PANEL.top + cell.y, cell.w, BUTTON.h)) {
                option.pick(choices);
                keep(choices);
                apply();
            }
            const lit = option.on(choices);
            ink(cell.cap, lit ? rgb(AMBER, 0.95) : rgb(ICE, over ? 0.95 : 0.55), UIVisual);
            ink(cell.text, lit ? rgb(AMBER) : over ? rgb(ICE) : rgb(HAZE));
        }
        const closeX = left + PANEL.w - BUTTON.w - 24;
        const overClose = inside(frame.pointer, closeX, PANEL.top + closeY, BUTTON.w, BUTTON.h);
        ink(closeCap, rgb(ICE, overClose ? 0.95 : 0.55), UIVisual);
        ink(closeText, overClose ? rgb(ICE) : rgb(HAZE));
        if (click && inside(click, closeX, PANEL.top + closeY, BUTTON.w, BUTTON.h)) show(false);
        frame.click = null;
    };
}
