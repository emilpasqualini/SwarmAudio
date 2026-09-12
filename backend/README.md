# HIVE backend — swarm audio

Phones on the same Wi-Fi scan a QR code, stream their **3-axis gyroscope + 3-axis
accelerometer** at ~60 Hz to this server on the Mac, and the server forwards
everything as **OSC over UDP** to the installation (Pd, Max, SuperCollider, …) —
on this Mac and on any teammate's laptop.

```
phone (Safari / Chrome)        Mac: backend                       sound
 devicemotion 60 Hz  ──wss/POST──▶ ingest → registry ──UDP/OSC──▶ Pd / Max / SC (any machine)
 binary frames, ~50 ms batches            │
                                          ├──▶ swarm features @ 30 Hz (energy, motion, sync)
                                          ├──▶ /feed     raw JSON WebSocket (Python etc.)
                                          ├──▶ /wall     projector: wi-fi + join QR codes, the swarm as bees, the queen
                                          └──▶ /monitor  dashboard: config, devices, targets, test tones
```

## Run

```bash
cd backend
./start.sh                 # checks Node, installs, builds, starts, opens the dashboard
./start.sh --sim 3         # …with three fake phones
./start.sh --dev           # rebuild the phone app on every save
```

The terminal prints the phone URL as a QR code, e.g. `https://172.20.10.2:8443`,
and the dashboard opens at `http://localhost:8080/monitor` — the same QR code
big enough to scan from across a table.

**Everything else is configured on the dashboard** and saved to
`hive.config.json`, so it is the same after a restart:

| dashboard | what |
|---|---|
| OSC targets | add/remove laptops (`host:port`), enable/disable, Ping, send counter, last error |
| fake phones | 0–50 virtual devices through the real pipeline (also `--sim n`) |
| swarm rate | Hz of `/hive/swarm/*` |
| device timeout | ms of silence before a phone is dropped |
| filter: min cutoff / beta | One-Euro smoothing of `rel` — rest-state cutoff (Hz) and how fast it opens up on movement |
| zero: rest before / slide time | when and how quickly the adaptive zero follows a resting phone (`rel` → 0) |
| osc /hive/sample / per field / roster / swarm | switch each message family on or off |
| queen / queen after | who the queen bee is (♛ in the table crowns one by hand; a bee that flies into her takes the crown; with no queen, the phone that moved most is crowned after *queen after* seconds) |
| iphone hotspot / wi-fi name / wi-fi password | the network the phones must be on — rendered as a *join this Wi-Fi* QR code on the dashboard and on the wall (step 1, before the join code). macOS hides the SSID from apps, so type it; the hotspot toggle only changes the hints and wording |
| wall: wi-fi code / join code | show or hide each QR code on the wall — off once everyone is in, and the bees get the whole wall |
| ♛ / × in the device table | crown a device / drop it now |
| test tones | sonify the swarm on this Mac |

Only the ports come from the environment and need a restart:
`HIVE_HTTPS_PORT` (8443, phones) and `HIVE_HTTP_PORT` (8080, dashboard and `/feed`).

## On the phone

1. Scan the QR → the browser warns about the certificate (it is self-signed;
   there is no authority that signs certificates for a LAN address):
   - **iPhone/Safari:** *Show Details → visit this website → Visit Website*
   - **Android/Chrome:** *Advanced → Proceed to … (unsafe)*
2. Tap **join the swarm** → on iPhone allow motion access.
3. Keep the page open. The phone shows the wall in miniature — every bee as a
   dot, yours ringed, the queen golden — its slot number (`#3`), six live bars,
   and one of two lines: *collide with the queen to become queen* or *you are
   the queen*. Languages: EN (default) · DE · 日本語.

The little map is fed on the link the phone already has — as the reply to a
POSTed frame or a text message down the socket — ten times a second, and drawn
a fifth of a second behind so the dots glide. It needs the wall page to be open
somewhere: the flight model runs there, the server only relays positions.

Why HTTPS at all: both iOS and Android only expose motion sensors to a secure
page. Why the phone sometimes says `link POST` instead of `WS`: iOS Safari
accepts the tapped-through certificate for the page but silently refuses
WebSockets to it, so the app falls back to POSTing the same binary frames.
Same data, same rate, ~20 ms more latency.

## OSC

The protocol is documented in **[docs/OSC.md](docs/OSC.md)** — generated from
[`shared/osc-schema.ts`](shared/osc-schema.ts), the same tables the dashboard's
*OSC protocol* card shows, so the three cannot disagree. In one breath:

```
/hive/sample   i slot · s uid · f t · acc xyz · rel xyz · gyro xyz · activity · idle · |acc| |rel| |gyro|   ~60 Hz per phone
/hive/swarm    f t · i count · f energy · f motion · f sync                                                  swarm rate (30 Hz)
/hive/join     i slot · s uid · s name · s platform        /hive/leave  i slot · s uid
/hive/roster   i count · (i slot · s uid · s name)…         /hive/schema i version                            every second
/hive/queen    s uid · i slot                                when the crown moves, and every second ('' / 0 = none)
/hive/dev/<slot>/acc|rel|gyro|activity|mag|turn             the same per-sample data, one small message each
```

`uid` is stable per phone; `slot` is 1..N per session. Fields are only ever
appended (`turn` — rotation about the vertical however the phone is held —
came with schema v2). Each family can be switched off on the dashboard.

## The wall (`/wall`) and the queen

Open `http://localhost:8080/wall` on the projector; double-click for
fullscreen, `h` hides the panels. Bottom left: the Wi-Fi QR code (if set) and
the join QR code. The swarm is drawn as bees: activity drives speed and wing
beat, turning the phone about the vertical turns the bee, tilt steers; the
edge pushes back softly, bees shrink as the swarm grows. Everything is the
server's `rel` / `activity` / `turn`, so the wall shows what the OSC side hears.

One bee is the **queen** — larger, golden, a halo. The server decides who
(`queenUid`, `/hive/queen` on OSC): crowned by hand on the dashboard, or, while
there is no queen, the phone that moved most within *queen after* seconds. On
the wall a bee that flies *into* her takes the crown (the mover wins; the queen
bumping into a bystander changes nothing; phones lying still never take or lose
it). Her solo on the sound side is still to come — `/hive/queen` is the hook.

## Team setup — receiving on another laptop

1. Join the same Wi-Fi as the Mac. Find your IP (`ipconfig getifaddr en0` on
   macOS, `ipconfig` on Windows, `hostname -I` on Linux).
2. On the dashboard, under **OSC targets**, add `your-ip:9001` with a label.
   Press **Ping**; your receiver should print `/hive/ping`.
3. Receive:
   - **Pd:** open [`examples/hive-receive.pd`](examples/hive-receive.pd)
     (`netreceive -u -b 9000 → oscparse → list trim → route hive → route sample → unpack`).
   - **Max:** `[udpreceive 9001]` → `[route /hive/sample]` → `[unpack i s f f f …]`.
   - **SuperCollider:** `thisProcess.openUDPPort(9001); OSCFunc.trace(true);`
   - **Python, OSC:** `python3 examples/osc_listen.py 9001` (no dependencies).
   - **Python, raw JSON:** `pip install websockets`, then
     `python3 examples/feed_client.py ws://<mac-ip>:8080/feed` — every sample as
     a dict, plus join/leave/swarm messages. No OSC parsing at all.

Every enabled target receives the complete stream; disabling one on the
dashboard stops it instantly. The list survives a restart.

## Debug sound on the Mac

Dashboard → **Test tones**. One sine per phone: forward/back tilt bends the
pitch, turning opens the volume, left/right tilt pans. If you hear it, the sensor
is being read, the frame crossed the network, the server decoded it and the feed
carries it. This is Web Audio in the browser — a check, not the installation.

## Known limits, and what to do at the venue

- **Guest Wi-Fi often isolates clients** — phones cannot reach the Mac at all.
- **The phone that provides a hotspot cannot reach its own clients.** If the
  Mac is tethered to your iPhone (`172.20.10.x`), that iPhone will never find
  the server; every *other* phone on the hotspot will. Enter the hotspot's name
  and password on the dashboard so the wall shows a *join this Wi-Fi* QR code
  first; switch on *maximise compatibility* on the iPhone (2.4 GHz) so every
  phone can see it.
- **Recommended at the venue — the Mac hosts the Wi-Fi, no internet needed:**
  System Settings → General → Sharing → *Internet Sharing*: share from
  *Ethernet* (works without a cable), to computers using *Wi-Fi*, name it
  `HIVE`, set a password, switch it on. Everyone joins `HIVE`; the Mac is
  always `192.168.2.1`, there is no client isolation and no hotspot-host problem.
  The server prints every address it has and re-issues the certificate when
  the address changes.
- 60 Hz is the browser's cap on both platforms.
- The screen must stay on. The app holds a wake lock (iOS ≥ 16.4, Chrome), but
  a locked phone stops sending within a second and is dropped after 3 s; it
  rejoins by itself when unlocked and keeps its slot if still free.
- Latency: default batches of 3 samples (~50 ms). `https://…:8443/?batch=1`
  sends every sample on its own.

## Layout

```
shared/protocol.ts   binary frame: 12-byte header + n × 7 float32   (npm run protocol:test)
shared/osc-schema.ts the OSC protocol as data → docs/OSC.md (npm run docs:osc) + dashboard card
server/condition.ts  per-device One-Euro smoothing, adaptive zero (rel), activity, turn
server/queen.ts      who the queen is when nobody said: the phone that moved most
server/wall.ts       the wall's bee positions, relayed to the phones' maps on their own link
server/              ingest (ws + POST) · registry · osc fan-out · targets · settings · store · swarm · feed · monitor · simulate
start.sh             the one command
client/src/          phone app (main, sensors, transport, swarm-map, i18n EN/DE/JA) · wall (wall, visuals/bees) · dashboard (monitor, tones) · theme.css
examples/            osc_listen.py · feed_client.py · hive-receive.pd
scripts/             osc-listen.ts (npm run osc:listen -- 9000)
```

The design follows emilpasqualini.eu via `theme.css` (Young Serif, Bitter,
accent `#F2B8B4`), fonts self-hosted so it works offline.

Recording and replay of swarms (e.g. bee datasets through the same OSC map) is
the next step: everything downstream of `Registry.push` already only sees
`Sample { slot, t, acc, gyro }`.
