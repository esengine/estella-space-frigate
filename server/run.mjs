import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = path.resolve(HERE, '..');
const ENGINE = path.resolve(GAME, '..', '..');
const argv = process.argv.slice(2);
const outfile = path.join(GAME, '.esengine', 'cache', 'sector-server.mjs');

const { build } = await import('esbuild');
await build({
    entryPoints: [path.join(HERE, 'main.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    sourcemap: true,
    logLevel: 'warning',
    alias: { 'esengine/session': path.join(ENGINE, 'sdk', 'dist', 'net', 'session', 'index.js') },
    banner: { js: "import { createRequire as __sectorRequire } from 'node:module';\nconst require = __sectorRequire(import.meta.url);" },
    nodePaths: [path.join(HERE, 'node_modules'), path.join(ENGINE, 'sdk', 'node_modules'), path.join(ENGINE, 'node_modules')].filter((p) => existsSync(p)),
});

if (argv.includes('--build-only')) {
    console.log(`sector server: built ${outfile}`);
    process.exit(0);
}
const child = spawn(process.execPath, [outfile, ...argv], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => undefined);
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
