# work-on-the-moon (`wotm`)

> Web launcher + live mirror for Claude Code sessions on **your own** machine.
> First-class support for **cmux-claude**: attach to your terminal/cmux Claude
> sessions from a phone or laptop browser.

```sh
npx work-on-the-moon
# → http://localhost:3700  (passkey setup link printed in stdout)
```

---

## English

### What it is

`wotm` is a small self-hosted Node server that does two things:

1. **Managed sessions (`/chat/<project>`)** — spawns `claude --dangerously-skip-permissions`
   inside `~/Code/<project>/` and exposes a chat UI to your browser. Bidirectional.
2. **Live sessions (`/chat-live/...`)** — **read-only mirror of any `claude` you
   already started elsewhere** (a terminal, **cmux-claude**, tmux, etc.) by tailing
   `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`. If `cmux` is running, input is
   forwarded back through its Unix socket so you can type from a phone too.

The cmux-claude web access is the headline feature: you keep working in your
local cmux as usual, and `wotm` gives you a synchronized browser view + remote
keystroke injection.

### Requirements

- macOS (Linux/Windows planned — see Roadmap)
- Node.js 20+
- The `claude` CLI installed (autodetected at `~/.local/bin/claude`,
  `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`, or `$CLAUDE_BIN`)
- A passkey-capable browser

### Quickstart (self-hosted)

```sh
npx work-on-the-moon            # listens on 127.0.0.1:3700
# open the printed /setup?token=... URL once to register a passkey
# subsequent visits just need the passkey
```

Reset everything (passkeys, sessions, tokens):

```sh
npx work-on-the-moon reset
```

### Why localhost + passkey?

WebAuthn (passkeys) requires a stable Relying Party ID. `wotm` defaults to
`RP_ID=localhost` and `ORIGIN=http://localhost:3700`, which the WebAuthn spec
treats as a secure context **without** TLS. This means:

- **Use `http://localhost:3700` in your browser** — not `127.0.0.1`, not your
  LAN IP. Passkeys will refuse to register otherwise.
- A passkey created against `localhost` is bound to your machine; it cannot be
  reused from another device against the same `localhost` URL.
- For multi-device access you need to expose the server under a real domain and
  set `ORIGIN`/`RP_ID` accordingly (e.g. via Cloudflare Tunnel, Tailscale Funnel,
  or your own reverse proxy). Changing `RP_ID` invalidates existing passkeys.

### Configuration

| Env var      | Default                  | Notes                                  |
|--------------|--------------------------|----------------------------------------|
| `PORT`       | `3700`                   | Listen port                            |
| `HOST`       | `127.0.0.1`              | Listen interface                       |
| `ORIGIN`     | `http://localhost:3700`  | WebAuthn expected origin               |
| `RP_ID`      | `localhost`              | WebAuthn Relying Party ID              |
| `CLAUDE_BIN` | autodetected             | Override path to the `claude` binary   |

State lives in `~/.claude-web/data.json` (passkeys, sessions, project history)
and is created on first run.

### Roadmap

`wotm` currently supports **macOS self-hosted** as its primary environment.
Planned additions:

- **Linux** support (PTY/path differences, packaging)
- **Tailscale Funnel** preset for multi-device access without Cloudflare
- **Docker** image for headless servers
- **Multi-user** mode (today the server assumes a single owner)
- More **cmux-claude** integration surfaces (workspace switching, surface
  metadata, attach-by-workspace)

Issues and PRs welcome.

---

## 한국어

### 무엇을 하는가

`wotm`은 자기 머신에서 돌리는 작은 셀프호스팅 Node 서버야. 두 가지를 함:

1. **Managed (`/chat/<project>`)** — 서버가 직접 `claude --dangerously-skip-permissions`를
   `~/Code/<project>/`에서 spawn하고 브라우저 chat UI로 양방향 사용.
2. **Live (`/chat-live/...`)** — **터미널이나 cmux-claude에서 이미 띄워둔
   claude 프로세스를 read-only로 미러링.** `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`을
   tail해서 보여줌. cmux가 떠 있으면 unix 소켓으로 입력도 forwarding되니
   휴대폰에서 키 입력도 가능.

핵심 가치는 **cmux-claude를 웹에서 그대로 쓸 수 있다**는 점. 로컬 cmux 작업
흐름은 그대로 두고, `wotm`이 동기화된 브라우저 뷰 + 원격 키 주입을 얹어줌.

### 요구사항

- macOS (Linux/Windows는 Roadmap 참고)
- Node.js 20+
- `claude` CLI 설치 (`~/.local/bin/claude`, `/usr/local/bin/claude`,
  `/opt/homebrew/bin/claude` 또는 `$CLAUDE_BIN`을 자동 탐색)
- 패스키 가능 브라우저

### 빠른 시작 (셀프호스팅)

```sh
npx work-on-the-moon            # 127.0.0.1:3700 에서 listen
# stdout에 찍힌 /setup?token=... URL을 한 번 열어 패스키 등록
# 이후엔 패스키만으로 로그인
```

전부 초기화:

```sh
npx work-on-the-moon reset
```

### 왜 localhost + 패스키인가

WebAuthn은 안정적인 Relying Party ID를 요구함. `wotm`은 기본값으로
`RP_ID=localhost` / `ORIGIN=http://localhost:3700`을 쓰는데, WebAuthn 스펙상
**TLS 없이도 secure context로 인정되는 유일한 호스트가 `localhost`**임. 그래서:

- 브라우저에서 반드시 **`http://localhost:3700`**으로 접속해야 함. `127.0.0.1`이나
  LAN IP로는 패스키 등록이 거부됨.
- `localhost`에 등록된 패스키는 해당 머신에 묶임 — 다른 디바이스에서 같은 URL로
  접근해도 그대로 못 씀.
- 여러 디바이스에서 접근하려면 실도메인 + `ORIGIN`/`RP_ID` 설정이 필요
  (Cloudflare Tunnel, Tailscale Funnel, 직접 reverse proxy 등). `RP_ID`가
  바뀌면 기존 패스키는 전부 무효화됨.

### 설정

| Env 변수     | 기본값                   | 설명                                   |
|--------------|--------------------------|----------------------------------------|
| `PORT`       | `3700`                   | Listen 포트                            |
| `HOST`       | `127.0.0.1`              | Listen 인터페이스                      |
| `ORIGIN`     | `http://localhost:3700`  | WebAuthn expected origin               |
| `RP_ID`      | `localhost`              | WebAuthn Relying Party ID              |
| `CLAUDE_BIN` | 자동 탐색                | `claude` 바이너리 경로 override        |

상태는 첫 실행 시 `~/.claude-web/data.json`에 생성·저장됨 (패스키, 세션, 프로젝트 기록).

### 로드맵

지금은 **macOS 셀프호스팅**이 1차 지원 환경이고, 다음을 추가 예정:

- **Linux** 지원 (PTY/경로 차이, 패키징)
- **Tailscale Funnel** 프리셋 (Cloudflare 없이 다기기 접근)
- **Docker** 이미지 (헤드리스 서버용)
- **멀티유저** 모드 (현재는 단일 소유자 가정)
- **cmux-claude** 연동 확장 (workspace 전환, surface 메타, workspace로 어태치)

이슈/PR 환영.

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
- 30-day session TTL. Atomic write + mutex on `~/.claude-web/data.json`.
- Bootstrap prints a one-time registration URL to stdout. `wotm reset` wipes
  all state.

### External dependencies

- `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` — written by the
  `claude` CLI itself; this server only reads.
- cmux unix socket (`~/Library/Application Support/cmux/cmux.sock`) — optional,
  enables live input. Without it, live mode is read-only.
