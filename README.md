# Claude 진행판

Cursor·VS Code 에서 Claude Code 확장 채팅을 쓸 때, **지금 보고 있는 세션**의 상태를 오른쪽 탭에 모아 보여 줍니다.

| 탭 | 보여 주는 것 |
|---|---|
| 진행판 | Claude 가 일을 시작하며 올린 체크리스트와 진행률 |
| 결과보고 | Claude 가 턴을 끝내며 쓴 보고(도구를 쓴 턴). 그 턴에 바꾼 파일 · 캡처 · 검사(빌드 · 린트 · 테스트) 결과를 함께 묶음. 안 읽은 보고에 점 |
| 컨텍스트 | 항목별 토큰(색 막대), 5시간·주간 한도, 비용 |
| 에이전트 | 띄운 하위 에이전트와 상태, 지금 하는 일 한 줄. 누르면 받은 지시 · 한 일(입력 · 결과) · 최종 보고를 큰 창으로 |
| 코덱스 | Claude 가 `codex exec` 로 시킨 일, 대화, 이어 보내기, Codex 한도 |
| 결과물 | Claude 가 보내거나 열어 본 이미지, 누르면 크게 보기 · 복사, 두 장 골라 비교 |
| 주소 | 대화에 나온 미리보기 주소(localhost 등)와 켜져 있는지, 사내 IP 로 열기 |
| 바뀐 파일 | Claude 가 고친 파일과 횟수, 누르면 열기 |

탭 줄 오른쪽 버튼으로 탭을 켜고 끄고 순서를 바꿀 수 있고(끌어서도 바꿀 수 있어요), 세션마다 따로 정할 수도 있습니다.

맥에서는 Cursor 창이 뒤에 있을 때 Claude 가 일을 마치거나 질문하며 멈추면 알림이 옵니다(알림을 누르면 스크립트 편집기가 열리는 건 맥 기본 알림의 한계입니다).

## 설치

두 가지를 설치합니다. 필요한 것: Claude Code 2.1.287 이상, Cursor 또는 VS Code 1.98 이상.

**1. Claude Code 플러그인** (진행판 규칙 알림 + 사용량 기록)

Claude Code 입력창에서:

```
/plugin marketplace add HOLYMOLYJUN/claude-side-panel
/plugin install side-panel@claude-side-panel
```

범위는 사용자(user)를 고릅니다. 설치한 뒤 열려 있는 세션에서는 `/reload-plugins` 를 한 번 실행합니다.

**2. Cursor·VS Code 확장** (오른쪽 화면)

[Releases](https://github.com/HOLYMOLYJUN/claude-side-panel/releases) 에서 `claude-side-panel.vsix` 를 받아 터미널에서:

```bash
cursor --install-extension claude-side-panel.vsix   # VS Code 는 code --install-extension
```

또는 확장 화면 오른쪽 위 `…` → **VSIX에서 설치**.

## 쓰는 법

1. Claude 세션 탭을 한 번 누릅니다.
2. `Cmd+Shift+P` → **Claude 진행판 열기**.
3. 그다음부터는 다른 Claude 탭을 누를 때마다 그 세션 내용으로 바뀝니다.

컨텍스트 항목과 한도는 플러그인을 설치한 뒤 답이 한 번 끝나야 보입니다. 코덱스 탭은 Codex CLI 를 쓰는 사람만 채워집니다.

## 읽고 쓰는 파일

모두 내 컴퓨터 안의 파일이고, 밖으로 보내는 것은 없습니다.

- 읽기: `~/.claude/projects/` (세션 기록), `~/.claude/session-plans/`, `~/.claude/session-usage/`, `~/.codex/sessions/`, `~/.codex/auth.json` (계정 ID 만)
- 쓰기: 플러그인이 `~/.claude/session-usage/` 에 사용량을 적고, Claude 가 `~/.claude/session-plans/` 에 진행판을 씁니다.
- 코덱스 탭에서 보내기를 누르면 그 Codex 세션을 `codex exec resume` 으로 이어 실행합니다(기본 읽기 전용).

## 알아 둘 점

- 세션 기록 형식은 공식 규격이 아니라서, Claude Code 가 바뀌면 고쳐야 할 수 있습니다.
- Codex 일은 「codex exec 호출 뒤 2분 안에 시작했거나 작업 폴더에 세션 ID 가 있는 기록」으로 세션과 짝짓습니다. 여러 세션이 동시에 Codex 를 부르면 섞일 수 있습니다.
- Codex 이어 보내기는 macOS 의 zsh 로그인 셸에서 `codex` 를 찾습니다.

## 내 입맛대로 고치기

진행판 화면은 웹 페이지 한 장(`panel.html`, HTML·CSS·JS)이라서, **Claude Code 에게 말로 부탁하면 그 자리에서 UI 를 고칠 수 있습니다.** 진행판이 열려 있으면 파일을 저장하는 순간 다시 그려지므로, 창을 다시 불러오거나 다시 설치할 필요가 없습니다.

예를 들어 Claude 에게 이렇게 말하면 됩니다.

- 「진행판 panel.html 에서 칩 위아래 여백 좀 늘려 줘」
- 「결과보고 탭 미리보기를 세 줄로 바꿔 줘」
- 「탭 이름 앞에 아이콘 넣어 줘」
- 「컨텍스트 막대 색을 우리 브랜드 색으로 바꿔 줘」

**처음 한 번만: 내 저장소를 설치된 확장에 연결하기**

설치된 확장을 바로 고치면 다음 업데이트 때 사라지므로, 저장소를 받아 두고 연결해 쓰는 것을 권합니다.

```bash
git clone https://github.com/HOLYMOLYJUN/claude-side-panel.git ~/dev/claude-side-panel
cd ~/dev/claude-side-panel
EXT=$(ls -d ~/.cursor/extensions/leesangjun.claude-side-panel-* | tail -1)   # VS Code 는 ~/.vscode/extensions
ln -sf "$PWD/panel.html" "$EXT/panel.html"
ln -sf "$PWD/extension.js" "$EXT/extension.js"
```

연결한 뒤 창을 한 번 다시 불러오면(`Cmd+Shift+P` → **Developer: Reload Window**) 그다음부터는 `~/dev/claude-side-panel/panel.html` 을 고칠 때마다 바로 반영됩니다. Claude 에게 부탁할 때 이 폴더를 알려 주세요.

**파일 구성**

- `panel.html`: 화면 전부. 저장하면 바로 반영
- `extension.js`: 세션 기록 읽기. 고친 뒤 창을 다시 불러와야 함
- `mod/`: Claude Code 플러그인(훅과 mod). 고친 뒤 `/reload-plugins`
- 묶기: `npx @vscode/vsce package --skip-license`
