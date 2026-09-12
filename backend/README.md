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
                                          ├──▶ /feed   raw JSON WebSocket (Python etc.)
                                          └──▶ /monitor dashboard: QR, devices, targets, test tones
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
| osc acc + gyro / magnitudes / swarm | switch each message family on or off |
| × in the device table | drop a device now |
| test tones | sonify the swarm on this Mac |

Only the ports come from the environment and need a restart:
`HIVE_HTTPS_PORT` (8443, phones) and `HIVE_HTTP_PORT` (8080, dashboard and `/feed`).

## On the phone

1. Scan the QR → the browser warns about the certificate (it is self-signed;
   there is no authority that signs certificates for a LAN address):
   - **iPhone/Safari:** *Show Details → visit this website → Visit Website*
   - **Android/Chrome:** *Advanced → Proceed to … (unsafe)*
2. Tap **Join the swarm** → on iPhone allow motion access.
3. Keep the page open. The phone shows its slot number (`#3`), its colour, and
   six live bars. Slot numbers are what the sound side addresses.

Why HTTPS at all: both iOS and Android only expose motion sensors to a secure
page. Why the phone sometimes says `link POST` instead of `WS`: iOS Safari
accepts the tapped-through certificate for the page but silently refuses
WebSockets to it, so the app falls back to POSTing the same binary frames.
Same data, same rate, ~20 ms more latency.

## OSC

All addresses, all targets, one bundle per sample:

```
/hive/dev/<slot>/acc    f f f    m/s², gravity included; flat phone ≈ (0, 0, 9.81) on iOS *and* Android
/hive/dev/<slot>/gyro   f f f    °/s about x, y, z
/hive/dev/<slot>/mag    f f      |acc|  |gyro|
/hive/dev/<slot>/join   s i      platform, slot
/hive/dev/<slot>/leave  i        slot
/hive/swarm/count       i        devices                    ┐
/hive/swarm/energy      f        mean |acc − g|  (m/s²)     │ 30 Hz
/hive/swarm/motion      f        mean |gyro|     (°/s)      │
/hive/swarm/sync        f        0..1, 1 = all turning alike┘
/hive/ping              i        from the dashboard's Ping button
```

Slots are small integers, reused after a device leaves, so `route 1 2 3` works.

## Team setup — receiving on another laptop

1. Join the same Wi-Fi as the Mac. Find your IP (`ipconfig getifaddr en0` on
   macOS, `ipconfig` on Windows, `hostname -I` on Linux).
2. On the dashboard, under **OSC targets**, add `your-ip:9001` with a label.
   Press **Ping**; your receiver should print `/hive/ping`.
3. Receive:
   - **Pd:** open [`examples/hive-receive.pd`](examples/hive-receive.pd)
     (`netreceive -u -b 9001 → oscparse → list trim → route hive …`).
   - **Max:** `[udpreceive 9001]` → `[route /hive/dev/1/acc]`.
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
  Bring your own network: an iPhone hotspot (Mac shows up as `172.20.10.x`) or
  the Mac's *Internet Sharing*. The server prints every address it has.
- 60 Hz is the browser's cap on both platforms.
- The screen must stay on. The app holds a wake lock (iOS ≥ 16.4, Chrome), but
  a locked phone stops sending within a second and is dropped after 3 s; it
  rejoins by itself when unlocked and keeps its slot if still free.
- Latency: default batches of 3 samples (~50 ms). `https://…:8443/?batch=1`
  sends every sample on its own.

## Layout

```
shared/protocol.ts   binary frame: 12-byte header + n × 7 float32   (npm run protocol:test)
server/              ingest (ws + POST) · registry · osc fan-out · targets · settings · store · swarm · feed · monitor · simulate
start.sh             the one command
client/src/          phone app (main, sensors, transport, i18n) · dashboard (monitor, tones) · theme.css
examples/            osc_listen.py · feed_client.py · hive-receive.pd
scripts/             osc-listen.ts (npm run osc:listen -- 9000)
```

The design follows emilpasqualini.eu via `theme.css` (Young Serif, Bitter,
accent `#F2B8B4`), fonts self-hosted so it works offline.

Recording and replay of swarms (e.g. bee datasets through the same OSC map) is
the next step: everything downstream of `Registry.push` already only sees
`Sample { slot, t, acc, gyro }`.
