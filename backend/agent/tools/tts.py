"""Text-to-speech tool for audio_expert using ElevenLabs."""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

import requests
from dotenv import load_dotenv
from langchain_core.tools import tool
from agent.tools.audio_common import probe_duration

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parents[2]
ROOT_ENV_PATH = BASE_DIR.parent / ".env"
BACKEND_ENV_PATH = BASE_DIR / ".env"

# The project currently keeps secrets in the repository-root .env, while some
# deployments use backend/.env. Load both explicitly so behavior does not depend
# on the PowerShell working directory or import order. Existing process values
# keep precedence (override=False is python-dotenv's default).
load_dotenv(ROOT_ENV_PATH)
load_dotenv(BACKEND_ENV_PATH)

ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY")
ELEVENLABS_DEFAULT_VOICE_ID = os.getenv("ELEVENLABS_DEFAULT_VOICE_ID")
ELEVENLABS_TTS_MODEL = os.getenv("ELEVENLABS_TTS_MODEL", "eleven_multilingual_v2")

VOICES_PATH = BASE_DIR / "assets" / "tts_voices.json"
AUDIO_DIR = BASE_DIR / "audio_files"

_NO_MAPPING_ERROR = (
    "ERROR: 이 카탈로그 보이스는 elevenlabs_voice_id 매핑이 없음 — "
    ".env 의 ELEVENLABS_DEFAULT_VOICE_ID 사용 또는 tts_voices.json 에 매핑 추가"
)

# LangGraph ToolNode 는 여러 tool call 을 병렬 스레드로 실행한다. manifest 는
# read-modify-write 라 락 없이는 동시 append 끼리 서로를 덮어써 항목이 유실된다.
_MANIFEST_LOCK = threading.Lock()


def _json_response(**payload: object) -> str:
    return json.dumps(payload, ensure_ascii=False)


def _load_voice_catalog() -> list[dict]:
    try:
        with open(VOICES_PATH, encoding="utf-8") as f:
            return json.load(f).get("voices", [])
    except Exception as error:
        logger.warning("tts_voices.json load failed: %s", error)
        return []


def _resolve_voice(
    voice: str, voice_id: str = ""
) -> tuple[Optional[str], Optional[str], Optional[str]]:
    """Resolve the voice argument. Returns (elevenlabs_voice_id, catalog_id, error).

    Precedence (merges both selection schemes the team uses):
    1. voice_id: explicit ElevenLabs voice ID — always wins.
    2. "default" / empty: ELEVENLABS_DEFAULT_VOICE_ID from .env.
    3. Numeric alias ("1", "2", ...): ELEVENLABS_VOICE_<N> from .env.
    4. Catalog id (assets/tts_voices.json): resolve its "elevenlabs_voice_id" field.
       A value of "env:<NAME>" points to an environment variable; a missing
       mapping falls back to ELEVENLABS_DEFAULT_VOICE_ID, else returns an error.
    5. Anything else: treated as a raw ElevenLabs voice ID.
    """
    if voice_id:
        # Backward compatibility: older plans put catalog ids or numeric aliases
        # in `voice_id`, although that parameter is documented for raw ElevenLabs
        # ids. Resolve recognizable aliases through the catalog instead of sending
        # strings such as "female_ko_general" to ElevenLabs as if they were ids.
        explicit = str(voice_id).strip()
        catalog_ids = {str(v.get("id", "")) for v in _load_voice_catalog()}
        if explicit.isdigit() or explicit in catalog_ids or explicit == "default":
            voice = explicit
        else:
            return explicit, None, None

    if not voice or voice == "default":
        return (ELEVENLABS_DEFAULT_VOICE_ID or None), None, None

    voice_key = str(voice).strip()

    if voice_key.isdigit():
        mapped = os.getenv(f"ELEVENLABS_VOICE_{voice_key}")
        if mapped:
            return mapped, voice_key, None
        return None, voice_key, (
            f"ERROR: 보이스 별칭 {voice_key} 매핑 없음 — "
            f".env 에 ELEVENLABS_VOICE_{voice_key} 를 추가하거나 다른 보이스를 지정"
        )

    entry = next((v for v in _load_voice_catalog() if v.get("id") == voice_key), None)
    if entry is None:
        return voice_key, None, None

    mapped = entry.get("elevenlabs_voice_id")
    if isinstance(mapped, str) and mapped.startswith("env:"):
        env_name = mapped[4:]
        if env_name == "ELEVENLABS_DEFAULT_VOICE_ID":
            mapped = ELEVENLABS_DEFAULT_VOICE_ID
        else:
            mapped = os.getenv(env_name)
    elif not mapped:
        mapped = ELEVENLABS_DEFAULT_VOICE_ID

    if mapped:
        return mapped, voice_key, None
    return None, voice_key, _NO_MAPPING_ERROR


def _append_narration_manifest(
    key: str,
    output_file: Path,
    text: str,
    voice: str,
    catalog_id: Optional[str],
    params: dict,
) -> Optional[str]:
    """Append one narration entry to audio_files/<key>.narration.json.

    Serialized by _MANIFEST_LOCK: read-modify-write from parallel tool threads
    would otherwise drop entries.
    """
    try:
        AUDIO_DIR.mkdir(parents=True, exist_ok=True)
        manifest_path = AUDIO_DIR / f"{key}.narration.json"
        with _MANIFEST_LOCK:
            entries: list = []
            if manifest_path.exists():
                loaded = json.loads(manifest_path.read_text(encoding="utf-8"))
                if isinstance(loaded, list):
                    entries = loaded
            entry = {
                "id": f"n{len(entries) + 1:03d}",
                "text": text,
                "voice": voice,
                "params": params,
                "file": str(output_file),
                "created_at_epoch": int(time.time()),
            }
            if catalog_id:
                entry["catalog_voice"] = catalog_id
            entries.append(entry)
            manifest_path.write_text(
                json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        return str(manifest_path)
    except Exception as error:
        logger.warning("narration manifest append failed: %s", error)
        return None


@tool
def text_to_speech(
    text: str,
    voice: str = "default",
    voice_id: str = "",
    stability: Optional[float] = None,
    style: Optional[float] = None,
    speed: Optional[float] = None,
    output_path: str = "",
    model: str = "",
) -> str:
    """Convert text to speech and save it as an MP3 file.

    Args:
        text: Text to synthesize.
        voice: Catalog voice id from assets/tts_voices.json (e.g. "male_ko_general"),
            a numeric alias resolved via ELEVENLABS_VOICE_<N>, or a raw ElevenLabs
            voice ID. "default" uses ELEVENLABS_DEFAULT_VOICE_ID.
        voice_id: Explicit ElevenLabs voice ID. Overrides `voice` when set.
        stability: Voice stability 0.0-1.0 (default 0.5). Higher = calmer/steadier,
            lower = more expressive.
        style: Style exaggeration 0.0-1.0. Sent only when provided.
        speed: Speech speed multiplier (e.g. 0.9 calm, 1.1 fast). Sent only when provided.
        output_path: Optional output MP3 path. Defaults to
            audio_files/audio_<ts>_<rand>.mp3. The narration manifest is grouped by
            the output file stem, so pass a stable output_path to group takes.
        model: ElevenLabs model id. Defaults to ELEVENLABS_TTS_MODEL.
    """
    resolved_voice, catalog_id, resolve_error = _resolve_voice(voice, voice_id)
    model_id = model or ELEVENLABS_TTS_MODEL

    logger.info(
        "text_to_speech called - voice: %s (resolved: %s), text: %s...",
        voice, resolved_voice, text[:30],
    )

    if not ELEVENLABS_API_KEY:
        return _json_response(
            text=text,
            voice=voice,
            output=None,
            status="error",
            error="ELEVENLABS_API_KEY is required in .env.",
        )

    if resolve_error:
        return _json_response(
            text=text,
            voice=voice,
            output=None,
            status="error",
            error=resolve_error,
        )

    if not resolved_voice:
        return _json_response(
            text=text,
            voice=voice,
            output=None,
            status="error",
            error="voice_id is required. Set ELEVENLABS_DEFAULT_VOICE_ID in .env.",
        )

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{resolved_voice}"
    headers = {
        "Accept": "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": ELEVENLABS_API_KEY,
    }
    voice_settings: dict = {
        "stability": stability if stability is not None else 0.5,
        "similarity_boost": 0.75,
    }
    if style is not None:
        voice_settings["style"] = style
    if speed is not None:
        voice_settings["speed"] = speed
    data = {
        "text": text,
        "model_id": model_id,
        "voice_settings": voice_settings,
    }

    if output_path:
        resolved_output = Path(output_path)
        if not resolved_output.is_absolute():
            resolved_output = BASE_DIR / output_path
    else:
        # 난수 접미: int(time.time()) 만으로는 같은 초에 병렬 호출된 두 나래이션이
        # 같은 경로에 써서 하나가 조용히 덮어써진다.
        resolved_output = AUDIO_DIR / f"audio_{int(time.time())}_{uuid.uuid4().hex[:6]}.mp3"
    # manifest 는 출력 파일 stem 으로 분리. 예전 기본 키 "session" 은 전역 상수라
    # 모든 세션 / 영상의 나래이션이 audio_files/session.narration.json 에 섞였다.
    manifest_key = resolved_output.stem
    resolved_output.parent.mkdir(parents=True, exist_ok=True)

    try:
        response = requests.post(url, headers=headers, json=data, timeout=60)

        if response.status_code == 200:
            if not response.content:
                return _json_response(
                    text=text,
                    voice=resolved_voice,
                    model=model_id,
                    output=None,
                    status="error",
                    error="ElevenLabs가 빈 TTS 응답을 반환했습니다.",
                )
            resolved_output.write_bytes(response.content)
            manifest = _append_narration_manifest(
                manifest_key, resolved_output, text,
                voice=resolved_voice, catalog_id=catalog_id, params=voice_settings,
            )
            return _json_response(
                text=text,
                voice=resolved_voice,
                catalog_voice=catalog_id,
                model=model_id,
                voice_settings=voice_settings,
                output=str(resolved_output),
                duration_sec=probe_duration(resolved_output),
                manifest=manifest,
                status="success",
            )

        return _json_response(
            text=text,
            voice=resolved_voice,
            model=model_id,
            output=None,
            status="fail",
            status_code=response.status_code,
            error=response.text,
        )

    except requests.exceptions.Timeout:
        return _json_response(
            text=text,
            voice=resolved_voice,
            model=model_id,
            output=None,
            status="error",
            error="ElevenLabs TTS request timed out.",
        )
    except Exception as error:
        return _json_response(
            text=text,
            voice=resolved_voice,
            model=model_id,
            output=None,
            status="error",
            error=str(error),
        )


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
    stability: Optional[float] = None,
    style: Optional[float] = None,
    speed: Optional[float] = None,
) -> str:
    """영상 오디오를 전사한 뒤, 그 텍스트를 TTS로 변환함.

    영상의 발화를 그대로 다른 목소리로 다시 읽히는 용도 (더빙/보이스 교체).

    Args:
        video_path: 영상 파일 경로
        voice: 카탈로그 보이스 id / 숫자 별칭 / raw ElevenLabs voice id. default 면 .env 기본값
        voice_id: 명시적 ElevenLabs voice id (voice 보다 우선)
        output_path: 생성할 TTS 오디오 저장 경로
        model: ElevenLabs TTS 모델
        stability: 목소리 안정도 0.0-1.0 (높을수록 차분)
        style: 스타일 과장 0.0-1.0
        speed: 말 속도 배율 (0.9 차분 / 1.1 빠름)
    """
    from agent.tools.transcribe import transcribe_video

    try:
        transcript_result = json.loads(
            transcribe_video.invoke({"video_path": video_path})
        )
    except Exception as error:
        return _json_response(
            status="error", output=None,
            error="영상 오디오 전사 호출에 실패했습니다.", detail=str(error),
        )

    if transcript_result.get("status") != "success":
        return _json_response(
            status="error", output=None,
            error="영상 오디오 전사에 실패했습니다.",
            transcribe_result=transcript_result,
        )

    transcript_text = _join_transcript_segments(transcript_result.get("segments", []))
    if not transcript_text:
        return _json_response(
            status="error", output=None,
            error="영상에서 TTS로 변환할 음성 텍스트를 찾지 못했습니다.",
            transcribe_result=transcript_result,
        )

    tts_result = json.loads(
        text_to_speech.invoke({
            "text": transcript_text,
            "voice": voice,
            "voice_id": voice_id,
            "output_path": output_path,
            "model": model,
            "stability": stability,
            "style": style,
            "speed": speed,
        })
    )

    return _json_response(
        status=tts_result.get("status", "error"),
        output=tts_result.get("output"),
        text=transcript_text,
        transcript=transcript_result,
        tts=tts_result,
        report=(
            f"segments: {len(transcript_result.get('segments', []))}, "
            f"output: {tts_result.get('output')}"
        ),
    )


if __name__ == "__main__":
    print("실행 시작")
    result = text_to_speech.invoke({"text": "테스트 음성입니다. 안녕하세요."})
    print(result)


TOOLS = [text_to_speech, transcribe_video_to_speech]
