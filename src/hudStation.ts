import { TextAlign, UIVisual } from 'esengine';
import { AMBER, HAZE, ICE, rgb, type Frame, type Kit, type Log } from './hudKit';
import { moveOre, online, pressDock } from './online';
import { GRAMS, tonnage } from './shared/sector';

const PANEL = { w: 620, h: 196, top: 176 };
const BUTTON = { w: 180, h: 30, top: 146 };
const SHOWN = 8;

export interface StationDesk { update(frame: Frame): void; spots: Record<string, { left: number; top: number }>; said: { text: string; good: boolean } }

/**
 * The station's side of the glass: docking, and the pilot's own warehouse while she is docked. Everything it shows is the
 * server's word: the two tonnages, whether she is docked, and above all that ore has moved, which is said only when the
 * server has answered that it did.
 */
export function buildStation(kit: Kit, log: Log): StationDesk {
    const { root, textures, node, sliced, solid, label, fade, place, say, ink } = kit;
    const spots: StationDesk['spots'] = {};
    const said = { text: '', good: false };
    if (!online.enabled) return { update: () => undefined, spots, said };

    const panel = node(root, 'Station', { left: 0, top: PANEL.top, width: PANEL.w, height: PANEL.h });
    solid(panel, 'StationBack', { left: 0, top: 0, width: PANEL.w, height: PANEL.h }, rgb(0x050a10, 0.92));
    solid(panel, 'StationEdge', { left: 0, top: 0, width: 3, height: PANEL.h }, rgb(AMBER, 0.9));
    const title = label(panel, 'StationTitle', { left: 24, top: 14, width: 360, height: 22 }, { size: 16, color: rgb(ICE), spacing: 4 });
    label(panel, 'StationRule', { left: 300, top: 16, width: PANEL.w - 324, height: 18 }, { size: 10, color: rgb(HAZE, 0.9), spacing: 1.6, align: TextAlign.Right, strong: false, content: 'DOCKED  ·  YOUR WAREHOUSE' });
    label(panel, 'StationHoldTitle', { left: 24, top: 52, width: 260, height: 14 }, { size: 10, color: rgb(HAZE), spacing: 2.6, content: 'IN YOUR HOLD' });
    const hold = label(panel, 'StationHold', { left: 24, top: 70, width: 260, height: 34 }, { size: 28, color: rgb(ICE), spacing: 0.8 });
    label(panel, 'StationStoreTitle', { left: 336, top: 52, width: 260, height: 14 }, { size: 10, color: rgb(HAZE), spacing: 2.6, content: 'IN YOUR WAREHOUSE', align: TextAlign.Right });
    const store = label(panel, 'StationStore', { left: 336, top: 70, width: 260, height: 34 }, { size: 28, color: rgb(ICE), spacing: 0.8, align: TextAlign.Right });
    const status = label(panel, 'StationStatus', { left: 24, top: 114, width: PANEL.w - 48, height: 18 }, { size: 12, color: rgb(HAZE), spacing: 1.4, align: TextAlign.Center });
    const buttons = [
        { name: 'store', x: 24, key: 'KeyJ' },
        { name: 'take', x: 24 + BUTTON.w + 16, key: 'KeyK' },
        { name: 'leave', x: PANEL.w - BUTTON.w - 24, key: 'KeyH' },
    ].map((b) => ({
        ...b,
        cap: sliced(panel, `Station${b.name}`, { left: b.x, top: BUTTON.top, width: BUTTON.w, height: BUTTON.h }, textures.keycap, 9, rgb(ICE, 0.55)),
        text: label(panel, `Station${b.name}Text`, { left: b.x, top: BUTTON.top, width: BUTTON.w, height: BUTTON.h - 2 }, { size: 11, color: rgb(HAZE), align: TextAlign.Center, spacing: 1.4 }),
    }));
    fade(panel, 0);

    const down: Record<string, boolean> = {};
    const struck = (frame: Frame, code: string): boolean => { const held = frame.held(code), was = down[code] === true; down[code] = held; return held && !was; };
    const inside = (p: { left: number; top: number } | null, x: number, y: number, w: number, h: number): boolean => !!p && p.left >= x && p.left <= x + w && p.top >= y && p.top <= y + h;
    let answered = '', refusedAt = 0, told = 'none0', was: string = 'none';

    const update = (frame: Frame): void => {
        const keys = { store: struck(frame, 'KeyJ'), take: struck(frame, 'KeyK'), leave: struck(frame, 'KeyH') };
        const move = online.move, now = Date.now();
        // What the server said of the last order, once, in the log: a success here is one it has written down.
        if (move.op !== '' && move.state !== 'pending' && move.state !== '' && answered !== move.op) {
            answered = move.op;
            if (move.state === 'done') log.say(`${move.withdraw ? 'TAKEN FROM' : 'STORED IN'} THE WAREHOUSE   ${tonnage(move.grams)} T`, AMBER);
            else log.say(`STATION REFUSED   ${move.why}`, AMBER);
        }
        if (online.dock.at !== refusedAt) { refusedAt = online.dock.at; if (online.dock.why) log.say(`THE ANCHORAGE SAYS   ${online.dock.why}`, AMBER); }
        if (told !== `${online.mooring}${online.berth}`) {
            told = `${online.mooring}${online.berth}`;
            if (online.mooring === 'assigned') log.say(`BERTH ${online.berth} IS KEPT FOR YOU`, AMBER);
            else if (online.mooring === 'docking') log.say(`THE ANCHORAGE HAS HER   BERTH ${online.berth}`, AMBER);
            else if (online.mooring === 'docked') log.say(`DOCKED IN BERTH ${online.berth}   WAREHOUSE OPEN`, AMBER);
            else if (online.mooring === 'undocking') log.say(`CAST OFF FROM BERTH ${online.berth}   WAREHOUSE SHUT`, AMBER);
            else if (was !== 'none') log.say(was === 'undocking' ? 'CLEAR OF THE ANCHORAGE   THE HELM IS YOURS' : 'BERTH GIVEN UP', AMBER);
            was = online.mooring;
        }

        const linked = online.link === 'online';
        if (!online.docked || !linked) {
            fade(panel, 0);
            for (const name in spots) delete spots[name];
            if (keys.leave && linked) pressDock();
            said.text = '';
            return;
        }
        const left = frame.across / 2 - PANEL.w / 2, top = PANEL.top;
        place(panel, left, top);
        fade(panel, 1);
        say(title, `${online.station.name}   BERTH ${online.berth}`);
        say(hold, `${tonnage(online.cargo)} T`);
        say(store, `${tonnage(online.stored)} T`);
        const pending = move.state === 'pending', fresh = now - move.at < SHOWN * 1000;
        const taking = Math.min(online.stored, 1 * GRAMS, online.capacity - online.cargo);
        const can = { store: !pending && online.cargo > 0, take: !pending && taking > 0, leave: !pending };
        const captions = { store: 'J   STORE ALL', take: taking >= GRAMS || taking <= 0 ? 'K   TAKE 1 T' : `K   TAKE ${tonnage(taking)} T`, leave: 'H   CAST OFF' };
        const click = frame.click;
        for (const b of buttons) {
            const name = b.name as keyof typeof can, x = left + b.x, y = top + BUTTON.top;
            const over = can[name] && inside(frame.pointer, x, y, BUTTON.w, BUTTON.h);
            const cued = name === 'store' && can.store && frame.time % 0.8 < 0.5;
            say(b.text, captions[name]);
            ink(b.cap, !can[name] ? rgb(ICE, 0.2) : cued ? rgb(AMBER, 0.95) : rgb(ICE, over ? 0.95 : 0.55), UIVisual);
            ink(b.text, !can[name] ? rgb(HAZE, 0.5) : cued ? rgb(AMBER) : over ? rgb(ICE) : rgb(HAZE));
            spots[b.name] = { left: x + BUTTON.w / 2, top: y + BUTTON.h / 2 };
            if (!can[name] || !(keys[name] || inside(click, x, y, BUTTON.w, BUTTON.h))) continue;
            if (name === 'store') moveOre(false, online.cargo);
            else if (name === 'take') moveOre(true, taking);
            else pressDock();
        }
        if (inside(click, left, top, PANEL.w, PANEL.h)) frame.click = null;
        // The status line never runs ahead of the server: an order out is "waiting", and only its answer is a result.
        if (pending && move.why === 'NOT SAVED') { said.text = 'THE STATION COULD NOT RECORD IT   NOTHING MOVED   TRYING AGAIN'; said.good = false; }
        else if (pending) { said.text = `${move.withdraw ? 'TAKING' : 'STORING'} ${tonnage(move.grams)} T   WAITING FOR THE STATION`; said.good = false; }
        else if (move.state === 'done' && fresh) { said.text = `${move.withdraw ? 'TAKEN' : 'STORED'} ${tonnage(move.grams)} T   WAREHOUSE NOW ${tonnage(move.stored)} T   HOLD ${tonnage(move.cargo)} T`; said.good = true; }
        else if (move.state === 'refused' && fresh) { said.text = move.why === 'EXPIRED' ? 'THAT ORDER IS TOO OLD TO ANSWER   IT WAS NOT DONE AGAIN' : `REFUSED   ${move.why}`; said.good = false; }
        else { said.text = online.cargo > 0 ? 'PRESS J TO STORE WHAT IS IN YOUR HOLD' : 'YOUR HOLD IS EMPTY   PRESS H TO CAST OFF'; said.good = false; }
        say(status, said.text);
        ink(status, pending ? rgb(AMBER, 0.6 + 0.4 * Math.sin(frame.time * 8)) : said.good ? rgb(ICE) : move.state === 'refused' && fresh ? rgb(AMBER) : rgb(HAZE));
    };

    return { update, spots, said };
}
