# Space Frigate

Made with the [Estella engine](https://github.com/esengine/estella).

**[Play it in your browser](https://esengine.github.io/estella-space-frigate/)**, or download the whole game as [one 3.4 MB HTML file](https://github.com/esengine/estella-space-frigate/releases/latest). It needs a desktop browser with WebGL2; the first launch bakes the models on your graphics card, which takes about half a minute.

![Cruising, turning on thrusters, mining, gunnery, and a jump through a gate to a ringed planet](docs/demo.gif)

A frigate on patrol: fly her, mine asteroids, fight off raiders with five turrets, and jump through gates from one star system to the next: a banded gas giant, a ringed ice giant and a rust-red desert world. Rocks are solid: running into one costs shield, then hull, and knocks both of you off course. Once you take the helm, raiders arrive in waves and make firing passes; lock one with `T`, face it with `L`, and shoot it down. Every model, texture, sound and the whole HUD is generated from recipes. There are no hand-painted textures and no models from an outside tool.

## Controls

| Key | Action |
| --- | --- |
| `W` / `S` | Engine order up / down |
| `A` / `D` | Rudder, one step at a time |
| `Q` / `E` | Pitch down / up, one step at a time |
| `X` | Rudder and pitch to neutral (she holds her attitude) |
| `Z` | Come level |
| `T` / `R` | Lock next target (raiders first) / release |
| `F` | Mining beam (cruise mode) |
| `V` / `B` | Autopilot: close on target / align to gate (flying through a gate jumps to the next system) |
| `G` | Combat mode on / off |
| `Space` | Fire in combat mode (twice for a salvo, hold to keep firing); toggle the camera tour in cruise mode |
| `C` | Auto fire on the locked target (combat mode) |
| `L` | Swing the view to the locked target |
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
