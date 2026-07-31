"""
자막 / 타이틀 / 캡션 / 오버레이 텍스트 Tool (은채)

FFmpeg subtitles= (SRT burn-in) / drawtext= (오버레이) 필터로 텍스트를 영상에 삽입.
- SRT 파일 저장 위치: videos/subtitles/
- 폰트 파일 위치: assets/fonts/, 한국어 기본: NotoSansKR-Regular.ttf
"""

import json
import logging
import os
import re
import subprocess
import uuid
from pathlib import Path
from dotenv import load_dotenv
from langchain_core.tools import tool
from typing_extensions import TypedDict

logger = logging.getLogger(__name__)

_HERE = os.path.dirname(__file__)
PROJECT_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
VIDEOS_DIR = os.path.join(PROJECT_ROOT, "videos")
SUBTITLES_DIR = os.path.join(VIDEOS_DIR, "subtitles")
FONTS_DIR = os.path.abspath(os.path.join(_HERE, "..", "..", "assets", "fonts"))

# 경로를 명시해야 한다 — 인자 없는 load_dotenv() 는 CWD 부터 위로 훑어서
# backend/ 밖(리포 루트, pytest 등)에서 띄우면 조용히 무시되고 SUBTITLE_FONT 가
# 기본값으로 돌아간다.
load_dotenv(os.path.abspath(os.path.join(_HERE, "..", "..", ".env")))

_DEFAULT_FONT_FILE = os.getenv("SUBTITLE_FONT", "NotoSansKR-Regular.ttf")
_EMOJI_FONT_FILE = "NotoColorEmoji.ttf"
_FONTCONFIG_FILE = os.path.abspath(
    os.path.join(_HERE, "..", "..", "assets", "fontconfig", "fonts.conf")
)


def _resolve_video_file(video_path: str) -> Path:
    """Resolve absolute, videos/... and videos-relative paths consistently."""
    raw = Path(video_path)
    if raw.is_absolute():
        return raw.resolve()
    parts = raw.parts
    without_videos = (
        Path(*parts[1:]) if parts and parts[0].lower() == "videos" else raw
    )
    backend_root = Path(VIDEOS_DIR).parent
    candidates = [
        backend_root / raw,
        Path(VIDEOS_DIR) / without_videos,
        Path(VIDEOS_DIR) / raw,
    ]
    return next((p.resolve() for p in candidates if p.exists()), candidates[1].resolve())

# 반응형 자막 비율 상수 (PlayResY=288 기준 ASS 캔버스 / drawtext 는 실제 픽셀)
_FONT_SIZE_PCT = 0.05          # 화면 높이의 5%
_MARGIN_LANDSCAPE_PCT = 0.08   # 가로형 하단 마진 (8%)
_MARGIN_PORTRAIT_PCT = 0.15    # 세로형 하단 마진 (15%)


class AutoSubtitleStyle(TypedDict, total=False):
    platform: str
    font: str
    font_size: int
    size: int
    color: str
    stroke_color: str
    stroke_width: float
    position: str
    margin_v: int
    bold: bool
    fade: bool


def _get_video_size_ffprobe(video_path: str) -> tuple[int, int]:
    """ffprobe 로 영상 너비×높이 반환. 실패 시 (0, 0)."""
    import subprocess as _sp
    cmd = [
        "ffprobe", "-v", "quiet",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height",
        "-of", "csv=p=0",
        video_path,
    ]
    result = _sp.run(cmd, capture_output=True, text=True)
    try:
        w, h = result.stdout.strip().split(",")
        return int(w), int(h)
    except (ValueError, IndexError):
        return 0, 0


def _resolve_video_path(video_path: str) -> str:
    """Resolve absolute, backend-relative, then videos-relative paths."""
    if os.path.isabs(video_path):
        return os.path.normpath(video_path)
    project_relative = os.path.join(PROJECT_ROOT, video_path)
    if os.path.exists(project_relative):
        return os.path.normpath(project_relative)
    return os.path.normpath(os.path.join(VIDEOS_DIR, video_path))


def _render_error(result: str) -> str | None:
    """Normalize text_expert tool errors, including JSON-formatted errors."""
    if not isinstance(result, str):
        return "자막 렌더 결과 형식이 올바르지 않습니다."
    if result.startswith("ERROR"):
        return result.partition(":")[2].strip() or result
    try:
        parsed = json.loads(result)
    except (json.JSONDecodeError, TypeError):
        return None
    if isinstance(parsed, dict) and (
        parsed.get("status") == "error" or parsed.get("error")
    ):
        return str(parsed.get("message") or parsed.get("error"))
    return None


_FONT_MAGIC = (b"\x00\x01\x00\x00", b"OTTO", b"true")
_family_cache: dict[str, str | None] = {}  # 파일 절대경로 -> 내부 family 명


def _sfnt_family_name(font_path: str) -> str | None:
    """TTF/OTF name 테이블에서 family 명(nameID 16 우선, 없으면 1) 추출.

    libass 는 폰트 *내부* family 명으로만 매칭한다. 파일이 폰트가 아니거나
    파싱 실패면 None (호출부가 파일명 기반으로 폴백).
    """
    import struct

    try:
        with open(font_path, "rb") as f:
            data = f.read()
        if data[:4] not in _FONT_MAGIC:
            return None
        num_tables = struct.unpack(">H", data[4:6])[0]
        for i in range(num_tables):
            rec = 12 + i * 16
            if data[rec:rec + 4] != b"name":
                continue
            t_off = struct.unpack(">I", data[rec + 8:rec + 12])[0]
            count, str_off = struct.unpack(">HH", data[t_off + 2:t_off + 6])
            candidates: dict[tuple[int, bool], str] = {}
            for j in range(count):
                r = t_off + 6 + j * 12
                pid, _eid, lid, nid, length, offset = struct.unpack(
                    ">6H", data[r:r + 12]
                )
                if nid not in (1, 16):
                    continue
                raw = data[t_off + str_off + offset:t_off + str_off + offset + length]
                if pid == 3:  # Windows: UTF-16BE
                    value = raw.decode("utf-16-be", "ignore").strip()
                else:  # Mac/Unicode: 사실상 ASCII/Latin-1
                    value = raw.decode("latin-1", "ignore").strip()
                if value:
                    candidates[(nid, pid == 3 and lid == 0x409)] = value
            # typographic family(16) > legacy family(1), 영어(0x409) 우선
            for key in ((16, True), (1, True), (16, False), (1, False)):
                if key in candidates:
                    return candidates[key]
            return None
    except (OSError, struct.error):
        return None
    return None


def _font_family_from_file(font_file: str) -> str:
    """폰트 파일명 -> libass FontName (폰트 내부 family 명).

    force_style 의 FontName 은 *패밀리명* 이라 파일명을 그대로 넣으면 매칭 실패.
    파일명 stem 은 내부 family 와 다른 경우가 많다 (NotoSansKR-Regular.ttf 의
    내부 명은 "Noto Sans KR"). 이름이 틀리면 libass 가 Arial 로 조용히 폴백해
    한글이 두부가 되므로, 폰트 파일의 name 테이블에서 직접 읽는다.
    """
    stem = os.path.splitext(os.path.basename(font_file))[0]
    for suffix in ("-Regular", "-Bold", "-Medium", "-Light", "-SemiBold", "-ExtraBold"):
        if stem.endswith(suffix):
            stem = stem[: -len(suffix)]
            break

    path = os.path.join(FONTS_DIR, os.path.basename(font_file))
    if os.path.exists(path):
        abs_path = os.path.abspath(path)
        if abs_path not in _family_cache:
            _family_cache[abs_path] = _sfnt_family_name(abs_path)
        parsed = _family_cache[abs_path]
        if parsed:
            return parsed

    # 파일이 없거나 파싱 실패 — 알려진 패밀리 매핑 후 stem 폴백.
    known_families = {
        "NotoSansKR": "Noto Sans KR",
        "NotoSerifKR": "Noto Serif KR",
    }
    return known_families.get(stem, stem)


# ─── 내부 헬퍼 ────────────────────────────────────────────────────────────────

def _resolve_font(filename: str) -> str | None:
    """fonts/ 디렉터리에 해당 폰트가 있으면 절대 경로, 없으면 None."""
    path = os.path.join(FONTS_DIR, filename)
    return path if os.path.exists(path) else None


def _ffmpeg_env() -> dict[str, str]:
    """Return a subprocess environment with a project fontconfig on Windows.

    Gyan/WinGet FFmpeg builds can include libass/fontconfig without installing a
    machine-wide default fonts.conf. In that case subtitles rendering fails even
    when fontsdir points at a valid TTF. Keep explicit user configuration, but
    provide the project config as the Windows fallback.
    """
    env = os.environ.copy()
    if os.name == "nt" and os.path.isfile(_FONTCONFIG_FILE):
        env.setdefault("FONTCONFIG_FILE", _FONTCONFIG_FILE)
        env.setdefault("FONTCONFIG_PATH", os.path.dirname(_FONTCONFIG_FILE))
    return env


def _seconds_to_srt_time(s: float) -> str:
    h = int(s // 3600)
    m = int((s % 3600) // 60)
    sec = int(s % 60)
    ms = int((s % 1) * 1000)
    return f"{h:02d}:{m:02d}:{sec:02d},{ms:03d}"


def _wrap_text(text: str, max_len: int) -> str:
    """공백 기준 줄바꿈. max_len 초과 시 이전 공백에서 분리."""
    if len(text) <= max_len:
        return text
    lines = []
    while len(text) > max_len:
        idx = text[:max_len].rfind(" ")
        if idx == -1:
            idx = max_len
        lines.append(text[:idx])
        text = text[idx:].strip()
    if text:
        lines.append(text)
    return "\n".join(lines)


def _calc_max_chars(font_size: int) -> int:
    """화면 80% 기준 최대 한 줄 글자 수.

    libass 기본 PlayResX=640 기준으로 한국어 전각 문자 너비 ≈ font_size px.
    → max_chars = 0.8 * 640 / font_size = 512 / font_size
    """
    return max(8, int(512 / font_size))


def _build_srt(transcript: list, platform: str = "youtube", max_len: int = 0) -> str:
    """transcript 세그먼트 리스트 → SRT 문자열. 타이밍은 원본 그대로.

    max_len > 0 이면 해당 글자 수 초과 시 줄바꿈.
    """
    blocks = []
    for i, seg in enumerate(transcript, 1):
        start_ts = _seconds_to_srt_time(float(seg["start"]))
        end_ts = _seconds_to_srt_time(float(seg["end"]))
        text = seg.get("text", "").strip()
        if max_len > 0:
            text = _wrap_text(text, max_len)
        blocks.append(f"{i}\n{start_ts} --> {end_ts}\n{text}")
    return "\n\n".join(blocks)


def _ffmpeg_filter_path(path: str) -> str:
    """Windows 드라이브 콜론을 이스케이프 — FFmpeg filtergraph 내 경로 안전 변환."""
    path = path.replace("\\", "/")
    if len(path) >= 2 and path[1] == ":":
        path = path[0] + "\\:" + path[2:]
    return path


def _escape_drawtext(text: str) -> str:
    """FFmpeg drawtext text= 값 이스케이프."""
    text = text.replace("\\", "\\\\")
    text = text.replace("'", "\\'")
    text = text.replace(":", "\\:")
    text = text.replace("%", "%%")
    return text


def _default_style(platform: str = "youtube") -> dict:
    if platform == "shorts":
        return {
            "font_size": 24,
            "color": "white",
            "stroke_color": "black",
            "stroke_width": 2,
            "position": "bottom",
            "margin_v": 30,
            "platform": "shorts",
        }
    return {
        "font_size": 24,
        "color": "white",
        "stroke_color": "black",
        "stroke_width": 1.5,
        "position": "bottom",
        "margin_v": 40,
        "platform": "youtube",
    }


def _merge_style(style_json: str | dict, tool_defaults: dict | None = None) -> dict:
    """style JSON 문자열/dict를 플랫폼 기본값에 병합."""
    overrides: dict = {}
    if isinstance(style_json, dict):
        overrides = dict(style_json)
    elif style_json:
        try:
            overrides = json.loads(style_json)
        except (json.JSONDecodeError, TypeError):
            logger.warning("style JSON 파싱 실패 — 기본값 사용")

    platform = overrides.get("platform", "youtube")
    style = _default_style(platform)
    if tool_defaults:
        style.update(tool_defaults)
    style.update(overrides)
    return style


def _ass_alignment(position: str) -> int:
    """ASS/SSA 정렬 코드: bottom=2, center=5, top=8."""
    return {"bottom": 2, "center": 5, "top": 8}.get(position, 2)


_NAMED_COLORS = {
    "white": "FFFFFF",
    "black": "000000",
    "yellow": "FFFF00",
    "red": "FF0000",
    "green": "00FF00",
    "blue": "0000FF",
    "orange": "FFA500",
    "cyan": "00FFFF",
    "magenta": "FF00FF",
    "pink": "FFC0CB",
    "gray": "808080",
    "grey": "808080",
}


def _hex_to_rgb(value: str) -> tuple[int, int, int]:
    """'#RRGGBB' / 'RGB' / 색 이름 → (r, g, b). 형식 오류 시 ValueError."""
    v = str(value).strip().lower()
    v = _NAMED_COLORS.get(v, v)
    v = v.lstrip("#")
    if len(v) == 3:
        v = "".join(ch * 2 for ch in v)
    if not re.fullmatch(r"[0-9a-fA-F]{6}", v):
        raise ValueError(f"색상 형식 오류: {value}")
    return int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16)


def _color_to_ass(value: str, alpha: str | None = None) -> str:
    """임의 hex/색 이름 → ASS 색 문자열 (&H[AA]BBGGRR — BGR 순서).

    alpha=None 이면 force_style/인라인 태그용 &HBBGGRR,
    alpha='00' 등 지정 시 [V4+ Styles] 라인용 &HAABBGGRR.
    """
    r, g, b = _hex_to_rgb(value)
    if alpha is None:
        return f"&H{b:02X}{g:02X}{r:02X}"
    return f"&H{alpha}{b:02X}{g:02X}{r:02X}"


def _srt_force_style(style: dict, font_name: str) -> str:
    """FFmpeg subtitles= force_style 문자열 생성. 색은 임의 hex/색 이름 허용."""
    try:
        primary = _color_to_ass(style.get("color", "white"))
    except ValueError:
        logger.warning(f"color 파싱 실패({style.get('color')}) — white 사용")
        primary = "&HFFFFFF"
    try:
        outline = _color_to_ass(style.get("stroke_color", "black"))
    except ValueError:
        logger.warning(f"stroke_color 파싱 실패({style.get('stroke_color')}) — black 사용")
        outline = "&H000000"
    return (
        f"FontName={font_name},"
        f"FontSize={style.get('font_size', 24)},"
        f"PrimaryColour={primary},"
        f"OutlineColour={outline},"
        f"Outline={style.get('stroke_width', 1.5)},"
        f"Alignment={_ass_alignment(style.get('position', 'bottom'))},"
        f"MarginV={style.get('margin_v', 40)}"
    )


def _drawtext_xy(position: str) -> str:
    return {
        "center": "x=(w-text_w)/2:y=(h-text_h)/2",
        "top": "x=(w-text_w)/2:y=h*0.05",
        "bottom": "x=(w-text_w)/2:y=h*0.85",
        "top-left": "x=w*0.05:y=h*0.05",
        "top-right": "x=w*0.95-text_w:y=h*0.05",
        "bottom-left": "x=w*0.05:y=h*0.85",
        "bottom-right": "x=w*0.95-text_w:y=h*0.85",
    }.get(position, "x=(w-text_w)/2:y=(h-text_h)/2")


def _run_ffmpeg(cmd: list) -> tuple[int, str]:
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="ignore",
        env=_ffmpeg_env(),
    )
    return result.returncode, result.stderr


# ─── Tools ────────────────────────────────────────────────────────────────────

@tool
def add_subtitle(video_path: str, srt_path: str, style: str = "") -> str:
    """SRT 파일을 영상에 burn-in 자막으로 삽입.

    audio_expert가 생성한 SRT 또는 직접 제공한 SRT를 영상에 합성.
    자막 타이밍은 SRT 그대로 유지 (임의 수정 금지).

    Args:
        video_path: 입력 영상 파일명 (videos/ 기준, 예: sample.mp4)
        srt_path: SRT 파일 경로 (videos/subtitles/ 기준 상대경로 또는 절대경로)
        style: JSON 스타일 문자열
               {'font_size':24, 'color':'white', 'stroke_width':1.5,
                'position':'bottom', 'margin_v':40, 'platform':'youtube'}
    """
    try:
        input_path = _resolve_video_path(video_path)
        if not os.path.exists(input_path):
            return json.dumps({"error": f"영상 파일 없음: {input_path}"}, ensure_ascii=False)

        srt_abs = srt_path if os.path.isabs(srt_path) else os.path.join(SUBTITLES_DIR, srt_path)
        if not os.path.exists(srt_abs):
            return json.dumps({"error": f"SRT 파일 없음: {srt_abs}"}, ensure_ascii=False)

        s = _merge_style(style)

        # 영상 해상도 감지 → force_style 값 반응형 조정 (기본값인 경우에만)
        vw, vh = _get_video_size_ffprobe(input_path)
        if vh > 0:
            is_portrait = vh > vw
            default_s = _default_style(s.get("platform", "youtube"))
            if s.get("font_size") == default_s["font_size"]:
                # PlayResY=288 캔버스 기준 — libass 가 actual_h/288 배율로 스케일
                s["font_size"] = max(8, round(288 * _FONT_SIZE_PCT))
            if s.get("margin_v") == default_s["margin_v"]:
                pct = _MARGIN_PORTRAIT_PCT if is_portrait else _MARGIN_LANDSCAPE_PCT
                s["margin_v"] = max(4, round(288 * pct))

        font_path = _resolve_font(_DEFAULT_FONT_FILE)
        # SUBTITLE_FONT 로 다른 폰트를 지정해도 여기서 NotoSansKR 을 박으면
        # libass 가 그 패밀리를 못 찾아 폰트 지정이 무력화된다 — 실제 파일에서 유도.
        font_name = _font_family_from_file(_DEFAULT_FONT_FILE) if font_path else "Arial"
        if not font_path:
            logger.warning(f"{_DEFAULT_FONT_FILE} 없음 — 시스템 기본 폰트(Arial) 사용")

        force_style = _srt_force_style(s, font_name)
        srt_ffmpeg = _ffmpeg_filter_path(srt_abs)

        fonts_part = ""
        if os.path.exists(FONTS_DIR):
            fonts_part = f":fontsdir='{_ffmpeg_filter_path(FONTS_DIR)}'"

        vf = f"subtitles='{srt_ffmpeg}'{fonts_part}:force_style='{force_style}'"

        name, ext = os.path.splitext(os.path.basename(input_path))
        output_path = os.path.join(
            os.path.dirname(input_path),
            f"{name}_subtitled{ext or '.mp4'}",
        )

        cmd = ["ffmpeg", "-y", "-i", input_path, "-vf", vf, output_path]
        code, stderr = _run_ffmpeg(cmd)
        if code != 0:
            return json.dumps({"error": stderr[-800:]}, ensure_ascii=False)

        with open(srt_abs, encoding="utf-8") as f:
            segments = len([b for b in f.read().split("\n\n") if b.strip()])

        # 큐 문서 동기화 — 기존 문서가 없을 때만 SRT 기반으로 생성 (best-effort)
        try:
            from agent.tools import subtitle_cues  # 지연 임포트 (순환 방지)
            subtitle_cues.sync_cues_from_srt(input_path, srt_abs, style=s)
        except Exception as sync_error:
            logger.warning(f"큐 문서 동기화 스킵: {sync_error}")

        return json.dumps({
            "output": output_path,
            "style": {"font": font_name, "size": s["font_size"], "color": s["color"]},
            "segments": segments,
            "status": "success",
        }, ensure_ascii=False)

    except FileNotFoundError:
        return json.dumps({"error": "FFmpeg가 설치되어 있지 않습니다."}, ensure_ascii=False)
    except Exception as e:
        logger.error(f"add_subtitle 오류: {e}")
        return json.dumps({"error": str(e)}, ensure_ascii=False)


def _source_speech(source: str) -> list[dict]:
    """원본 영상의 발화 목록을 [{start_ms, end_ms, text}] 로 반환.

    우선순위:
    1) videos/subtitles/<원본>.json — Whisper 원본 전사.
       실제 발화 경계와 정확한 문장이 그대로 남아 있어 자막의 1순위.
    2) videos/<원본>_analysis.json 의 transcript — Gemini 가 프레임 구간에 맞춰
       재가공한 것이라 경계가 뭉개져 있다. Whisper 결과가 없을 때만 fallback.
    """
    stem = os.path.splitext(os.path.basename(source))[0]

    whisper_path = os.path.join(SUBTITLES_DIR, f"{stem}.json")
    if os.path.exists(whisper_path):
        try:
            with open(whisper_path, encoding="utf-8") as f:
                cache = json.load(f)
            segs = cache.get("segments", [])
            correction = cache.get("correction") or {}
            saved_display = cache.get("display_segments")
            if isinstance(saved_display, list) and saved_display:
                display_speech = [
                    item
                    for item in saved_display
                    if isinstance(item, dict) and item.get("kind") != "sound"
                ]
                display_edits = {
                    index: str(item.get("text", "")).strip()
                    for index, item in enumerate(display_speech)
                    if str(item.get("text", "")).strip()
                }
            else:
                display_edits = {
                    item["segment_index"]: item["display_text"]
                    for item in correction.get("display_edits", [])
                    if (
                        isinstance(item, dict)
                        and isinstance(item.get("segment_index"), int)
                        and isinstance(item.get("display_text"), str)
                    )
                }
            speech = [
                {
                    "start_ms": int(float(s.get("start", 0)) * 1000),
                    "end_ms": int(float(s.get("end", 0)) * 1000),
                    "text": str(s.get("text", "")).strip(),
                    "display_text": display_edits.get(
                        index,
                        str(s.get("text", "")).strip(),
                    ),
                    "kind": "speech",
                }
                for index, s in enumerate(segs)
                if str(s.get("text", "")).strip()
            ]
            if isinstance(saved_display, list) and saved_display:
                sound_items = [
                    {
                        "start": item.get("start"),
                        "end": item.get("end"),
                        "text": item.get("text"),
                    }
                    for item in saved_display
                    if isinstance(item, dict) and item.get("kind") == "sound"
                ]
            else:
                sound_items = correction.get("sound_captions", [])
            for item in sound_items:
                if not isinstance(item, dict) or not str(item.get("text", "")).strip():
                    continue
                speech.append({
                    "start_ms": int(float(item.get("start", 0)) * 1000),
                    "end_ms": int(float(item.get("end", 0)) * 1000),
                    "text": "",
                    "display_text": str(item["text"]).strip(),
                    "kind": "sound",
                })
            speech.sort(key=lambda item: (item["start_ms"], item["end_ms"]))
            return speech
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            pass

    analysis_path = os.path.join(VIDEOS_DIR, f"{stem}_analysis.json")
    if os.path.exists(analysis_path):
        try:
            with open(analysis_path, encoding="utf-8") as f:
                segs = json.load(f).get("segments", [])
            return [
                {
                    "start_ms": s.get("start_ms", 0),
                    "end_ms": s.get("end_ms", 0),
                    "text": str(s.get("transcript") or "").strip(),
                    "display_text": str(s.get("transcript") or "").strip(),
                    "kind": "speech",
                }
                for s in segs
                if str(s.get("transcript") or "").strip()
            ]
        except (OSError, json.JSONDecodeError):
            pass

    return []


def _transcript_from_origin(video_path: str) -> list[dict]:
    """편집 결과물의 origin 정보로 원본 대사를 재구성.

    cut/merge 가 남긴 <파일>.origin.json 에는 각 구간이 어느 원본의
    어느 시각이었는지(source/start_ms/end_ms) 와 결과물 내 위치(offset_ms)가 들어있다.
    이를 이용해 원본 발화(_source_speech)를 잘라내고 시간축을 옮겨 붙인다.

    origin 정보가 없거나 원본에 대사가 없으면 빈 리스트 → 호출측이 재전사 fallback.
    """
    try:
        from agent.tools.edit import _read_origin
    except ImportError:
        return []

    clips = _read_origin(video_path)
    if not clips:
        return []

    out: list[dict] = []
    for clip in clips:
        source = clip.get("source")
        if not source:
            continue

        speech = _source_speech(source)
        if not speech:
            continue

        clip_start = clip.get("start_ms", 0)
        clip_end = clip.get("end_ms", 0)
        offset = clip.get("offset_ms", 0)

        for seg in speech:
            seg_start = seg["start_ms"]
            seg_end = seg["end_ms"]
            # 클립 구간과 겹치는 부분만
            if seg_end <= clip_start or seg_start >= clip_end:
                continue
            # 원본 시각 -> 결과물 시각으로 이동 + 클립 경계로 자르기
            new_start = max(seg_start, clip_start) - clip_start + offset
            new_end = min(seg_end, clip_end) - clip_start + offset
            if new_end <= new_start:
                continue
            out.append({
                "start": round(new_start / 1000, 2),
                "end": round(new_end / 1000, 2),
                "text": seg["text"],
                "display_text": seg.get("display_text", seg["text"]),
                "kind": seg.get("kind", "speech"),
            })

    out.sort(key=lambda s: s["start"])
    return out


def _display_segments(
    segments: list[dict],
    correction: dict | None = None,
) -> list[dict]:
    """Build render-only captions while leaving canonical spoken segments untouched."""
    correction = correction if isinstance(correction, dict) else {}
    display_edits = {
        item["segment_index"]: item["display_text"]
        for item in correction.get("display_edits", [])
        if (
            isinstance(item, dict)
            and isinstance(item.get("segment_index"), int)
            and isinstance(item.get("display_text"), str)
        )
    }
    rendered: list[dict] = []
    for index, segment in enumerate(segments):
        display_text = str(
            segment.get("display_text")
            or display_edits.get(index)
            or segment.get("text", "")
        ).strip()
        if not display_text:
            continue
        item = {
            "start": float(segment["start"]),
            "end": float(segment["end"]),
            "text": display_text,
        }
        if isinstance(segment.get("style"), dict):
            item["style"] = segment["style"]
        if segment.get("kind") == "sound":
            item["style"] = {
                "position": "top",
                "color": "#FFE600",
                **item.get("style", {}),
            }
            item["kind"] = "sound"
        rendered.append(item)

    for sound in correction.get("sound_captions", []):
        if not isinstance(sound, dict) or not str(sound.get("text", "")).strip():
            continue
        rendered.append({
            "start": float(sound["start"]),
            "end": float(sound["end"]),
            "text": str(sound["text"]).strip(),
            "kind": "sound",
            "style": {"position": "top", "color": "#FFE600"},
        })
    rendered.sort(key=lambda item: (item["start"], item["end"]))
    return rendered


def _canonical_segments(segments: list[dict]) -> list[dict]:
    """Strip display-only annotations from a transcript sidecar."""
    canonical = []
    for segment in segments:
        text = str(segment.get("text", "")).strip()
        if not text or segment.get("kind") == "sound":
            continue
        item = {
            "start": segment["start"],
            "end": segment["end"],
            "text": text,
        }
        canonical.append(item)
    return canonical


@tool
def add_auto_subtitle(
    video_path: str,
    style: str | AutoSubtitleStyle = "",
    output_path: str = "",
) -> str:
    """영상을 자동 전사(Whisper)하고 자막 큐 문서 생성 후 burn-in — one-shot 처리.

    내부 흐름: Whisper 전사·보수적 교정·화면용 반응/효과음 캡션 제안 →
    SRT/JSON 사이드카 저장(프론트 호환) →
    큐 문서(videos/subtitles/<stem>.cues.json, source_video 기록) 생성 →
    render_subtitles 로 ASS 렌더 + burn-in.
    교정된 발화 원문과 `(당황)`, `[쾅]` 같은 화면 연출은 별도로 저장되며,
    연출은 원본 미디어 근거와 높은 신뢰도를 통과한 소수 큐에만 적용된다.
    이후 개별 수정은 update_subtitle_cues / set_subtitle_style + render_subtitles 로 처리.
    플랫폼(shorts/youtube)에 따라 줄 길이와 폰트 크기 자동 조정.

    Args:
        video_path: 입력 영상 파일명 (videos/ 기준, 예: sample.mp4)
        style: JSON 스타일 문자열 {'platform':'youtube'|'shorts', 'font_size':24, ...}
        output_path: 최종 자막 번인 영상 경로. 생략 시 입력 파일 옆
            <stem>_subtitled.mp4.
    """
    try:
        from agent.tools.transcribe import transcribe_video  # 지연 임포트 (순환 방지)

        input_path = _resolve_video_path(video_path)
        if not os.path.exists(input_path):
            return json.dumps({"error": f"영상 파일 없음: {input_path}"}, ensure_ascii=False)

        platform = "youtube"
        if style:
            try:
                parsed_style = style if isinstance(style, dict) else json.loads(style)
                platform = parsed_style.get("platform", "youtube")
            except (json.JSONDecodeError, TypeError):
                pass

        # 1. 자막 원천 확보
        #    편집 결과물(cut/merge)이면 원본 분석 JSON 의 transcript 를 시간축
        #    보정해 재사용한다. 잘린 조각을 재전사하면 문장이 깨지고, 이미 TTS 를
        #    얹은 뒤라면 나레이션 음성까지 자막에 섞이기 때문.
        transcript = _transcript_from_origin(input_path)
        result: dict = {}

        if transcript:
            logger.info(
                f"add_auto_subtitle: 원본 분석 transcript 재사용 — {len(transcript)}개 (재전사 생략)"
            )
        else:
            logger.info(f"add_auto_subtitle: transcribe 시작 — {video_path}")
            raw = transcribe_video.invoke({"video_path": str(input_path)})
            result = json.loads(raw)
            if "error" in result:
                return json.dumps({"error": f"전사 실패: {result['error']}"}, ensure_ascii=False)

            transcript = result.get("segments", [])
            if not transcript:
                return json.dumps({"error": "전사 결과가 비어 있습니다."}, ensure_ascii=False)

        canonical_transcript = _canonical_segments(transcript)
        display_transcript = _display_segments(
            transcript,
            result.get("correction"),
        )
        if not display_transcript:
            return json.dumps({"error": "화면용 자막 결과가 비어 있습니다."}, ensure_ascii=False)
        expressive_caption_count = sum(
            1
            for segment in transcript
            if (
                segment.get("kind") == "sound"
                or str(segment.get("display_text", "")).strip()
                not in {"", str(segment.get("text", "")).strip()}
            )
        )
        correction = result.get("correction")
        if isinstance(correction, dict):
            expressive_caption_count += len(correction.get("display_edits", []))
            expressive_caption_count += len(correction.get("sound_captions", []))

        from agent.tools import subtitle_cues  # 지연 임포트 (순환 방지)

        # 2. SRT 생성 (font_size 기반 80% 줄바꿈)
        s_tmp = _merge_style(style)
        # 쇼츠는 자막 기본을 shorts_bold 프리셋(큰 볼드)으로 — 폰트 크기가 커지므로
        # 줄바꿈 기준 글자 수도 프리셋 size 로 계산해야 한 줄이 화면을 넘지 않는다.
        shorts_preset = None
        if platform == "shorts":
            shorts_preset = subtitle_cues.resolve_style_preset("shorts_bold")
        font_size = (shorts_preset or {}).get("size") or s_tmp.get("font_size", 24)
        max_len = _calc_max_chars(int(font_size))

        os.makedirs(SUBTITLES_DIR, exist_ok=True)
        name = os.path.splitext(os.path.basename(input_path))[0]
        srt_abs = os.path.join(SUBTITLES_DIR, f"{name}.srt")
        srt_content = _build_srt(display_transcript, platform, max_len=max_len)
        with open(srt_abs, "w", encoding="utf-8") as f:
            f.write(srt_content)

        json_abs = os.path.join(SUBTITLES_DIR, f"{name}.json")
        with open(json_abs, "w", encoding="utf-8") as f:
            json.dump({
                "schema_version": 2,
                "segments": canonical_transcript,
                "raw_segments": result.get("raw_segments", canonical_transcript),
                "display_segments": display_transcript,
                "correction": result.get("correction"),
                "language": result.get("language"),
                "engine": result.get("engine") or "origin-reuse",
            }, f, ensure_ascii=False, indent=2)
        logger.info(f"SRT/JSON 저장: {srt_abs} ({len(transcript)}개 세그먼트)")

        # 3. 큐 문서 생성 (진실의 원천) — source_video 기록 필수
        #    쇼츠면 shorts_bold 프리셋을 베이스로 깔고, 사용자가 style JSON 에
        #    명시한 키만 위에 유지 (예: {'platform':'shorts','color':'yellow'} → 노랑 유지).
        if shorts_preset:
            defaults = {**shorts_preset, **subtitle_cues.explicit_style_from_legacy(style)}
        else:
            defaults = subtitle_cues.style_defaults_from_legacy(s_tmp)
        _, cues_doc_path = subtitle_cues.create_cues_doc(
            stem=name,
            source_video=input_path,
            segments=display_transcript,
            style_defaults=defaults,
        )

        # 4. 큐 문서 기준 ASS 렌더 + burn-in (기존 출력 위치/이름 유지 — 프론트 호환)
        _, ext = os.path.splitext(input_path)
        if output_path:
            if os.path.isabs(output_path):
                resolved_output_path = os.path.normpath(output_path)
            elif os.path.dirname(output_path):
                resolved_output_path = os.path.normpath(
                    os.path.join(PROJECT_ROOT, output_path)
                )
            else:
                resolved_output_path = os.path.join(
                    os.path.dirname(input_path),
                    output_path,
                )
        else:
            resolved_output_path = os.path.join(
                os.path.dirname(input_path),
                f"{name}_subtitled{ext or '.mp4'}",
            )
        rendered = subtitle_cues.render_subtitles.invoke({
            "video_path": input_path,
            "output_path": resolved_output_path,
        })
        render_error = _render_error(rendered)
        if render_error:
            return json.dumps({"status": "error", "error": render_error}, ensure_ascii=False)
        if not os.path.exists(rendered):
            return json.dumps({
                "status": "error",
                "error": f"자막 렌더 결과 파일이 생성되지 않았습니다: {rendered}",
            }, ensure_ascii=False)

        # 최종 파일 stem으로도 전사/큐 문서를 남겨 server final 복구가 입력
        # 영상의 오래된 자막을 잘못 고르지 않게 한다.
        rendered_stem = os.path.splitext(os.path.basename(rendered))[0]
        rendered_json = os.path.join(SUBTITLES_DIR, f"{rendered_stem}.json")
        with open(rendered_json, "w", encoding="utf-8") as f:
            json.dump({
                "schema_version": 2,
                "segments": canonical_transcript,
                "raw_segments": result.get("raw_segments", canonical_transcript),
                "display_segments": display_transcript,
                "correction": result.get("correction"),
                "language": result.get("language"),
                "engine": result.get("engine") or "origin-reuse",
                "source_video": input_path,
            }, f, ensure_ascii=False, indent=2)
        _, rendered_cues_doc = subtitle_cues.create_cues_doc(
            stem=rendered_stem,
            source_video=input_path,
            segments=display_transcript,
            style_defaults=defaults,
        )

        return json.dumps({
            "output": rendered,
            "cues_doc": rendered_cues_doc,
            "source_cues_doc": cues_doc_path,
            "style": {
                "font": defaults["font"],
                "size": defaults["size"],
                "color": defaults["color"],
            },
            "segments": len(display_transcript),
            "spoken_segments": len(canonical_transcript),
            "expressive_captions": expressive_caption_count,
            "status": "success",
        }, ensure_ascii=False)

    except Exception as e:
        logger.error(f"add_auto_subtitle 오류: {e}")
        return json.dumps({"error": str(e)}, ensure_ascii=False)


@tool
def add_title(
    video_path: str,
    text: str,
    position: str = "center",
    start_time: float = 0.0,
    duration: float = 3.0,
    anim: str = "fade",
    style: str = "",
) -> str:
    """영상 위에 타이틀 텍스트 오버레이 — fade-in/out 지원.

    인트로·아웃트로 타이틀, 챕터 제목 등에 사용.
    anim='fade' 이면 0.5초 fade-in + 0.5초 fade-out 자동 적용.

    Args:
        video_path: 입력 영상 파일명 (videos/ 기준)
        text: 타이틀 텍스트
        position: 'center'|'top'|'bottom' (기본 'center')
        start_time: 타이틀 시작 시간(초) (기본 0.0)
        duration: 타이틀 표시 시간(초) (기본 3.0)
        anim: 'fade'|'none' (기본 'fade')
        style: JSON 스타일 {'font_size':48, 'color':'white', 'stroke_width':2}
    """
    try:
        input_path = _resolve_video_path(video_path)
        if not os.path.exists(input_path):
            return json.dumps({"error": f"영상 파일 없음: {input_path}"}, ensure_ascii=False)

        s = _merge_style(style, tool_defaults={"font_size": 48, "position": position})

        # drawtext 는 실제 픽셀값 — 영상 높이에 비례해 폰트 크기 조정
        vw, vh = _get_video_size_ffprobe(input_path)
        if vh > 0 and s.get("font_size") == 48:
            s["font_size"] = max(16, round(vh * _FONT_SIZE_PCT * 1.5))  # 타이틀은 1.5배

        font_size = s["font_size"]
        color = s["color"]
        stroke_color = s["stroke_color"]
        stroke_width = s["stroke_width"]

        font_path = _resolve_font(_DEFAULT_FONT_FILE)
        if not font_path:
            logger.warning(f"{_DEFAULT_FONT_FILE} 없음 — 시스템 기본 폰트 사용")

        t_end = start_time + duration
        fade_dur = 0.5
        safe_text = _escape_drawtext(text)

        parts = [f"text='{safe_text}'"]
        if font_path:
            parts.append(f"fontfile='{_ffmpeg_filter_path(font_path)}'")
        parts += [
            f"fontsize={font_size}",
            f"fontcolor={color}",
            f"borderw={stroke_width}",
            f"bordercolor={stroke_color}",
            _drawtext_xy(s.get("position", position)),
            f"enable='between(t,{start_time},{t_end})'",
        ]

        if anim == "fade":
            # 등장: 0 → 1 (fade_dur초), 퇴장: 1 → 0 (fade_dur초)
            parts.append(
                f"alpha='if(lt(t,{start_time + fade_dur}),"
                f"(t-{start_time})/{fade_dur},"
                f"if(gt(t,{t_end - fade_dur}),"
                f"({t_end}-t)/{fade_dur},1))'"
            )

        vf = "drawtext=" + ":".join(parts)

        output_file = Path(input_path).with_name(f"{Path(input_path).stem}_title{Path(input_path).suffix}")
        output_path = str(output_file)

        cmd = ["ffmpeg", "-y", "-i", input_path, "-vf", vf, "-c:a", "copy", output_path]
        code, stderr = _run_ffmpeg(cmd)
        if code != 0:
            return json.dumps({"error": stderr[-800:]}, ensure_ascii=False)

        return json.dumps({
            "output": str(output_file),
            "style": {
                "font": "NotoSansKR" if font_path else "system",
                "size": font_size,
                "color": color,
            },
            "segments": 1,
            "status": "success",
        }, ensure_ascii=False)

    except FileNotFoundError:
        return json.dumps({"error": "FFmpeg가 설치되어 있지 않습니다."}, ensure_ascii=False)
    except Exception as e:
        logger.error(f"add_title 오류: {e}")
        return json.dumps({"error": str(e)}, ensure_ascii=False)


@tool
def add_caption(
    video_path: str,
    text: str,
    at_time: float,
    duration: float = 2.0,
    style: str = "",
) -> str:
    """특정 시점에 강조 캡션을 영상에 삽입.

    주요 발언 강조, 쇼츠 텍스트 강조 등에 사용.
    effect_expert의 transition과 타이밍 충돌 여부는 Supervisor가 확인.

    Args:
        video_path: 입력 영상 파일명 (videos/ 기준)
        text: 캡션 텍스트
        at_time: 캡션 시작 시간(초)
        duration: 캡션 표시 시간(초) (기본 2.0)
        style: JSON 스타일 {'font_size':32, 'color':'yellow', 'position':'center',
               'platform':'youtube'}
    """
    try:
        input_path = _resolve_video_path(video_path)
        if not os.path.exists(input_path):
            return json.dumps({"status": "error", "error": f"영상 파일 없음: {input_path}"}, ensure_ascii=False)

        s = _merge_style(style, tool_defaults={"font_size": 32, "color": "yellow", "position": "center"})

        # drawtext 는 실제 픽셀값 — 영상 높이에 비례해 폰트 크기 조정
        vw, vh = _get_video_size_ffprobe(input_path)
        if vh > 0 and s.get("font_size") == 32:
            s["font_size"] = max(12, round(vh * _FONT_SIZE_PCT))

        font_size = s["font_size"]
        color = s["color"]
        stroke_color = s["stroke_color"]
        stroke_width = s["stroke_width"]
        position = s.get("position", "center")

        font_path = _resolve_font(_DEFAULT_FONT_FILE)
        if not font_path:
            logger.warning(f"{_DEFAULT_FONT_FILE} 없음 — 시스템 기본 폰트 사용")

        t_end = at_time + duration
        safe_text = _escape_drawtext(text)

        parts = [f"text='{safe_text}'"]
        if font_path:
            parts.append(f"fontfile='{_ffmpeg_filter_path(font_path)}'")
        parts += [
            f"fontsize={font_size}",
            f"fontcolor={color}",
            f"borderw={stroke_width}",
            f"bordercolor={stroke_color}",
            _drawtext_xy(position),
            f"enable='between(t,{at_time},{t_end})'",
        ]

        vf = "drawtext=" + ":".join(parts)

        output_file = Path(input_path).with_name(
            f"{Path(input_path).stem}_caption_{int(at_time)}{Path(input_path).suffix}"
        )
        output_path = str(output_file)

        cmd = ["ffmpeg", "-y", "-i", input_path, "-vf", vf, "-c:a", "copy", output_path]
        code, stderr = _run_ffmpeg(cmd)
        if code != 0:
            return json.dumps({"error": stderr[-800:]}, ensure_ascii=False)

        return json.dumps({
            "output": str(output_file),
            "style": {
                "font": "NotoSansKR" if font_path else "system",
                "size": font_size,
                "color": color,
            },
            "segments": 1,
            "status": "success",
        }, ensure_ascii=False)

    except FileNotFoundError:
        return json.dumps({"error": "FFmpeg가 설치되어 있지 않습니다."}, ensure_ascii=False)
    except Exception as e:
        logger.error(f"add_caption 오류: {e}")
        return json.dumps({"error": str(e)}, ensure_ascii=False)


@tool
def add_captions_batch(
    video_path: str,
    captions: list[dict],
    output_path: str = "",
) -> str:
    """여러 강조 캡션을 FFmpeg 한 번으로 영상에 삽입한다.

    발화 전체 자막은 add_auto_subtitle을 사용하고, 이 도구는 제목·챕터·핵심
    강조 문구처럼 선별된 화면 텍스트에만 사용한다.

    Args:
        video_path: 입력 영상 경로.
        captions: 캡션 목록. 각 항목은 text와 at_time 또는 start_ms를 포함하고,
            duration 또는 end_ms 및 선택적 style dict를 받을 수 있다.
        output_path: 선택 출력 경로. 생략하면 입력 파일 옆에 고유 이름으로 저장.
    """
    try:
        input_file = _resolve_video_file(video_path)
        input_path = str(input_file.resolve())
        if not os.path.exists(input_path):
            return json.dumps(
                {"status": "error", "error": f"영상 파일 없음: {input_path}"},
                ensure_ascii=False,
            )
        if not captions:
            return json.dumps(
                {"status": "error", "error": "captions 목록이 비어 있습니다."},
                ensure_ascii=False,
            )

        filters: list[str] = []
        normalized: list[dict] = []
        for index, item in enumerate(captions):
            text = str(item.get("text") or "").strip()
            if not text:
                return json.dumps(
                    {"status": "error", "error": f"captions[{index}].text가 비어 있습니다."},
                    ensure_ascii=False,
                )

            if item.get("start_ms") is not None:
                start = float(item["start_ms"]) / 1000.0
            else:
                start = float(item.get("at_time", 0.0))
            if item.get("end_ms") is not None:
                end = float(item["end_ms"]) / 1000.0
            else:
                end = start + float(item.get("duration", 2.0))
            if start < 0 or end <= start:
                return json.dumps(
                    {"status": "error", "error": f"captions[{index}] 시간 범위가 잘못되었습니다."},
                    ensure_ascii=False,
                )

            style_value = item.get("style") or {}
            style_json = (
                json.dumps(style_value, ensure_ascii=False)
                if isinstance(style_value, dict)
                else str(style_value)
            )
            s = _merge_style(
                style_json,
                tool_defaults={"font_size": 32, "color": "yellow", "position": "center"},
            )
            requested_font = str(s.get("font") or "").strip()
            font_path = (
                _resolve_font(requested_font)
                or _resolve_font(f"{requested_font}.ttf")
                or _resolve_font(_DEFAULT_FONT_FILE)
            )
            parts = [f"text='{_escape_drawtext(text)}'"]
            if font_path:
                parts.append(f"fontfile='{_ffmpeg_filter_path(font_path)}'")
            parts += [
                f"fontsize={int(s['font_size'])}",
                f"fontcolor={s['color']}",
                f"borderw={float(s['stroke_width']):g}",
                f"bordercolor={s['stroke_color']}",
                _drawtext_xy(s.get("position", "center")),
                f"enable='between(t,{start:.3f},{end:.3f})'",
            ]
            filters.append("drawtext=" + ":".join(parts))
            normalized.append({"text": text, "start": start, "end": end})

        if output_path:
            output_file = Path(output_path)
            if not output_file.is_absolute():
                output_file = Path(VIDEOS_DIR).parent / output_file
        else:
            output_file = input_file.with_name(
                f"{input_file.stem}_captions_{uuid.uuid4().hex[:8]}{input_file.suffix}"
            )
        output_file = output_file.resolve()
        output_file.parent.mkdir(parents=True, exist_ok=True)

        cmd = [
            "ffmpeg", "-y", "-i", input_path,
            "-vf", ",".join(filters),
            "-c:a", "copy", str(output_file),
        ]
        code, stderr = _run_ffmpeg(cmd)
        if code != 0:
            return json.dumps(
                {"status": "error", "error": stderr[-1200:]}, ensure_ascii=False
            )

        return json.dumps(
            {
                "status": "success",
                "output": str(output_file),
                "segments": len(normalized),
                "captions": normalized,
                "render_passes": 1,
            },
            ensure_ascii=False,
        )
    except FileNotFoundError:
        return json.dumps(
            {"status": "error", "error": "FFmpeg가 설치되어 있지 않습니다."},
            ensure_ascii=False,
        )
    except Exception as e:
        logger.error(f"add_captions_batch 오류: {e}")
        return json.dumps({"status": "error", "error": str(e)}, ensure_ascii=False)


@tool
def add_emoji_overlay(
    video_path: str,
    emoji: str,
    at_time: float,
    duration: float = 2.0,
    position: str = "center",
) -> str:
    """쇼츠/릴스용 이모지를 영상 특정 시점에 오버레이.

    assets/fonts/NotoColorEmoji.ttf 있으면 컬러 이모지, 없으면 시스템 폰트 fallback 후 보고.
    쇼츠 전용 — 유튜브 롱폼에서는 사용 자제 (SOUL.md 원칙).

    Args:
        video_path: 입력 영상 파일명 (videos/ 기준)
        emoji: 이모지 문자 (예: '🔥', '😂', '👍')
        at_time: 이모지 시작 시간(초)
        duration: 이모지 표시 시간(초) (기본 2.0)
        position: 'center'|'top'|'bottom'|'top-left'|'top-right'|'bottom-left'|'bottom-right'
    """
    try:
        input_path = _resolve_video_path(video_path)
        if not os.path.exists(input_path):
            return json.dumps({"error": f"영상 파일 없음: {input_path}"}, ensure_ascii=False)

        emoji_font = _resolve_font(_EMOJI_FONT_FILE)
        font_used = "NotoColorEmoji" if emoji_font else "system"
        if not emoji_font:
            logger.warning(f"{_EMOJI_FONT_FILE} 없음 — 시스템 기본 폰트로 fallback (컬러 이모지 미지원 가능)")

        t_end = at_time + duration
        safe_emoji = _escape_drawtext(emoji)

        parts = [f"text='{safe_emoji}'"]
        if emoji_font:
            parts.append(f"fontfile='{_ffmpeg_filter_path(emoji_font)}'")
        parts += [
            "fontsize=72",
            "fontcolor=white",
            _drawtext_xy(position),
            f"enable='between(t,{at_time},{t_end})'",
        ]

        vf = "drawtext=" + ":".join(parts)

        output_file = Path(input_path).with_name(
            f"{Path(input_path).stem}_emoji_{int(at_time)}{Path(input_path).suffix}"
        )
        output_path = str(output_file)

        cmd = ["ffmpeg", "-y", "-i", input_path, "-vf", vf, "-c:a", "copy", output_path]
        code, stderr = _run_ffmpeg(cmd)
        if code != 0:
            return json.dumps({"error": stderr[-800:]}, ensure_ascii=False)

        return json.dumps({
            "output": str(output_file),
            "style": {"font": font_used, "size": 72, "color": "color"},
            "segments": 1,
            "font_fallback": font_used == "system",
            "status": "success",
        }, ensure_ascii=False)

    except FileNotFoundError:
        return json.dumps({"error": "FFmpeg가 설치되어 있지 않습니다."}, ensure_ascii=False)
    except Exception as e:
        logger.error(f"add_emoji_overlay 오류: {e}")
        return json.dumps({"error": str(e)}, ensure_ascii=False)


TOOLS = [
    add_subtitle,
    add_auto_subtitle,
    add_title,
    add_caption,
    add_captions_batch,
    add_emoji_overlay,
]


if __name__ == "__main__":
    print("subtitle tools:", [t.name for t in TOOLS])
