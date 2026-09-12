# Swarm Phone Audio Installation — Technical Reference

Audience phones act as motion sensors for a laptop-hosted generative audio piece.
Crowd behaviour (synchrony, spatial distribution) drives neural audio synthesis.
No audio is rendered on the phones.

Context: built for a music-AI hackathon, 11–13 Sep 2026. Laptop is a Lenovo
ThinkPad P16v with an RTX 2000 Ada (8 GB VRAM), dual-boot Linux/Windows.

---

## 1. Core design decisions (settled — do not relitigate)

| Decision | Rationale |
|---|---|
| No metric positioning from phones | Web APIs expose nothing usable indoors. Verified. |
| Camera answers **where**, phones answer **how they move** | Two independent subsystems, no identity association needed between them |
| Phones are sensors only, never speakers | Removes all clock-sync-for-audio requirements |
| 3 zones in a triangle, not a 2×2 or 3×3 grid | Barycentric coords, CPU budget, legible to participants |
| Per-client voices via **batched RAVE**, not per-client plugin instances | One forward pass, batch N. Plugins can't batch. |
| Collective layer via 3× Morpho + custom morph | Morpho sounds better and 3 instances is affordable |

**Never associate camera blobs with phone clients.** It requires a handshake
(shake-to-pair or screen-blink decoding) and buys nothing. The two subsystems
feed different layers.

---

## 2. Architecture

```
phones ──ws──► server ──► one-euro ──► φ, energy, dominant freq
                              │
                              ├──► PLV matrix ──► Louvain ──► K clusters
                              │                               (K ≤ 8)
camera ──► homography ──► per-zone occupancy ──► w_A, w_B, w_C, entropy H
                              │
                              ▼
        ┌─────────────────────────────────────────┐
        │  VOICE LAYER (Python, GPU)              │
        │  per cluster k: features ──► z_k(t)     │
        │  batched RAVE decode (batch K)          │
        └──────────────┬──────────────────────────┘
                       │ K audio streams
                       ├──► ambisonic encode @ cluster centroids ──► array
                       │
                       └──► sum ──► ReaRoute/JACK ──► Reaper
                                                       │
        ┌──────────────────────────────────────────────┘
        │  COLLECTIVE LAYER (Reaper)
        │  3× Morpho (one model per zone) ──► swarm3morph JSFX ──► PA
        └── OSC: zone weights, entropy

projector ──► floor: zone grid w/ live levels
          └─► wall:  PLV graph, force-directed
```

---

## 3. Web client (phones)

### Hard requirements
- **HTTPS is mandatory** for sensor access. Self-signed certs cause permission
  failures and scare participants. Use a `cloudflared` or `ngrok` tunnel — the
  added latency is irrelevant since no audio renders on the phone.
- iOS requires `DeviceMotionEvent.requestPermission()` called **from inside a
  user gesture** (iOS 13+). `DeviceOrientationEvent` has its own separate prompt.
  One button, request both, then connect.
- Acquire a **Screen Wake Lock** or phones sleep mid-piece.

### Available sensors (verified cross-platform)
| API | iOS Safari | Android Chrome |
|---|---|---|
| `DeviceMotionEvent` (accel ±gravity, rotationRate) | yes, ~60 Hz | yes, ~60 Hz |
| `DeviceOrientationEvent` | yes | yes + `deviceorientationabsolute` |
| Compass | `webkitCompassHeading` | absolute orientation |
| Geolocation | useless indoors | useless indoors |
| Generic Sensor API, WebXR, Web Bluetooth, Vibration | **no** | yes (Chromium only) |
| Barometer, Wi-Fi RSSI, UWB | **no** | **no** |

Note: all iOS browsers are WebKit, so Chrome-on-iOS has Safari's limits.

### Client → server message (30 Hz, batched)
```json
{
  "id": "c7f3",
  "t": 1757650000123,        // client ms timestamp
  "seq": 4821,
  "a":  [0.12, -0.03, 0.98], // event.acceleration, gravity removed
  "r":  [1.2, -0.4, 0.1],    // event.rotationRate, deg/s
  "h":  183.4                // compass heading, deg, nullable
}
```
Batch 2 samples per message to halve overhead. JSON is fine at this rate.

### Time sync
Cristian's algorithm on connect, refreshed every 10 s. Target ±30 ms, which is
ample for 0.3–3 Hz signals. Server stores `offset_i` per client and corrects
timestamps on arrival. **Do not build NTP.**

---

## 4. Server

Python. OpenCV and torch are both Python, and Node would mean bridging anyway.

- `aiohttp` or `FastAPI` + `uvicorn` for HTTPS + WebSocket
- Per-client ring buffer: 8 s @ 50 Hz = 400 samples
- Loops, all separate threads/tasks:
  - websocket ingest (event-driven)
  - feature + clustering loop @ 5 Hz
  - camera loop @ 10–15 fps
  - RAVE inference thread (see §7)
  - OSC sender @ 20–30 Hz

---

## 5. Motion feature pipeline

Run per client on `|a|` (magnitude of gravity-removed acceleration).

1. **One-euro filter.** Start `mincutoff = 1.0 Hz, beta = 0.0, dcutoff = 1.0`.
   Tune: lower mincutoff until a phone at rest stops jittering, then raise beta
   (0.01–0.05) until lag during fast motion is acceptable.
   Ref: Casiez, Roussel, Vogel, CHI 2012.
2. **Resample** to a common 50 Hz grid using offset-corrected timestamps.
3. **Band-pass 0.3–3 Hz**, 4th-order Butterworth, causal (`scipy.signal.lfilter`).
   Its phase shift is identical for every client so it cancels in pairwise
   measures — do not use filtfilt.
4. **Instantaneous phase** φᵢ(t): FFT-based Hilbert over a sliding 4 s window,
   recomputed every 200 ms. Sample-rate phase resolution is unnecessary at 1 Hz.
5. **PLV matrix**: `PLV_ij = |mean_t exp(j(φᵢ − φⱼ))|` over the window → weighted
   adjacency. Amplitude-invariant, so pocket vs. hand doesn't matter.
6. **Kuramoto order parameter**: `R = |mean_i exp(jφᵢ)|` ∈ [0,1]. Global
   coherence scalar. Drives Morpho's Serendipity macro.
7. **Dominant movement frequency** fᵢ: autocorrelation over 8 s with parabolic
   interpolation, search 0.3–3 Hz. Plain FFT only resolves 0.125 Hz — interpolate.

### Secondary layer
Envelope correlation (correlate movement *energy* rather than phase) catches
"both active now" vs. "in step". Cheap, useful as a second adjacency.

### Harmonic relations
- Octave-transpose fᵢ into audio: `f_aud = fᵢ · 2ⁿ`, pick n to land in 150–600 Hz.
- Detect small-integer ratios in fᵢ/fⱼ (2:1, 3:2, 4:3, 5:4) → bonus adjacency
  weight, let those pairs fuse voices.

---

## 6. Clustering (this is where bugs will live)

**Louvain** community detection on the weighted PLV graph. Finds K itself;
resolution γ is your live granularity knob. Cap K at 8, merge smallest clusters
into nearest neighbour.

Simpler fallback: threshold PLV at ~0.6, take connected components.

### Stability — all three are required
Louvain is stochastic and **relabels clusters between runs**. Without these the
voices flicker every second and the piece sounds broken:

1. **Label persistence**: match new clusters to previous by maximum Jaccard
   overlap, resolved with Hungarian assignment (`scipy.optimize.linear_sum_assignment`).
2. **Hysteresis**: a client must be assigned to a new cluster for 3 consecutive
   runs before it actually moves.
3. **K cap + merge** as above.

Singletons are **correct**, not a bug. A person moving uniquely should be their
own voice — that is the 1-vs-3-vs-10 distinction the piece is built on.

### Perceptual ceiling
Auditory stream segregation gives out around 4–6 concurrent streams and worse
when timbres are similar. Don't fight this; compose with it. What actually makes
voices separable, in order: **spatial position** (by far), register slot,
onset sharpness, timbre. Timbre is the weakest separator.

---

## 7. Voice layer — batched RAVE

### Model setup
- **Models must be exported with `--streaming`** (cached convolutions). Without
  it you get clicking artifacts and it fails silently. Check this first if
  quality seems bad.
- Verify sample rate (many models are 44.1k, some 48k) and mono.
- Config matters: `v2` is tuned for timbre transfer on stationary signals;
  `v3` adds Snake activation + adaptive instance norm for style transfer.
  v1 checkpoints will disappoint.
- IRCAM's public checkpoints are uneven research artifacts. Neutone FX's
  community RAVE models are vetted and already streaming-exported.
- If using RAVE as a timbre-transfer effect, **compress and gain-stage the
  input**. Much of Morpho's perceived advantage is its non-neural wrapper
  (pre-conditioning, compression, gating, filtering, limiting).

### Batching
One decoder, batch size K, single forward pass. Identity lives in the latent
trajectory, not in separate models.

- RAVE compression ratio 2048 → latent rate ≈ **23 Hz at 48 kHz**, i.e. one
  latent frame ≈ 43 ms. Conveniently near the phone control rate.
- Decode 2–4 latent frames per pass = 85–170 ms of audio.
- **Inference on its own thread with a ring buffer. Never in the audio callback.**

### CPU vs GPU
CPU works (RAVE paper claims 20× realtime single-stream on laptop CPU) and
host↔GPU transfer is negligible at these sizes (~128 KB/pass, ~10 passes/sec).
**Default to GPU on contention grounds**: CPU is already carrying 3× Morpho, the
audio thread, the JSFX, the web server and the camera pipeline. The GPU is idle.
Benchmark both.

### Latent trajectory construction

Do **not** map 3 accelerometer axes to 3 latent dims and zero the rest. z near
zero is the prior mean and decodes to a dull average timbre.

```
z_k(t) = z_base(t + φ_k) + Σ_m u_km · d_m
```

- **`z_base(t)`** — encode a loop of source audio through the RAVE encoder once,
  offline. Keep the latent sequence. Guaranteed on-manifold and alive.
- **`d_m`** — direction vectors from PCA over the latents of your encoded corpus.
  First few PCs are perceptually meaningful (PC1 ≈ brightness/loudness); raw
  latent dims are arbitrary. Map: movement energy → PC1, dominant freq → PC2.
- **`φ_k`** — phase offset set from the client's movement phase φᵢ. **This is the
  key mechanism**: clients moving in sync sit at the same point in the shared
  trajectory and their voices converge in timbre automatically. Synchrony
  becomes timbral unison with no explicit rule.

Constraints:
- Keep ‖z‖ within ±3σ (RAVE latents are ≈ unit-normal). Beyond that gives
  artifacts, occasionally usable ones.
- **Smooth z hard.** At 23 Hz, jumps in z are audible glitches. One-euro the
  latent or slew over 100–300 ms.

### Morphing between RAVE models
Not possible directly — independently trained models have unrelated latent
spaces, so there is no correspondence to interpolate along. Encoding with one
and decoding with another produces garbage.

The principled version: fine-tune several models from **one common checkpoint**,
then linearly interpolate weights (linear mode connectivity / model soups).
Runtime cost is trivial — keep state dicts as GPU tensors, `torch.lerp` with
barycentric weights, evaluate via `torch.func.functional_call` so the module
never reloads. But fine-tuning is hours-to-days of training. Post-hackathon.

**AFTER** (ACIDS-IRCAM, diffusion-based) is the off-the-shelf version: timbre is
an explicit static embedding vector inside one model, so interpolating it is
genuine timbre morphing, and it disentangles pitch from timbre better than a VAE.
Heavier than RAVE; batching a dozen voices on 8 GB is unproven. Post-hackathon.

---

## 8. Camera → zone occupancy

- **Homography**: tape 4 known floor points, click in image,
  `cv2.getPerspectiveTransform` → top-down floor plan.
- **MVP** (~1 h): MOG2 background subtraction, warp the mask, sum foreground
  pixel mass per zone. Gives proportions, which is all that's needed.
- **Upgrade** (~3 h): YOLO person detection, use **bottom-centre of bbox** as the
  ground contact point, warp through the same homography.

> **CONFLICT**: projecting the grid onto the floor breaks MOG2 — projection
> changes register as foreground motion. Either use YOLO detection, or project
> on a wall. Decide early, it constrains both subsystems.

### Weights and evenness
```python
p = (counts + 0.5) / (counts.sum() + 0.5*K)   # Dirichlet smoothing, small N
g = np.sqrt(p)                                 # equal-power gains
H = -(p * np.log(p)).sum() / np.log(K)         # normalised entropy
```
- `sqrt(p)` not `p` — layers are partially correlated, proportional gains duck
  the total level when the crowd spreads.
- Gain floor ≈ −40 dB so zones don't hard-gate. Slew 1–2 s.
- **Ambient trigger**: smoothstep above H ≈ 0.85, with **dwell + hysteresis**
  (rise after 5 s above, fall after 3 s below). Entropy is noisy and upward-biased
  at small N; without hysteresis the ambient model flickers. Hysteresis turns
  evenness into an event people can feel arriving.

Note: with the barycentric morph, perfectly even spread already lands at the
centroid of the morph simplex — an in-between timbre belonging to no zone. That
*is* an ambient state, produced by geometry. A separate ambient model makes it a
discrete event instead. Both defensible; decide by ear in the room.

---

## 9. Collective layer — Reaper

```
source ──┬──► Morpho A (model 1) ──► mono send ──► ch1 ┐
         ├──► Morpho B (model 2) ──► mono send ──► ch2 ├─► swarm3morph ──► PA
         └──► Morpho C (model 3) ──► mono send ──► ch3 ┘
```

- Morpho facts: one model per instance, **no model-to-model blending**. Macro
  Mode = 4 per-model knobs (incl. Serendipity/randomness). Micro View exposes the
  model's 6 latent variables as offsets/scales. Has Mix (dry/wet), pitch shift,
  filter, delay, compressor, gate, limiter. Processes audio directly, not MIDI.
  Free tier ships 5 models. *Unverified: whether Micro View latents are
  automatable host parameters — check Reaper's FX parameter list.*
- Morpho preserves the source's rhythm, pitch contour and dynamics, so all three
  instances produce **time-aligned** output following the same performance. This
  is what makes the morph stage work.
- `swarm3morph.jsfx` — 3-way multiband envelope-transplant morph. Weighted
  geometric mean of per-band envelopes transplanted onto the weighted sum.
  See file header for routing and tuning. Key knobs: envelope smoothing
  (20–40 ms), morph character (0.7–0.9), band count.
- OSC → Reaper: `/fxparam/N/value`. Rate-limit 20–30 Hz. **Slew weights
  server-side over 1–2 s** — the JSFX does not smooth them.
- Source for Morpho: sum of the RAVE voices (so the collective sound is literally
  made of the individuals), and/or a room mic, and/or a resonator bank.
  If Morpho models want pitched sustained input, a room mic alone won't work.

### Python → Reaper audio
- Linux: PipeWire or JACK. Easier — prefer this side of the dual boot.
- Windows: **ReaRoute** (built into Reaper, 16 ch each way, ASIO latency,
  openable from `sounddevice`).

---

## 10. Projection

- **Floor**: zone triangle, each zone's brightness/saturation tracking its live
  gain; ambient state as a wash. Makes the evenness rule playable rather than
  mysterious.
- **Wall**: PLV graph, force-directed layout with edge weights as spring
  constants. People in sync visibly cluster. This is the feedback loop that makes
  participants play the game — build it early, it's cheap (canvas + the
  WebSocket state you already have).

---

## 11. Gotcha checklist

- [ ] RAVE models exported with `--streaming` — else silent clicking artifacts
- [ ] RAVE sample rate matches host; input is mono
- [ ] Louvain label persistence + hysteresis — else voices flicker every second
- [ ] Degenerate barycentric denominators (`w_A + w_B → 0`) — clamp with epsilon
- [ ] Floor projection vs MOG2 conflict — pick detection or wall projection
- [ ] iOS `requestPermission()` must be inside a user gesture
- [ ] Screen Wake Lock acquired
- [ ] z smoothing — unsmoothed latents at 23 Hz glitch audibly
- [ ] RAVE inference off the audio thread
- [ ] Entropy hysteresis — else ambient model flickers
- [ ] Zone gain floor + 1–2 s slew
- [ ] CPU headroom: 3× Morpho + JSFX + audio thread + server + camera

---

## 12. Build order

1. **Phones → WebSocket → laptop.** One-euro, per-client energy, global mean →
   OSC → one Morpho macro. Room mic through Morpho to PA. Full chain end-to-end
   with 2 phones and ugly numbers.
2. **PLV matrix, Kuramoto R, Louvain + stability.** Projected graph.
3. **Camera zones + entropy → 3× Morpho weights → swarm3morph.**
4. **Batched RAVE voice layer**, latent trajectories per cluster.
5. Stretch: ambisonic encoding at cluster centroids; harmonic ratio detection.

Layers 3 and 4 are independent — either can ship alone if the other doesn't come
together.

---

## 13. Open decisions

- Separate ambient model vs. accepting the simplex centroid as the ambient state
- Room mic vs. RAVE-voice-sum vs. resonator bank as Morpho's source
- Whether Morpho's Micro View latents are host-automatable
- Whether to encode voices ambisonically (IEM array) or stay stereo
