# side-panel

「Claude 진행판」 확장(Cursor·VS Code)의 짝 플러그인입니다. 화면은 그리지 않고, 확장이 읽을 파일만 남깁니다.

- 세션을 열 때와 요청을 보낼 때, 진행판 규칙(`~/.claude/session-plans/<세션ID>.md` 에 체크리스트 쓰기)을 Claude 에 알려 줍니다.
- 턴이 끝날 때마다 컨텍스트 항목별 토큰과 비용을 `~/.claude/session-usage/<세션ID>.json` 에, 사용 한도를 `~/.claude/session-usage/_limits.json` 에 적습니다.

설치 방법과 확장 설명은 저장소 첫 화면의 README 를 보세요.
