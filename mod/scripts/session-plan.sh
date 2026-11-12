#!/bin/bash
# SessionStart 훅: 이 세션의 진행판 파일 경로와 규칙을 Claude 에게 알려 준다.
id=$(jq -r '.session_id')
f="$HOME/.claude/session-plans/$id.md"
mkdir -p "$HOME/.claude/session-plans"
cat <<EOF
진행판 규칙 (사용자 화면 오른쪽 「Claude 진행판」에 보인다):
- 단계가 둘 이상인 요청을 받으면 일을 시작하기 전에 $f 를 아래 형식으로 덮어쓴다.
- 단계를 끝낼 때마다 그 줄을 [x] 로 바꾸고 뒤에 「 - 한 일 한 줄」 메모를 붙인다.
- 새 요청이 오면 새 목표로 덮어쓴다. 한 번에 끝나는 질문·답에는 쓰지 않는다.
- 파일이 이미 있으면 Read 한 뒤 Write 한다. 안 읽고 쓰면 Write 가 거절되니, 거절되면 읽고 다시 쓴다.
- 문구는 한국어, em dash 금지.

# 목표 한 줄
- [x] 끝난 단계 - 한 일 메모
- [ ] 남은 단계
EOF
