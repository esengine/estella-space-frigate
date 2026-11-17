import { Device, TextAlign, UIVisual } from 'esengine';
import { contract } from './contract';
import { AMBER, HAZE, ICE, rgb, type Frame, type Kit, type Log } from './hudKit';
import { MINING } from './hudMining';
import { online } from './online';
import { REFITS, install, refit, refitDue, type RefitChoice } from './refit';

const ENTRY = { w: 300, h: 30, top: 168 };
const PANEL = { w: 660, h: 252, top: 300 };
const CARD = { w: 296, h: 124, top: 52, gap: 20 };
const ROW = { top: 196, h: 30, install: 360, later: 120 };
const ORDER: readonly RefitChoice[] = ['hold', 'capacitor'];

export interface RefitDesk { update(frame: Frame): void; spots: Record<string, { left: number; top: number }> }

export function buildRefit(kit: Kit, log: Log): RefitDesk {
    const { root, textures, node, sliced, solid, label, fade, place, say, ink } = kit;
    const spots: RefitDesk['spots'] = {};

    const entry = node(root, 'RefitEntry', { left: 0, top: ENTRY.top, width: ENTRY.w, height: ENTRY.h });
    const entryCap = sliced(entry, 'RefitEntryCap', { left: 0, top: 0, width: ENTRY.w, height: ENTRY.h }, textures.keycap, 9, rgb(AMBER, 0.95));
    const entryText = label(entry, 'RefitEntryText', { left: 0, top: 0, width: ENTRY.w, height: ENTRY.h - 2 }, { size: 13, color: rgb(AMBER), align: TextAlign.Center, spacing: 1.8, content: 'U   CLAIM FREE REFIT' });
    fade(entry, 0);

    const panel = node(root, 'Refit', { left: 0, top: PANEL.top, width: PANEL.w, height: PANEL.h });
    solid(panel, 'RefitBack', { left: 0, top: 0, width: PANEL.w, height: PANEL.h }, rgb(0x050a10, 0.92));
    solid(panel, 'RefitEdge', { left: 0, top: 0, width: 3, height: PANEL.h }, rgb(AMBER, 0.9));
    label(panel, 'RefitTitle', { left: 24, top: 14, width: 300, height: 22 }, { size: 16, color: rgb(ICE), spacing: 4, content: 'FREE REFIT' });
    label(panel, 'RefitRule', { left: 300, top: 16, width: PANEL.w - 324, height: 18 }, { size: 10, color: rgb(HAZE, 0.9), spacing: 1.6, align: TextAlign.Right, strong: false, content: 'CHOOSE ONE  ·  ONE REFIT A VOYAGE' });
    const cards = ORDER.map((choice, i) => {
        const x = 24 + i * (CARD.w + CARD.gap), spec = REFITS[choice];
        const cap = sliced(panel, `Refit${choice}`, { left: x, top: CARD.top, width: CARD.w, height: CARD.h }, textures.plate, 26);
        const title = label(panel, `Refit${choice}Title`, { left: x + 18, top: CARD.top + 14, width: CARD.w - 36, height: 16 }, { size: 12, color: rgb(HAZE), spacing: 2.2, content: `${spec.key}   ${spec.title}` });
        const change = label(panel, `Refit${choice}Change`, { left: x + 18, top: CARD.top + 40, width: CARD.w - 36, height: 34 }, { size: 26, color: rgb(ICE), spacing: 0.8 });
        label(panel, `Refit${choice}Gain`, { left: x + 18, top: CARD.top + 86, width: CARD.w - 36, height: 16 }, { size: 10, color: rgb(HAZE), spacing: 1.6, strong: false, content: spec.gain });
        return { choice, x, cap, title, change };
    });
    const installCap = sliced(panel, 'RefitInstall', { left: 24, top: ROW.top, width: ROW.install, height: ROW.h }, textures.keycap, 9, rgb(ICE, 0.55));
    const installText = label(panel, 'RefitInstallText', { left: 24, top: ROW.top, width: ROW.install, height: ROW.h - 2 }, { size: 12, color: rgb(HAZE), align: TextAlign.Center, spacing: 1.6 });
    const laterX = PANEL.w - ROW.later - 24;
    const laterCap = sliced(panel, 'RefitLater', { left: laterX, top: ROW.top, width: ROW.later, height: ROW.h }, textures.keycap, 9, rgb(ICE, 0.55));
    const laterText = label(panel, 'RefitLaterText', { left: laterX, top: ROW.top, width: ROW.later, height: ROW.h - 2 }, { size: 11, color: rgb(HAZE), align: TextAlign.Center, spacing: 1.4, content: 'U   LATER' });
    fade(panel, 0);

    const down: Record<string, boolean> = {};
    const struck = (frame: Frame, code: string): boolean => { const held = frame.held(code), was = down[code] === true; down[code] = held; return held && !was; };
    const inside = (p: { left: number; top: number } | null, x: number, y: number, w: number, h: number): boolean => !!p && p.left >= x && p.left <= x + w && p.top >= y && p.top <= y + h;
    const show = (on: boolean): void => {
        refit.open = on;
        if (!on) refit.picked = '';
        if (on && Device.state().pointerLocked) void Device.pointerLock(false);
    };

    const update = (frame: Frame): void => {
        const due = refitDue(contract.done) && !online.enabled;
        const u = struck(frame, 'KeyU'), enter = struck(frame, 'Enter') || struck(frame, 'NumpadEnter'), esc = struck(frame, 'Escape');
        const keyed = ORDER.find((choice) => struck(frame, REFITS[choice].code));
        if (!due) { if (refit.open) show(false); fade(entry, 0); fade(panel, 0); for (const name in spots) delete spots[name]; return; }

        const entryX = frame.across / 2 - ENTRY.w / 2;
        place(entry, entryX, ENTRY.top);
        fade(entry, refit.open ? 0 : 1);
        const beat = frame.time % 0.9 < 0.6, overEntry = !refit.open && inside(frame.pointer, entryX, ENTRY.top, ENTRY.w, ENTRY.h);
        ink(entryCap, rgb(AMBER, beat || overEntry ? 0.95 : 0.45), UIVisual);
        ink(entryText, overEntry ? rgb(ICE) : rgb(AMBER, beat ? 1 : 0.6));
        spots.entry = { left: frame.across / 2, top: ENTRY.top + ENTRY.h / 2 };
        if (!refit.open) {
            if (u) show(true);
            else if (inside(frame.click, entryX, ENTRY.top, ENTRY.w, ENTRY.h)) { show(true); frame.click = null; }
            fade(panel, refit.open ? 1 : 0);
            if (!refit.open) return;
        } else if (u || esc) { show(false); fade(panel, 0); for (const name in spots) if (name !== 'entry') delete spots[name]; return; }

        const left = frame.across / 2 - PANEL.w / 2, click = frame.click;
        place(panel, left, PANEL.top);
        fade(panel, 1);
        if (keyed) refit.picked = keyed;
        for (const card of cards) {
            const x = left + card.x, y = PANEL.top + CARD.top;
            if (inside(click, x, y, CARD.w, CARD.h)) refit.picked = card.choice;
            const lit = refit.picked === card.choice, over = inside(frame.pointer, x, y, CARD.w, CARD.h);
            say(card.change, REFITS[card.choice].change(MINING));
            ink(card.cap, lit ? rgb(AMBER) : rgb(0xffffff, over ? 1 : 0.7), UIVisual);
            ink(card.title, lit ? rgb(AMBER) : over ? rgb(ICE) : rgb(HAZE));
            ink(card.change, lit ? rgb(AMBER) : rgb(ICE));
            spots[card.choice] = { left: x + CARD.w / 2, top: y + CARD.h / 2 };
        }
        const picked = refit.picked, rowY = PANEL.top + ROW.top;
        const overInstall = picked !== '' && inside(frame.pointer, left + 24, rowY, ROW.install, ROW.h);
        say(installText, picked === '' ? 'CHOOSE A REFIT ABOVE' : `ENTER   FIT ${REFITS[picked].title}`);
        ink(installCap, picked === '' ? rgb(ICE, 0.25) : rgb(AMBER, overInstall || frame.time % 0.9 < 0.6 ? 0.95 : 0.6), UIVisual);
        ink(installText, picked === '' ? rgb(HAZE, 0.6) : overInstall ? rgb(ICE) : rgb(AMBER));
        const overLater = inside(frame.pointer, left + laterX, rowY, ROW.later, ROW.h);
        ink(laterCap, rgb(ICE, overLater ? 0.95 : 0.55), UIVisual);
        ink(laterText, overLater ? rgb(ICE) : rgb(HAZE));
        spots.install = { left: left + 24 + ROW.install / 2, top: rowY + ROW.h / 2 };
        spots.later = { left: left + laterX + ROW.later / 2, top: rowY + ROW.h / 2 };
        const confirmed = picked !== '' && (enter || inside(click, left + 24, rowY, ROW.install, ROW.h));
        if (confirmed && install(picked, MINING, frame.time)) {
            log.say(`REFIT FITTED   ${refit.result}`, AMBER);
            fade(panel, 0);
            fade(entry, 0);
            delete spots.entry;
        } else if (inside(click, left + laterX, rowY, ROW.later, ROW.h)) { show(false); fade(panel, 0); }
        if (inside(click, left, PANEL.top, PANEL.w, PANEL.h)) frame.click = null;
    };

    return { update, spots };
}
