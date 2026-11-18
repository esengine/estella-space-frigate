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
- **The station berths her.** Kestrel Anchorage stands 2 600 units from the rock, further than a beam reaches, so ore comes to it in a hold. Two of its eight berths are in use, each with a number, a place, a heading, a point above it and an approach point beside the wing (`SECTOR.station.berths` in `src/shared/sector.ts`). A pilot asks for a berth and the server keeps the first free one for her account: two who ask in the same instant are given different ones, and nobody is given two, whoever signs in as her and however often she asks. The glass then leads her to that berth's approach point. When the server has flown her within 45 units of it, making 80 m/s or less, the station takes her in hand: from there her helm does nothing, and the server carries her at 16 units a second round to the berth's heading, across to above the berth and straight down into it. Only when she lies there, and a save that has her there is on the disk, is she docked and her warehouse open: if the disk refuses the write she lies in her berth and is told the station cannot record it yet, the write is tried again four times a second, and it is the write that succeeds that docks her. Casting off shuts the warehouse that instant and takes her out the same way, to be let go at rest at her approach point with her berth free, her helm's orders going on from the number they had reached (within one sign-in the count only goes up, since the server drops a number it has already passed). The two ways never come within a hull of one another or of the station. Nothing a client says about being near, slow, docked or in a berth is read.
- **A berth outlasts a link, and a berth only kept does not outlast its pilot.** Berths are in the save. A docked ship is in her berth after her pilot signs out, after a second sign-in takes her seat, and after the server is stopped or killed; a ship the server was bringing in when it stopped is found lying in her berth, and one it was taking out is found let go outside. A berth that is only kept, for a ship that has not reached it, is given up thirty seconds after her pilot has gone: the time it is due is in the save, so stopping and starting the server meanwhile gives her no longer.
- **A warehouse is its pilot's own.** An order moves ore between the sender's hold and the sender's warehouse, and has no field for anyone else's. It is refused, as a value, unless she is docked and the amount is whole grams she has.
- **The harbour has the camera while it has the ship.** From the step the server takes her in hand to the step it lets her go, the view is the harbour's (`src/director.ts`): coming in, a long view from outside and above the berth with ship, berth and station all in frame, then off her bow quarter as she comes down, then still, with her in the left of the picture and the warehouse panel on the right; going out, off her quarter astern as she lifts, drawn back as she is carried clear, and round behind her as she is let go. Which shot is up is read from where the server has her, not from a clock, so signing in to a ship already there goes to the shot for where she is, and one that lies in her berth unwritten is held in the last shot with no chime and no panel until the write that docks her. A drag of the view, or asking for any view of her own, takes it back for the rest of that manoeuvre: her view begins where the director's camera stands, so nothing is travelled through to reach it, and a link that drops and comes back does not hand the camera to the harbour again. While the station carries her the thrusters that push her that way are seen burning. The camera is kept out of the station by the same box model the berths are checked against (`src/shared/stationShape.ts`).
- **The station buys ore.** Docked, a pilot sells ore out of her own warehouse to the station: one tonne at a time for 100 credits, a test price (`SECTOR.station.buys`). A sale is one order and one write: her warehouse a tonne less, the station's stock a tonne more, her credits 100 more, together or not at all. It is refused unless she is docked, has a tonne stored, and names the lot and the price the station gave her; nothing she sends says what she is paid. Sales are numbered from the same count as moves of ore and are done once in the same way. The station's stock is still ore of the sector: rock, holds, warehouses and stock are the ten tonnes, and the credits paid out are always what that stock was bought for, which a save is refused for breaking.
- **An order is done once, for good.** Each pilot's orders are numbered 1, 2, 3 for as long as the sector lives, the count is in the save, and the server says which number is next. An order at or below a number already answered is never done: it is given its old answer if that is still remembered beside its name, and refused as `EXPIRED` if not. The few answers kept are a courtesy to a retry; it is the number that forbids the move, so no quantity of later orders, dropped links or restarts lets an old one through.
- **Told it moved, it moved; not told, it did not.** A move is written before it is made: the server hands the disk the whole sector as it would be with the move in it, and only when that is flushed and in place do the balances change and the reply go out. If the write fails nothing has moved, nothing is remembered, the reply is `NOT SAVED`, and the same order asked again is tried again and done once. A server stopped before, during or after the write comes back with the whole move or none of it. Its own periodic saves are retried when they fail, without stopping it; `/healthz` says `saving: failing` while they do. The rock, every hold and every warehouse always add up to the ten tonnes.
- **A sector is founded on purpose.** The first start needs `--new`, and writes the sector at once. After that a missing save stops the server: it never starts an empty world because it could not find the one it had. Each write keeps the save before it as `.bak`.

```bash
node examples/space-frigate/server/run.mjs --port 8090 --data examples/space-frigate/server-data/sector.json --new
```

Leave `--new` off every start after the first. Then open the web export twice, once as each test account:

```
http://127.0.0.1:<port>/?server=ws://127.0.0.1:8090/sector&account=pilot-a&token=test-token-a
http://127.0.0.1:<port>/?server=ws://127.0.0.1:8090/sector&account=pilot-b&token=test-token-b
```

Without `--accounts` the server flies those two test pilots, and says so. A sector other people reach has its own list of pilots, a token each, kept beside the save:

```bash
node pipeline/bin/estella.mjs export examples/space-frigate --platform server
```

writes `examples/space-frigate/dist-server/`: the server in one file, the web export, and the files that deploy both behind one address (`project.esproject`'s `server` block says how it is started). On the machine, once, from that folder (with Docker, prefix each `node server.mjs` with `docker compose run --rm server`, and the files go in `/data`):

```bash
node server.mjs --accounts /var/lib/space-frigate/pilots.json --add-pilot ana
node server.mjs --data /var/lib/space-frigate/sector.json --accounts /var/lib/space-frigate/pilots.json --new --found-only
```

The first prints her link, `https://<your domain>/?account=ana&token=...`, and is run again for each pilot (the server reads the list when it starts, so restart it after adding one). The second founds the sector and stops. Then `SITE_ADDRESS=<your domain> docker compose up -d --build`, or the systemd unit and Caddyfile in `deploy/`, as the folder's README says. A link with an account and no `?server=` dials `/sector` on the host the page came from.

She flies as she does offline; `T` locks the shared rock and `F` mines it. With a tonne aboard the panel asks for `H`, which asks the station for a berth; then it talks the helm to that berth's approach point (`B` steers for it, slow to a quarter, stop the engine there) and the station does the rest. `H` again gives up a berth that is only kept, or casts off from one she lies in. Docked, `J` stores what is in the hold, `K` takes a tonne back and `N` sells a tonne to the station for 100 credits. `Ctrl+C` (or `stop` on its input) stops the server and saves; it also saves every second while anything changes. `&wire=json` asks for text frames, to read a session in a debugger. `GET /healthz` gives the ore books (rock, holds, warehouses, the station's stock) and the credits paid out, and `GET /pilots` each ship, hold, warehouse and berth as the server has them, with who has each berth. After a change to `proto/sector.proto`, `node pipeline/bin/estella.mjs proto gen examples/space-frigate` writes `src/proto` again.

Checks: `tests/flight.test.ts`, `tests/sector.test.ts`, `tests/station.test.ts`, `tests/warehouse.test.ts`, `tests/market.test.ts` and `tests/director.test.ts` hold the rules, a simulated slow link among them. `node examples/space-frigate/tools/check-sector.mjs` drives the server as its own process over real sockets (forged places, floods of orders, a second sign-in taking the helm, a dropped link, a stop and start, a kill, a lost save, mining to the last gram, then the berths: eighty requests for a berth at once, both ships brought in together with every step each was sent compared, the way out, a berth kept through a dropped link and a kill and given up after thirty seconds; and the warehouse: orders repeated and sent ten at once, amounts that are not ore, the server stopped dead at three points of a move with `SECTOR_CRASH`, a disk that refuses the write, and an old order sent again after sixty-four others, a restart, a dropped link and a kill) and writes its books to `output/space-frigate/sector/ledger-<wire>.json` and who had which berth to `berths-<wire>.json`. `tools/measure-frames.mjs` opens the game as a player has it at several window sizes and keeps the time between frames, what the engine says a frame cost the GPU, and where the main thread's time went, lying still and with the view dragged; `tools/measure-load.mjs` times a first and a second visit and says what the wait was spent on. `tools/check-director.mjs` watches the harbour's camera in two clients, one to each berth, at 1280x720 and 1920x1080: the shots and their order, how the ship sits in each, the wait while the disk refuses a berthing, a drag, a reload, and the helm at the moment she is let go, with each window filmed to `output/space-frigate/director/video`. `tools/check-online.mjs` flies two copies of the game in a browser through a relay that holds every byte back (`SECTOR_DELAY_MS`, 100 each way by default) films both windows from asking for a berth to sailing away (`output/space-frigate/online/video/berths-A.webm` and `berths-B.webm`), and writes what it measured to `output/space-frigate/online/report.json`.

Not yet: ore is the only thing a warehouse holds and nobody can give any to anyone else; credits can be earned and not yet spent, the station pays one fixed price and never sells; two of the eight berths are in use and the other six are only drawn; a ship whose pilot is signed out is not drawn, though her berth is hers; under her own helm a ship in a sector sails through rocks, the station and other ships, because the server does not work out collisions and the client no longer does it alone (in the station's hands she is kept clear by the way she is taken); the other 39 rocks of the field are put away; a sector has no gate out, no planet to land on and no raiders; the two accounts and their tokens are fixed test values; the save is one JSON file.
The station is built in `tools/generate.py` after the multi-view design, from parts that are drawn more than once wherever it is the same more than once: a quarter of the hub and its command tower of four octagonal tiers, drawn four times round; a dock wing with two frigate berths, drawn three times; the wing that ends in the open repair dock; and, by itself, what is not alike all round (the masts above, the refinery, tanks and radiators hung below). A gate is a sixth of its ring with the node it carries, drawn six times, and its towers. The frigate is two lengths, fore and aft, each with a map of its own. A part drawn several times has a map a fraction the size and is made once: models are made on the player's machine the first time the game is opened, on up to four workers, and that wait went from 43 s to 28 s on a twenty-core desktop when the gate, the station's core and the frigate were parted this way. It spans 832 units, eight frigate lengths. `node pipeline/bin/estella.mjs bake-model <file.esmodel> --sheet <out.png>` draws a model from every side.

Assets are regenerated from their recipes with `python3 tools/generate.py`.

## What a world is

A world is made once, from the voyage's seed like the rest of its system, and everything that shows it reads the one thing
(`src/planetSpec.ts`):

- **Its ground** is one function of where on the planet a place is (`src/planetGround.ts`). The planet seen from space is drawn
  from a map of that ground, made a few rows a frame after she arrives in the system (how each place is painted and how high
  it stands), so its coasts, plains and ranges are the ones she lands among. She comes down where she came in: the place of the
  planet under her is turned to the top of the ground that is made.
- **What grows** is laid out by the engine's world generation from rules made for that world (`src/flora.ts`): how much grows
  and where, how large (a wood is several times its grown size, and a world has giants several times that), which trees make
  its woods and which its high ground, how much stone lies about. A desert has scrub, a rare tree and standing stones; a
  frozen world stone and a few trees low down; a lava world stone. Its leaves take after the colour of its plains, so no two
  worlds are the one green.
- **Its ground's grain** is four grey pictures (grass, soil, snow, rock; `tools/make-ground.py`) laid by the planet's paint and
  tinted by that world's colours, and **its sea** has waves, pale shallows and a shore (the engine's planet sea).

The trees are grown by the engine's tree step and written by the editor's model tools (`flora-src/`), then made ready for a wood
by `tools/flora-meshes.mjs`, which says what had to change and why. `tools/probe-flora.mjs` puts her low over the ground and
takes pictures.

Not yet: a world's climate does not change across it beyond wet and dry and high and low (no poles, no belts), the planet's
own cloud, ice cap and city lights are still drawn apart from its ground, and the sea does not rise and fall.

## License

[Apache-2.0](LICENSE). The piano samples are CC0 and the Chakra Petch font is under the SIL Open Font License; each carries its own licence file.
