// The trees as the game draws them, made from the trees the editor's model tools wrote. A tree is grown by the engine's tree step
// (model_write, a `tree` step: a trunk that forks into limbs, leaves as cut-out tufts on them, bark laid along every limb) and
// written by the editor under assets/, from where its .esmodel, .esmesh and leaf picture are moved to flora-src/, which does not
// ship. Then:
//   node examples/space-frigate/tools/flora-meshes.mjs
// What the editor writes is not what a wood on a planet can be drawn with, in four ways, each found by looking:
// - A tree is coloured at its vertices and its picture is grey (a strip of bark, a sprig of leaves). A wood is drawn merged, a
//   square of ground at a time, by the foliage material, which keeps a plant's height and its place in the wind where a mesh has
//   its colours. So the colour is put in the picture: the bark strip in the bark's colour and the sprig in the leaves'.
// - The model material the editor gives a tree drew white here whatever it was tinted, and the light it lets through a leaf
//   whitened the whole view under this game's sun; the foliage material takes its place, with little let through.
// - A second set of texture coordinates, which nothing here reads and which has a mesh drawn as lightmapped, is taken off.
// - The picture ships as it is, with the mips the GPU makes: a tuft far off is read from a small mip whose alpha is the average of
//   leaf and gap, under the cut-off, and the whole crown was cut away. (The engine keeps a cut-out's coverage down its mips only
//   for a compressed texture.) So the cut-off is low enough that a far tuft stays.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'flora-src'), OUT = path.join(ROOT, 'assets/flora');
const CUTOFF = 0.15;
// The bark strip is the top of the picture, down to this share of its height; the sprig is under it.
const BARK_ROWS = 0.14;
const LEAVES_ONLY = new Set(['bush']);
const { decodeMesh, encodeMesh, packChannels, MeshChannel } = await import(new URL('../../../sdk/dist/index.node.js', import.meta.url).href);
const { PNG } = createRequire(path.resolve(HERE, '../../../pipeline/package.json'))('pngjs');

function meta(file, type, importer = {}) {
  if (!existsSync(`${file}.meta`)) writeFileSync(`${file}.meta`, `${JSON.stringify({ uuid: randomUUID(), version: '2.0', type, importer }, null, 2)}\n`);
}

/** The mean colour (linear, 0 to 1) of the mesh's leaf vertices (greener than red) and of the rest. */
function coloursOf(m) {
  const c = m.channels.find((x) => x.semantic === MeshChannel.Color);
  const sum = { leaf: [0, 0, 0, 0], bark: [0, 0, 0, 0] };
  for (let v = 0; v < m.vertexCount; v++) {
    const at = v * m.vertexStride + c.offset, to = sum[m.vertices[at + 1] > m.vertices[at] ? 'leaf' : 'bark'];
    for (let j = 0; j < 3; j++) to[j] += m.vertices[at + j] / 255;
    to[3]++;
  }
  const mean = (s) => s.slice(0, 3).map((x) => x / Math.max(s[3], 1));
  return { leaf: mean(sum.leaf), bark: mean(sum.bark) };
}

const toLinear = (v) => (v / 255) ** 2.2, toByte = (x) => Math.round(255 * Math.min(Math.max(x, 0), 1) ** (1 / 2.2));

for (const file of readdirSync(SRC).filter((f) => f.endsWith('.esmesh') && !f.endsWith('-far.esmesh')).sort()) {
  const name = file.slice(0, -'.esmesh'.length);
  const m = decodeMesh(new Uint8Array(readFileSync(path.join(SRC, file))));
  const colours = coloursOf(m);
  // A bush is its leaves: its twigs are a thousand triangles nobody sees under them.
  if (LEAVES_ONLY.has(name)) {
    const c = m.channels.find((x) => x.semantic === MeshChannel.Color), leaf = (v) => m.vertices[v * m.vertexStride + c.offset + 1] > m.vertices[v * m.vertexStride + c.offset];
    const kept = [];
    for (let t = 0; t < m.indices.length; t += 3) if (leaf(m.indices[t])) kept.push(m.indices[t], m.indices[t + 1], m.indices[t + 2]);
    m.indices = new Uint32Array(kept);
  }
  const keep = m.channels.filter((c) => c.semantic !== MeshChannel.TexCoord1);
  const { channels, vertexStride } = packChannels(keep.map((c) => ({ semantic: c.semantic, components: c.components, type: c.type })));
  const vertices = new Uint8Array(m.vertexCount * vertexStride);
  for (let v = 0; v < m.vertexCount; v++) keep.forEach((c, i) => {
    vertices.set(m.vertices.subarray(v * m.vertexStride + c.offset, v * m.vertexStride + c.offset + (c.type === 0 ? 4 : 1) * c.components), v * vertexStride + channels[i].offset);
  });
  const mesh = path.join(OUT, `${name}.esmesh`);
  writeFileSync(mesh, Buffer.from(encodeMesh({ ...m, channels, vertexStride, vertices })));
  meta(mesh, 'mesh');

  // The picture in the tree's colours. Its sprig is lit from the middle out as the leaves were, so the grey it had is kept as shade.
  const grey = PNG.sync.read(readFileSync(path.join(SRC, `${name}_leaves.png`)));
  const out = new PNG({ width: grey.width, height: grey.height });
  for (let y = 0; y < grey.height; y++) for (let x = 0; x < grey.width; x++) {
    const at = (y * grey.width + x) * 4, tint = y < grey.height * BARK_ROWS ? colours.bark : colours.leaf;
    for (let j = 0; j < 3; j++) out.data[at + j] = toByte(toLinear(grey.data[at + j]) * tint[j]);
    out.data[at + 3] = grey.data[at + 3];
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
  console.log(name, m.indices.length / 3, 'triangles', JSON.stringify({ leaf: colours.leaf.map((x) => +x.toFixed(3)), bark: colours.bark.map((x) => +x.toFixed(3)) }));
}
