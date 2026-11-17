# Space Frigate

Made with the [Estella engine](https://github.com/esengine/estella).

**[Play it in your browser](https://esengine.github.io/estella-space-frigate/)**, or download the whole game as [one 3.4 MB HTML file](https://github.com/esengine/estella-space-frigate/releases/latest). It needs a desktop browser with WebGL2; the first launch bakes the models on your graphics card, which takes about half a minute.

![Cruising, turning on thrusters, mining, gunnery, and a jump through a gate to a ringed planet](docs/demo.gif)

A frigate on patrol: fly her, mine asteroids, fight off raiders with five turrets, and jump through gates from one star system to the next: a banded gas giant, a ringed ice giant and a rust-red desert world. Rocks are solid: running into one costs shield, then hull, and knocks both of you off course. Once you take the helm, raiders arrive in waves and make firing passes; lock one with `T`, face it with `L`, and shoot it down. She sails with a first contract: mine 10 tonnes of ore and deliver it to the gate. The panel at the top of the glass keeps the tonnage aboard and delivered and names the next key to press, the key's button blinks, and the gate's marker lights up once the ore is aboard. Every model, texture, sound and the whole HUD is generated from recipes. There are no hand-painted textures and no models from an outside tool.

## Controls

| Key | Action |
| --- | --- |
| `W` / `S` | Engine order up / down |
| `A` / `D` | Rudder, one step at a time |
| `Q` / `E` | Pitch down / up, one step at a time |
| `X` | Rudder and pitch to neutral (she holds her attitude) |
| `Z` | Come level |
| Click | Lock what you click on; on a desktop, a click on open space takes the mouse to look around (`Esc` gives the cursor back) |
| `T` / `R` | Lock next target (raiders first) / release |
| `F` | Mining beam (cruise mode) |
| `V` / `B` | Autopilot: close on target / align to gate (flying through a gate jumps to the next system) |
| `C` | Fire at will on / off (on from the start): raiders are locked as they come in range, and the turrets train on the locked raider and fire by themselves |
| `G` | Combat mode on / off: the gun camera, to aim and fire by hand |
| `Space` | Fire in combat mode (twice for a salvo, hold to keep firing); toggle the camera tour in cruise mode |
| `L` | Swing the view to the locked target |
| Drag | Look around (a phone, or a desktop without the mouse taken); aim in combat mode |
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

## Two pilots, one sector

A sector server flies every ship and keeps one rock of ten tonnes, what each pilot has mined from it, and a station with a warehouse for each of them: mine, carry, dock, store. It is the engine's session host (`esengine/session`) behind a WebSocket, speaking the messages in `proto/sector.proto` as protobuf.

- **The server flies.** A client sends the helm's orders (engine, rudder, elevation, roll), numbered a step at a time, and nothing else: there is no request that says where a ship is. The server flies one order a step, thirty steps a second by its own clock, with the rules in `src/shared/steer.ts`: the drive follows its order and the hull follows the drive, the thrusters turn her no faster than they can push, and her speed has a top. The game offline flies by the same file.
- **The helm still answers at once.** The client flies its own orders as it sends them (`src/shared/predict.ts`), and when the server's word comes it is taken as the truth and the orders it has not flown yet are flown again on top of it. What is left over is eased in, not jumped to. The other pilot's ship is drawn where her last report puts her now, carried on by the way she was making.
- **The server pays.** Ore is paid by the server's clock to a pilot it has signed in, who is asking, where the server has flown her within reach of the rock, until the rock is empty.
- **The station decides who is docked.** It stands 2 300 units from the rock, further than a beam reaches, so ore comes to it in a hold. A ship docks when the server has flown her within 300 units of it and she is making 80 m/s or less; docked, she is held and her helm does nothing until she casts off. Nothing a client says about being near, slow or docked is read.
- **A warehouse is its pilot's own.** An order moves ore between the sender's hold and the sender's warehouse, and has no field for anyone else's. It is refused, as a value, unless she is docked and the amount is whole grams she has. Each order carries a name of its own: asked again under that name it is answered as it was and moves nothing.
- **Told it moved, it moved.** The move, the new balances and the order's name are written to disk in one piece before the reply goes out. A server stopped before, during or after that write comes back with the whole move or none of it, and the client's retry is then done once or answered as done. The rock, every hold and every warehouse always add up to the ten tonnes.
- **A sector is founded on purpose.** The first start needs `--new`, and writes the sector at once. After that a missing save stops the server: it never starts an empty world because it could not find the one it had. Each write keeps the save before it as `.bak`.

```bash
node examples/space-frigate/server/run.mjs --port 8090 --data examples/space-frigate/server-data/sector.json --new
```

Leave `--new` off every start after the first. Then open the web export twice, once as each test account:

```
http://127.0.0.1:<port>/?server=ws://127.0.0.1:8090/sector&account=pilot-a&token=test-token-a
http://127.0.0.1:<port>/?server=ws://127.0.0.1:8090/sector&account=pilot-b&token=test-token-b
```

She flies as she does offline; `T` locks the shared rock and `F` mines it. With a tonne aboard the panel talks the helm to the station: `B` steers for it, `H` docks and casts off, and docked, `J` stores what is in the hold and `K` takes a tonne back. `Ctrl+C` (or `stop` on its input) stops the server and saves; it also saves every second while anything changes. `&wire=json` asks for text frames, to read a session in a debugger. `GET /healthz` gives the ore books (rock, holds, warehouses) and `GET /pilots` each ship, hold and warehouse as the server has them. After a change to `proto/sector.proto`, `node pipeline/bin/estella.mjs proto gen examples/space-frigate` writes `src/proto` again.

Checks: `tests/flight.test.ts`, `tests/sector.test.ts` and `tests/station.test.ts` hold the rules, a simulated slow link among them. `node examples/space-frigate/tools/check-sector.mjs` drives the server as its own process over real sockets (forged places, floods of orders, a second sign-in taking the helm, a dropped link, a stop and start, a kill, a lost save, mining to the last gram, then the run to the station: orders repeated and sent ten at once, amounts that are not ore, the server stopped dead at three points of a move with `SECTOR_CRASH`) and writes its books to `output/space-frigate/sector/ledger-<wire>.json`. `tools/check-online.mjs` flies two copies of the game in a browser through a relay that holds every byte back (`SECTOR_DELAY_MS`, 100 each way by default) and writes what it measured to `output/space-frigate/online/report.json`.

Not yet: ore is the only thing a warehouse holds and nobody can give any to anyone else; the station is drawn as the gate's ring; a ship in a sector sails through rocks, because the server does not work out collisions and the client no longer does it alone; the other 39 rocks of the field are put away; a sector has no gate out, no planet to land on and no raiders; the two accounts and their tokens are fixed test values; the save is one JSON file.
Assets are regenerated from their recipes with `python3 tools/generate.py`.

## License

[Apache-2.0](LICENSE). The piano samples are CC0 and the Chakra Petch font is under the SIL Open Font License; each carries its own licence file.
