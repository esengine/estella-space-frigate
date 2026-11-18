// The trees as the game draws them, made from the trees the editor's model tools wrote. A tree is grown by the engine's tree step
// (model_write, a `tree` step: a trunk that forks into limbs, leaves as cut-out tufts on them, bark laid along every limb; and a
// second model, `-far`, a stem and the outline of its crown in a couple of hundred triangles) and written by the editor under
// assets/, from where its .esmodel, .esmesh and leaf picture are moved to flora-src/, which does not ship. Then:
//   node examples/space-frigate/tools/flora-meshes.mjs
// A forest is thousands of trees, drawn as instances: one mesh a kind and a record a tree, the tree near the eye, the cheaper
// one further off, and past that two crossed cards merged a square of ground at a time. What the editor writes is made into
// those three meshes, one picture and one material:
// - The foliage material draws them all (it sways them, cuts the leaves out, and takes a world's own colour). It reads a
//   vertex's colour as how far up the plant it is and how lit, not as a colour, so each mesh's colours are written as that, and
//   the colour a vertex had goes into the picture: the bark strip in the bark's colour, the sprig in the leaves', and two solid
//   patches in its blank corner, one of each, which the cheaper tree (it has no picture of its own) is pointed at.
// - A second set of texture coordinates, which nothing here reads and which has a mesh drawn as lightmapped, is taken off.
// - The picture ships as it is, with the mips the GPU makes: a tuft far off is read from a small mip whose alpha is the average
//   of leaf and gap, under the cut-off, and the whole crown was cut away. (The engine keeps a cut-out's coverage down its mips
//   only for a compressed texture.) So the cut-off is low enough that a far tuft stays.
// - The light a leaf lets through whitened the whole view under this game's sun whenever a wood was in it: there is none.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'flora-src'), OUT = path.join(ROOT, 'assets/flora');
const CUTOFF = 0.15;
// The picture: its bark strip is the top, down to this share of its height, and the sprig is under it. Its top right corner is
// blank and solid: the left half of that is made the leaves' colour and the right half the bark's.
const BARK_ROWS = 0.14, CORNER = 0.74, CORNER_SPLIT = 0.87;
const LEAF_PATCH = [0.8, 0.95], BARK_PATCH = [0.94, 0.95];
// The part of the picture a card shows: the sprig.
const SPRIG = { u0: 0.16, v0: 0.08, u1: 0.84, v1: 0.76 };
const LEAVES_ONLY = new Set(['bush']);
const POINTED = new Set(['pine']);
const { decodeMesh, encodeMesh, packChannels, MeshChannel, MeshChannelType } = await import(new URL('../../../sdk/dist/index.node.js', import.meta.url).href);
const { PNG } = createRequire(path.resolve(HERE, '../../../pipeline/package.json'))('pngjs');

function meta(file, type, importer = {}) {
  if (!existsSync(`${file}.meta`)) writeFileSync(`${file}.meta`, `${JSON.stringify({ uuid: randomUUID(), version: '2.0', type, importer }, null, 2)}\n`);
}

/** Whether a vertex of a grown tree is leaf (greener than red) and not bark. */
const leafAt = (m, colour, v) => m.vertices[v * m.vertexStride + colour.offset + 1] > m.vertices[v * m.vertexStride + colour.offset];

function coloursOf(m) {
  const c = m.channels.find((x) => x.semantic === MeshChannel.Color);
  const sum = { leaf: [0, 0, 0, 0], bark: [0, 0, 0, 0] };
  for (let v = 0; v < m.vertexCount; v++) {
    const at = v * m.vertexStride + c.offset, to = sum[leafAt(m, c, v) ? 'leaf' : 'bark'];
    for (let j = 0; j < 3; j++) to[j] += m.vertices[at + j] / 255;
    to[3]++;
  }
  const mean = (s) => s.slice(0, 3).map((x) => x / Math.max(s[3], 1));
  return { leaf: mean(sum.leaf), bark: mean(sum.bark) };
}

/**
 * A grown mesh as the foliage material draws it: no second coordinates, a colour that says how far up the plant a vertex is
 * (red) and that it is fully lit (blue), and, for a tree with no picture of its own (`solid`), every vertex pointed at the
 * patch of its kind.
 */
function prepared(m, solid, which) {
  const colour = m.channels.find((c) => c.semantic === MeshChannel.Color), position = m.channels.find((c) => c.semantic === MeshChannel.Position);
  let indices = m.indices;
  if (which) {
    // Its leaves and its bark are two meshes: a world tints its leaves its own colour, and its bark is left the colour bark is.
    const kept = [];
    for (let t = 0; t < indices.length; t += 3) if (leafAt(m, colour, indices[t]) === (which === 'leaf')) kept.push(indices[t], indices[t + 1], indices[t + 2]);
    indices = new Uint32Array(kept);
  }
  const keep = m.channels.filter((c) => c.semantic !== MeshChannel.TexCoord1);
  const { channels, vertexStride } = packChannels(keep.map((c) => ({ semantic: c.semantic, components: c.components, type: c.type })));
  const vertices = new Uint8Array(m.vertexCount * vertexStride), view = new DataView(vertices.buffer), from = new DataView(m.vertices.buffer, m.vertices.byteOffset);
  const uv = channels.find((c) => c.semantic === MeshChannel.TexCoord0), to = channels.find((c) => c.semantic === MeshChannel.Color);
  const low = m.aabbMin[1], span = Math.max(m.aabbMax[1] - low, 1e-6);
  for (let v = 0; v < m.vertexCount; v++) {
    keep.forEach((c, i) => vertices.set(m.vertices.subarray(v * m.vertexStride + c.offset, v * m.vertexStride + c.offset + (c.type === 0 ? 4 : 1) * c.components), v * vertexStride + channels[i].offset));
    const up = Math.min(Math.max((from.getFloat32(v * m.vertexStride + position.offset + 4, true) - low) / span, 0), 1);
    const at = v * vertexStride + to.offset;
    vertices[at] = Math.round(up * 255); vertices[at + 1] = 128; vertices[at + 2] = 255; vertices[at + 3] = 255;
    if (solid) {
      const patch = leafAt(m, colour, v) ? LEAF_PATCH : BARK_PATCH;
      view.setFloat32(v * vertexStride + uv.offset, patch[0], true); view.setFloat32(v * vertexStride + uv.offset + 4, patch[1], true);
    }
  }
  return { ...m, channels, vertexStride, vertices, indices };
}

/**
 * What stands for a tree past where it is drawn whole: three cards showing its sprig, two upright and crossed and one lying flat
 * through the crown, so it is leaves from the side and from above (she is flown over it more often than past it). A conifer's
 * upright cards come to a point.
 */
function cards(m, pointed, which) {
  const { channels, vertexStride } = packChannels([
    { semantic: MeshChannel.Position, components: 3, type: MeshChannelType.Float32 },
    { semantic: MeshChannel.TexCoord0, components: 2, type: MeshChannelType.Float32 },
    { semantic: MeshChannel.Color, components: 4, type: MeshChannelType.UNorm8 },
    { semantic: MeshChannel.Normal, components: 3, type: MeshChannelType.Float32 },
  ]);
  const half = Math.max(m.aabbMax[0] - m.aabbMin[0], m.aabbMax[2] - m.aabbMin[2]) / 2, top = m.aabbMax[1];
  // The crown fills the cards: its foot is where the leaves begin, a third of the way up a tree and the ground for a bush.
  const foot = top > half * 1.2 ? top * 0.3 : 0;
  const points = [], indices = [];
  const point = (x, y, z, u, v, up) => { points.push([x, y, z, u, v, up]); return points.length - 1; };
  const mid = (SPRIG.u0 + SPRIG.u1) / 2;
  if (which === 'leaf') for (const [dx, dz] of [[1, 0], [0, 1]]) {
    const a = point(-dx * half, foot, -dz * half, SPRIG.u0, SPRIG.v0, 0.35), b = point(dx * half, foot, dz * half, SPRIG.u1, SPRIG.v0, 0.35);
    if (pointed) { indices.push(a, b, point(0, top, 0, mid, SPRIG.v1, 1)); continue; }
    const c = point(dx * half, top, dz * half, SPRIG.u1, SPRIG.v1, 1), d = point(-dx * half, top, -dz * half, SPRIG.u0, SPRIG.v1, 1);
    indices.push(a, b, c, a, c, d);
  }
  // Its trunk, as two narrow cards in the bark's colour, from under the ground to where the leaves begin. Without it a crown
  // far off hangs in the air; and it goes down past the foot because the ground far off is drawn coarser than it is, and lower
  // on a ridge than where the tree was stood.
  if (which === 'bark') {
    const girth = Math.max(half * 0.09, top * 0.035), under = -top * 0.3;
    for (const [dx, dz] of [[1, 0], [0, 1]]) {
      const a = point(-dx * girth, under, -dz * girth, BARK_PATCH[0], BARK_PATCH[1], 0.2), b = point(dx * girth, under, dz * girth, BARK_PATCH[0], BARK_PATCH[1], 0.2);
      const c = point(dx * girth, foot * 1.25, dz * girth, BARK_PATCH[0], BARK_PATCH[1], 0.45), d = point(-dx * girth, foot * 1.25, -dz * girth, BARK_PATCH[0], BARK_PATCH[1], 0.45);
      indices.push(a, b, c, a, c, d);
    }
  }
  const flat = half * (pointed ? 0.62 : 0.92), at = foot + (top - foot) * (pointed ? 0.3 : 0.55);
  if (which === 'leaf') {
  const e = point(-flat, at, -flat, SPRIG.u0, SPRIG.v0, 0.8), f = point(flat, at, -flat, SPRIG.u1, SPRIG.v0, 0.8), g = point(flat, at, flat, SPRIG.u1, SPRIG.v1, 0.8), h = point(-flat, at, flat, SPRIG.u0, SPRIG.v1, 0.8);
  indices.push(e, g, f, e, h, g);
  }
  const vertices = new Uint8Array(points.length * vertexStride), view = new DataView(vertices.buffer);
  points.forEach(([x, y, z, u, v, up], n) => {
    const o = n * vertexStride;
    view.setFloat32(o + channels[0].offset, x, true); view.setFloat32(o + channels[0].offset + 4, y, true); view.setFloat32(o + channels[0].offset + 8, z, true);
    view.setFloat32(o + channels[1].offset, u, true); view.setFloat32(o + channels[1].offset + 4, v, true);
    vertices[o + channels[2].offset] = Math.round(up * 255); vertices[o + channels[2].offset + 1] = 128; vertices[o + channels[2].offset + 2] = 255; vertices[o + channels[2].offset + 3] = 255;
    // Lit as a rounded thing, from above: a card lit by its own normal is bright on one side and a dark slab on the other.
    view.setFloat32(o + channels[3].offset + 4, 1, true);
  });
  return { channels, vertexStride, vertexCount: points.length, vertices, indices: new Uint32Array(indices), aabbMin: [-half, which === 'bark' ? -top * 0.3 : foot, -half], aabbMax: [half, which === 'bark' ? foot * 1.25 : top, half] };
}

/**
 * A tree's leaves from further off: one tuft in every `n` of the tree's own, each made `grow` times as large about its middle,
 * so the crown keeps its outline and its tufts keep their size against the tree. (Three cards the size of the whole crown
 * showed one tuft's picture as large as the tree: leaves the size of a ship's turret.)
 */
function thinned(m, n, grow) {
  const position = m.channels.find((c) => c.semantic === MeshChannel.Position), stride = m.vertexStride;
  const view = new DataView(m.vertices.buffer, m.vertices.byteOffset);
  // A tuft is the triangles that share vertices.
  const tuft = Array.from({ length: m.vertexCount }, (_, i) => i);
  const find = (i) => { while (tuft[i] !== i) { tuft[i] = tuft[tuft[i]]; i = tuft[i]; } return i; };
  for (let t = 0; t < m.indices.length; t += 3) { const a = find(m.indices[t]); tuft[find(m.indices[t + 1])] = a; tuft[find(m.indices[t + 2])] = a; }
  const used = new Set(m.indices), roots = [...new Set([...used].map(find))].sort((a, b) => a - b);
  const kept = new Set(roots.filter((_, i) => i % n === 0));
  const middle = new Map();
  for (const v of used) {
    const r = find(v);
    if (!kept.has(r)) continue;
    const at = middle.get(r) ?? [0, 0, 0, 0];
    for (let j = 0; j < 3; j++) at[j] += view.getFloat32(v * stride + position.offset + j * 4, true);
    at[3]++; middle.set(r, at);
  }
  const renumber = new Map(), bytes = [];
  for (const v of [...used].sort((a, b) => a - b)) {
    const r = find(v);
    if (!kept.has(r)) continue;
    renumber.set(v, renumber.size);
    const one = m.vertices.slice(v * stride, (v + 1) * stride), out = new DataView(one.buffer), c = middle.get(r);
    for (let j = 0; j < 3; j++) { const mid = c[j] / c[3]; out.setFloat32(position.offset + j * 4, mid + (view.getFloat32(v * stride + position.offset + j * 4, true) - mid) * grow, true); }
    bytes.push(one);
  }
  const vertices = new Uint8Array(bytes.length * stride);
  bytes.forEach((b, i) => vertices.set(b, i * stride));
  const indices = [];
  for (let t = 0; t < m.indices.length; t += 3) if (kept.has(find(m.indices[t]))) indices.push(renumber.get(m.indices[t]), renumber.get(m.indices[t + 1]), renumber.get(m.indices[t + 2]));
  return { ...m, vertexCount: bytes.length, vertices, indices: new Uint32Array(indices) };
}

const toLinear = (v) => (v / 255) ** 2.2, toByte = (x) => Math.round(255 * Math.min(Math.max(x, 0), 1) ** (1 / 2.2));
const write = (name, mesh) => { const file = path.join(OUT, `${name}.esmesh`); writeFileSync(file, Buffer.from(encodeMesh(mesh))); meta(file, 'mesh'); };

for (const file of readdirSync(SRC).filter((f) => f.endsWith('.esmesh') && !f.endsWith('-far.esmesh')).sort()) {
  const name = file.slice(0, -'.esmesh'.length);
  const grown = decodeMesh(new Uint8Array(readFileSync(path.join(SRC, file)))), far = decodeMesh(new Uint8Array(readFileSync(path.join(SRC, `${name}-far.esmesh`))));
  const colours = coloursOf(grown);
  const near = prepared(grown, false, 'leaf');
  write(name, near);
  // Past where the tree is drawn whole, a fifth of its tufts; and merged a square of ground at a time out to the horizon, a twelfth.
  write(`${name}-card`, thinned(near, 5, 1.8));
  write(`${name}-far`, thinned(near, 12, 2.7));
  if (!LEAVES_ONLY.has(name)) {
    write(`${name}-bark`, prepared(grown, false, 'bark'));
    write(`${name}-card-bark`, cards(grown, POINTED.has(name), 'bark'));
  }

  // The picture in the tree's colours. Its sprig is lit from the middle out as the leaves were, so the grey it had is kept as shade.
  const grey = PNG.sync.read(readFileSync(path.join(SRC, `${name}_leaves.png`)));
  const out = new PNG({ width: grey.width, height: grey.height });
  for (let y = 0; y < grey.height; y++) for (let x = 0; x < grey.width; x++) {
    const at = (y * grey.width + x) * 4, u = x / grey.width, bark = y < grey.height * BARK_ROWS;
    const corner = bark && u >= CORNER;
    const tint = corner ? (u < CORNER_SPLIT ? colours.leaf : colours.bark) : bark ? colours.bark : colours.leaf;
    // The patches are flat: the mean of the leaves, a little dark, as a crown seen whole is.
    for (let j = 0; j < 3; j++) out.data[at + j] = toByte(corner ? tint[j] * (u < CORNER_SPLIT ? 0.6 : 0.8) : toLinear(grey.data[at + j]) * tint[j]);
    out.data[at + 3] = corner ? 255 : grey.data[at + 3];
  }
  const picture = path.join(OUT, `${name}.png`);
  writeFileSync(picture, PNG.sync.write(out));
  meta(picture, 'texture');

  const material = path.join(OUT, `${name}.esmaterial`);
  writeFileSync(material, `${JSON.stringify({
    version: '1.0', type: 'material', shader: 'builtin:foliage', blendMode: 0, depthTest: true, depthWrite: true, cull: 0,
    properties: {
      u_albedo: `assets/flora/${name}.png`, u_useTexture: 1, u_alphaCutoff: CUTOFF,
      // Darker at the foot than at the top, as a tree standing among others is.
      u_baseColor: { r: 0.62, g: 0.62, b: 0.62, a: 1 }, u_tipColor: { r: 1.12, g: 1.12, b: 1.12, a: 1 },
      u_windStrength: 0.3, u_windSpeed: 0.8, u_windDirection: 30, u_gustScale: 0.004, u_flutter: 0.04, u_translucency: 0, u_roughness: 0.9,
    },
  }, null, 2)}\n`);
  meta(material, 'material');
  if (!LEAVES_ONLY.has(name)) {
    // The bark's own material: the same picture and the same sway, so stem and crown move as one, and no world's tint.
    const bark = path.join(OUT, `${name}-bark.esmaterial`);
    writeFileSync(bark, `${JSON.stringify({
      version: '1.0', type: 'material', shader: 'builtin:foliage', blendMode: 0, depthTest: true, depthWrite: true, cull: 0,
      properties: {
        u_albedo: `assets/flora/${name}.png`, u_useTexture: 1, u_alphaCutoff: CUTOFF,
        u_baseColor: { r: 0.7, g: 0.7, b: 0.7, a: 1 }, u_tipColor: { r: 1, g: 1, b: 1, a: 1 },
        u_windStrength: 0.3, u_windSpeed: 0.8, u_windDirection: 30, u_gustScale: 0.004, u_flutter: 0.04, u_translucency: 0, u_roughness: 0.95,
      },
    }, null, 2)}\n`);
    meta(bark, 'material');
  }
  void far;
  console.log(name, near.indices.length / 3, 'triangles');
}

// ── what covers the ground ─────────────────────────────────────────────────────────────────────────────────────────────
// Grass and flowers, as she sees them from a hundred metres up: not a blade or a bloom but a patch of them. A patch is a card a
// unit across lying on the ground (the rules size it and lean it with the slope) with a few short cards standing in it, showing a
// picture of blades or of blooms (tools/make-ground.py) cut out by its alpha, so the ground shows between them.
function cover(name, picture, { standing, tall, cutoff, wind }) {
  const { channels, vertexStride } = packChannels([
    { semantic: MeshChannel.Position, components: 3, type: MeshChannelType.Float32 },
    { semantic: MeshChannel.TexCoord0, components: 2, type: MeshChannelType.Float32 },
    { semantic: MeshChannel.Color, components: 4, type: MeshChannelType.UNorm8 },
    { semantic: MeshChannel.Normal, components: 3, type: MeshChannelType.Float32 },
  ]);
  const points = [], indices = [];
  const point = (x, y, z, u, v, up) => { points.push([x, y, z, u, v, up]); return points.length - 1; };
  // The carpet: just clear of the ground, so it is not lost in it where the ground rolls.
  const lift = 0.03;
  const a = point(-0.5, lift, -0.5, 0, 0, 0.7), b = point(0.5, lift, -0.5, 1, 0, 0.7), c = point(0.5, lift, 0.5, 1, 1, 0.7), d = point(-0.5, lift, 0.5, 0, 1, 0.7);
  indices.push(a, c, b, a, d, c);
  // What stands in it: short cards at angles to each other, each a strip of the picture.
  for (let k = 0; k < standing; k++) {
    const turn = (k / standing) * Math.PI + 0.4, cx = 0.3 * Math.cos(k * 2.4), cz = 0.3 * Math.sin(k * 2.4), dx = Math.cos(turn) * 0.34, dz = Math.sin(turn) * 0.34;
    const u0 = (k % 2) * 0.5, u1 = u0 + 0.5;
    const e = point(cx - dx, 0, cz - dz, u0, 0, 0), f = point(cx + dx, 0, cz + dz, u1, 0, 0), g = point(cx + dx, tall, cz + dz, u1, 0.5, 1), h = point(cx - dx, tall, cz - dz, u0, 0.5, 1);
    indices.push(e, f, g, e, g, h);
  }
  const vertices = new Uint8Array(points.length * vertexStride), view = new DataView(vertices.buffer);
  points.forEach(([x, y, z, u, v, up], n) => {
    const o = n * vertexStride;
    view.setFloat32(o + channels[0].offset, x, true); view.setFloat32(o + channels[0].offset + 4, y, true); view.setFloat32(o + channels[0].offset + 8, z, true);
    view.setFloat32(o + channels[1].offset, u, true); view.setFloat32(o + channels[1].offset + 4, v, true);
    vertices[o + channels[2].offset] = Math.round(up * 255); vertices[o + channels[2].offset + 1] = 128; vertices[o + channels[2].offset + 2] = 255; vertices[o + channels[2].offset + 3] = 255;
    view.setFloat32(o + channels[3].offset + 4, 1, true);
  });
  write(name, { channels, vertexStride, vertexCount: points.length, vertices, indices: new Uint32Array(indices), aabbMin: [-0.5, 0, -0.5], aabbMax: [0.5, Math.max(tall, lift), 0.5] });
  const material = path.join(OUT, `${name}.esmaterial`);
  writeFileSync(material, `${JSON.stringify({
    version: '1.0', type: 'material', shader: 'builtin:foliage', blendMode: 0, depthTest: true, depthWrite: true, cull: 0,
    properties: {
      u_albedo: `assets/flora/${picture}.png`, u_useTexture: 1, u_alphaCutoff: cutoff,
      u_baseColor: { r: 0.8, g: 0.8, b: 0.8, a: 1 }, u_tipColor: { r: 1.1, g: 1.1, b: 1.1, a: 1 },
      u_windStrength: wind, u_windSpeed: 1.1, u_windDirection: 30, u_gustScale: 0.01, u_flutter: 0.08, u_translucency: 0, u_roughness: 0.95,
    },
  }, null, 2)}\n`);
  meta(material, 'material');
  console.log(name, indices.length / 3, 'triangles');
}
cover('sward', 'blades', { standing: 9, tall: 0.2, cutoff: 0.3, wind: 0.5 });
cover('meadow', 'blooms', { standing: 6, tall: 0.12, cutoff: 0.3, wind: 0.4 });
