# +1 Jump Pogo

A multiplayer "+1" pogo game for the browser, built with **Three.js** and **Colyseus** for Bloxity. You ride a pogo stick that never stops bouncing. Every bounce gives Power, Power levels you up, and every level adds +2.5 Jump Power. You bounce up the giant Rainbow Stairs for Wins and spend the Wins on better pogos. It is a clone of the Roblox game *[+1 Jump Pogo](https://www.roblox.com/games/92351376921057/1-Jump-Pogo)*; see `reference/Gameplay.mp4`.

It uses the same engine as Climb Obby Escape and Speed Dino Escape (server, Bloxity integration, avatars, controller support and effects). The world, pogo physics, HUD and soundtrack are new.

## Project layout

| Folder | What it is |
|---|---|
| `client/` | Vite + Three.js game client (`src/main.js`, `world.js`, `engine.js`, `ui.js`, `fx.js`, `audio.js`) |
| `server/` | Colyseus 0.18 server: the `pogo` room (`PogoRoom.js`), player profiles, leaderboards, Bux webhook |
| `shared/` | Game data and formulas used by both sides (`config.js`) |

## Run it locally

Needs Node 20 or newer.

```sh
npm install          # if your npm skips the postinstall: npm --prefix server install && npm --prefix client install
npm run build        # builds the client into client/dist
npm start            # server + game on http://localhost:2567
```

You can also double-click `start-local.bat`. For development, run `npm run dev:server` and `npm run dev:client` in two terminals, then open the Vite URL (http://localhost:5173). In dev the client connects to the server on port 2567. Set `VITE_SERVER_URL` to point it somewhere else, and `PORT` to change the server's port.

## Gameplay

- **Every bounce gives +Power.** The pogo hops on its own. Hold **Space** (or tap it in the air) and the next landing becomes a full Jump Power bounce. A bounce pays `1 + 1 per 15 studs of height`, multiplied by your pogo, the trampoline under you, rebirths, trail, passes, boosts and Friend Boost. A blue "👟+N" pops up for every gain.
- **Levels:** Power is also XP. A level takes 50 XP at the start, rising 7.5% per level, with a jump to 322 at Level 20. These numbers come from the reference (621 at 29, 1.5K at 41, 4.4K at 56, 12.3K at 70). Each level adds **+2.5 Jump Power** ("Level 2 > Level 3 / Jump Power 55 > 57.5 (+2.5)"), from 50 at Level 0 up to Level 150. A full bounce rises `0.42 × Jump Power` studs. The **Jump power** box on the right can lower it.
- **The Rainbow Stairs:** 30 giant studded steps out at sea, coloured from green through yellow, orange, red and pink to blue. Each riser is labelled with its height: 10, 25, 45, 70, 100, 136, 175, 223, 277, 337, 404, 480 STUD, as in the reference, then +8% per step, ending at 3,549 STUD. A gold summit sits on top. Each step has a **"+N Wins"** pad (1, 3, 5, 10, 15, 25 ... 100K, and 250K at the summit). A pad pays out and sends you back to the lobby, once per trip. Fall in the sea and you splash back to the lobby.
- **Power Gems:** about 88 spinning crystals float over the steps. Touch one for a burst of Power (25 × the height bonus). It comes back for you after 45 s, and the server checks your position and the timer.
- **NEW HEIGHT!** Reaching a step you've never stood on shows a banner and fireworks. While you're on the stairs, an altitude bar under the step counter shows your height and a marker for your best.
- **Training:** trampolines on the right side of the lobby: 1.5x (0 Rebirths), 2x (1), 3x (2), 5x (3), 7.5x (4), 10x (5), 15x (8), 25x (12) and the **ADMIN** 250x pass. A locked trampoline says "You need N Rebirths to use this trampoline!". A **secret 3x trampoline** appears somewhere in the lobby for one minute every five minutes, timed by the server clock, with a "A Secret Trampoline Has Spawned In The Lobby!" toast.
- **Pogo Skins:** a stand on the left with a pad and a spinning pogo for each skin. Step on a pad to buy or equip: x1 FREE, x2 for 1 Win, x3 for 15, x5 for 50, x10 for 125, x15 for 250, x20 for 520, x25 for 1,300, x30 for 3,000, x40 for 8,000 and x50 for 25,000 Wins ("You need 4% more Wins!", "x15 Power unlocked and equipped!"). The Cute (x60), Galaxy (x150) and ADMIN (x300) pogos are game passes. Higher pogos glow and leave fire, sparks, stars or hearts.
- **Objectives** ("Follow the beam and bounce on Trampoline 1!"): 20 guided steps. Glowing chevrons and a light pillar point to the next target: a trampoline, a step's Wins pad or a pogo pad. Each step pays Power or Wins.
- **Rebirth** from Level 20 (+10 per rebirth, up to 120): your level resets to 0, and you get +50% Power, +25 Jump Power, new trampolines and trails. You keep Power, Wins and pogos. **World 2** needs 10 Rebirths and is coming soon.
- **Lobby:** the 4 leaderboards (Top Power, Wins, Rebirths, Playtime) with an update timer, a free chest once a day, the World 2 portal, and islands with palms out at sea.
- **HUD** (from the reference): Wins and the SHOP / REBIRTH / TRAILS / REWARD tiles on the left. The objective line at the top. Starter Pack and settings top right. On the right, Jump power with MAX, "(Total boost)" and the green **x2 Power** pass. At the bottom, "Jump Power: 50.0", "Total Power", the Level bar and the **+10K / +100K / +1M Power** buttons (+1M / +10M / +25M from Level 50).
- **Also included:** Daily Reward (7 days), FREE playtime rewards, Auto Bounce on your best trampoline, offline trampoline earnings (a quarter rate, up to 8 h), Friend Boost and the Store.
- **Soundtrack:** "Rainbow Bounce", an original, code-generated 126 BPM future-bass / tropical-house track. It has sidechain-pumped supersaw chords (Fmaj7 – G6 – Em7 – Am7), a sub bass, a vocal-chop lead with echo, marimba, snare-roll and riser build-ups, and impacts on each drop. The song runs 32 bars: intro, build, drop, break, build, drop 2. The music is muffled while a menu is open, and gets an extra sparkle layer on the stairs. Sound effects include pogo boings, trampoline thumps and splashes. There are no audio files.

## Graphics

- **The sea:** a custom water shader with drifting Roblox-style cells and pale ridges, sun glints, a sky-tinted fresnel, animated white foam where it meets the lobby, the bridge and the stairs, and fog. It follows the camera, so it never ends.
- **Materials:** Roblox studs everywhere (normal-mapped bevelled studs), PBR plastic under a soft studio environment map, and a sun with soft shadows. A final grade adds saturation, contrast, a vignette and bloom on neon.
- **Sky:** rainbow light pillars, instanced clouds that rise with you up the stairs, and a sky that deepens toward space near the top.
- **Landing aids:** a soft drop shadow under you on whatever you'll land on, and the camera pulls back on big, fast bounces. Each Wins pad has a gold light column so you can spot it from below.
- **Pogo sticks:** modelled with a coil spring that compresses on every landing. The rider's body drops while the rubber foot stays planted. Trampoline mats dip when you land.
- **Performance:** static meshes are merged into about 18 draw-call batches. The lobby view is about 100–400 draw calls.

## Controls

| Action | Keyboard / mouse | Controller |
|---|---|---|
| Move | WASD / arrows | Left stick |
| Big bounce | Hold Space (or tap it in the air) | A |
| Camera | Drag, wheel to zoom | Right stick, D-pad up/down to zoom, R3 to reset |
| Auto Bounce | Button (top right) | X |
| Rewards / Rebirth / Trails | Buttons | Y / LB / RB |
| Shop / Settings | Buttons | View / Menu |

Phones get an on-screen joystick and a JUMP button (hold it for big bounces).

## How multiplayer works

- Everyone joins one shared `pogo` room (up to 24 players).
- **Client-side:** pogo physics and movement. Other players are interpolated and squash their springs when they land.
- **Server-side:** everything that changes progress. Bounces are rate-limited (one per 0.26 s), and their Power uses the server's copy of your height and the trampoline under you. The server also handles the Wins pads (position-checked, one claim per trip), highest step, pogo and trail unlocks, rebirths, objectives, rewards, Friend Boost and purchases.
- Progress is saved per browser (a random id in localStorage) or per Bloxity account: in MongoDB on Legion (`MONGODB_URI`), and in `server/data/profiles.json` locally. A signed browser backup (`SAVE_SECRET`) restores progress on a restarted file-mode server.

## Bloxity

- `GAME_SLUG` in `client/src/bloxity.js` defaults to `jump-pogo`. It must match the game's slug in bloxity.io Manage Games.
- Prices are in **Bux**. SKUs are in `SKUS` in `shared/config.js` (`power_10k` … `pass_admin_trampoline`); create them in the game's IAP catalog. Without a catalog the game runs in demo mode, where purchases are free.
- Set `LEGION_WEBHOOK_SECRET` on the server to switch to Bux mode. `POST /api/legion-webhook` then grants purchases.

## Deploy (Bloxity hosting)

Every push to `main` (prod) or `dev` runs `.github/workflows/deploy.yml`. It builds `server/Dockerfile` into `ghcr.io/asivixlp44-cmyk/jump-pogo-server`, rolls it out on Legion (`jump-pogo`) and uploads the client.

One-time setup:

- Create the app `jump-pogo` on hosting.bloxity.io.
- Create the game with the slug `jump-pogo` in bloxity.io Manage Games, plus the SKUs.
- Add the repo secret `LEGION_DEPLOY_TOKEN`.
