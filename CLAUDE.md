# SwarmAudio — Team HIVE, Music & AI Hackathon 2026 (Uttendorf)

Phones stream gyroscope + accelerometer to a Mac; the Mac forwards OSC to the
sound installation. One repo, one folder per workstream — keep your work in
your folder and do not reshape others'.

```
backend/         Node/TypeScript server + phone web app + dashboard   (Emil)
                 → see backend/README.md for run instructions, OSC map, team setup
backend/vision/  Python camera pipeline (YOLO11n-pose) feeding the server; own venv
<yours>/         Pd patches, SuperCollider, datasets, visuals, …
```

## Working agreements

- **The OSC protocol lives in `backend/shared/osc-schema.ts`** and nowhere
  else: the server builds messages from it, `npm run docs:osc` regenerates
  `backend/docs/OSC.md`, the dashboard renders it. Only ever *append* fields to
  the wide messages; bump `OSC_SCHEMA_VERSION` when you do; never rename or
  reorder — everyone's patches depend on it. Same for the binary phone frame
  in `backend/shared/protocol.ts`.
- New signal processing goes into `backend/server/condition.ts` (per device),
  `backend/server/swarm.ts` / `global.ts` (whole swarm), `vision.ts` (camera
  crowd) or `mix.ts` (bees ⇄ camera), then becomes a new schema field and a
  `MUTABLE` key. Phones and the camera process send raw observations only;
  all computation happens on the server. Python side: numpy only — no
  scikit-learn, no python-osc.
- Commits are authored by the humans on the team — no AI co-author trailers.
- Backend: TypeScript, strict, no framework on the client, hand-written DOM.
  Comments explain *why* (see the file headers); match that style.
- Do not add the `osc` npm package (pulls a vulnerable `ws`); OSC encoding is in
  `backend/server/osc-encode.ts`.
- Runtime configuration belongs on the dashboard (`/api/settings`, `/api/targets`,
  persisted in `hive.config.json`), not in new env vars — only ports are env.
- Never commit `backend/certs/`, `backend/dist/`, `backend/hive.config.json`
  (already gitignored).
- Python helpers for consumers live in `backend/examples/` and must run with
  the standard library where possible.
- Language of code and comments: English. Phone UI has EN/DE/JA strings in
  `backend/client/src/i18n.ts` — add all three when you add a string; EN and DE
  are lower case by design.

## Quick start

```bash
cd backend && ./start.sh                           # QR code + dashboard at http://localhost:8080/monitor
./start.sh --sim 3                                 # three fake phones, no hardware needed
./start.sh --dev                                   # rebuild the phone app on save
python3 examples/osc_listen.py 9000                # see what the installation receives
```

## Facts worth knowing before touching the backend

- Phones need **HTTPS** for motion sensors; the cert is self-signed and
  regenerated when the Mac's LAN IP changes. iOS Safari refuses `wss://` on it,
  so the phone app falls back to POSTing the same frames — both are normal.
- Both platforms cap sensors at ~60 Hz. iOS's gravity sign is flipped on the
  client so a flat phone reads `(0, 0, +9.81)` everywhere.
- Slots (1..N) identify devices on the OSC side; UUIDs never leave the server.
- Everything downstream of `Registry.push` only sees `Sample { slot, uid, t, acc,
  gyro, rel, activity, idle, turn }` — that is the seam for replaying recorded
  or external (bee) swarm data later.
- The queen is a server setting (`queenUid`, `/hive/queen` on OSC). The wall's
  flight model (`client/src/visuals/bees.ts`) runs in the projector's browser;
  it reports positions to `/api/wall` (relayed to the phones' maps on the ingest
  link) and crown changes to `/api/settings`. Do not move the flight model to
  the server unless you also move those.
- Phone UI strings: EN (default, all lower case) · DE (all lower case) · JA
  (polite です/ます, 女王蜂 for the queen) in `client/src/i18n.ts` — add all three.
