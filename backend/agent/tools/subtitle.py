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
from dotenv import load_dotenv
from langchain_core.tools import tool

logger = logging.getLogger(__name__)

_HERE = os.path.dirname(__file__)
VIDEOS_DIR = os.path.abspath(os.path.join(_HERE, "..", "..", "videos"))
SUBTITLES_DIR = os.path.join(VIDEOS_DIR, "subtitles")
FONTS_DIR = os.path.abspath(os.path.join(_HERE, "..", "..", "assets", "fonts"))

# 경로를 명시해야 한다 — 인자 없는 load_dotenv() 는 CWD 부터 위로 훑어서
# backend/ 밖(리포 루트, pytest 등)에서 띄우면 조용히 무시되고 SUBTITLE_FONT 가
# 기본값으로 돌아간다.
load_dotenv(os.path.abspath(os.path.join(_HERE, "..", "..", ".env")))

_DEFAULT_FONT_FILE = os.getenv("SUBTITLE_FONT", "NotoSansKR-Regular.ttf")
_EMOJI_FONT_FILE = "NotoColorEmoji.ttf"


def _font_family_from_file(font_file: str) -> str:
    """폰트 파일명 -> libass FontName. NanumGothic-Regular.ttf -> NanumGothic.

    force_style 의 FontName 은 *패밀리명* 이라 파일명을 그대로 넣으면 매칭 실패.
    """
    stem = os.path.splitext(os.path.basename(font_file))[0]
    for suffix in ("-Regular", "-Bold", "-Medium", "-Light", "-SemiBold", "-ExtraBold"):
        if stem.endswith(suffix):
            return stem[: -len(suffix)]
    return stem


# ─── 내부 헬퍼 ────────────────────────────────────────────────────────────────

def _resolve_font(filename: str) -> str | None:
    """fonts/ 디렉터리에 해당 폰트가 있으면 절대 경로, 없으면 None."""
    path = os.path.join(FONTS_DIR, filename)
    return path if os.path.exists(path) else None


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


def _merge_style(style_json: str, tool_defaults: dict | None = None) -> dict:
    """style JSON 문자열을 파싱해 플랫폼 기본값에 병합. tool_defaults가 있으면 중간에 덮어씀."""
    overrides: dict = {}
    if style_json:
        try:
            overrides = json.loads(style_json)
        except json.JSONDecodeError:
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
        cmd, capture_output=True, text=True, encoding="utf-8", errors="ignore"
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
        input_path = os.path.join(VIDEOS_DIR, video_path)
        if not os.path.exists(input_path):
            return json.dumps({"error": f"영상 파일 없음: {input_path}"}, ensure_ascii=False)

        srt_abs = srt_path if os.path.isabs(srt_path) else os.path.join(SUBTITLES_DIR, srt_path)
        if not os.path.exists(srt_abs):
            return json.dumps({"error": f"SRT 파일 없음: {srt_abs}"}, ensure_ascii=False)

        s = _merge_style(style)
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

        name, ext = os.path.splitext(video_path)
        output_name = f"{name}_subtitled{ext}"
        output_path = os.path.join(VIDEOS_DIR, output_name)

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
            "output": output_name,
            "style": {"font": font_name, "size": s["font_size"], "color": s["color"]},
            "segments": segments,
            "status": "success",
        }, ensure_ascii=False)

    except FileNotFoundError:
        return json.dumps({"error": "FFmpeg가 설치되어 있지 않습니다."}, ensure_ascii=False)
    except Exception as e:
        logger.error(f"add_subtitle 오류: {e}")
        return json.dumps({"error": str(e)}, ensure_ascii=False)


@tool
def add_auto_subtitle(video_path: str, style: str = "") -> str:
    """영상을 자동 전사(Whisper)하고 자막 큐 문서 생성 후 burn-in — one-shot 처리.

    내부 흐름: Whisper 전사 → SRT/JSON 사이드카 저장(프론트 호환) →
    큐 문서(videos/subtitles/<stem>.cues.json, source_video 기록) 생성 →
    render_subtitles 로 ASS 렌더 + burn-in.
    이후 개별 수정은 update_subtitle_cues / set_subtitle_style + render_subtitles 로 처리.
    플랫폼(shorts/youtube)에 따라 줄 길이와 폰트 크기 자동 조정.

    Args:
        video_path: 입력 영상 파일명 (videos/ 기준, 예: sample.mp4)
        style: JSON 스타일 문자열 {'platform':'youtube'|'shorts', 'font_size':24, ...}
    """
    try:
        from agent.tools.transcribe import transcribe_video  # 지연 임포트 (순환 방지)

        input_path = os.path.join(VIDEOS_DIR, video_path)
        if not os.path.exists(input_path):
            return json.dumps({"error": f"영상 파일 없음: {input_path}"}, ensure_ascii=False)

        platform = "youtube"
        if style:
            try:
                platform = json.loads(style).get("platform", "youtube")
            except json.JSONDecodeError:
                pass

        # 1. Whisper 전사
        logger.info(f"add_auto_subtitle: transcribe 시작 — {video_path}")
        raw = transcribe_video.invoke({"video_path": str(input_path)})
        result = json.loads(raw)
        if "error" in result:
            return json.dumps({"error": f"전사 실패: {result['error']}"}, ensure_ascii=False)

        transcript = result.get("segments", [])
        if not transcript:
            return json.dumps({"error": "전사 결과가 비어 있습니다."}, ensure_ascii=False)

        # 2. SRT 생성 (font_size 기반 80% 줄바꿈)
        s_tmp = _merge_style(style)
        font_size = s_tmp.get("font_size", 24)
        max_len = _calc_max_chars(font_size)

        os.makedirs(SUBTITLES_DIR, exist_ok=True)
        name, _ = os.path.splitext(video_path)
        srt_abs = os.path.join(SUBTITLES_DIR, f"{name}.srt")
        srt_content = _build_srt(transcript, platform, max_len=max_len)
        with open(srt_abs, "w", encoding="utf-8") as f:
            f.write(srt_content)

        json_abs = os.path.join(SUBTITLES_DIR, f"{name}.json")
        with open(json_abs, "w", encoding="utf-8") as f:
            json.dump({"segments": transcript, "language": result.get("language"), "engine": result.get("engine")}, f, ensure_ascii=False, indent=2)
        logger.info(f"SRT/JSON 저장: {srt_abs} ({len(transcript)}개 세그먼트)")

        # 3. 큐 문서 생성 (진실의 원천) — source_video 기록 필수
        from agent.tools import subtitle_cues  # 지연 임포트 (순환 방지)

        defaults = subtitle_cues.style_defaults_from_legacy(s_tmp)
        _, cues_doc_path = subtitle_cues.create_cues_doc(
            stem=name,
            source_video=input_path,
            segments=transcript,
            style_defaults=defaults,
        )

        # 4. 큐 문서 기준 ASS 렌더 + burn-in (기존 출력 위치/이름 유지 — 프론트 호환)
        _, ext = os.path.splitext(video_path)
        output_name = f"{name}_subtitled{ext}"
        rendered = subtitle_cues.render_subtitles.invoke({
            "video_path": video_path,
            "output_path": os.path.join(VIDEOS_DIR, output_name),
        })
        if isinstance(rendered, str) and rendered.startswith("ERROR"):
            return json.dumps({"error": rendered}, ensure_ascii=False)

        return json.dumps({
            "output": output_name,
            "cues_doc": cues_doc_path,
            "style": {
                "font": defaults["font"],
                "size": defaults["size"],
                "color": defaults["color"],
            },
            "segments": len(transcript),
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
        input_path = os.path.join(VIDEOS_DIR, video_path)
        if not os.path.exists(input_path):
            return json.dumps({"error": f"영상 파일 없음: {input_path}"}, ensure_ascii=False)

        s = _merge_style(style, tool_defaults={"font_size": 48, "position": position})
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

        name, ext = os.path.splitext(video_path)
        output_name = f"{name}_title{ext}"
        output_path = os.path.join(VIDEOS_DIR, output_name)

        cmd = ["ffmpeg", "-y", "-i", input_path, "-vf", vf, "-c:a", "copy", output_path]
        code, stderr = _run_ffmpeg(cmd)
        if code != 0:
            return json.dumps({"error": stderr[-800:]}, ensure_ascii=False)

        return json.dumps({
            "output": output_name,
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
        input_path = os.path.join(VIDEOS_DIR, video_path)
        if not os.path.exists(input_path):
            return json.dumps({"error": f"영상 파일 없음: {input_path}"}, ensure_ascii=False)

        s = _merge_style(style, tool_defaults={"font_size": 32, "color": "yellow", "position": "center"})
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

        name, ext = os.path.splitext(video_path)
        output_name = f"{name}_caption_{int(at_time)}{ext}"
        output_path = os.path.join(VIDEOS_DIR, output_name)

        cmd = ["ffmpeg", "-y", "-i", input_path, "-vf", vf, "-c:a", "copy", output_path]
        code, stderr = _run_ffmpeg(cmd)
        if code != 0:
            return json.dumps({"error": stderr[-800:]}, ensure_ascii=False)

        return json.dumps({
            "output": output_name,
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
        input_path = os.path.join(VIDEOS_DIR, video_path)
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

        name, ext = os.path.splitext(video_path)
        output_name = f"{name}_emoji_{int(at_time)}{ext}"
        output_path = os.path.join(VIDEOS_DIR, output_name)

        cmd = ["ffmpeg", "-y", "-i", input_path, "-vf", vf, "-c:a", "copy", output_path]
        code, stderr = _run_ffmpeg(cmd)
        if code != 0:
            return json.dumps({"error": stderr[-800:]}, ensure_ascii=False)

        return json.dumps({
            "output": output_name,
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


TOOLS = [add_subtitle, add_auto_subtitle, add_title, add_caption, add_emoji_overlay]


if __name__ == "__main__":
    print("subtitle tools:", [t.name for t in TOOLS])
