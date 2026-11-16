import { Assets, GetWorld, Name, Res, SceneManager, Time, defineSystem, loadWork } from 'esengine';
import type { App, Entity } from 'esengine';
import { AMBER, DESIGN, FONTS, HAZE, ICE, createKit, rgb, type Textures } from './hudKit';

const BAR = { width: 560, height: 2 };
const NAMES: Record<string, string> = { stage: 'CLEARING MOORINGS', frigate: 'HULL PLATING', gate: 'JUMP GATE', raider: 'CONTACT PROFILES', turret: 'TURRETS', guns: 'BATTERIES' };
const SHADE_SECONDS = 0.25;
const LIFT_SECONDS = 0.5;
const SETTLED_FRAMES = 12;
const STAGED_SHARE = 0.96;

export const loading = { share: 0, done: false, cover: false, error: '' };

type Phase = 'working' | 'shading' | 'switching' | 'settling' | 'lifting' | 'gone';

export function installLoading(app: App): void {
    const pendingShaders = (): number => (app as unknown as { wasmModule?: { renderer_getPendingShaders?: () => number } }).wasmModule?.renderer_getPendingShaders?.() ?? 0;
    let fonts: { regular: number; strong: number } | null = null;
    let asked = false, baked = false, staged = false, target = 0, subject = '';
    let phase: Phase = 'working', clock = 0, quiet = 0;
    let screen: { canvas: Entity; update(dt: number): void; shade(amount: number): void; lift(amount: number): void } | null = null;

    app.addSystem(defineSystem([GetWorld(), Res(Time), Res(SceneManager)], (world, time, scenes) => {
        if (phase === 'gone') return;
        const booting = world.findEntityByName('BootCamera') !== null;
        if (!booting && phase === 'working') return;
        const dt = Math.min(time.delta, 0.05);
        if (!asked) {
            asked = true;
            loading.cover = true;
            const assets = app.getResource(Assets);
            void Promise.all([assets.loadFont(FONTS.regular), assets.loadFont(FONTS.strong)]).then(([regular, strong]) => { fonts = { regular: regular.handle, strong: strong.handle }; });
            loadWork().run((progress) => {
                target = progress.total > 0 ? STAGED_SHARE * progress.done / progress.total : STAGED_SHARE;
                subject = progress.label;
            }).then(() => { baked = true; }, (error: unknown) => { loading.error = error instanceof Error ? error.message : String(error); });
            void scenes.prepare('main').then(() => scenes.readyRenderPrograms('main')).then(() => { staged = true; }, () => { staged = true; });
        }
        if (fonts && !screen) {
            const kit = createKit(world, {} as Textures, fonts);
            const canvas = world.findEntityByName('Hud')!;
            world.insert(canvas, Name, { value: 'Loading' });
            const shade = kit.solid(kit.root, 'LoadingShade', { left: 0, top: 0, right: 0, bottom: 0 }, rgb(0x000000));
            kit.fade(shade, 0);
            const centre = kit.pivot(kit.root, 'LoadingPivot', { left: DESIGN.width / 2, top: DESIGN.height / 2 + 150 });
            kit.label(centre, 'LoadingShip', { left: -BAR.width / 2, top: -86, width: BAR.width, height: 34 }, { size: 30, color: rgb(ICE), spacing: 9, content: 'ESV HALCYON' });
            kit.label(centre, 'LoadingClass', { left: -BAR.width / 2, top: -48, width: BAR.width, height: 16 }, { size: 11, color: rgb(HAZE, 0.9), spacing: 2.6, content: 'MERIDIAN CLASS FRIGATE', strong: false });
            kit.solid(centre, 'LoadingTrack', { left: -BAR.width / 2, top: 0, width: BAR.width, height: BAR.height }, rgb(HAZE, 0.22));
            const bar = kit.solid(centre, 'LoadingBar', { left: -BAR.width / 2, top: 0, width: 0, height: BAR.height }, rgb(ICE));
            const head = kit.glow(kit.solid(centre, 'LoadingHead', { left: -BAR.width / 2, top: -2, width: 26, height: BAR.height + 4 }, rgb(AMBER, 0.9)));
            const status = kit.label(centre, 'LoadingStatus', { left: -BAR.width / 2, top: 14, width: BAR.width - 80, height: 16 }, { size: 11, color: rgb(HAZE, 0.9), spacing: 2.2, strong: false });
            const percent = kit.label(centre, 'LoadingPercent', { left: BAR.width / 2 - 80, top: 14, width: 80, height: 16 }, { size: 11, color: rgb(ICE), spacing: 2.2, content: '0 %' });
            let breath = 0;
            screen = {
                canvas,
                shade: (amount) => kit.fade(shade, amount),
                lift: (amount) => kit.fade(kit.root, 1 - amount),
                update(step) {
                    loading.share += (target - loading.share) * Math.min(1, step * 5);
                    breath += step;
                    const across = BAR.width * loading.share;
                    kit.size(bar, across, BAR.height);
                    kit.place(head, -BAR.width / 2 + Math.max(0, across - 26), -2);
                    kit.fade(head, loading.share >= 0.999 ? 0 : 0.55 + 0.45 * Math.sin(breath * 5));
                    kit.say(percent, `${Math.round(loading.share * 100)} %`);
                    kit.say(status, loading.error ? 'FITTING OUT FAILED' : loading.share >= 0.999 ? 'READY TO GET UNDER WAY' : `FITTING OUT  ·  ${NAMES[subject] ?? (subject.startsWith('rock') ? 'ASTEROID FIELD' : 'SYSTEMS')}`);
                },
            };
        }
        if (!screen) return;
        clock += dt;
        if (phase === 'working' && baked && staged) { phase = 'shading'; clock = 0; subject = 'stage'; }
        if (phase === 'shading') {
            screen.shade(clock / SHADE_SECONDS);
            if (clock >= SHADE_SECONDS) {
                phase = 'switching';
                void scenes.switchTo('main').then(() => { phase = 'settling'; quiet = 0; }, (error: unknown) => { loading.error = error instanceof Error ? error.message : String(error); });
            }
        }
        if (phase === 'settling') {
            quiet = pendingShaders() === 0 ? quiet + 1 : 0;
            if (quiet >= SETTLED_FRAMES) { phase = 'lifting'; clock = 0; target = 1; loading.share = 1; }
        }
        screen.update(dt);
        if (phase === 'lifting') {
            screen.lift(clock / LIFT_SECONDS);
            if (clock >= LIFT_SECONDS) {
                world.despawn(screen.canvas);
                screen = null;
                phase = 'gone';
                loading.done = true;
                loading.cover = false;
            }
        }
    }));
}
