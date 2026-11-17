import net from 'node:net';

// A slow link to try the sector on by hand: every byte to and from the server is passed on, in order, late.
//
//   node tools/slow-link.mjs [--listen 8091] [--to 8090] [--delay 100]
//
// `--delay` is each way, in milliseconds: 100 is 200 ms there and back. Point the game at the listening port
// (?server=ws://127.0.0.1:8091/sector) and the sector server keeps its own.
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback; };
const listen = arg('listen', 8091), to = arg('to', 8090), delay = arg('delay', 100);

const relay = net.createServer((client) => {
    const upstream = net.connect(to, '127.0.0.1');
    const late = (from, into) => {
        const waiting = [];
        from.on('data', (chunk) => { waiting.push(chunk); setTimeout(() => { const next = waiting.shift(); if (!into.destroyed) into.write(next); }, delay); });
        from.on('close', () => setTimeout(() => into.destroy(), delay));
        from.on('error', () => into.destroy());
    };
    late(client, upstream);
    late(upstream, client);
});
relay.listen(listen, '127.0.0.1', () => console.log(`[slow-link] 127.0.0.1:${listen} -> 127.0.0.1:${to}, ${delay} ms each way (${delay * 2} ms there and back)`));
