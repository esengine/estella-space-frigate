# The ground's four pictures, made from numbers: what a planet's layers are drawn with (grass, soil, snow, rock), grey and tiling,
# since the planet's own colours tint them (a layer's colour is a world's, its grain is not).
#   python examples/space-frigate/tools/make-ground.py
import json, pathlib, uuid
import numpy as np
from PIL import Image

OUT = pathlib.Path(__file__).resolve().parent.parent / 'assets' / 'ground'
SIZE = 256


def noise(cells, seed):
    """Value noise that repeats over the picture: `cells` lattice points a side, smoothly joined."""
    rng = np.random.default_rng(seed)
    lattice = rng.random((cells, cells))
    t = np.arange(SIZE) * cells / SIZE
    i = np.floor(t).astype(int)
    f = t - i
    f = f * f * f * (f * (f * 6 - 15) + 10)
    a, b = i % cells, (i + 1) % cells
    top = lattice[np.ix_(a, a)] * (1 - f)[None, :] + lattice[np.ix_(a, b)] * f[None, :]
    bottom = lattice[np.ix_(b, a)] * (1 - f)[None, :] + lattice[np.ix_(b, b)] * f[None, :]
    return top * (1 - f)[:, None] + bottom * f[:, None]


def fbm(cells, octaves, seed, gain=0.5):
    total, amp, norm = np.zeros((SIZE, SIZE)), 1.0, 0.0
    for o in range(octaves):
        total += amp * noise(min(cells * 2 ** o, SIZE), seed + o * 17)
        norm += amp
        amp *= gain
    return total / norm


def ridged(cells, octaves, seed):
    total, amp, norm = np.zeros((SIZE, SIZE)), 1.0, 0.0
    for o in range(octaves):
        total += amp * (1 - np.abs(noise(min(cells * 2 ** o, SIZE), seed + o * 31) * 2 - 1)) ** 2
        norm += amp
        amp *= 0.5
    return total / norm


def write(name, grey, tile, roughness):
    # About its own middle and held near white, so a layer's colour is what the ground reads as and this is its grain.
    grey = (grey - grey.mean()) / (grey.std() + 1e-9)
    img = np.clip(0.78 + 0.11 * grey, 0.35, 1.0)
    picture = OUT / f'{name}.png'
    Image.fromarray((img * 255).astype(np.uint8), 'L').save(picture, optimize=True)
    for path, kind, importer in ((picture, 'texture', {'wrapMode': 'repeat'}), (OUT / f'{name}.esterrainlayer', 'terrain-layer', {})):
        meta = pathlib.Path(str(path) + '.meta')
        known = json.loads(meta.read_text(encoding='utf-8'))['uuid'] if meta.exists() else str(uuid.uuid4())
        meta.write_text(json.dumps({'uuid': known, 'version': '2.0', 'type': kind, 'importer': importer}, indent=2) + '\n', encoding='utf-8')
    (OUT / f'{name}.esterrainlayer').write_text(json.dumps({
        'albedo': f'assets/ground/{name}.png', 'tile': tile, 'tint': [1, 1, 1], 'roughness': roughness, 'normalStrength': 1, 'heightBlend': 0.2,
    }, indent=2) + '\n', encoding='utf-8')
    print(name, picture.stat().st_size, 'bytes')


OUT.mkdir(parents=True, exist_ok=True)
# Grass: a fine grain of blades, and only a little of anything broad: what is broad in a picture is what the eye finds
# repeating across a plain, and the planet has a wander in brightness of its own for that.
write('grass', 0.18 * fbm(6, 3, 1) + 0.6 * fbm(40, 2, 5) + 0.4 * noise(128, 9), 90, 0.95)
# Soil and scree: coarser, with stones as bright specks.
soil = 0.3 * fbm(8, 3, 21) + 0.7 * fbm(36, 3, 23)
write('soil', soil + 0.5 * np.clip(noise(64, 27) - 0.72, 0, 1) * 4, 90, 0.9)
# Snow: almost even, with long soft drifts.
write('snow', 0.8 * fbm(3, 3, 41) + 0.2 * fbm(24, 2, 45), 160, 0.6)
# Rock: beds and cracks.
write('rock', 0.7 * ridged(5, 5, 61) + 0.5 * fbm(4, 4, 67) - 0.6 * np.clip(ridged(9, 3, 71) - 0.8, 0, 1) * 5, 120, 0.85)
