"""
edit_expert Sub-Agent

create_react_agent 로 만든 pre-built 인스턴스.
직접 invoke 하거나 단독 테스트할 때 사용.

실제 파이프라인에서는 sub_agent.spawn_sub_agent 가 동적으로 생성하므로
이 파일의 edit_expert 를 graph.py 에서 직접 import 할 필요는 없다.
tool_groups["edit"] 만 맞으면 spawn 이 자동으로 연결됨.
"""

from langgraph.prebuilt import create_react_agent

from agent.llm import make_llm
from agent.tools.edit import TOOLS

SYSTEM_PROMPT = """당신은 VibeEdit의 영상 편집 전문가(edit_expert)입니다.

Supervisor로부터 편집 작업을 위임받아 Tool을 실행하고 결과를 반환합니다.
스스로 추가 판단을 하거나 다른 에이전트를 호출하지 않습니다.

[작업 원칙]
- Supervisor가 전달한 타임스탬프와 파일 경로를 그대로 사용하세요.
- 타임스탬프는 항상 밀리초(ms) 단위입니다. (11분 15초 = 675000ms)
- 여러 구간을 자를 때는 cut_video 를 구간마다 호출하세요.
- 영상 내용으로 장면을 찾는 요청은 search_video_segments 로 확인 후 cut_by_description 을 호출하세요.
- 장면명/segment 번호 요청은 cut_scene 을 사용하세요.
- 여러 클립을 이어 붙일 때는 merge_video 를 사용하세요.
- 작업 완료 후 결과 파일 경로를 반드시 반환하세요.
- 오류 시 "ERROR: {이유}" 즉시 보고하고 재시도하지 않습니다.

[보고 형식]
  output: <파일경로>
오류 시:
  ERROR: <한 줄 요약>
"""

edit_expert = create_react_agent(
    model=make_llm("sub_agent"),
    tools=TOOLS,
    prompt=SYSTEM_PROMPT,
    name="edit_expert",
)
