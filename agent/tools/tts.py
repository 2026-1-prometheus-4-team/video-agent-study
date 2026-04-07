"""
텍스트 -> 음성 합성 Tool (은채)

TODO
- 실제 TTS 엔진 연동 (예: ElevenLabs, OpenAI TTS, Coqui 등)
- 결과 오디오 파일 경로 반환
"""

import json
import logging
from langchain_core.tools import tool

logger = logging.getLogger(__name__)


@tool
def text_to_speech(text: str, voice: str = "default") -> str:
    """텍스트를 음성으로 합성해 오디오 파일로 저장.

    Args:
        text: 음성으로 변환할 텍스트
        voice: 사용할 보이스 ID (선택)
    """
    logger.info(f"text_to_speech 호출 - voice: {voice}, text: {text[:30]}...")
    # TODO: 실제 TTS 엔진 연동
    return json.dumps({
        "text": text,
        "voice": voice,
        "output": "tts_dummy.wav",
        "status": "dummy",
    })


TOOLS = [text_to_speech]
