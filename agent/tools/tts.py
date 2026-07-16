"""Text-to-speech tool using ElevenLabs."""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv
from langchain_core.tools import tool


logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parents[2]
ENV_PATH = BASE_DIR / ".env"
load_dotenv(ENV_PATH)

ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech"


def _json_response(**payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False)


def _json_error(message: str, **extra: Any) -> str:
    return _json_response(
        status="error",
        success=False,
        output=None,
        error=message,
        **extra,
    )


def _resolve_output_path(output_path: str = "") -> Path:
    if output_path:
        candidate = Path(output_path)
        if not candidate.is_absolute():
            candidate = BASE_DIR / candidate
        return candidate.resolve()

    output_dir = BASE_DIR / "audio_files"
    return output_dir / f"audio_{int(time.time())}.mp3"

def _resolve_voice_id(voice: str = "default", voice_id: str = "") -> str:
    if voice_id:
        return voice_id

    if not voice or voice == "default":
        return os.getenv("ELEVENLABS_DEFAULT_VOICE_ID", "")

    voice_key = str(voice).strip()

    if voice_key.isdigit():
        return os.getenv(f"ELEVENLABS_VOICE_{voice_key}", "")

    return voice_key


@tool
def text_to_speech(
    text: str,
    voice: str = "default",
    voice_id: str = "",
    output_path: str = "",
    model: str = "",
) -> str:
    """Convert text to speech using ElevenLabs.

    Args:
        text: Text to synthesize.
        voice: ElevenLabs voice id. If omitted or "default", uses
            ELEVENLABS_DEFAULT_VOICE_ID from .env.
        voice_id: Alias for voice. Useful when callers use voice_id as the key.
        output_path: Optional output path. If omitted, saves under audio_files.
        model: ElevenLabs TTS model. Defaults to ELEVENLABS_TTS_MODEL or
            eleven_multilingual_v2.
    """
    logger.info("text_to_speech called - voice: %s, text: %s...", voice, text[:30])

    api_key = os.getenv("ELEVENLABS_API_KEY")
    if not api_key:
        return _json_error("ELEVENLABS_API_KEY가 .env에 필요합니다.")

    selected_voice = _resolve_voice_id(voice=voice, voice_id=voice_id)

    if not selected_voice:
        return _json_error("ELEVENLABS_DEFAULT_VOICE_ID가 .env에 필요합니다.")

    model_id = model or os.getenv("ELEVENLABS_TTS_MODEL", "eleven_multilingual_v2")
    output = _resolve_output_path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    url = f"{ELEVENLABS_TTS_URL}/{selected_voice}"
    headers = {
        "Accept": "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": api_key,
    }
    payload = {
        "text": text,
        "model_id": model_id,
        "voice_settings": {
            "stability": 0.5,
            "similarity_boost": 0.75,
        },
    }

    try:
        response = requests.post(url, headers=headers, json=payload, timeout=60)
        if response.status_code != 200:
            return _json_error(
                "ElevenLabs TTS 요청에 실패했습니다.",
                status_code=response.status_code,
                response=response.text,
                voice=selected_voice,
                model=model_id,
            )

        output.write_bytes(response.content)
        return _json_response(
            status="success",
            success=True,
            text=text,
            voice=selected_voice,
            model=model_id,
            output=str(output),
        )

    except requests.exceptions.Timeout:
        return _json_error(
            "ElevenLabs TTS 요청 시간이 초과되었습니다.",
            voice=selected_voice,
            model=model_id,
        )
    except Exception as error:
        return _json_error(str(error), voice=selected_voice, model=model_id)


def _join_transcript_segments(segments: list[dict]) -> str:
    return " ".join(
        str(segment.get("text", "")).strip()
        for segment in segments
        if str(segment.get("text", "")).strip()
    ).strip()


@tool
def transcribe_video_to_speech(
    video_path: str,
    voice: str = "default",
    voice_id: str = "",
    output_path: str = "",
    model: str = "",
) -> str:
    """영상 오디오를 전사한 뒤, 그 텍스트를 TTS로 변환함.

    Args:
        video_path: 영상 파일 경로
        voice: ElevenLabs voice id. default면 .env의 기본 voice 사용
        voice_id: voice의 별칭
        output_path: 생성할 TTS 오디오 저장 경로
        model: ElevenLabs TTS 모델
    """
    from agent.tools.transcribe import transcribe_video

    try:
        transcript_result = json.loads(
            transcribe_video.invoke({"video_path": video_path})
        )
    except Exception as error:
        return _json_error("영상 오디오 전사 호출에 실패했습니다.", detail=str(error))

    if transcript_result.get("status") != "success":
        return json.dumps(
            {
                "status": "error",
                "success": False,
                "output": None,
                "error": "영상 오디오 전사에 실패했습니다.",
                "transcribe_result": transcript_result,
            },
            ensure_ascii=False,
        )

    transcript_text = _join_transcript_segments(
        transcript_result.get("segments", [])
    )

    if not transcript_text:
        return _json_error(
            "영상에서 TTS로 변환할 음성 텍스트를 찾지 못했습니다.",
            transcribe_result=transcript_result,
        )

    tts_result = json.loads(
        text_to_speech.invoke(
            {
                "text": transcript_text,
                "voice": voice,
                "voice_id": voice_id,
                "output_path": output_path,
                "model": model,
            }
        )
    )

    return json.dumps(
        {
            "status": tts_result.get("status", "error"),
            "success": tts_result.get("status") == "success",
            "output": tts_result.get("output"),
            "text": transcript_text,
            "transcript": transcript_result,
            "tts": tts_result,
            "report": (
                f"segments: {transcript_result.get('segment_count', 0)}, "
                f"output: {tts_result.get('output')}"
            ),
        },
        ensure_ascii=False,
    )

if __name__ == "__main__":
    result = text_to_speech.invoke(
        {
            "text": "테스트 음성입니다. 안녕하세요.",
        }
    )
    print(result)


TOOLS = [text_to_speech, transcribe_video_to_speech]
