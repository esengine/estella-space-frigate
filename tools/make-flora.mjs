// The stones that lie on a planet's ground, made from numbers. The trees and bushes beside them (assets/flora/*.esmodel) are grown
// by the engine's tree step and written by the editor's model tools, which this does not touch.
//
//   node examples/space-frigate/tools/make-flora.mjs
//
// It needs the SDK built (`node build-tools/cli.js sdk`), for the mesh format. A unit is about two metres (see PLANETFALL.unitsPerKm).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..');
const { MeshChannel, MeshChannelType, packChannels, encodeMesh } =
  await import(new URL('../../../sdk/dist/index.node.js', import.meta.url).href);

function write(rel, data) {
  const file = path.join(PROJECT, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
}

function meta(rel, type, importer = {}) {
  const file = path.join(PROJECT, `${rel}.meta`);
  const uuid = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).uuid : randomUUID();
  write(`${rel}.meta`, `${JSON.stringify({ uuid, version: '2.0', type, importer }, null, 2)}\n`);
}

const hash = (x, y, s) => {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(s, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

function shape() {
  const pos = [], uv = [], nrm = [], idx = [];
  const vert = (p, n, u, v) => { pos.push(...p); nrm.push(...n); uv.push(u, v); return pos.length / 3 - 1; };
  return { pos, uv, nrm, idx, vert };
}

function save(name, s) {
  const { channels, vertexStride } = packChannels([
    { semantic: MeshChannel.Position, components: 3, type: MeshChannelType.Float32 },
    { semantic: MeshChannel.TexCoord0, components: 2, type: MeshChannelType.Float32 },
    { semantic: MeshChannel.Color, components: 4, type: MeshChannelType.UNorm8 },
    { semantic: MeshChannel.Normal, components: 3, type: MeshChannelType.Float32 },
  ]);
  const count = s.pos.length / 3;
  const vertices = new Uint8Array(count * vertexStride);
  const view = new DataView(vertices.buffer);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    const at = i * vertexStride;
    const n = [s.nrm[i * 3], s.nrm[i * 3 + 1], s.nrm[i * 3 + 2]], len = Math.hypot(...n) || 1;
    for (let k = 0; k < 3; k++) {
      view.setFloat32(at + channels[0].offset + k * 4, s.pos[i * 3 + k], true);
      view.setFloat32(at + channels[3].offset + k * 4, n[k] / len, true);
      min[k] = Math.min(min[k], s.pos[i * 3 + k]);
      max[k] = Math.max(max[k], s.pos[i * 3 + k]);
    }
    view.setFloat32(at + channels[1].offset, s.uv[i * 2], true);
    view.setFloat32(at + channels[1].offset + 4, s.uv[i * 2 + 1], true);
    view.setUint32(at + channels[2].offset, 0xffffffff, true);
  }
  write(`assets/flora/${name}.esmesh`, Buffer.from(encodeMesh({ channels, vertexStride, vertexCount: count, vertices, indices: new Uint32Array(s.idx), aabbMin: min, aabbMax: max })));
  meta(`assets/flora/${name}.esmesh`, 'mesh');
  return { name, triangles: s.idx.length / 3, height: +(max[1] - min[1]).toFixed(1), width: +(Math.max(max[0] - min[0], max[2] - min[2])).toFixed(1) };
}

/** A stone: a ball of flat faces pushed in and out, squat, its foot under the ground. */
function stone() {
  const s = shape();
  const sides = 7, rings = 4, grid = [];
  for (let j = 0; j <= rings; j++) {
    const row = [], lat = -Math.PI / 2 + (j / rings) * Math.PI;
    for (let k = 0; k < sides; k++) {
      const lon = (k / sides) * Math.PI * 2 + (j % 2) * (Math.PI / sides);
      const push = j === 0 || j === rings ? 0.85 : 0.72 + 0.5 * hash(k, j, 41);
      row.push([Math.cos(lat) * Math.sin(lon) * 2.2 * push, Math.sin(lat) * 1.5 * push + 0.7, Math.cos(lat) * Math.cos(lon) * 2.0 * push]);
    }
    grid.push(row);
  }
  const face = (a, b, c) => {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const len = Math.hypot(...n);
    if (len < 1e-9) return;
    const i = s.vert(a, n, 0.5, 0.5); s.vert(b, n, 0.5, 0.5); s.vert(c, n, 0.5, 0.5);
    s.idx.push(i, i + 1, i + 2);
  };
  for (let j = 0; j < rings; j++) for (let k = 0; k < sides; k++) {
    const a = grid[j][k], b = grid[j][(k + 1) % sides], c = grid[j + 1][k], d = grid[j + 1][(k + 1) % sides];
    if (j > 0) face(a, b, c);
    if (j < rings - 1) face(b, d, c);
  }
  return save('stone', s);
}

function material(name, properties) {
  const rel = `assets/flora/${name}.esmaterial`;
  write(rel, `${JSON.stringify({ version: '1.0', type: 'material', shader: 'builtin:foliage', blendMode: 0, depthTest: true, depthWrite: true, cull: 0, properties }, null, 2)}\n`);
  meta(rel, 'material');
}


material('stone', {
  u_baseColor: { r: 0.2, g: 0.19, b: 0.18, a: 1 }, u_tipColor: { r: 0.5, g: 0.48, b: 0.45, a: 1 },
  u_windStrength: 0, u_flutter: 0, u_translucency: 0, u_roughness: 0.95,
});
console.log(JSON.stringify(stone()));
