# pi-usage-web

Web dashboard for AI provider usage: subscription quotas from the
cloud side (Codex, Kimi, Grok, Ollama, CommandCode, Devin, OpenCode,
xAI, …) and per-machine pi coding-agent token accounting pushed by
[pi-report](https://github.com/uzqw/aide) daemons — one wall of cards
for "how much quota is left" and "how much we actually burned".

Stack: PocketBase backend + hooks, Node fetcher sidecar, React (Vite +
TypeScript) frontend. No Swift, no native app.

## Layout

- `ui/` — React (Vite + TypeScript) frontend.
- `pb_hooks/` — PocketBase JS hooks (`/api/codexbar/*` routes,
  snapshot store).
- `fetcher/` — Node sidecar that fetches provider usage over direct
  HTTP (local auth files + Chrome cookie/localStorage replay) and
  POSTs snapshots to PocketBase.
- `pb_data/` — PocketBase data dir (created on first serve;
  gitignored).

## Run

```sh
cd ui && npm install && npm run build   # produces ui/dist
pocketbase serve --dir pb_data --hooksDir pb_hooks \
  --publicDir ui/dist --http 127.0.0.1:8099
node fetcher/fetch.mjs --once          # one refresh cycle
node fetcher/fetch.mjs                 # loop (adaptive interval)
```

Then open http://127.0.0.1:8099/ — PocketBase serves the React build
and the `/api/codexbar/*` JSON routes from the same port.

The fetcher reads the Chrome profile on disk
(`~/.config/google-chrome`, override with `CHROME_PROFILE_DIR`);
Chrome can stay running — the stores are read-only snapshots.
Providers without a usable credential render a "no session" card.

## Reporting your own pi usage

Machines running the [pi coding agent](https://github.com/earendil-works/pi)
push per-machine snapshots with `pi-report` (see the
[aide repo](https://github.com/uzqw/aide), `pi-report/`). Each machine
appears as its own `pi@<host>` card: tokens and equivalent cost for
today, deduplicated across session replays. Point it at this instance
with `CODEXBAR_URL` and it just shows up — no backend changes needed.

## Requirements

- Node 20+ (fetcher and UI build).
- PocketBase binary (0.38.x) on PATH.
- Google Chrome with the provider sites logged in (cookie /
  localStorage replay); KWallet or `secret-tool` for cookie decryption
  (`v11`), else the legacy `peanuts` key (`v10`).

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md). MIT — see [LICENSE](LICENSE).