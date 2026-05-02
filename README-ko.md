# work-on-the-moon (`wotm`)

**언어:** [English](README.md) · [한국어](README-ko.md)

> 자기 머신에서 도는 Claude Code 세션의 웹 런처 + 라이브 미러.
> **cmux-claude**를 1급 지원 — 터미널/cmux에서 띄운 Claude 세션을 폰이나
> 노트북 브라우저에서 그대로 어태치할 수 있어.

```sh
npx work-on-the-moon
# → http://localhost:3700  (패스키 등록 링크가 stdout에 찍힘)
```

![브라우저에서 미러링되는 cmux-claude 세션](docs/screenshots/chat-live.png)

> `cmux-claude` 세션 라이브 뷰 — 기본은 read-only, cmux Unix 소켓을 통한
> 키스트로크 forwarding은 옵션.

---

## 무엇을 하는가

`wotm`은 자기 머신에서 돌리는 작은 셀프호스팅 Node 서버야. 두 가지를 함:

1. **Managed (`/chat/<project>`)** — 서버가 직접 `claude --dangerously-skip-permissions`를
   `~/Code/<project>/`에서 spawn하고 브라우저 chat UI로 양방향 사용.
2. **Live (`/chat-live/...`)** — **터미널이나 cmux-claude에서 이미 띄워둔
   claude 프로세스를 read-only로 미러링.** `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`을
   tail해서 보여줌. cmux가 떠 있으면 unix 소켓으로 입력도 forwarding되니
   휴대폰에서 키 입력도 가능.

핵심 가치는 **cmux-claude를 웹에서 그대로 쓸 수 있다**는 점. 로컬 cmux 작업
흐름은 그대로 두고, `wotm`이 동기화된 브라우저 뷰 + 원격 키 주입을 얹어줌.

## 요구사항

- macOS (Linux/Windows는 Roadmap 참고)
- Node.js 20+
- `claude` CLI 설치 (`~/.local/bin/claude`, `/usr/local/bin/claude`,
  `/opt/homebrew/bin/claude` 또는 `$CLAUDE_BIN`을 자동 탐색)
- 패스키 가능 브라우저

## 빠른 시작 (셀프호스팅)

```sh
npx work-on-the-moon            # 127.0.0.1:3700 에서 listen
# stdout에 찍힌 /setup?token=... URL을 한 번 열어 패스키 등록
# 이후엔 패스키만으로 로그인
```

![로그인 화면](docs/screenshots/login.png)

전부 초기화:

```sh
npx work-on-the-moon reset
```

## 왜 localhost + 패스키인가

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

## 설정

| Env 변수     | 기본값                   | 설명                                   |
|--------------|--------------------------|----------------------------------------|
| `PORT`       | `3700`                   | Listen 포트                            |
| `HOST`       | `127.0.0.1`              | Listen 인터페이스                      |
| `ORIGIN`     | `http://localhost:3700`  | WebAuthn expected origin               |
| `RP_ID`      | `localhost`              | WebAuthn Relying Party ID              |
| `CLAUDE_BIN` | 자동 탐색                | `claude` 바이너리 경로 override        |

상태는 첫 실행 시 `~/.claude-web/data.json`에 생성·저장됨 (패스키, 세션, 프로젝트 기록).

## 로드맵

지금은 **macOS 셀프호스팅**이 1차 지원 환경이고, 다음을 추가 예정:

- **Linux** 지원 (PTY/경로 차이, 패키징)
- **Tailscale Funnel** 프리셋 (Cloudflare 없이 다기기 접근)
- **Docker** 이미지 (헤드리스 서버용)
- **멀티유저** 모드 (현재는 단일 소유자 가정)
- **cmux-claude** 연동 확장 (workspace 전환, surface 메타, workspace로 어태치)

이슈/PR 환영.

---

## 아키텍처

상세 아키텍처(디렉토리 구조, 두 세션 flow, 라이브 어태치 시퀀스, 인증, 외부 의존성)는
영문 README의 [Architecture](README.md#architecture) 섹션에 정리되어 있어.

## 라이선스

MIT — [LICENSE](LICENSE) 참조.
