"""Background-music generation tool for audio_expert.

Uses ElevenLabs Music API.
Generated audio files are saved under PROJECT_ROOT/bgm_files by default.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv
from langchain_core.tools import tool

from agent.tools.audio_common import ensure_parent, resolve_input_path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
ENV_PATH = PROJECT_ROOT / ".env"
load_dotenv(ENV_PATH)

ELEVENLABS_MUSIC_URL = "https://api.elevenlabs.io/v1/music"
ELEVENLABS_VIDEO_TO_MUSIC_URL = "https://api.elevenlabs.io/v1/music/video-to-music"


def _json_error(message: str, **extra: Any) -> str:
    return json.dumps(
        {
            "status": "error",
            "output": None,
            "error": message,
            **extra,
        },
        ensure_ascii=False,
    )


def _compact(value: str, limit: int = 700) -> str:
    value = " ".join((value or "").split())
    if len(value) <= limit:
        return value
    return value[: limit - 3].rstrip() + "..."


def _build_video_bgm_prompt(
    *,
    prompt: str,
    video_summary: str,
    scene_descriptions: str,
    mood: str,
    genre: str,
    tempo: str,
    energy: str,
    target_use: str,
    instrumental: bool,
) -> str:
    """Build an English music-generation prompt from direct or video context."""
    direct_prompt = prompt.strip()
    if direct_prompt:
        final_prompt = direct_prompt
    else:
        parts = [
            (
                "Compose original background music tailored to the video, with a clear "
                "editorial identity rather than generic stock music."
            ),
            f"Video summary: {_compact(video_summary)}" if video_summary else "",
            (
                f"Scene descriptions: {_compact(scene_descriptions)}"
                if scene_descriptions
                else ""
            ),
            (
                f"Target use: {target_use}"
                if target_use
                else "Target use: short-form video background music"
            ),
            f"Mood: {mood}" if mood else "",
            f"Genre/style: {genre}" if genre else "",
            f"Tempo: {tempo}" if tempo else "",
            f"Energy: {energy}" if energy else "",
            (
                "Default style if unspecified: modern Korean YouTube documentary/vlog "
                "underscore, warm piano or muted synth motif, soft electronic percussion, "
                "subtle bass, polished but not dramatic."
            ),
            (
                "Structure: short attention-grabbing intro, gentle rhythmic development, "
                "small transitions for scene changes, and a clean natural ending."
            ),
            (
                "Mixing: leave space in the 1-4 kHz speech range, keep the melody simple, "
                "avoid busy lead lines, avoid sudden loud hits, and make it easy to duck "
                "under narration or dialogue."
            ),
            (
                "Avoid: elevator music, corporate stock music, cheesy ukulele, overly epic "
                "cinematic trailer sounds, vocals, lyrics, spoken words, and distracting hooks."
            ),
        ]
        final_prompt = ", ".join(part for part in parts if part)

    if instrumental:
        lower_prompt = final_prompt.lower()
        no_vocal_terms = ("instrumental", "no vocals", "no lyrics", "without vocals")
        if not any(term in lower_prompt for term in no_vocal_terms):
            final_prompt = f"{final_prompt}, instrumental, no vocals, no lyrics"

    return final_prompt


def _output_extension(output_format: str) -> str:
    normalized = (output_format or "").lower()
    if normalized.startswith("wav") or normalized.startswith("pcm"):
        return ".wav"
    if normalized.startswith("ogg"):
        return ".ogg"
    return ".mp3"


def _resolve_bgm_output_path(output_path: str, output_format: str) -> Path:
    if output_path:
        candidate = Path(output_path)
        if not candidate.is_absolute():
            candidate = PROJECT_ROOT / candidate
        return candidate.resolve()

    output_dir = PROJECT_ROOT / "bgm_files"
    extension = _output_extension(output_format)
    return output_dir / f"generated_bgm_{time.time_ns()}{extension}"


def _style_tags(*values: str) -> list[str]:
    tags: list[str] = []
    for value in values:
        for item in (value or "").replace(",", " ").split():
            cleaned = item.strip().lower()
            if cleaned and cleaned not in tags:
                tags.append(cleaned)
    return tags[:10]


def _save_audio_response(response: requests.Response, output: Path) -> None:
    ensure_parent(output)
    output.write_bytes(response.content)


@tool
def generate_bgm(
    prompt: str = "",
    duration_sec: int = 30,
    instrumental: bool = True,
    video_path: str = "",
    video_summary: str = "",
    scene_descriptions: str = "",
    mood: str = "",
    genre: str = "",
    tempo: str = "",
    energy: str = "",
    target_use: str = "",
    output_path: str = "",
    provider: str = "elevenlabs",
    model: str = "",
    output_format: str = "",
    timeout_sec: int = 300,
) -> str:
    """Generate BGM audio with ElevenLabs Music API.

    Args:
        prompt: Direct music prompt, e.g. "bright upbeat instrumental vlog BGM".
            If omitted, a prompt is built from video_summary and scene_descriptions.
        duration_sec: Desired duration in seconds. ElevenLabs allows 3-600 seconds.
        instrumental: Force instrumental music when using text-prompt generation.
        video_path: Optional video file. If provided, uses ElevenLabs Video To Music.
        video_summary: Summary of the video to generate matching BGM.
        scene_descriptions: Important scenes, transcript mood, or editing plan details.
        mood: Optional mood, e.g. calm, bright, tense, emotional.
        genre: Optional genre/style, e.g. lo-fi, cinematic, acoustic, electronic.
        tempo: Optional tempo, e.g. slow, medium, fast, 90 BPM.
        energy: Optional energy, e.g. low, medium, high.
        target_use: Optional usage context, e.g. YouTube Shorts, vlog, education.
        output_path: Optional output audio path. Defaults under bgm_files.
        provider: Currently only "elevenlabs" is implemented.
        model: ElevenLabs music model. Defaults to ELEVENLABS_MUSIC_MODEL or music_v2.
        output_format: ElevenLabs output format. Defaults to ELEVENLABS_MUSIC_OUTPUT_FORMAT
            or mp3_44100_128.
        timeout_sec: Maximum wait time for the API request.
    """
    if provider != "elevenlabs":
        return _json_error(
            f"Unsupported BGM provider: {provider}",
            supported_providers=["elevenlabs"],
        )

    api_key = os.getenv("ELEVENLABS_API_KEY")
    if not api_key:
        return _json_error("ELEVENLABS_API_KEY is required in .env")

    model_name = model or os.getenv("ELEVENLABS_MUSIC_MODEL", "music_v2")
    audio_format = (
        output_format
        or os.getenv("ELEVENLABS_MUSIC_OUTPUT_FORMAT")
        or "mp3_44100_128"
    )
    output = _resolve_bgm_output_path(output_path, audio_format)

    final_prompt = _build_video_bgm_prompt(
        prompt=prompt,
        video_summary=video_summary,
        scene_descriptions=scene_descriptions,
        mood=mood,
        genre=genre,
        tempo=tempo,
        energy=energy,
        target_use=target_use,
        instrumental=instrumental,
    )

    headers = {"xi-api-key": api_key}
    params = {"output_format": audio_format}

    try:
        if video_path:
            source_video = resolve_input_path(video_path)
            description = _compact(final_prompt, 1000)
            tags = _style_tags(mood, genre, tempo, energy, target_use)

            with source_video.open("rb") as video_file:
                files = [("videos[]", (source_video.name, video_file))]
                data: list[tuple[str, str]] = [
                    ("description", description),
                    ("model_id", model_name),
                ]
                for tag in tags:
                    data.append(("tags[]", tag))

                response = requests.post(
                    ELEVENLABS_VIDEO_TO_MUSIC_URL,
                    headers=headers,
                    params=params,
                    files=files,
                    data=data,
                    timeout=timeout_sec,
                )
            mode = "video_to_music"
        else:
            duration_ms = max(3000, min(int(duration_sec * 1000), 600000))
            payload: dict[str, Any] = {
                "prompt": final_prompt,
                "music_length_ms": duration_ms,
                "model_id": model_name,
                "force_instrumental": instrumental,
            }

            response = requests.post(
                ELEVENLABS_MUSIC_URL,
                headers={**headers, "Content-Type": "application/json"},
                params=params,
                json=payload,
                timeout=timeout_sec,
            )
            mode = "prompt"

        if response.status_code >= 400:
            return _json_error(
                "ElevenLabs Music API request failed",
                status_code=response.status_code,
                response=response.text,
                provider=provider,
                model=model_name,
                mode=mode,
            )

        _save_audio_response(response, output)
        return json.dumps(
            {
                "status": "success",
                "output": str(output),
                "provider": provider,
                "model": model_name,
                "mode": mode,
                "prompt": final_prompt,
                "prompt_mode": "direct" if prompt.strip() else "video_context",
                "duration_sec": duration_sec,
                "instrumental": instrumental,
                "video_path": video_path or None,
                "video_summary": video_summary or None,
                "scene_descriptions": scene_descriptions or None,
                "mood": mood or None,
                "genre": genre or None,
                "tempo": tempo or None,
                "energy": energy or None,
                "target_use": target_use or None,
                "output_format": audio_format,
                "song_id": response.headers.get("song-id"),
                "report": (
                    f"output: {output}, provider: {provider}, model: {model_name}, "
                    f"mode: {mode}, duration_sec: {duration_sec}, "
                    f"instrumental: {instrumental}"
                ),
            },
            ensure_ascii=False,
        )
    except Exception as error:
        return _json_error(str(error), provider=provider, model=model_name)


TOOLS = [generate_bgm]
