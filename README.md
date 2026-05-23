# work-on-the-moon (`wotm`)

**Languages:** [English](README.md) · [한국어](README-ko.md)
**Demo / landing:** <https://work.handlecusion.com/landing>

> Web launcher + live mirror for Claude Code sessions on **your own** machine.
> First-class support for **cmux-claude**: attach to your terminal/cmux Claude
> sessions from a phone or laptop browser.

```sh
npx work-on-the-moon
# → http://localhost:3700  (passkey setup link printed in stdout)
```

![cmux-claude session mirrored in browser](https://raw.githubusercontent.com/handlecusion/work-on-the-moon/main/docs/screenshots/chat-live.png)

> Live view of a `cmux-claude` session — read-only by default, with optional
> keystroke forwarding through the cmux Unix socket.

> **Status:** `0.x` — APIs and on-disk state may change between minor versions.
> **Security:** the Managed flow runs `claude --dangerously-skip-permissions`,
> i.e. the spawned `claude` will execute file/shell tools without asking. Only
> expose `wotm` to a trusted device (your own phone/laptop), behind a passkey,
> behind TLS.
> **cmux is optional** — without it, Live mode still works as a read-only
> mirror; cmux just adds keystroke forwarding.

---

## What it is

`wotm` is a small self-hosted Node server that does two things:

1. **Managed sessions (`/chat/<project>`)** — spawns `claude --dangerously-skip-permissions`
   inside `<WORKSPACE_DIR>/<project>/` (default `~/Code/<project>/`) and exposes a
   chat UI to your browser. Bidirectional.
2. **Live sessions (`/chat-live/...`)** — **read-only mirror of any `claude` you
   already started elsewhere** (a terminal, **cmux-claude**, tmux, etc.) by tailing
   `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`. If `cmux` is running, input is
   forwarded back through its Unix socket so you can type from a phone too.

The cmux-claude web access is the headline feature: you keep working in your
local cmux as usual, and `wotm` gives you a synchronized browser view + remote
keystroke injection.

## Requirements

- macOS (Linux/Windows planned — see Roadmap)
- Node.js 20+
- The `claude` CLI installed (autodetected at `~/.local/bin/claude`,
  `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`, or `$CLAUDE_BIN`)
- A passkey-capable browser

## External access setup

`wotm` is meant to be reached from your phone or another laptop, not just the
machine that runs it. WebAuthn (passkeys) requires a stable hostname with
HTTPS, and the server itself only listens on `127.0.0.1:3700`. So you need a
tunnel/proxy that:

1. Gives you a stable public **hostname**
2. Terminates **TLS** for that hostname
3. Forwards traffic to `localhost:3700`

Two recommended setups — pick one. Both let you use the **same passkey** across
all devices that hit the same hostname.

![Login screen](https://raw.githubusercontent.com/handlecusion/work-on-the-moon/main/docs/screenshots/login.png)

### Option A — Cloudflare Tunnel

You bring a domain (or use a free Cloudflare-hosted subdomain), Cloudflare
handles TLS and routing. No router/firewall changes needed.

```sh
# 1. install
brew install cloudflared

# 2. log in (opens browser, pick the zone you own)
cloudflared tunnel login

# 3. create a named tunnel (saves credentials JSON to ~/.cloudflared/<UUID>.json)
cloudflared tunnel create wotm

# 4. route a hostname to the tunnel
cloudflared tunnel route dns wotm wotm.example.com
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: wotm
credentials-file: /Users/<you>/.cloudflared/<UUID>.json
ingress:
  - hostname: wotm.example.com
    service: http://localhost:3700
  - service: http_status:404
```

Run the tunnel (foreground or as a system service):

```sh
cloudflared tunnel run wotm
# or: sudo cloudflared service install
```

Start `wotm` with the public hostname:

```sh
ORIGIN=https://wotm.example.com \
RP_ID=wotm.example.com \
npx work-on-the-moon
```

Open `https://wotm.example.com` in any browser, register a passkey via the
`/setup?token=...` URL printed to stdout, done.

### Option B — Tailscale Funnel

No domain needed — Tailscale gives you a `<machine>.<tailnet>.ts.net` hostname
with managed TLS. `funnel` is public; `serve` is private to your tailnet.

```sh
# 1. install + log in
brew install --cask tailscale
sudo tailscale up

# 2. enable MagicDNS + HTTPS in the admin console:
#    https://login.tailscale.com/admin/dns  →  toggle MagicDNS, then "Enable HTTPS"

# 3. find your machine's tailnet FQDN
tailscale status        # look for e.g. mac-mini.tailxxxx.ts.net

# 4. expose port 3700
tailscale funnel --bg 3700           # PUBLIC (anyone with the URL)
# or:
tailscale serve --bg --https=443 http://localhost:3700   # PRIVATE (tailnet devices only)
```

Start `wotm` with the tailnet hostname:

```sh
ORIGIN=https://mac-mini.tailxxxx.ts.net \
RP_ID=mac-mini.tailxxxx.ts.net \
npx work-on-the-moon
```

### Local testing only

If you just want to try `wotm` on the same machine without exposing it:

```sh
npx work-on-the-moon            # defaults to http://localhost:3700
```

WebAuthn treats `http://localhost` as a secure context, so passkey registration
works without TLS. **But this passkey is bound to `RP_ID=localhost`** — you
cannot reuse it from another device, and switching to a tunnel hostname later
will require re-registering. Treat localhost mode as a test bench, not a
deployment.

Reset everything (passkeys, sessions, tokens):

```sh
npx work-on-the-moon reset
```

## Autostart at login (macOS)

For long-running deployments, install a LaunchAgent so `wotm` boots
automatically when you log in (and restarts on crash):

```sh
npm install -g work-on-the-moon
wotm install --origin=https://wotm.example.com --rp-id=wotm.example.com
wotm status      # show LaunchAgent state
wotm uninstall   # unload + remove
```

`install` writes `~/Library/LaunchAgents/com.work-on-the-moon.plist` capturing
the current `node` binary path, `PATH`, and any `WORKSPACE_DIR` /
`CLAUDE_BIN` / `CMUX_*` env vars set in your shell at install time. Re-run
`wotm install` after upgrading node or changing those values. Logs go to
`~/.wotm/launchd.out.log` and `~/.wotm/launchd.err.log`.

The tunnel itself (Cloudflare Tunnel, Tailscale Funnel) needs its own
autostart — `sudo cloudflared service install` for Cloudflare, or the
default Tailscale daemon for Funnel/Serve.

## Configuration

| Env var      | Default                  | Notes                                  |
|--------------|--------------------------|----------------------------------------|
| `PORT`       | `3700`                   | Listen port                            |
| `HOST`       | `127.0.0.1`              | Listen interface                       |
| `ORIGIN`     | `http://localhost:3700`  | WebAuthn expected origin (set this for tunnel mode) |
| `RP_ID`      | `localhost`              | WebAuthn Relying Party ID (set this for tunnel mode) |
| `CLAUDE_BIN` | autodetected             | Override path to the `claude` binary   |
| `WORKSPACE_DIR` | `~/Code`              | Directory that contains your project subdirectories. Supports `~/...`. |

State lives in `~/.wotm/data.json` (passkeys, sessions, project history)
and is created on first run. Changing `RP_ID` invalidates passkeys registered
under the old value, so settle on the hostname before registering devices.

## Roadmap

`wotm` currently supports **macOS** as its primary environment, with two
recommended access modes (Cloudflare Tunnel, Tailscale Funnel). Planned:

- **Linux** support (PTY/path differences, packaging)
- **Docker** image for headless servers
- **Multi-user** mode (today the server assumes a single owner)
- More **cmux-claude** integration surfaces (workspace switching, surface
  metadata, attach-by-workspace)

Issues and PRs welcome.

---

## Architecture

```
auth/         WebAuthn, session cookie, JSON store
lib/          claude PTY runner, project store, live scanner, jsonl tailer, cmux IPC client
routes/       Express + WS — auth/setup/devices/projects/chat/slash/sessions/live
public/       Vanilla JS UI (chat, chat-live, index, login, setup, devices)
scripts/      smoke-* end-to-end checks
bin/          npx entry point (wotm)
```

### Two session flows

**Managed** — this server spawns and owns the `claude` CLI. Input over WS
(`/ws/chat`) → PTY → stdout JSONL → normalized → pushed back to the client.
Per-project state in `lib/projectStore.js`.

**Live** — this server **observes** an external `claude` process started
elsewhere (terminal, cmux, tmux). Process discovery via `pgrep`/`lsof`/`ps`,
session id extracted from the command line or recovered from the most recent
jsonl in `~/.claude/projects/<encoded-cwd>/`. The cmux Unix socket is probed
opportunistically — if present, input forwarding is enabled.

### Live attach flow

1. **Process discovery** (`lib/liveSessionScanner.js`)
   - `pgrep -fla` + `lsof -d cwd` + `ps -o lstart` to enumerate live PIDs.
   - Pull session id from `--session-id`/`--continue`/`--resume`, fall back to
     the most recent jsonl mtime within 60 s in the project dir.
   - Read jsonl head (4 KB) for cwd/gitBranch and tail (64 KB) for last
     user/assistant text. Memoized for 5 s.

2. **cmux mapping** (same scanner)
   - 1.5 s budget on the cmux unix socket: `listWorkspaces` → match cwd →
     `listSurfaces` to find the terminal surface id.
   - Decorate each entry with `cmuxAvailable / cmuxSurfaceId / cmuxWorkspaceId`.

3. **WS attach** (`routes/live.js` + `lib/liveTailer.js`)
   - Client sends `{type:'hello', sessionId}` or `{type:'hello', cwd}`.
   - Server resolves the jsonl path; if it doesn't exist yet (just-spawned
     session, no first message), it sends an empty transcript and polls every
     1.5 s until the file appears, then re-sends `init`.

4. **Tailer fan-out** (`lib/liveTailer.js`)
   - One fs watcher per file regardless of subscriber count. `fs.watch` + 1 s
     poll hybrid. New bytes parsed line-by-line and fanned out.

5. **Meta polling** (10 s)
   - `busy / idleSeconds / pid / cmuxAvailable` changes → `meta_update`.

6. **Input forwarding** (cmux entries only)
   - `{type:'send', text}` → `cmuxClient.sendText(surfaceId, text)` → keystroke
     injected into the external `claude` PTY via cmux IPC. Echo arrives via
     tail, so no optimistic render.

### Auth

- Single-user passkey (WebAuthn) registration.
- Session token in httpOnly cookie; WS accepts cookie or `?session=<token>`.
- 30-day session TTL. Atomic write + mutex on `~/.wotm/data.json`.
- Bootstrap prints a one-time registration URL to stdout. `wotm reset` wipes
  all state.

### External dependencies

- `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` — written by the
  `claude` CLI itself; this server only reads.
- cmux unix socket (`~/Library/Application Support/cmux/cmux.sock`) — optional,
  enables live input. Without it, live mode is read-only.

## Acknowledgments

- **cmux** — `wotm`'s Live mode rides on cmux's workspace/surface IPC. The
  "use cmux from a phone" experience exists only because cmux exposes a clean
  Unix socket protocol with `listWorkspaces` / `listSurfaces` / `sendText`.
  Thanks to the cmux team.
- **Tailscale** — Funnel and Serve, plus managed TLS for `*.ts.net`, are what
  make `wotm` reachable from anywhere without owning a domain or running a
  reverse proxy. Thanks to the Tailscale team.

## License

MIT — see [LICENSE](LICENSE).
