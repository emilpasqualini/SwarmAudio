# morpho — four Neutone models in parallel, played by the swarm

Four neural audio models run at once on a single input, each with the pre- and
post-conditioning the Neutone Morpho plugin puts around its model, mixed into
one output. The input is either a microphone or a built-in synth that gives
every phone in the room its own voice. Every knob can be driven by the OSC the
HIVE backend sends, protocol v3.

This is the collective layer of the piece (`CLAUDE.md` §9) as one process rather
than a rack of plugin instances in a DAW.

## Install and run

```bash
pip install -r requirements.txt
python morpho_rack.py
```

```bash
python morpho_rack.py --input synth --default-routing   # the installation
python morpho_rack.py --input mic                       # the room
python morpho_rack.py --input both                      # room plus voices
python morpho_rack.py --scale free --queen-mode loudest
python morpho_rack.py --chain voice --block 512
python morpho_rack.py --list-models
python morpho_rack.py --no-gui --preset live.json --routing live.json
```

## Official Neutone models

The library tab lists all 48 official Neutone models. Select one and press
`→ slot N` to download and load it in one step; they land in `models/` and
`models/index.json` ships as a snapshot of the catalogue. `--list-models` shows
the same list on the terminal, `--refresh-library` re-scrapes it.

The index comes from <https://neutone.ai/fx/models>, which carries every model's
metadata as JSON in the page, and the files are content-addressed by `model_id`
in Neutone's public bucket. Neither is a documented API, so both may break and
everything here fails soft.

Those models predate three things the current SDK does, and all three had to be
handled or every official model loads nameless and with no parameters: they
carry no embedded `metadata.json`, only an exported method (and the older ones
have `to_metadata` but not `get_metadata_json`); their parameter type is `knob`,
not `continuous`; and `used` and `default_value` are strings.

**Morpho's own bundled models cannot be used here.** They sit in
`%APPDATA%/Neutone/NeutoneMorpho/resources/models` as content-hash files, but
they are encrypted: 7.999 bits of entropy per byte and no archive signature
anywhere in them. Only the plugin can read them. What does work is any `.nm`
file — the official FX library above, anything you train in Neutone Cocoon, and
anything you export yourself with the SDK's `save_neutone_model`.

## What feeds the models

A radio on the top bar: **mic**, **synth**, **both**, **file**, **test**. They
are gains rather than a switch, so `both` is a real blend, and `input.mic` and
`input.synth` are in the registry, so the swarm can crossfade between the room
and itself. Switching needs no restart: the rack opens a duplex stream when it
can and falls back to output-only when there is no input device.

### The synth

One voice per client. A voice is a sine with three controls:

| control | meant to come from |
|---|---|
| level | that client's `activity` |
| pitch | that client's `turn`, turning on the spot |
| roughness | that client's `\|rel\|`, how far from rest |

**Roughness** is the psychoacoustic sense: amplitude modulation in the 20–70 Hz
band, which the ear hears as grating rather than as tremolo. At zero the voice
is a clean sine, 74 dB down to the next partial.

**Scale** is a dropdown, and **free** means no quantising at all — pitch follows
the sensor continuously, glissando rather than notes. The others (chromatic,
major, minor, pentatonic, whole tone) snap to a root you choose.

A client that leaves stops sending, so a voice whose level has not been written
for `timeout` seconds fades out; `/hive/leave` frees it immediately. Without
that the last activity value sticks and the voice drones forever.

Sixteen voices cost 3.9% of the real-time budget.

### The queen

`/hive/queen` carries a uid and a slot, and the slot picks the voice. Seven ways
for her to take precedence, switchable live:

| mode | what it sounds like |
|---|---|
| **off** | she is just another voice |
| **loudest** | she rises a little, everyone else drops a lot — about 23 dB apart at full amount. The bluntest, and the one that reads from the back of a room |
| **duck** | the others duck only *while she moves*, so she carves a hole by moving rather than by existing |
| **solo** | only her voice feeds the models; the piece becomes a portrait of one person |
| **tuning** | her pitch becomes the root everyone else is quantised to. She decides the key without being louder — the subtlest one, and the one people work out for themselves |
| **harmony** | everyone else snaps to an octave or a fifth of her pitch. The crowd becomes her chord |
| **drone** | she is held an octave down as a sustained pedal and never times out. The crowd plays over a bass note that is a person |

`queen_amount` scales all of them and is itself OSC-routable, so the crown can
tighten as the room synchronises.

## Routing the swarm

Protocol v3 has five families and the osc tab groups both lists by them:

- **swarm** — how *much* the crowd moves. Loudness and brightness.
- **global** — how it moves: alike, in step, what rhythm, everyone or a soloist.
- **camera** — what the room looks like from the webcam.
- **mix** — where the bees on the wall and the bodies in the room meet.
- **client N** — one phone, and so one voice.

Picking `client 3` pre-selects `synth voice 3`. **learn** binds the next address
that arrives. **use seen** fills the input range from what an address actually
sent in the room, which beats guessing and is the difference between a fader
that sweeps and one pinned at an end.

**load defaults** installs 45 routes:

| from | to | why |
|---|---|---|
| client N activity / turn / \|rel\| | voice N level / pitch / roughness | the three things a person can feel themselves doing |
| global coherence | master reverb mix, inverted | together is dry and close |
| global phaseSync | slots 2–4 level | in step brings the others into unison |
| global entropy | synth detune | a soloist thins the bank |
| global tempo | slot 1 compressor release | the conditioning breathes at the crowd's pulse |
| global crest | slot 1 gate threshold | a spiky room gates harder |
| swarm energy | every slot's input high cut | harder movement opens the sound |
| swarm motion | every slot's first model parameter | turning stirs the latent |
| swarm count | master reverb size | more people, bigger room |
| cam spread | master reverb pre-delay | a crowd coming together closes the space |
| cam armsUp | master level | |
| cam stillness | synth level | a still room quietens |
| cam occupancy | slot 1 dry/wet | |
| mix covered | slot 1 reverb | the two subsystems agreeing is worth hearing |

`coherence` is used rather than `swarm/sync` because it is a real correlation of
movement rather than of how hard people happen to be turning. Camera routes cost
nothing when no camera is attached, since nothing arrives on those addresses.

Measured on a fake crowd that synchronises halfway through a run: reverb mix
0.52 → 0.05, slot 2 −40 dB → −3 dB, reverb pre-delay 48 ms → 19 ms.

The default slews are 3 to 8 seconds on purpose, so the installation drifts
rather than jumps. `slew` is seconds to travel the full output range.

## Conditioning setups

Five, applied to one slot or all four: **clean** (gain-staging only, the
default), **voice**, **percussive**, **drone**, **bypass**.

**link all slots** makes every chain edit apply to all four, through OSC as well
as the window. **copy** and **paste** move one slot's whole chain onto another
or onto all of them, for when you want them mostly alike but not identical.

`CLAUDE.md` §7 says most of Morpho's perceived advantage over a bare model is
this wrapper rather than the network, and that is right. The **compressor** is
on in every setup, because RAVE encoders were trained on level-consistent
material and a quiet or wildly dynamic input decodes to mush. The **noise gate**
is on the output because neural decoders idle audibly — given silence, RAVE
still decodes its prior into a faint wash, and four of those on a PA is a real
noise floor.

```
in → pitch shift → feedback delay → compressor → filter → MODEL
   → noise gate → limiter → filter → reverb → dry/wet → level → sum
                                       master reverb → master limiter → out
```

## What it costs

The top bar carries a block-size box and a live graph with two traces: the red
one is how much of a block's budget the audio work takes, the blue one how much
of the machine the whole process takes. They answer different questions — the
first says whether the stream is about to break up, the second whether there is
room for the backend, the camera and the projector on the same laptop.

**One torch thread per model is the default, and it is measurably the best.**
The four slots already run in parallel, so intra-op threads only add
synchronisation. Four RAVE models with eight voices and the clean chain:

| torch threads | block budget | machine CPU |
|---|---|---|
| 1 | 18% | 15% |
| 2 | 21% | 33% |
| 3 | 24% | 52% |
| 5 | 35% | 89% |

Percentage of the real-time budget for four models, by block size. Under about
70% is comfortable.

| configuration | 512 | 1024 | 2048 |
|---|---|---|---|
| models only | 48% | 40% | 29% |
| plus the compressor (the default) | 57% | 44% | 32% |
| plus filter, gate, limiter, master reverb | 67% | 51% | 36% |
| every effect on all four slots | 123% | 72% | 52% |

That is `conv1d-overdrive.random`, the heaviest in the library. **Block size
defaults to 1024** because at 512 the full chain does not fit; changing it in
the app restarts the stream and re-tells every model, which takes a moment. The
per-slot reverb is the most expensive single effect and is off by default —
prefer the master reverb, one instance instead of four.

## How it works

- **Inference never runs in the audio callback.** The callback only moves blocks
  between two queues; models and effects run on a worker thread with the four
  slots on a thread pool. This is the `CLAUDE.md` §11 rule.
- **The four slots are time-aligned.** Each model reports its buffering and
  algorithmic delay and every slot is delayed up to the slowest, so the four
  land on the same sample. Without this the mix smears, which defeats a morph
  stage. Each slot's dry path is delayed by its own latency too.
- **The parameter registry is cached.** OSC calls `set_param` for every routed
  message and a busy room sends about a thousand a second; rebuilding two
  hundred closures each time burned more CPU than all four models together and
  starved the worker into underruns. Caching it was a 547x speedup on that path.
- **Each OSC route keeps its own clock.** Sharing one across the table makes a
  slew depend on how much *other* traffic arrives, so a busy room would crawl
  every fader to a fraction of its setting.
- **Models are warmed up before the stream opens.** A TorchScript module's first
  passes do lazy allocation and run several times slower; live that lands as a
  burst of underruns. Paid up front it costs 170 ms once.
- **Gain changes are continuous across block boundaries.** The dynamics detect
  at 32-sample chunk rate and interpolate back up, anchored on the previous
  block's gain. Without the anchor the ramp restarts every block and puts a step
  in the gain at the block rate, an audible buzz at 94 Hz.
- **The rack is CPU-only.** The Neutone wrapper keeps its queues and I/O buffers
  as plain tensors rather than registered buffers and reallocates them whenever
  the sample rate is set, so `.to("cuda")` moves the weights but not the
  plumbing and inference fails on a device mismatch.

## Known limits

- Sample rate conversion is the wrapper's own. A model whose native rate differs
  from `--sr` resamples, which adds latency; the status line reports the total.
- `/hive/sample` and `/hive/cam/person` are not offered as routing sources. Both
  carry one message per subject with the identity inside, so routing either at a
  knob means every phone or every person writes the same one and the last wins.
- Synth voices are addressed by client slot, so voice 3 is whoever holds slot 3.
  Slots are reused when someone leaves, which is the backend's design.
- The pitch shifter is a two-tap crossfading delay line. It adds no latency and
  its artefact is a mild warble, not the smearing a phase vocoder gives.
- Processing width is mono by default (`--channels`). Output is always stereo.
