# Space Frigate

Made with the [Estella engine](https://github.com/esengine/estella).

![Cruising, turning on thrusters, a gate transit, mining and gunnery](docs/demo.gif)

A frigate on patrol off a gas giant: fly her, mine asteroids, fight with five turrets, and jump through gates. Every model, texture, sound and the whole HUD is generated from recipes. There are no hand-painted textures and no models from an outside tool.

## Controls

| Key | Action |
| --- | --- |
| `W` / `S` | Engine order up / down |
| `A` / `D` | Rudder, one step at a time |
| `Q` / `E` | Pitch down / up, one step at a time |
| `X` | Rudder and pitch to neutral (she holds her attitude) |
| `Z` | Come level |
| `T` / `R` | Lock next target / release |
| `F` | Mining beam (cruise mode) |
| `V` / `B` | Autopilot: close on target / align to gate |
| `G` | Combat mode on / off |
| `Space` | Fire in combat mode (twice for a salvo, hold to keep firing); toggle the camera tour in cruise mode |
| `C` | Auto fire on the locked target (combat mode) |
| Drag | Look around; aim in combat mode |
| Wheel, `1`–`6` | Zoom, camera presets |
| `M` | Music |

Every action also has a button on screen, so it plays on a phone.

## Run it

This repository is the game only. It mounts at `examples/space-frigate` inside an Estella checkout; see the engine's README for building the engine. Then, from the engine root:

```bash
node pipeline/bin/estella.mjs export examples/space-frigate --out output/space-frigate/web --no-aot
```

Tests, from this folder:

```bash
node ../../sdk/node_modules/vitest/vitest.mjs run
```

Assets are regenerated from their recipes with `python3 tools/generate.py`.

## License

[Apache-2.0](LICENSE). The piano samples are CC0 and the Chakra Petch font is under the SIL Open Font License; each carries its own licence file.
