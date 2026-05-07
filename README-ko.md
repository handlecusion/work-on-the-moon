# work-on-the-moon (`wotm`)

**언어:** [English](README.md) · [한국어](README-ko.md)

> 자기 머신에서 동작하는 Claude Code 세션의 웹 런처 + 라이브 미러.
> **cmux-claude**를 1급 지원함 — 터미널/cmux에서 띄운 Claude 세션을 폰이나
> 노트북 브라우저에서 그대로 어태치 가능.

```sh
npx work-on-the-moon
# → http://localhost:3700  (패스키 등록 링크가 stdout에 출력됨)
```

![브라우저에서 미러링되는 cmux-claude 세션](https://raw.githubusercontent.com/handlecusion/work-on-the-moon/main/docs/screenshots/chat-live.png)

> `cmux-claude` 세션 라이브 뷰 — 기본은 read-only, cmux Unix 소켓을 통한
> 키스트로크 forwarding은 옵션.

> **상태:** `0.x` — 마이너 버전 간 API/온디스크 상태가 변경될 수 있음.
> **보안:** Managed flow는 `claude --dangerously-skip-permissions`로 실행됨.
> 즉, 띄워진 `claude`가 파일/셸 도구를 확인 없이 실행함. 신뢰 가능한
> 디바이스(본인의 폰/노트북) 한정 + 패스키 + TLS 뒤에서만 노출 권장.
> **cmux는 선택 사항** — 없어도 Live 모드는 read-only 미러로 동작함. cmux는
> 키스트로크 forwarding을 추가해 주는 역할.

---

## 무엇을 하는가

`wotm`은 자기 머신에서 돌리는 작은 셀프호스팅 Node 서버. 두 가지 기능을 제공함.

1. **Managed (`/chat/<project>`)** — 서버가 직접 `claude --dangerously-skip-permissions`를
   `<WORKSPACE_DIR>/<project>/` (기본값 `~/Code/<project>/`)에서 spawn하고 브라우저
   chat UI로 양방향 사용 가능.
2. **Live (`/chat-live/...`)** — **터미널이나 cmux-claude에서 이미 띄워둔
   claude 프로세스를 read-only로 미러링.** `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`을
   tail해서 표시함. cmux가 떠 있으면 unix 소켓으로 입력도 forwarding되어
   휴대폰에서도 키 입력 가능.

핵심 가치는 **cmux-claude를 웹에서 그대로 사용 가능**하다는 점. 로컬 cmux 작업
흐름은 그대로 두고, `wotm`이 동기화된 브라우저 뷰 + 원격 키 주입을 제공함.

## 요구사항

- macOS (Linux/Windows는 Roadmap 참고)
- Node.js 20+
- `claude` CLI 설치 (`~/.local/bin/claude`, `/usr/local/bin/claude`,
  `/opt/homebrew/bin/claude` 또는 `$CLAUDE_BIN`을 자동 탐색)
- 패스키 가능 브라우저

## 외부 접근 설정

`wotm`은 폰이나 다른 노트북에서 접속해서 사용하는 것이 본 용도. 호스팅 머신에서만
사용할 경우 본 섹션은 건너뛰어도 됨. WebAuthn(패스키)은 안정된 hostname + HTTPS를
요구하고, 서버 자체는 `127.0.0.1:3700`에만 listen하므로 다음 셋을 만족하는
터널/프록시가 필요함.

1. 안정된 public **hostname**
2. 해당 hostname에 대한 **TLS** 종단
3. `localhost:3700`로 트래픽 forwarding

추천 방식 두 가지 — 둘 중 하나 선택. 둘 다 같은 hostname으로 접속하는 모든
디바이스에서 **하나의 패스키** 공유 가능.

![로그인 화면](https://raw.githubusercontent.com/handlecusion/work-on-the-moon/main/docs/screenshots/login.png)

### Option A — Cloudflare Tunnel

도메인이 있을 경우(또는 Cloudflare에서 무료 서브도메인 발급) 가장 매끄러운 방식.
TLS와 라우팅을 Cloudflare가 처리함. 라우터/방화벽 설정 변경 불필요.

```sh
# 1. 설치
brew install cloudflared

# 2. CF 계정 로그인 (브라우저 열림, 본인 zone 선택)
cloudflared tunnel login

# 3. named tunnel 생성 (~/.cloudflared/<UUID>.json에 자격증명 저장)
cloudflared tunnel create wotm

# 4. hostname을 tunnel로 라우팅
cloudflared tunnel route dns wotm wotm.example.com
```

`~/.cloudflared/config.yml` 작성:

```yaml
tunnel: wotm
credentials-file: /Users/<you>/.cloudflared/<UUID>.json
ingress:
  - hostname: wotm.example.com
    service: http://localhost:3700
  - service: http_status:404
```

터널 실행 (foreground 또는 시스템 서비스로):

```sh
cloudflared tunnel run wotm
# 또는: sudo cloudflared service install
```

public hostname을 env로 설정하고 `wotm` 시작:

```sh
ORIGIN=https://wotm.example.com \
RP_ID=wotm.example.com \
npx work-on-the-moon
```

브라우저에서 `https://wotm.example.com` 열고 stdout에 출력된 `/setup?token=...`
URL로 패스키 등록 → 완료.

### Option B — Tailscale Funnel

도메인 불필요 — Tailscale이 `<machine>.<tailnet>.ts.net` hostname과 TLS를
관리함. `funnel`은 public(누구나), `serve`는 자신의 tailnet 디바이스에서만 접근 가능.

```sh
# 1. 설치 + 로그인
brew install --cask tailscale
sudo tailscale up

# 2. admin 콘솔에서 MagicDNS + HTTPS 활성화:
#    https://login.tailscale.com/admin/dns  →  MagicDNS 토글, "Enable HTTPS" 클릭

# 3. 머신의 tailnet FQDN 확인
tailscale status        # 예: mac-mini.tailxxxx.ts.net

# 4. 포트 3700 노출
tailscale funnel --bg 3700           # PUBLIC (URL을 아는 누구나)
# 또는:
tailscale serve --bg --https=443 http://localhost:3700   # PRIVATE (tailnet 한정)
```

tailnet hostname을 env로 설정하고 `wotm` 시작:

```sh
ORIGIN=https://mac-mini.tailxxxx.ts.net \
RP_ID=mac-mini.tailxxxx.ts.net \
npx work-on-the-moon
```

### 로컬 테스트만 하고 싶을 때

같은 머신에서 간단히 테스트하는 용도라면:

```sh
npx work-on-the-moon            # 기본 http://localhost:3700
```

WebAuthn이 `http://localhost`를 secure context로 취급하므로 TLS 없이도 패스키
등록 가능. **단, 이 패스키는 `RP_ID=localhost`에 묶여 있어** 다른 디바이스에서
재사용 불가. 이후 tunnel hostname으로 옮길 경우 재등록 필요. 로컬 테스트 벤치
용도로만 사용 권장.

전부 초기화:

```sh
npx work-on-the-moon reset
```

## 로그인 시 자동 시작 (macOS)

상시 운영하려면 LaunchAgent를 설치해서 로그인 시 `wotm`이 자동 기동되도록
설정 가능 (크래시 시 자동 재시작 포함):

```sh
npm install -g work-on-the-moon
wotm install --origin=https://wotm.example.com --rp-id=wotm.example.com
wotm status      # LaunchAgent 상태 확인
wotm uninstall   # 언로드 + 제거
```

`install` 실행 시 `~/Library/LaunchAgents/com.work-on-the-moon.plist`가 작성되며,
현재 셸의 `node` 절대경로, `PATH`, `WORKSPACE_DIR` / `CLAUDE_BIN` / `CMUX_*` 환경
변수가 그대로 박힙니다. node를 업그레이드하거나 위 값들이 바뀌면 `wotm install`을
다시 실행해야 함. 로그는 `~/.wotm/launchd.out.log`, `~/.wotm/launchd.err.log`.

터널 자체(Cloudflare Tunnel, Tailscale Funnel)도 별도로 자동 기동해야 합니다 —
Cloudflare는 `sudo cloudflared service install`, Tailscale은 기본 데몬이 처리.

## 설정

| Env 변수     | 기본값                   | 설명                                   |
|--------------|--------------------------|----------------------------------------|
| `PORT`       | `3700`                   | Listen 포트                            |
| `HOST`       | `127.0.0.1`              | Listen 인터페이스                      |
| `ORIGIN`     | `http://localhost:3700`  | WebAuthn expected origin (터널 모드 시 설정) |
| `RP_ID`      | `localhost`              | WebAuthn Relying Party ID (터널 모드 시 설정) |
| `CLAUDE_BIN` | 자동 탐색                | `claude` 바이너리 경로 override        |
| `WORKSPACE_DIR` | `~/Code`              | 프로젝트들이 들어 있는 루트 디렉토리. `~/...` 사용 가능. |

상태는 첫 실행 시 `~/.wotm/data.json`에 생성·저장됨 (패스키, 세션, 프로젝트 기록).
`RP_ID`를 변경하면 이전 값으로 등록된 패스키가 무효화되므로, 디바이스 등록 전에
hostname 확정 권장.

## 로드맵

현재 **macOS**를 1차로 지원하며, 두 가지 추천 외부 접근 모드(Cloudflare Tunnel,
Tailscale Funnel)를 제공. 추가 예정:

- **Linux** 지원 (PTY/경로 차이, 패키징)
- **Docker** 이미지 (헤드리스 서버용)
- **멀티유저** 모드 (현재는 단일 소유자 가정)
- **cmux-claude** 연동 확장 (workspace 전환, surface 메타, workspace 단위 어태치)

이슈/PR 환영.

---

## 감사의 말

- **cmux** — `wotm`의 Live 모드는 cmux의 workspace/surface IPC에 의존함.
  "휴대폰에서 cmux를 쓴다"의 키스트로크 forwarding은 cmux가 깔끔한 Unix 소켓
  프로토콜을 노출해 주기에 가능함. cmux 팀에 감사.
- **Tailscale** — Funnel과 Serve, 그리고 `*.ts.net`의 관리형 TLS 덕분에 도메인
  보유나 자체 리버스 프록시 운영 없이도 `wotm`을 외부에서 접근할 수 있음.
  Tailscale 팀에 감사.

## 아키텍처

상세 아키텍처(디렉토리 구조, 두 세션 flow, 라이브 어태치 시퀀스, 인증, 외부 의존성)는
영문 README의 [Architecture](README.md#architecture) 섹션에 정리되어 있음.

## 라이선스

MIT — [LICENSE](LICENSE) 참조.
