"""Text-to-speech tool for audio_expert using ElevenLabs."""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

import requests
from dotenv import load_dotenv
from langchain_core.tools import tool

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parents[2]
ENV_PATH = BASE_DIR / ".env"

load_dotenv(ENV_PATH)

ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY")
ELEVENLABS_DEFAULT_VOICE_ID = os.getenv("ELEVENLABS_DEFAULT_VOICE_ID")
ELEVENLABS_TTS_MODEL = os.getenv("ELEVENLABS_TTS_MODEL", "eleven_multilingual_v2")


def _json_response(**payload: object) -> str:
    return json.dumps(payload, ensure_ascii=False)


@tool
def text_to_speech(text: str, voice: str = "default") -> str:
    """Convert text to speech and save it as an MP3 file.

    Args:
        text: Text to synthesize.
        voice: ElevenLabs voice ID. If "default", ELEVENLABS_DEFAULT_VOICE_ID is used.
    """
    if voice == "default":
        voice = ELEVENLABS_DEFAULT_VOICE_ID or ""

    logger.info("text_to_speech called - voice: %s, text: %s...", voice, text[:30])

    if not ELEVENLABS_API_KEY:
        return _json_response(
            text=text,
            voice=voice,
            output=None,
            status="error",
            error="ELEVENLABS_API_KEY is required in .env.",
        )

    if not voice:
        return _json_response(
            text=text,
            voice=voice,
            output=None,
            status="error",
            error="voice_id is required. Set ELEVENLABS_DEFAULT_VOICE_ID in .env.",
        )

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice}"
    headers = {
        "Accept": "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": ELEVENLABS_API_KEY,
    }
    data = {
        "text": text,
        "model_id": ELEVENLABS_TTS_MODEL,
        "voice_settings": {
            "stability": 0.5,
            "similarity_boost": 0.75,
        },
    }

    output_dir = BASE_DIR / "audio_files"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"audio_{int(time.time())}.mp3"

    try:
        response = requests.post(url, headers=headers, json=data, timeout=60)
        print("status_code:", response.status_code)

        if response.status_code == 200:
            output_path.write_bytes(response.content)
            return _json_response(
                text=text,
                voice=voice,
                model=ELEVENLABS_TTS_MODEL,
                output=str(output_path),
                status="success",
            )

        return _json_response(
            text=text,
            voice=voice,
            model=ELEVENLABS_TTS_MODEL,
            output=None,
            status="fail",
            status_code=response.status_code,
            error=response.text,
        )

    except requests.exceptions.Timeout:
        return _json_response(
            text=text,
            voice=voice,
            model=ELEVENLABS_TTS_MODEL,
            output=None,
            status="error",
            error="ElevenLabs TTS request timed out.",
        )
    except Exception as error:
        return _json_response(
            text=text,
            voice=voice,
            model=ELEVENLABS_TTS_MODEL,
            output=None,
            status="error",
            error=str(error),
        )


if __name__ == "__main__":
    print("실행 시작")
    result = text_to_speech.invoke({"text": "테스트 음성입니다. 안녕하세요."})
    print(result)


TOOLS = [text_to_speech]
