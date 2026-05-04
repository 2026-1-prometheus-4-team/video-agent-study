"""
텍스트 -> 음성 합성 Tool (은채)

TODO
- 실제 TTS 엔진 연동 (예: ElevenLabs, OpenAI TTS, Coqui 등)
- 결과 오디오 파일 경로 반환
"""

import json
import logging
from langchain_core.tools import tool
import os
import time
import requests
from dotenv import load_dotenv
import edge_tts
from pathlib import Path
import asyncio

logger = logging.getLogger(__name__)

@tool
def text_to_speech(text: str, voice: str = "ko-KR-SunHiNeural") -> str:
    """텍스트를 음성으로 합성해 오디오 파일로 저장.

    Args:
        text: 음성으로 변환할 텍스트
        voice: 사용할 보이스 ID (선택)
    """
    logger.info(f"text_to_speech 호출 - voice: {voice}, text: {text[:30]}...")
    
    # TODO: 실제 TTS 엔진 연동

    output_dir = "audio_files"
    os.makedirs(output_dir, exist_ok=True)

    filename = f"audio_{int(time.time())}.mp3"
    file_path = os.path.join(output_dir, filename)

    async def run_tts():
        communicate = edge_tts.Communicate(text, voice)
        await communicate.save(file_path)

    try:
        asyncio.run(run_tts())
        
        return json.dumps({
                "text": text,
                "voice": voice,
                "output": file_path,
                "status": "success",
            })

    except Exception as e:
        return json.dumps({
        "text": text,
        "voice": voice,
        "output": None,
        "status": "error",
        "error": str(e)
    })



# 테스트
if __name__ == "__main__":
    print("실행 시작")
    result = text_to_speech.invoke({
        "text": "테스트 음성 안녕하세요",
        "voice": "ko-KR-SunHiNeural"
    })
    print(result)


TOOLS = [text_to_speech]
