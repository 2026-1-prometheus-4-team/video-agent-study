"""
LangGraph 노드 모음

각 노드는 `(state: AgentState) -> dict` 시그니처.
반환된 partial dict 가 state 에 patch 됨.

노드 책임 매트릭스
- analysis_node : 사전 영상 분석 -> video_context 채움
- script_node   : 6 단계 plan JSON 생성 -> script_plan
- supervisor_node : ReAct 루프, sub-agent spawn 으로 step 실행
- critic_node   : 결과 검증 -> PASS / RETRY
"""

from agent.nodes.script_node import script_node, should_interrupt_for_questions
from agent.nodes.critic_node import critic_node, route_after_critic
from agent.nodes.summary_node import summary_node, should_summarize

__all__ = [
    "script_node",
    "should_interrupt_for_questions",
    "critic_node",
    "summary_node",
    "should_summarize",
    "route_after_critic",
]
