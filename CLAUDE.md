# SwarmAudio — Team HIVE, Music & AI Hackathon 2026 (Uttendorf)

Phones stream gyroscope + accelerometer to a Mac; the Mac forwards OSC to the
sound installation. One repo, one folder per workstream — keep your work in
your folder and do not reshape others'.

```
backend/     Node/TypeScript server + phone web app + dashboard   (Emil)
             → see backend/README.md for run instructions, OSC map, team setup
<yours>/     Pd patches, SuperCollider, datasets, visuals, …
```

## Working agreements

- **Do not change the OSC address scheme or the binary frame** in
  `backend/shared/protocol.ts` / `backend/server/osc.ts` without telling the
  team — everyone's patches depend on it. Add new addresses; do not rename.
- Backend: TypeScript, strict, no framework on the client, hand-written DOM.
  Comments explain *why* (see the file headers); match that style.
- Do not add the `osc` npm package (pulls a vulnerable `ws`); OSC encoding is in
  `backend/server/osc-encode.ts`.
- Never commit `backend/certs/`, `backend/dist/`, `backend/hive.config.json`
  (already gitignored).
- Python helpers for consumers live in `backend/examples/` and must run with
  the standard library where possible.
- Language of code and comments: English. Phone UI has EN/DE strings in
  `backend/client/src/i18n.ts` — add both when you add a string.

## Quick start

```bash
cd backend && npm install && npm run dev          # QR code + dashboard at http://localhost:8080/monitor
HIVE_SIMULATE=3 npm start                          # three fake phones, no hardware needed
python3 examples/osc_listen.py 9000                # see what the installation receives
```

## Facts worth knowing before touching the backend

- Phones need **HTTPS** for motion sensors; the cert is self-signed and
  regenerated when the Mac's LAN IP changes. iOS Safari refuses `wss://` on it,
  so the phone app falls back to POSTing the same frames — both are normal.
- Both platforms cap sensors at ~60 Hz. iOS's gravity sign is flipped on the
  client so a flat phone reads `(0, 0, +9.81)` everywhere.
- Slots (1..N) identify devices on the OSC side; UUIDs never leave the server.
- Everything downstream of `Registry.push` only sees `Sample { slot, t, acc, gyro }`
  — that is the seam for replaying recorded or external (bee) swarm data later.
