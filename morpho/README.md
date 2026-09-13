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
python morpho_rack.py --personal --assign "queen apart"  # a model per phone
python morpho_rack.py --input mic                       # the room
python morpho_rack.py --input both                      # room plus voices
python morpho_rack.py --scale free --queen-mode loudest
python morpho_rack.py --chain voice --block 512
python morpho_rack.py --list-models
python morpho_rack.py --list-devices                    # indices for the next line
python morpho_rack.py --in-device 18 --in-channel mix --out-device 15 --out-channel 1
python morpho_rack.py --no-gui --preset live.json --routing live.json
```

## The window, control by control

The window has three rows at the top that stay visible, and five tabs: **rack**,
**synth**, **chain**, **osc** and **library**. Every fader shows its name and
current value on the left, and moves on its own when OSC or a preset changes it.
A fader you are dragging is left alone until you let go.

### Top bar

| control | what it does |
|---|---|
| **start** / **stop** | Opens or closes the audio stream. Loaded models are warmed up first, so starting takes a moment. |
| **reset** | Clears the internal state of every model, effect and synth voice. Use it if a model gets stuck or starts to howl. While running it happens between two blocks. |
| **feed the models:** mic · synth · both · file · test | What the models hear. **mic** is the audio input, **synth** the per-phone voices, **both** the two mixed, **file** a looped wav given with `--file` (there is no picker for it), **test** a slowly swept tone with a little noise. Switching needs no restart. |
| **save preset** | Writes every parameter in the rack, and which model is in each slot, to a JSON file in `presets/`. The OSC routing is saved separately, on the osc tab. |
| **load preset** | Loads such a file: the models, then every parameter. |
| status line | `stopped`, or `running`, then what feeds the models, the block size in samples, the models' latency, **load** (how much of each block's time the audio work takes), **underruns** (blocks the sound card asked for before they were ready, heard as dropouts) and **clips** (blocks still over full scale after the master limiter, which only happens with it switched off). `mic (no input device)` means the mic is selected but no input could be opened. |

| second row | what it does |
|---|---|
| **block** 128 … 4096 | Audio block size. Larger is safer on the CPU and adds latency; the text beside it gives the block length in milliseconds. Changing it restarts the stream. |
| **networks on cpu** | Where the models run, set with `--device`. |
| **osc address ▸ hover or click** | This laptop's address for the backend's dashboard, hidden in case the window is on a projector or in a screenshot. Hover to see it, as `osc to 10.193.123.139:9001`; click to keep it shown, click again to hide; double-click to copy the first address to the clipboard. With several network interfaces, each address is listed, the one that reaches the LAN first. `(not listening)` means the osc tab's **listen** is off. The address is re-read every few seconds, because it changes when the laptop changes network. |
| **budget N%  cpu N%** and the graph | Red: the load figure from the status line, over the last minute and a half. Blue: how much of the whole machine this process uses. The grey line is 70% of the budget, comfortable; the pink line is 100%, where dropouts start. The graph scale goes to 150%. |

| third row: audio devices | what it does |
|---|---|
| **in** | The input device. **(no input)** opens none, so nothing waits on a microphone; the synth, file and test sources still work. Then each device once, labelled `name · host API · channels`: ASIO drivers first, then WASAPI. MME, DirectSound and WDM-KS are left out because they list the same hardware again with more latency; a device that has an ASIO driver is shown only as ASIO. Until you pick one, the rack uses the device Windows has set as default, and that one is shown selected. WASAPI devices set to a rate other than 48 kHz still open, because Windows converts the rate. `(not at this sample rate)` means a device refuses `--sr` even so (only possible with ASIO). Choosing a device while running restarts the stream; if it will not open, an error says so and the previous device stays in use. |
| **in** channel | Which input channel feeds the models: **mix** averages all of the device's inputs, or pick one channel (pairs with `--channels 2`). A mono mic on a stereo rack only offers mix. Greyed out with no input. |
| input meter | The input's peak level, before anything in the rack touches it: green to −12 dB, yellow to −3 dB, red above. The white line holds the recent peak. The square on the right lights red when the input reached full scale and stays lit until you click the meter. It works whatever feeds the models, so you can check the mic while the synth plays. |
| input level text | The meter in numbers. `below -60 dB` is quiet but alive. **silent (muted?)** means the device delivers exact zeros, which a real microphone never does: a mute key, a zeroed input level in Windows sound settings, or microphone access switched off. `no input` means the device failed to open (the reason is at the end of the row); `input off` means **(no input)** is chosen. |
| **out** and its channel | The output device and the pair of outputs the master goes to (1-2, 3-4, … on a multichannel interface). |
| output meter | The master's peak after the limiter, with its own clip light (click to clear). It reads empty below −60 dB. |
| **rescan** | Looks for interfaces plugged in after start. The stream stops for a moment, the devices in use are found again by name, and it restarts. If one has gone, the system default takes over and a message says which. |
| note at the end | `in and out share one clock` (one duplex stream, the best case), `in and out on separate clocks` (input on ASIO, output on WASAPI or the other way round, so each gets its own stream; the clocks drift by a few parts per million, heard as a rare click many minutes apart; pick both on the same host API to avoid it), `output only`, or why the input would not open. |

The devices and channels are remembered in `presets/audio.json`, by name rather
than by index, since indices move when anything is plugged in. They are used at
the next start unless `--in-device` or `--out-device` is given.

### rack tab

**Each slot strip**, top to bottom:

| control | what it does |
|---|---|
| **slot N** | The frame title. |
| model name, bold | The loaded model, or `empty`. |
| grey info line | Mono or stereo input, the model's latency in samples and milliseconds, and where it runs: `cpu`, `gpu`, or `cpu (gpu refused: …)` with the reason. Shows `no model`, `loading...`, or the error if a load failed. |
| model picker | Every model downloaded through the library tab. Picking one loads it into this slot. |
| **file...** | Load any `.nm` file from disk. |
| **clear** | Unload the model. |
| **on** | Untick to silence the slot. It keeps running, so ticking it again is instant and stays in time. |
| **solo** | When any slot is soloed, only soloed slots are heard. |
| **input** all · queen · crowd · off | What this slot listens to. **all** is whatever *feed the models* selects; **queen** and **crowd** are the two halves of the synth used by queen split; **off** is silence. Greyed out in *one model per client* routing, where the slots are templates. |
| **cam** bar and `cam +N dB` | The gain the camera section is applying to this slot right now. `cam -` means no camera data is arriving, so no camera gain is applied. |
| **level** | The slot's fader, −40 to +12 dB. The camera gain comes on top of it. |
| **dry/wet** | 0 is only the slot's input, delayed to line up with the model; 1 is only the model. Starts at the model's own default. |
| **pitch** | The pre-chain's input repitch, surfaced here because moving the source into a model's register decides whether the model answers at all. ±36 semitones (÷8 to ×8); past about two octaves the grain repetition of the shifter becomes audible texture. The same knob as on the chain tab, and it follows **link all slots** there. |
| **repitch** + **auto** | The tick enables the repitch. **auto** probes the model: a private copy is loaded (playback is untouched) and fed a tone with a slow 5 Hz swell, every 3 semitones across ±2½ octaves around the register the connected voices are singing in. Each step is scored not by loudness — a model pushed out of its register does not go quiet, it drones loudly on its own, which is exactly the wrong answer — but by whether the output still *follows* the input: how strongly the 5 Hz swell shows in the output's envelope, times how much of the output's energy stays within an octave of the probe tone. The winning step becomes the pitch setting, the repitch is switched on, and the grey text reports it, e.g. `+27 st → 1244 Hz (4.2×)` — the × is peak score over median. `flat response` means no register followed better than the rest and nothing is changed. Takes some seconds; only this slot is set, even with *link all slots* on. |
| model parameters + **auto** | One fader per parameter the model declares, 0 to 1. For RAVE models these are usually Chaos, Z edit index, Z scale and Z offset; DDSP models have pitch shift and harmonic, noise and reverb mix. Models without parameters show `no parameters`. **auto** under the faders searches these knobs with the same follows-the-input score as the repitch auto, at the register the repitch delivers — so run the repitch auto first. Coordinate descent from the current values (coarse sweep per knob, then a finer one around each winner), so the result is never worse than where the faders stand; `already good, left as is` means exactly that. The winners slew in like a fader move. A knob an OSC route drives (the default routing drives p1 from swarm motion) is taken over again by the route. |
| meter, bottom | The slot's output level, on a decibel scale covering the top 60 dB. |

**Below the slots:**

| control | what it does |
|---|---|
| **routing** shared · queen split · one model per client | How the synth voices reach the models. **shared**: every slot hears the input mixer. **queen split**: the queen's voice goes to slots 1 and 3, everyone else's to 2 and 4, levels matched. **one model per client**: every phone gets its own copy of a model. The grey text explains the current choice. See the sections further down. |
| **camera sections set slot levels** | When ticked, each slot's level follows how many people the camera sees in its section of the picture. |
| layout: columns · quadrants | **columns** cuts the picture into four strips, left to right, for slots 1 to 4. **quadrants** cuts it into a 2×2 grid: top left, top right, bottom left, bottom right. |
| **depth** | 0: the camera has no effect. 1: its full effect. |
| **empty section** | How far a slot drops when nobody stands in its section, −60 to 0 dB. Default −30. |
| `source: …   people per section: …` | Where the head count comes from (`people`, `clusters`, or `none`) and how many people are in each section. |
| **level**, bottom row, and its meter | The master level after all four slots, −40 to +12 dB, and the master output meter. |

**Only in *one model per client* routing**, a further row appears:

| control | what it does |
|---|---|
| **clients get** round robin · one model · queen apart | Which slot's model a phone gets. **round robin**: phone N uses the Nth loaded slot, wrapping around. **one model**: every phone uses the first loaded slot. **queen apart**: the queen's voice goes to a separate copy of the first loaded slot's model; everyone else is spread over the other slots. |
| **private models** | The most copies that may exist, 1 to 16, default 6. Phones past the limit share one copy per slot. |
| `N private model(s) running, N loading, N spare` | How many copies are playing, how many are still loading, and how many are loaded in reserve for the next phone to join. `FAILED` and a reason appear if a copy could not load. |

The camera sections' slew time (1.5 s) has no fader; route `zones.slew` over OSC
to change it.

### synth tab

| control | what it does |
|---|---|
| grey text, top | A reminder of what a voice is. |

**bank**, settings shared by every voice:

| control | what it does |
|---|---|
| **level** | The whole synth's output, −40 to +12 dB. |
| **glide** | How long a voice takes to slide to a new pitch, 0 to 2 s. |
| **scale** | The same setting as the **scale** dropdown below, shown as a number: 0 free, 1 chromatic, 2 major, 3 minor, 4 pentatonic, 5 whole tone. Use the dropdown. |
| **root note** | The key the scale is built on, as a MIDI note number from 24 to 72. 45 is A2, 48 is C3, 57 is A3. |
| **detune** | Spreads the voices apart by up to 50 cents: odd-numbered voices go down, even-numbered ones up. A thicker, beating sound. |
| **voice timeout** | How many seconds a phone may send nothing before its voice goes silent. If the backend sends no roster, the phone also counts as having left and its row disappears. |
| **scale** dropdown | **free** turns quantising off completely, so pitch follows the phone continuously. The other five snap each voice to the nearest note of that scale. |
| `N client(s) connected, M sounding` | Phones present, and how many of their voices are making sound. |

**the queen:**

| control | what it does |
|---|---|
| **precedence** | How the queen stands out: off, loudest, duck, solo, tuning, harmony or drone. The grey text underneath describes the chosen mode; the table in *The queen* below covers all seven. |
| `voice N (uid …)` | Who holds the crown, or `no queen`. |
| **queen amount** | How strongly the mode applies, 0 to 1. |

**who is here**, one row per connected phone:

| column | shows |
|---|---|
| **voice** | `voice N`, the phone's slot number on the backend. |
| **who** | The name and uid, or `(no roster yet)` before the backend has named the phone. The queen's row starts with ♛ and has a yellow background. A greyed row is a phone that has left and is fading out. |
| **phone** | ios, android or other. |
| **level** | A 20-step bar of the voice's loudness, driven by that phone's activity. |
| **pitch** | The voice's pitch in hertz, before any scale snapping. |
| **rough** | Roughness, 0 to 1. |
| **into** | In queen split routing, whether this voice currently feeds the `queen` or the `crowd` models. `-` otherwise. |
| **own model** | In one model per client routing, the model this phone has: its name, `loading`, `waiting`, `(shared)` when the phone is past the private-model limit, or `queen's model` while it wears the crown under queen apart. |

### chain tab

The conditioning around the models: what happens to the sound before a model
hears it and after it comes out.

| control | what it does |
|---|---|
| **slot:** 1 · 2 · 3 · 4 | Which slot's chain is shown. |
| **setup:** clean · voice · percussive · drone · bypass | A ready-made chain. The grey line underneath says what the selected one is for. Nothing changes until you press one of the next two buttons. |
| **this slot** | Apply the selected setup to the slot shown. |
| **all slots** | Apply it to all four. |
| **link all slots** | When ticked, every edit to any slot's chain is made on all four, including edits made over OSC. Ticking it first copies the shown slot's chain onto the other three. |
| **copy** | Remember the shown slot's whole chain. |
| **paste** | Put the remembered chain onto the shown slot. Greyed out until you copy. |
| **paste to all** | Put it onto all four slots. |

Below are three columns in signal order, top to bottom: **into the model**
(pitch, delay, compressor, filter), **out of the model** (gate, limiter, filter,
reverb) and **master** (reverb, limiter, shared by the whole rack). Each box has
an **enabled** tick and its faders:

| effect | faders |
|---|---|
| **pitch** | **pitch** −24 to +24 semitones · **mix** of shifted and original, 0 to 1 · **grain** 20 to 120 ms: longer is smoother on small shifts and smears more on large ones |
| **delay** | **time** 10 ms to 2 s · **feedback** 0 to 0.95, how many repeats · **mix** of echoes added, 0 to 1 · **damping** 500 Hz to 20 kHz, repeats get darker each time round |
| **compressor** | **threshold** −48 to 0 dB, where it starts working · **ratio** 1:1 to 20:1, how hard · **attack** 0.5 to 200 ms · **release** 10 ms to 2 s · **knee** 0 to 24 dB, how gradually it starts · **make-up** −12 to +24 dB, gain afterwards |
| **filter** | **low cut** 20 Hz to 2 kHz, off at 20 Hz · **high cut** 500 Hz to 20 kHz, off above 19 kHz · **resonance** 0.5 to 4, a peak at both cut-offs |
| **gate** | **threshold** −90 to 0 dB, quieter than this closes it · **attack** 0.1 to 100 ms, how fast it opens · **release** 5 ms to 2 s, how fast it closes · **range** −90 to 0 dB, how far it closes |
| **limiter** | **ceiling** −24 to 0 dB, nothing passes above it · **release** 10 ms to 1 s |
| **reverb** | **mix** 0 to 1 · **size** of the room, 0 to 1 · **damping** 0 to 1, a darker tail · **width** 0 to 1, stereo spread, only with `--channels 2` · **pre-delay** 0 to 200 ms before the reverb starts |

### osc tab

**Top row:**

| control | what it does |
|---|---|
| **receive port** | The UDP port to listen on, default 9001. Must match the target set on the backend's dashboard. |
| **listen** / **stop** | Start or stop receiving. Changing the port needs a stop and a listen. |
| `listening on …` | The port, packets received so far, how many different addresses have arrived, and decoding errors. `not listening` otherwise. |
| **what to send** | Opens a window listing which OSC switches on the backend dashboard this routing needs on, which can go off, and roughly how many messages a second that saves. |
| **load defaults** | Replaces the routing with the built-in one. Asks first if routes already exist, then lists what it installed. |
| **load routing** / **save routing** | Load or save the routing table, and the port, as JSON in `presets/`. |

**arriving**, left:

| column | shows |
|---|---|
| **swarm / client** | Every address that has arrived, grouped: swarm, global, camera, mix, client 1, client 2 … events, other. |
| **values** | The first four numbers of the latest message. |

Click an address to put it into the editor below the routing list.

**routing**, right, one row per route, grouped the same way. Each group header
shows how many routes it holds.

| column | shows |
|---|---|
| **from** | The OSC address. |
| **arg** | Which number in the message is used, counting from 0. |
| **controls** | The parameter it drives, as a key such as `slot1.pre.filter.lp`. |
| **in -> out** | The input range mapped onto the output range. |
| **now** | The value the route most recently sent. |

Click a single route to load it into the editor. To select several,
ctrl-click or shift-click them; click a group header to take every route in that
group; press **ctrl+A** in the list to select all. Several selected are for
removing, not editing, so the editor stays as it was.

**The editor**, under the routing list:

| control | what it does |
|---|---|
| **from** group dropdown | swarm, global, camera, mix and client 1 … 16 are always listed, with the documented range for every address; events and anything undocumented appear once something from them has arrived. Picking **client N** also switches **controls** to **synth voice N**. |
| address | The addresses in that group. Picking one fills in **arg** and a sensible input range, and the grey line underneath says what the value means and its units. You can also type an address. |
| **arg** | Which number in the message to use, counting from 0. |
| **learn** | Press, then move a phone or wave at the camera: the next address carrying a number fills in **from** and **arg**. Shows `...` while waiting. Needs **listen** on. |
| **controls** group dropdown | The group of parameters: input, synth, synth voice N, slot N and its model and effects, master, routing, camera sections, personal models. |
| parameter dropdown | The parameter within that group. Picking one fills **out** with its full range. |
| **in** low, high | The input range. Values outside it are held at its ends. |
| **use seen** | Fill **in** with the lowest and highest values this route has actually received. For an address not routed yet, it uses the latest value, widened to at least 0 to 1. |
| **out** low, high | The output range, in the parameter's own units, dB for levels and Hz for filters. Putting the higher number first reverses the direction. |
| **full** | Fill **out** with the parameter's whole range. |
| **invert** | Flip the mapping: the top of the input gives the bottom of the output. |
| **slew s** | Seconds to travel the whole output range, which smooths a jumpy sensor. 0 is instant. |
| **add / update** | Save the route. A route with the same address, arg and parameter is updated; otherwise a new one is added. |
| **remove** | Delete every route selected in the routing list, including all routes under a selected group header. Asks first when more than one would go. The **Delete** or **Backspace** key does the same while the list has focus. |

### library tab

| control | what it does |
|---|---|
| **refresh list** | Fetch the current model list from neutone.ai. Needs internet. The list in `models/index.json` works offline. |
| **download selected** | Download every selected model into `models/`, one after another. Pressing it again while a batch runs only adds models not already queued; a model is never downloaded twice at once. |
| **cancel** | Stop the batch: the file in progress is abandoned and the rest are dropped. Greyed out when nothing is downloading. |
| **-> slot 1** … **-> slot 4** | Download the selected model if needed, then load it into that slot. With several selected, they go into that slot and the slots after it, in list order; any past slot 4 are only downloaded. |
| status text | `48 models, N downloaded`; during a batch, `downloading 2 of 5:` with the model name and MB so far; afterwards `done` or `cancelled` with a count. |
| **model** · **MB** · **i/o** · **local** · **what it is** | The model's name, download size, whether it takes mono or stereo input, and Neutone's description. **local** is `yes` once downloaded, `queued` while waiting in a batch, and a percentage while downloading. |

Select several models with ctrl-click or shift-click; **ctrl+A** in the list
selects all 48.

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

**feed the models** on the top bar: **mic**, **synth**, **both**, **file**,
**test**. They are gains rather than a switch, so `both` is a real blend, and
`input.mic` and `input.synth` can be routed from OSC, so the swarm can crossfade
between the room and itself. Switching needs no restart: the rack opens a duplex stream when it
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

The **scale** dropdown's **free** means no quantising at all — pitch follows
the sensor continuously, glissando rather than notes. The others (chromatic,
major, minor, pentatonic, whole tone) snap to a root you choose.

**Who is who.** Voice N is whoever holds slot N on the backend, because that is
how the per-client addresses (`/hive/dev/N/...`) are numbered: client 3 on the
dashboard is voice 3 here. Identity is tracked by uid underneath, from
`/hive/join`, `/hive/leave` and the once-a-second `/hive/roster`:

- only connected phones have a voice, and the synth tab lists exactly those, with
  name, uid, phone type, level, pitch and roughness, the queen marked with a crown
- a different uid arriving in a freed slot starts from silence instead of
  inheriting the last person's pitch and loudness
- a late `/hive/leave` for the slot's previous holder is ignored
- a phone missing from the roster, or silent for `timeout` seconds when there is
  no roster, fades out and its row goes
- the queen is found by uid, so a slot number that has gone stale between two
  `/hive/queen` messages cannot crown the wrong voice

Sixteen voices cost about 4% of the real-time budget.

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

**queen amount** scales all of them and can be routed from OSC
(`synth.queen_amount`), so the crown can tighten as the room synchronises.

### Queen split: find her by sound

**routing → queen split** on the rack tab, or `--split`. Every client still has a voice,
but her voice goes into slots 1 and 3 and everyone else's into slots 2 and 4.
Load different models into the odd and even slots and the room hears the queen
as one timbre and the crowd as another; the game is working out which person
that timbre belongs to.

- When the crown moves, her old voice crossfades into the crowd bus and the new
  queen's out of it over a third of a second, so the change is heard, not clicked.
- One sine against the sum of seven would decide the game on loudness, so each
  bus has a slow automatic gain pulling it to the same level over a second or
  two, with a gate so a still queen is not boosted into noise. Measured: 0.0 dB
  between the two buses once settled.
- The queen modes that change loudness (loudest, duck, solo) are bypassed while
  split is on, for the same reason. The pitch modes still work, if you want to
  give the room a clue.

Each slot's **input** dropdown (all, queen, crowd, off) gives any other
arrangement than 1+3 against 2+4.

### One model per client

**routing → one model per client** on the rack tab, or `--personal`. Every phone gets a
private copy of a model, fed by nothing but that person's voice, so each person
in the room has their own neural voice with its own state.

The four slots become templates. A client's copy is loaded from its template's
file and follows that template: model parameters, dry/wet, level fader, camera
section, and conditioning chain. Anything that drives a slot, including OSC
routes, drives every client on it. **clients get** chooses the template:

| | |
|---|---|
| **round robin** | client N uses the Nth loaded slot, wrapping around |
| **one model** | everyone uses the first loaded slot |
| **queen apart** | the queen's voice goes to a dedicated copy of the first slot's model; everyone else is spread over the other slots. The crown moving is a crossfade between two copies that are already running, so it is instant |

- Copies load on three background threads, below normal priority, from a cached
  copy of the file, and warm up before going live, so a join never stalls the
  audio. One spare per template is kept loaded, so the next person to join gets
  a model in the very next block.
- A copy costs about 0.4 s to load and 1.1 s to warm up.
- The synth tab's **own model** column shows whose copy is which, and whether it
  is still loading or shared.
- **private models** caps how many copies exist (default 6); clients past the cap
  share one overflow copy per template. The output of N copies is scaled by
  1/√N so the room's level stays steady as people arrive.

What it costs, `RAVE.IILThales`, on this laptop: one copy about 16% of the
budget, eight about 60–110% depending on the machine's state. The networks run
in parallel (60 ms of work fits in 13 ms of wall time); the remainder is each
copy's conditioning chain. DDSP models are several times heavier per copy. Keep
the cap low for heavy models, or use a larger block.

## Routing the swarm

Protocol v4 has five families and the osc tab groups both lists by them:

- **swarm** — how *much* the crowd moves. Loudness and brightness.
- **global** — how it moves: alike, in step, what rhythm, everyone or a soloist.
- **camera** — what the room looks like from the webcam.
- **mix** — where the bees on the wall and the bodies in the room meet.
- **client N** — one phone, and so one voice.

Picking `client 3` pre-selects `synth voice 3`. **learn** binds the next address
that arrives. **use seen** fills the input range from what an address actually
sent in the room, which beats guessing and is the difference between a fader
that sweeps and one pinned at an end.

**load defaults** installs 67 routes:

| from | to | why |
|---|---|---|
| client N activity / turn / \|rel\| | voice N level / pitch / roughness | the three things a person can feel themselves doing |
| global coherence | master reverb mix, inverted | together is dry and close |
| global entropy | synth detune | a soloist thins the bank |
| global tempo | all slots' compressor release | the conditioning breathes at the crowd's pulse |
| global crest | all slots' gate threshold | a spiky room gates harder |
| swarm energy | all slots' input high cut | harder movement opens the sound |
| swarm motion | all slots' first model parameter | turning stirs the latent |
| swarm count | master reverb size | more people, bigger room |
| cam person | slot N level, from section N | see camera sections below |

**All four slots are equal.** Every route that shapes a model shapes all four
identically, and no route sets a slot's level: that is the camera's job.

`coherence` is used rather than `swarm/sync` because it is a real correlation of
movement rather than of how hard people happen to be turning. Camera routes cost
nothing when no camera is attached, since nothing arrives on those addresses.

### Camera sections set the slot levels

The picture is cut into four sections, left to right (`columns`, the default) or
as a 2×2 grid (`quadrants`), and slot N's level follows how many people stand in
section N. Walking across the room walks the sound from one model to the next.

- People come from `/hive/cam/person`; `/hive/cam/cluster` is the fallback,
  which is far fewer packets if you would rather switch persons off.
- Gains are the square root of each section's share, so the total power stays
  constant: an evenly spread room leaves every slot at unity, and everyone in
  one section puts that slot at +6 dB with the other three at the floor
  (−30 dB by default). Slewed over 1.5 s against tracking jitter.
- With no camera attached, or nobody in view, the sections step aside and every
  slot stays at unity. The level fader on each slot is still a trim on top.

### What the backend needs to send

**what to send** on the osc tab, or `python morpho_rack.py --send-list`, works
this out from the routing actually loaded. For the defaults:

| leave on | |
|---|---|
| per phone | `dev/activity`, `dev/turn`, `dev/mag` |
| swarm | `swarm/count`, `swarm/energy`, `swarm/motion` |
| global | `global/coherence`, `global/entropy`, `global/tempo`, `global/crest` |
| camera | `cam/person` (the sections' head counts) |

Everything else can go off: `dev/acc`, `dev/rel`, `dev/gyro`, `dev/queen`,
`swarm/sync`, the other six `global/*`, the other 26 `cam/*` — including the
v4 flow field's `cam/grid`, `cam/gridflow` and `cam/density`, 48-96 floats per
frame each — all six `mix/*`, and all five wide messages (`/hive/sample`,
`/hive/swarm`, `/hive/global`, `/hive/cam`, `/hive/mix`). `/hive/queen`,
`join`, `leave`, `roster` and `schema` are always sent. With eight phones and
six people in view that is roughly 5,100 messages a second down to 1,700, and
most of the saving is the per-phone raw sensors.

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

The **block** dropdown and the graph on the second row of the top bar are the
two things to watch: red says whether the stream is about to break up, blue
whether there is room left for the backend, the camera and the projector.

### Is it using the cores?

Yes. Four workers driving four copies of `DDSP.sax` give 3.3× the throughput of
one, exactly the same as four separate processes (3.28×), so the Python
interpreter lock is not the bottleneck and moving to processes would buy nothing.

### Why it was slow

Three things, in order of size:

1. **Two bugs, now fixed.** The parameter registry was rebuilt for every OSC
   message — at a room's traffic that burned more CPU than the models — and
   torch ran five intra-op threads per model, oversubscribing the cores.
2. **This laptop's CPU state.** The same four models measured anywhere from 41%
   to over 200% of the budget depending on heat and on Windows moving a window
   that is not in focus onto the efficiency cores. The rack now raises its
   process priority, opts out of Windows power throttling (EcoQoS) and asks for
   a 1 ms timer at start (`--no-boost` to skip). Keep the laptop on mains power
   with a performance power plan.
3. **The models.** DDSP models are the expensive ones, about a quarter of a core
   each; `RAVE.IILThales` is a tenth of that.

Torch's intra-op thread count is timed at every start, stepping up from one
thread only when more are at least 15% faster. More threads usually buy nothing
and cost a lot: torch's workers spin while they wait, so the four heavy models
ran at the same speed with three threads as with one (55% against 54% of the
budget) while using 54% of the machine instead of 15% — cores the backend and
camera need. `--torch-threads N` overrides it.

### The GPU does not help these models

The RTX 2000 Ada works, and `runner.py` can run a model's network on it: the
Neutone wrapper cannot leave the CPU (its queues are TorchScript objects Python
cannot even reach), so the runner drives the network inside it directly and does
the buffering itself. On CPU it matches the wrapper bit for bit with identical
latency, verified on RAVE and DDSP models. But measured on this laptop:

| model | CPU | GPU |
|---|---|---|
| `RAVE.IILThales`, block 1024 | ~2–5% | 103% |
| `RAVE.gamelan`, block 1024 | ~5% | 134% |
| `RAVE.086-jaap`, block 1024 | ~23% | 35% |
| any `DDSP.*` | ~27% | cannot run |

Streaming RAVE runs hundreds of tiny operations per 2048-sample buffer, and on a
laptop GPU under the Windows display driver the fixed cost of launching each one
swamps the arithmetic. DDSP cannot run on a GPU at all: its pitch tracker calls
`torch.arange` without a device inside its own compiled code. The synth and the
conditioning together are under 3% of the budget, so there is nothing else
worth moving.

So `--device cpu` is the default. `--device cuda` exists, falls back to the CPU
per slot with the reason in the log and on the slot, and needs a CUDA build of
torch: it is installed in a separate conda environment, `morpho-gpu`, so
`ml-audio` is untouched.

### Block size

Percentage of the budget for four models, by block size. Under about 70% is
comfortable.

| configuration | 512 | 1024 | 2048 |
|---|---|---|---|
| models only | 48% | 40% | 29% |
| plus the compressor (the default) | 57% | 44% | 32% |
| plus filter, gate, limiter, master reverb | 67% | 51% | 36% |
| every effect on all four slots | 123% | 72% | 52% |

That is `conv1d-overdrive.random`. **Block size defaults to 1024**; changing it
in the app restarts the stream and re-tells every model. The per-slot reverb is
the most expensive single effect and is off by default.

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
- **OSC dispatch is one dictionary lookup.** Routes are indexed by address, so a
  message nobody routes costs about a microsecond however long the table grows.

## Known limits

- Sample rate conversion is the wrapper's own. A model whose native rate differs
  from `--sr` resamples, which adds latency; the status line reports the total.
- `/hive/sample` is not offered as a routing source. It
  carries one message per phone with the slot inside, so routing it at a
  knob means every phone writes the same one and the last wins.
- Synth voices are addressed by client slot, so voice 3 is whoever holds slot 3.
  Slots are reused when someone leaves; the new person gets a fresh voice.
- The pitch shifter is a two-tap crossfading delay line. It adds no latency and
  its artefact is a mild warble, not the smearing a phase vocoder gives.
- Processing width is mono by default (`--channels`). Output is always stereo.
