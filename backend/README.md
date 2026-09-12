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
                                          ├──▶ /hive/global  swarm meta-parameters (coherence, tempo, entropy …) @ swarm rate
                                          ├──▶ /wall     projector: wi-fi + join QR codes, the swarm as bees, the queen
                                          └──▶ /monitor  dashboard: config, devices, targets, camera view, test tones
webcam ──▶ vision/hive_vision.py (Python, YOLO11n-pose) ──ws──▶ /vision ──▶ /hive/cam · /hive/mix · wall shadows · dashboard picture
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
| start / pause · reset | people can join while paused — bees hover, no queen race, phones say *waiting*. **start** lets it all go (movement, queen race, crown passing); **reset** clears the queen, re-spawns every bee and waits for start again. The server starts paused |
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
| camera: preview / osc camera / osc per person / cluster radius / mirror / wall coupling / coupling strength | the camera pipeline (see below); *wall coupling* draws the bees toward the crowds the camera sees |
| osc global / osc mix | switch the meta-parameter families |
| osc parameters | one chip per small message (dev/acc, swarm/energy, global/tempo, cam/person, mix/covered, …) — off = not sent; saves Wi-Fi traffic for whatever nobody patches |
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
   and one of three lines: *no queen yet — move a lot!* (whoever moves most
   is crowned first), *collide with the queen to become queen*, or *you are
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
/hive/sample   i slot · s uid · f t · acc xyz · rel xyz · gyro xyz · activity · idle · |acc| |rel| |gyro| · turn · i queen   ~60 Hz per phone
/hive/swarm    f t · i count · f energy · f motion · f sync                                                  swarm rate (30 Hz)
/hive/join     i slot · s uid · s name · s platform        /hive/leave  i slot · s uid
/hive/roster   i count · (i slot · s uid · s name)…         /hive/schema i version                            every second
/hive/queen    s uid · i slot                                when the crown moves, and every second ('' / 0 = none)
/hive/dev/<slot>/acc|rel|gyro|activity|mag|turn|queen       the same per-sample data, one small message each
/hive/global   s "global" · f t · i count · coherence · phaseSync · tempo · centroid · entropy · dispersion · leanX · leanY · onsets · crest
/hive/cam      f t · i count · i clusters · spread · energy · cx · cy · armsUp · flowX · flowY · turbulence · moveSync · converge · nearest · stillness · occupancy
/hive/cam/cluster · /hive/cam/person · /hive/cam/status      groups, tracked people (anonymous), whether the camera runs
/hive/mix      f t · i bees · i people · distance · beesInCrowd · queenInCrowd · covered · alignment · balance
```

`uid` is stable per phone; `slot` is 1..N per session. Fields are only ever
appended (`turn` — rotation about the vertical however the phone is held —
came with schema v2). Each family can be switched off on the dashboard.

## Swarm meta-parameters — `/hive/global`

The hive as one signal, signal-processing style, at the swarm rate
([server/global.ts](server/global.ts)): **coherence** (pairwise correlation of
movement over 1 s — do people move alike?), **phaseSync** (Kuramoto order
parameter — are they in step?), **tempo** (dominant rhythm, Hz, autocorrelation
of the swarm's energy), **centroid** (spectral centroid — sway or jitter),
**entropy** (everyone or a soloist), **dispersion** (how different the tilts
are), **leanX/Y** (where the room leans), **onsets** (bursts per second),
**crest** (spiky or steady). Live numbers on the dashboard; every field also as
`/hive/global/<name>`.

## The camera — `backend/vision/`

A second, anonymous layer: a webcam and **YOLO11n-pose** (people + skeletons,
tracked; Metal-accelerated on Apple Silicon) in a Python process that talks to
the server. Nobody in the picture is matched to a phone — the camera is a
*field*, the phones are the agents; people can be in the picture without a
phone and in the hive without being in the picture.

```bash
./start.sh --vision            # second terminal; makes vision/.venv on first use, then runs
./start.sh --vision --show     # …with a preview window
./start.sh --vision --source clip.mp4   # a video file instead of the camera (loops)
```

The model (~6 MB) downloads into `vision/models/` on the first run — **do that
once with internet before the venue**. macOS asks for camera access for the
terminal you start it from; allow it (System Settings → Privacy & Security →
Camera). If nothing opens, the script says why; `--list-cameras` prints what
it sees, and the dashboard's *camera* menu picks one by name — the built-in
FaceTime camera or an iPhone as **Continuity Camera** (it appears as
"<name> Camera" while it is nearby and unlocked; camera indices are not stable,
so pick by name).

`--backend coreml` runs the model on the **Neural Engine** via Core ML
(exported once from the `.pt`, ~1 min, no internet) instead of the GPU
(`mps`, default). On an M1 Pro `mps` is faster (≈50 fps raw vs ≈25), but Core
ML leaves the GPU to the wall on the projector — use it when both run on the
same Mac and the wall stutters.

What comes out, per processed frame (~25 fps on an M1 Pro):
- **people** — tracker id, position, `depth` (box height: closer = bigger),
  `armsUp` (0–2 wrists above shoulders), `crouch`, `energy` (how fast they move);
- **clusters** — groups closer than the *cluster radius* (tiny DBSCAN);
- **room numbers** — count, spread, energy, centroid, mean armsUp;
- **crowd motion** (server-side, frame to frame) — flow, turbulence,
  moveSync, converge, nearest, stillness, occupancy.

All of it goes out as `/hive/cam*` OSC (own switches), into `/feed`, onto the
wall (people as soft shadows, groups as rings; with *wall coupling* the bees
are drawn toward the crowds) and onto the dashboard, which shows the
**annotated picture live** (boxes, ids, skeletons, cluster circles — *preview*
switches it off to spare the camera process). Cluster radius, mirror and
preview are pushed back to Python live.

**`/hive/mix`** ([server/mix.ts](server/mix.ts)) relates the two crowds:
distance between the swarm's and the crowd's centroids, fraction of bees inside
a group, whether the queen is among people, how much of the crowd a bee is
touching, whether swarm and crowd drift the same way, and the bees/people
balance. Both pictures are 0..1 across, so no matching is needed.

For REAPER: add the laptop as an OSC target; *Options → Preferences →
Control/OSC/Web → Add OSC*, receive only, that port; *Param → Learn* on a plugin
parameter while moving in front of the camera. Everything is in
[docs/OSC.md](docs/OSC.md). A Steam Controller as meta-modulator (from the
original idea) can hook into the same settings later.

## Every feature, mathematically

Notation: a phone $i$ delivers samples at $\approx 60$ Hz with acceleration
$\mathbf{a}_i(t)\in\mathbb{R}^3$ (m/s², gravity included, sign-normalised so a
flat phone reads $(0,0,+9.81)$) and rotation rate
$\boldsymbol{\omega}_i(t)\in\mathbb{R}^3$ (°/s). $\Delta t$ is the time since
the previous sample of that phone (clamped to $[1, 100]$ ms). All constants
below are in [`server/condition.ts`](server/condition.ts),
[`server/swarm.ts`](server/swarm.ts), [`server/global.ts`](server/global.ts),
[`server/vision.ts`](server/vision.ts), [`server/mix.ts`](server/mix.ts).

### Per phone — `/hive/sample` ([condition.ts](server/condition.ts))

**Smoothing — One-Euro filter** (Casiez, Roussel & Vogel 2012), per axis.
With cutoff $f_c$ the smoothing factor for a step $\Delta t$ is

$$\alpha(f_c,\Delta t)=\frac{2\pi f_c\,\Delta t}{2\pi f_c\,\Delta t+1}.$$

The derivative is smoothed with a fixed cutoff $f_d = 1$ Hz, and the signal
cutoff rises with the speed of change:

$$\dot{\hat a}_k = \dot{\hat a}_{k-1} + \alpha(f_d,\Delta t)\Big(\tfrac{a_k-\hat a_{k-1}}{\Delta t}-\dot{\hat a}_{k-1}\Big),\qquad
f_c = f_{\min} + \beta\,|\dot{\hat a}_k|,\qquad
\hat a_k = \hat a_{k-1} + \alpha(f_c,\Delta t)\,(a_k-\hat a_{k-1}).$$

Dashboard: $f_{\min}$ = *filter: min cutoff* (1 Hz), $\beta$ = *filter: beta*
(0.3 per m/s² per s). At rest the cutoff sits at $f_{\min}$ and jitter is gone;
a flick raises it so the move arrives without lag.

**Activity** — how much the phone is turning or being jolted, 0..1:

$$r_k=\min\!\Big(1,\ \max\big(\tfrac{\|\boldsymbol\omega_k\|}{150},\ \tfrac{\|\mathbf a_k-\mathbf a_{k-1}\|}{6}\big)\Big),\qquad
\mathrm{act}_k=\mathrm{act}_{k-1}+\big(1-e^{-\Delta t/\tau_a}\big)(r_k-\mathrm{act}_{k-1}),\ \tau_a=0.25\,\text{s}.$$

**Idle** — seconds since activity last dropped below $0.06$:
$\mathrm{idle}_k = \mathrm{idle}_{k-1}+\Delta t$ if $\mathrm{act}_k<0.06$, else $0$.

**Adaptive zero and `rel`** — the baseline $\mathbf b$ starts at the first
sample and only moves once the phone has rested for $T_{\text{idle}}$
(*zero: rest before*, 1.2 s), sliding with time constant $\tau_z$ (*zero: slide
time*, 2.5 s):

$$\mathbf b_k=\mathbf b_{k-1}+\big(1-e^{-\Delta t/\tau_z}\big)(\hat{\mathbf a}_k-\mathbf b_{k-1})\ \text{ if } \mathrm{idle}_k>T_{\text{idle}},\qquad
\mathbf{rel}_k=\hat{\mathbf a}_k-\mathbf b_k .$$

So `rel` is zero whenever someone holds still — at any angle — and only
*change* produces signal.

**Turn** — rotation about the room's vertical, however the phone is held: the
gyro projected onto the smoothed gravity direction,

$$\mathrm{turn}_k=\frac{\boldsymbol\omega_k\cdot\hat{\mathbf a}_k}{\|\hat{\mathbf a}_k\|}\quad(\text{°/s, }+\text{ = counter-clockwise seen from above}).$$

**Magnitudes** — $\|\mathbf a\|$, $\|\mathbf{rel}\|$, $\|\boldsymbol\omega\|$.

### Whole swarm — `/hive/swarm` ([swarm.ts](server/swarm.ts)), at the swarm rate

Over the $N$ phones with a latest sample:

$$\mathrm{energy}=\frac1N\sum_i\big|\,\|\mathbf a_i\|-g\,\big|,\qquad
\mathrm{motion}=\frac1N\sum_i\|\boldsymbol\omega_i\|,\qquad
\mathrm{sync}=\frac{1}{1+c_v^2},\ \ c_v=\frac{\sigma(\|\boldsymbol\omega_i\|)}{\mathrm{motion}} .$$

sync is 1 when everyone turns equally hard and → 0 when one moves and the
rest are still.

### Swarm meta-parameters — `/hive/global` ([global.ts](server/global.ts))

Each phone keeps a ring buffer of the last 256 samples of $\mathbf{rel}$,
$m=\|\mathbf{rel}\|$ and act; the swarm keeps a series
$E_n=\frac1N\sum_i m_i$ sampled at the swarm rate $f_s$ (30 Hz; 128 values ≈ 4 s).
Computed over the $N$ phones seen in the last 1.5 s.

- **coherence** — mean pairwise Pearson correlation of the magnitude series
  over the last $W=60$ samples (≈1 s):
  $$\mathrm{coherence}=\frac{1}{\binom N2}\sum_{i<j}\rho\big(m_i[-W{:}],\,m_j[-W{:}]\big),\qquad
  \rho(x,y)=\frac{\sum(x-\bar x)(y-\bar y)}{\sqrt{\sum(x-\bar x)^2\sum(y-\bar y)^2}} .$$
- **phaseSync** — Kuramoto order parameter. Each phone's phase comes from the
  last two upward zero crossings of $\mathrm{rel}_y$ (demeaned over 180
  samples): with crossings at sample indices $c_1<c_2$ and period $P=c_2-c_1$,
  $\varphi_i=2\pi\,(n-1-c_2)/P$. Then
  $$R=\Big|\frac1M\sum_{i=1}^M e^{\,\mathrm{j}\varphi_i}\Big|\in[0,1]$$
  over the $M\ge2$ phones that oscillate at all. 1 = in step.
- **tempo** — dominant rhythm of the swarm. $E$ is demeaned and Hann-windowed;
  its normalised autocorrelation
  $r(\ell)=\sum_n E_nE_{n-\ell}\big/\sum_n E_n^2$ is searched for the strongest
  *local* maximum with $\ell\in[f_s/6,\ f_s/0.5]$ (0.5–6 Hz);
  $\mathrm{tempo}=f_s/\ell^\ast$ if $r(\ell^\ast)>0.3$, else 0.
- **centroid** — spectral centroid of the same windowed series, 128-point FFT:
  $$\mathrm{centroid}=\frac{\sum_{b=1}^{63}|X_b|^2\,\frac{b\,f_s}{128}}{\sum_{b=1}^{63}|X_b|^2}\ \text{Hz}.$$
- **entropy** — how evenly activity is spread: with $p_i=\mathrm{act}_i/\sum_j\mathrm{act}_j$,
  $$\mathrm{entropy}=-\frac{1}{\ln N}\sum_i p_i\ln p_i\in[0,1]$$
  (1 = everyone equally active, 0 = one soloist; defined 1 when nobody moves and $N>1$).
- **dispersion** — spread of the tilts, $\sqrt{\frac1N\sum_i\|\mathbf{rel}_i-\overline{\mathbf{rel}}\|^2}$ (m/s²).
- **leanX, leanY** — $\overline{\mathrm{rel}_x}$, $\overline{\mathrm{rel}_y}$: where the room leans.
- **onsets** — activity onsets (act crossing 0.06 upward) summed over phones
  within the last 2 s, divided by 2 s.
- **crest** — over the last $2f_s$ values of $E$: $\max E\,/\,\mathrm{rms}(E)$; ≈1 steady, high = spiky.

### Camera — `/hive/cam` ([vision/hive_vision.py](vision/hive_vision.py), [vision.ts](server/vision.ts))

Per frame, YOLO11n-pose gives each tracked person a box $(x_1,y_1,x_2,y_2)$
and 17 keypoints. Coordinates are normalised by the frame size, $x$ mirrored
when *mirror* is on. Per person $p$:

- position $(x_p,y_p)$ = box centre; **depth** $=(y_2-y_1)/H$ (box height in
  frame heights — closer = bigger);
- **armsUp** = number of wrists whose $y$ is above the matching shoulder's (0–2);
- **crouch** $=\mathrm{clip}\big(1-\tfrac{\text{knee}_y-\text{hip}_y}{0.8\,(\text{hip}_y-\text{shoulder}_y)},0,1\big)$;
- **energy** — centroid speed in frame widths/s, $v=\|\Delta\mathbf p\|/\Delta t$,
  squashed $\min(1,v/1.5)$ and smoothed with $\tau=0.3$ s.

**Clusters** — DBSCAN with `min_samples = 1`, i.e. the connected components
of the graph "closer than $\varepsilon$" ($\varepsilon$ = *cluster radius*, in
frame widths, default 0.12): a chain of people each within $\varepsilon$ of the
next is one group. Each cluster reports its size $n$, centroid and radius
$\max_p\|\mathbf p-\bar{\mathbf p}\|$.

Room numbers: **count**; **spread** = mean pairwise distance
$\frac{1}{\binom N2}\sum_{p<q}\|\mathbf p-\mathbf q\|$; **energy** = mean person
energy; **cx, cy** = centroid of everyone; **armsUp** = mean.

Crowd motion (server, from consecutive frames; velocities $\mathbf v_p=\Delta\mathbf p/\Delta t$
for people seen in both):

- **flowX, flowY** $=\bar{\mathbf v}$; **turbulence** $=\sqrt{\frac1N\sum_p\|\mathbf v_p-\bar{\mathbf v}\|^2}$;
- **moveSync** — mean pairwise cosine similarity $\frac{\mathbf v_p\cdot\mathbf v_q}{\|\mathbf v_p\|\|\mathbf v_q\|}$ over people with $\|\mathbf v\|>0.03$;
- **converge** — $\frac{d}{dt}\mathrm{spread}$, exponentially smoothed ($\alpha=0.15$ per frame); negative = coming together;
- **nearest** — $\frac1N\sum_p\min_{q\ne p}\|\mathbf p-\mathbf q\|$;
- **stillness** — fraction of people with energy $<0.05$;
- **occupancy** — fraction of a $4\times3$ grid over the frame with someone in it.

### Bees ⇄ camera — `/hive/mix` ([mix.ts](server/mix.ts))

Bee positions $\mathbf b_k$ (from the wall, $x$ divided by the aspect ratio so
both pictures are $[0,1]^2$), headings $\theta_k$, and the camera's people,
clusters and flow:

- **distance** $=\|\bar{\mathbf b}-(c_x,c_y)\|$;
- **beesInCrowd** — fraction of bees with $\|\mathbf b_k-\mathbf c_j\|\le r_j+0.04$ for some cluster $j$;
- **queenInCrowd** — the same test for the queen's bee (0/1);
- **covered** — fraction of people with a bee within 0.1;
- **alignment** $=\cos\angle\big(\sum_k(\cos\theta_k,\sin\theta_k),\ (\mathrm{flowX},\mathrm{flowY})\big)$, 0 when the crowd barely moves;
- **balance** $=\dfrac{\#\text{bees}}{\#\text{bees}+\#\text{people}}$.

### The wall's flight model ([client/src/visuals/bees.ts](client/src/visuals/bees.ts))

Not a feature, but it is what the phones see and `/hive/mix` reads. The phone
is a joystick: $\mathbf j=\mathrm{clip}(\mathbf{rel}_{x,y}/4.9,-1,1)$, with the
$y$ axis flipped so tipping the top edge away means *up* on the wall, rotated
by the yaw the phone has accumulated, $\psi=\int\mathrm{turn}\,dt$ (turn
around and your "forward" turns with you). Each animal has a heading $\theta$
and a speed $s$ in world units (height = 1) per second:

$$\dot\theta=\dot\psi+7\,\mathrm{wrap}(\angle\mathbf j-\theta)\,[\|\mathbf j\|>0.08]+\text{edge}+\text{separation}+\text{crowd},\qquad
s\to 0.24\cdot\begin{cases}\|\mathbf j\| & \|\mathbf j\|>0.08\\ \min(1,1.4\,\mathrm{act}) & \text{flat}\end{cases}\ (\tau=0.25\,\text{s}).$$

Edges push back with $(1-d/0.09)^2$ inside a 9 % margin; neighbours within
0.05 turn each other away; with *wall coupling* the nearest camera cluster
turns the animal toward it with strength $\le$ the tilt's. Deterministic: same
input, same path. Note the adaptive zero: a tilt *held* still for a couple of
seconds becomes the new zero and the animal slows to a halt — only change
moves it.

## The wall (`/wall`) and the queen

Open `http://localhost:8080/wall` on the projector; double-click for
fullscreen, `h` hides the panels. Bottom left: the Wi-Fi QR code (if set) and
the join QR code. The swarm is drawn as bees: activity drives speed and wing
beat, turning the phone about the vertical turns the bee, tilt steers; the
edge pushes back softly, bees shrink as the swarm grows. Everything is the
server's `rel` / `activity` / `turn`, so the wall shows what the OSC side hears.
Movement is deliberately simple: tilt forward = go, tilt sideways = turn,
moving about = go; tilting back stops. Until **start** on the dashboard the bees
hover where they spawned.

**Species** (dashboard): *bees* fly and beat their wings; *sheep* walk (legs
swing with the distance covered), face left or right instead of turning, and
when they rest they either lie down or graze — decided by lot each time. The
queen sheep is the big black one with a white rim.

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
server/global.ts     /hive/global — swarm meta-parameters (correlation, phase, tempo, spectrum, entropy …)
server/vision.ts     the camera process's frames: validation, crowd motion, relay to OSC / feed / wall / dashboard
server/mix.ts        /hive/mix — bees ⇄ camera
vision/              Python: hive_vision.py (YOLO11n-pose, tracking, clustering) · start.sh · requirements.txt
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
