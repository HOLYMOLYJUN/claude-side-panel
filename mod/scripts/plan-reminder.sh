#!/bin/bash
# UserPromptSubmit 훅: 긴 세션에서도 진행판 규칙을 잊지 않게 요청마다 한 줄로 다시 알린다.
id=$(jq -r '.session_id')
echo "진행판: 이 요청이 단계 둘 이상이면 시작 전에 $HOME/.claude/session-plans/$id.md 를 새 목표로 덮어쓰고, 단계를 끝낼 때마다 [x] 와 「 - 한 일」 메모로 갱신한다."
