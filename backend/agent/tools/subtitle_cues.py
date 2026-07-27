"""
자막 큐 레이어 Tool — 큐 문서(videos/subtitles/<stem>.cues.json)가 진실의 원천.

기존 one-shot 번인(add_auto_subtitle)의 한계 해소:
- 큐 단위 ID(c001, c002 ...)로 개별 자막 수정 / 삭제 / 스타일 오버라이드
- style_defaults + per-cue style 오버라이드 → ASS 파일 생성 → source_video 에 1회 번인
- source_video 를 문서에 기록해 재렌더 기점 유지 (이중 번인 방지)

큐 문서 스키마 (version 1):
{
  "version": 1,
  "video_stem": "<stem>",
  "source_video": "<번인 전 소스 mp4 절대 경로>",
  "id_seq": <지금까지 발급된 최대 id 순번 — 재사용 방지>,
  "style_defaults": {"font", "size", "color", "stroke_color", "stroke_width",
                     "position", "margin_v", "bold"},
  "cues": [{"id": "c001", "start": 1.2, "end": 3.4, "text": "...",
            "style": {있는 키만 오버라이드, "fade": true 지원}}]
}
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import uuid

from langchain_core.tools import tool

from agent.tools.subtitle import (
    FONTS_DIR,
    SUBTITLES_DIR,
    VIDEOS_DIR,
    _color_to_ass,
    _ffmpeg_filter_path,
    _hex_to_rgb,
)

logger = logging.getLogger(__name__)

_PROJECT_ROOT = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)
OUTPUTS_DIR = os.path.join(_PROJECT_ROOT, "outputs")

# 반응형 자막 비율 상수 — PlayResY=288 기준 ASS 캔버스에서 비율로 표현.
# libass 가 actual_height/PlayResY 배율로 스케일링하므로
# canvas_val = PlayResY * PCT 로 설정하면 실제 영상에서 항상 화면 높이의 PCT% 로 렌더됨.
_FONT_SIZE_PCT = 0.05          # 화면 높이 대비 폰트 비율 (5%)
_MARGIN_LANDSCAPE_PCT = 0.08   # 가로형: 하단 마진 비율 (8%)
_MARGIN_PORTRAIT_PCT = 0.15    # 세로형: 하단 마진 비율 (15%, shorts UI 위)


def _get_video_size(video_path: str) -> tuple[int, int]:
    """ffprobe 로 영상 너비×높이 반환. 실패 시 (0, 0)."""
    cmd = [
        "ffprobe", "-v", "quiet",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height",
        "-of", "csv=p=0",
        video_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    try:
        w, h = result.stdout.strip().split(",")
        return int(w), int(h)
    except (ValueError, IndexError):
        return 0, 0


def _detect_content_area(video_path: str) -> tuple[int, int, int, int]:
    """pad 사이드카(.pad.json) 우선 읽기 → 없으면 (0, 0, 0, 0) 반환.

    resize_video pad 모드가 수학적으로 정확한 콘텐츠 영역을 사이드카에 저장.
    h264 압축 아티팩트로 cropdetect 가 검은 여백을 잘못 감지하는 문제를 피하기 위해
    cropdetect 방식을 제거하고 사이드카 방식으로 대체.

    Returns: (x_offset, y_offset, content_w, content_h)
    """
    sidecar = video_path + ".pad.json"
    if os.path.exists(sidecar):
        try:
            with open(sidecar, encoding="utf-8") as f:
                d = json.load(f)
            return int(d["x"]), int(d["y"]), int(d["w"]), int(d["h"])
        except (KeyError, ValueError, json.JSONDecodeError):
            pass
    return 0, 0, 0, 0


def _apply_responsive_style(
    defaults: dict,
    video_w: int,
    video_h: int,
    content_area: tuple[int, int, int, int] | None = None,
) -> dict:
    """실제 영상 크기 + 콘텐츠 영역 기반으로 font_size, margin_v 를 자동 조정.

    pad 모드 영상(검은 여백 포함)의 경우 content_area 로 실제 콘텐츠 경계를 받아
    자막이 콘텐츠 영역 안에 위치하도록 margin_v 재계산.
    기본값인 경우에만 덮어씀 — 사용자가 명시 설정한 값은 유지.
    """
    if video_h <= 0:
        return defaults

    result = dict(defaults)
    is_portrait = video_h > video_w

    if result.get("size") == DEFAULT_STYLE["size"]:
        result["size"] = max(8, round(PLAY_RES_Y * _FONT_SIZE_PCT))

    if result.get("margin_v") == DEFAULT_STYLE["margin_v"]:
        cx, cy, cw, ch = content_area if content_area else (0, 0, 0, 0)
        pad_bottom = video_h - (cy + ch) if ch > 0 else 0

        if pad_bottom > video_h * 0.05:
            # 검은 여백 5% 이상 → 콘텐츠 하단 기준으로 5% 안쪽에 자막 배치
            margin_v_px = pad_bottom + ch * 0.05
            result["margin_v"] = max(4, round(margin_v_px * PLAY_RES_Y / video_h))
        else:
            pct = _MARGIN_PORTRAIT_PCT if is_portrait else _MARGIN_LANDSCAPE_PCT
            result["margin_v"] = max(4, round(PLAY_RES_Y * pct))

    return result


def _fit_portrait_font_size(
    requested_size: float,
    texts: list[str],
    play_res_x: int,
) -> float:
    """세로 영상에서 긴 문장이 세 줄 안팎으로 들어오도록 폰트 상한을 계산."""
    if not texts:
        return requested_size

    def _text_units(text: str) -> float:
        # 한글/전각 문자는 거의 1em, ASCII와 공백은 더 좁게 잡는다.
        return sum(1.0 if ord(char) > 127 else 0.55 for char in text)

    longest = max(_text_units(text.replace("\n", " ")) for text in texts)
    if longest <= 0:
        return requested_size

    usable_width = play_res_x - 20
    max_lines = 3
    width_limit = usable_width * max_lines / (longest * 0.9)
    height_limit = PLAY_RES_Y * 0.24 / max_lines
    responsive_cap = PLAY_RES_Y * 0.06
    return max(10.0, min(
        float(requested_size),
        responsive_cap,
        width_limit,
        height_limit,
    ))


# subtitle.py 의 SUBTITLE_FONT (파일명 기반) 와 같은 기본값을 쓴다 — 두 렌더
# 경로(add_subtitle 번인 / 큐 문서 렌더)가 서로 다른 폰트를 쓰면 사용자가
# 같은 영상에서 다른 자막 폰트를 보게 된다.
def _default_font_family() -> str:
    from agent.tools.subtitle import _DEFAULT_FONT_FILE, _font_family_from_file

    return _font_family_from_file(_DEFAULT_FONT_FILE)


DEFAULT_STYLE = {
    "font": _default_font_family(),
    "size": 24,
    "color": "#FFFFFF",
    "stroke_color": "#000000",
    "stroke_width": 1.5,
    "position": "bottom",
    "margin_v": 40,
    "bold": False,
}

# ASS 가상 캔버스 — libass 는 size/margin_v/stroke_width 를 이 좌표계로 해석하고
# frame_height/PlayResY 배로 확대해 렌더한다. 384x288 은 FFmpeg 이 SRT → ASS 변환에
# 쓰는 기본값(ASS_DEFAULT_PLAYRESX/Y)이며, subtitle.py 의 force_style 번인 경로가
# 그 위에서 동작한다. DEFAULT_STYLE 의 size 24 / margin_v 40 / stroke_width 1.5 와
# style_defaults_from_legacy() 의 font_size → size 무보정 매핑이 모두 이 288 기준으로
# 캘리브레이션돼 있으므로, 실제 해상도(1920x1080 등)를 넣으면 자막이 1/3.75 크기로
# 작아진다. 두 경로의 번인 크기를 일치시키기 위해 고정값 사용.
PLAY_RES_X = 384
PLAY_RES_Y = 288

# position → ASS \an 정렬 코드 (numpad 배치, 9방향)
_AN_MAP = {
    "bottom-left": 1,
    "bottom": 2,
    "bottom-right": 3,
    "center-left": 4,
    "middle-left": 4,
    "center": 5,
    "middle": 5,
    "center-right": 6,
    "middle-right": 6,
    "top-left": 7,
    "top": 8,
    "top-right": 9,
}

_ALLOWED_STYLE_KEYS = {
    "font", "size", "color", "stroke_color", "stroke_width",
    "position", "margin_v", "bold", "fade",
}

_FONT_EXTS = {".ttf", ".otf", ".ttc"}
_FONT_WEIGHT_SUFFIX = re.compile(
    r"[-_](?:regular|bold|light|medium|thin|black|italic|semibold|demibold"
    r"|extrabold|extralight|heavy|book)$",
    re.IGNORECASE,
)


# ─── 경로 / 문서 헬퍼 ─────────────────────────────────────────────────────────

def _resolve_video_path(video_path: str) -> str:
    """edit.py 컨벤션: 절대 경로 → 그대로, 아니면 프로젝트 루트 → videos/ 순."""
    if os.path.isabs(video_path):
        return os.path.normpath(video_path)
    direct = os.path.join(_PROJECT_ROOT, video_path)
    if os.path.exists(direct):
        return os.path.normpath(direct)
    return os.path.normpath(os.path.join(VIDEOS_DIR, video_path))


def _video_stem(video_path: str) -> str:
    return os.path.splitext(os.path.basename(video_path))[0]


def _cues_doc_path(stem: str) -> str:
    return os.path.join(SUBTITLES_DIR, f"{stem}.cues.json")


def _save_cues_doc(doc: dict) -> str:
    os.makedirs(SUBTITLES_DIR, exist_ok=True)
    path = _cues_doc_path(doc["video_stem"])
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
    return path


def _next_cue_id(doc: dict) -> str:
    """새 큐 id 발급. id_seq 로 과거 발급분까지 추적 — 삭제돼도 재사용 금지."""
    highest = int(doc.get("id_seq", 0))
    for cue in doc.get("cues", []):
        m = re.fullmatch(r"c(\d+)", str(cue.get("id", "")))
        if m:
            highest = max(highest, int(m.group(1)))
    doc["id_seq"] = highest + 1
    return f"c{highest + 1:03d}"


def create_cues_doc(
    stem: str,
    source_video: str,
    segments: list,
    style_defaults: dict | None = None,
) -> tuple[dict, str]:
    """세그먼트 리스트에서 큐 문서를 새로 생성하고 저장. (doc, path) 반환.

    id 는 c001 부터 순번 부여. 기존 문서가 있으면 덮어씀 (새 전사 = 새 진실).
    """
    cues = []
    for i, seg in enumerate(segments, 1):
        cue = {
            "id": f"c{i:03d}",
            "start": round(float(seg["start"]), 3),
            "end": round(float(seg["end"]), 3),
            "text": str(seg.get("text", "")).strip(),
        }
        if isinstance(seg.get("style"), dict) and seg["style"]:
            cue["style"] = seg["style"]
        cues.append(cue)
    cues.sort(key=lambda c: (float(c["start"]), float(c["end"])))

    doc = {
        "version": 1,
        "video_stem": stem,
        "source_video": str(source_video),
        "id_seq": len(cues),
        "style_defaults": {**DEFAULT_STYLE, **(style_defaults or {})},
        "cues": cues,
    }
    path = _save_cues_doc(doc)
    logger.info(f"큐 문서 생성: {path} ({len(cues)}개 큐)")
    return doc, path


def _load_or_promote(video_path: str) -> tuple[dict | None, str]:
    """큐 문서 로드. 없으면 전사 사이드카(<stem>.json)에서 자동 승격 생성."""
    stem = _video_stem(video_path)
    doc_path = _cues_doc_path(stem)
    if os.path.exists(doc_path):
        with open(doc_path, encoding="utf-8") as f:
            return json.load(f), doc_path

    sidecar = os.path.join(SUBTITLES_DIR, f"{stem}.json")
    if os.path.exists(sidecar):
        with open(sidecar, encoding="utf-8") as f:
            segments = json.load(f).get("segments", [])
        if segments:
            # 사이드카는 source_video 를 기록하지 않으므로 현재 video_path 로 승격
            doc, path = create_cues_doc(
                stem=stem,
                source_video=_resolve_video_path(video_path),
                segments=segments,
            )
            logger.info(f"사이드카 승격: {sidecar} → {path}")
            return doc, path

    return None, doc_path


def _no_cues_error() -> str:
    return json.dumps({
        "status": "error",
        "error": "no_cues",
        "message": "큐 문서/전사 결과가 없습니다. transcribe 또는 add_auto_subtitle 를 먼저 실행하세요.",
    }, ensure_ascii=False)


def style_defaults_from_legacy(style: dict) -> dict:
    """subtitle.py 의 legacy 스타일 dict → 큐 문서 style_defaults 변환."""
    def to_hex(value, fallback: str) -> str:
        try:
            r, g, b = _hex_to_rgb(str(value))
            return f"#{r:02X}{g:02X}{b:02X}"
        except ValueError:
            return fallback

    requested_font = str(style.get("font", _default_font_family()))
    resolved_font = _resolve_font_family(requested_font) or requested_font
    return {
        "font": resolved_font,
        "size": style.get("font_size", 24),
        "color": to_hex(style.get("color", "white"), "#FFFFFF"),
        "stroke_color": to_hex(style.get("stroke_color", "black"), "#000000"),
        "stroke_width": style.get("stroke_width", 1.5),
        "position": style.get("position", "bottom"),
        "margin_v": style.get("margin_v", 40),
        "bold": bool(style.get("bold", False)),
    }


def _parse_srt_time(ts: str) -> float:
    h, m, rest = ts.strip().split(":")
    s, ms = rest.split(",")
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0


def _parse_srt(content: str) -> list[dict]:
    segments = []
    for block in content.split("\n\n"):
        lines = [ln for ln in block.strip().splitlines() if ln.strip()]
        if not lines:
            continue
        timing_idx = next((i for i, ln in enumerate(lines) if " --> " in ln), None)
        if timing_idx is None:
            continue
        start_ts, end_ts = lines[timing_idx].split(" --> ")
        text = "\n".join(lines[timing_idx + 1:]).strip()
        if not text:
            continue
        segments.append({
            "start": _parse_srt_time(start_ts),
            "end": _parse_srt_time(end_ts),
            "text": text,
        })
    return segments


def sync_cues_from_srt(video_path: str, srt_path: str, style: dict | None = None) -> str | None:
    """SRT 파일 기반으로 큐 문서 생성. 기존 문서가 있으면 보존(스킵).

    add_subtitle(SRT 직접 burn-in) 호환용 — 반환: 생성된 문서 경로 또는 None.
    """
    stem = _video_stem(video_path)
    doc_path = _cues_doc_path(stem)
    if os.path.exists(doc_path):
        return None
    with open(srt_path, encoding="utf-8") as f:
        segments = _parse_srt(f.read())
    if not segments:
        return None
    _, path = create_cues_doc(
        stem=stem,
        source_video=_resolve_video_path(video_path),
        segments=segments,
        style_defaults=style_defaults_from_legacy(style or {}),
    )
    return path


# ─── 스타일 검증 ──────────────────────────────────────────────────────────────

def _parse_style_arg(style) -> dict:
    """style 인자(JSON 문자열 또는 dict) → dict. 오류 시 ValueError."""
    if not style:
        return {}
    if isinstance(style, dict):
        return style
    parsed = json.loads(style)
    if not isinstance(parsed, dict):
        raise ValueError("style 은 JSON object 여야 합니다.")
    return parsed


def _validate_style(style: dict) -> str | None:
    """스타일 dict 검증 — 문제 있으면 에러 메시지, 없으면 None. (폰트는 별도 검증)"""
    if not isinstance(style, dict):
        return "style 은 JSON object 여야 합니다."
    unknown = set(style) - _ALLOWED_STYLE_KEYS
    if unknown:
        return f"알 수 없는 style 키: {sorted(unknown)} (허용: {sorted(_ALLOWED_STYLE_KEYS)})"
    pos = style.get("position")
    if pos is not None and pos not in _AN_MAP:
        return f"position 값이 잘못됨: {pos} (허용: {sorted(set(_AN_MAP))})"
    for key in ("color", "stroke_color"):
        if style.get(key) is not None:
            try:
                _hex_to_rgb(str(style[key]))
            except ValueError:
                return f"{key} 색상 형식 오류: {style[key]} (hex 또는 색 이름)"
    return None


# ─── 폰트 스캔 ────────────────────────────────────────────────────────────────

def _normalize_font_key(name: str) -> str:
    name = os.path.splitext(name)[0]
    return re.sub(r"[\s_\-]+", "", name).lower()


def _scan_fonts() -> dict[str, str]:
    """assets/fonts 스캔 → {정규화 키: 패밀리명}. 파일명 기반 매핑.

    'NotoSansKR-Regular.ttf' → 패밀리 'NotoSansKR' (weight 접미사 제거).
    대소문자 무시, 하이픈/언더스코어/공백 허용.
    """
    families: dict[str, str] = {}
    if not os.path.isdir(FONTS_DIR):
        return families
    for fname in sorted(os.listdir(FONTS_DIR)):
        base, ext = os.path.splitext(fname)
        if ext.lower() not in _FONT_EXTS:
            continue
        family = _FONT_WEIGHT_SUFFIX.sub("", base)
        families.setdefault(_normalize_font_key(family), family)
        families.setdefault(_normalize_font_key(base), family)
    return families


def _resolve_font_family(requested: str) -> str | None:
    families = _scan_fonts()
    key = _normalize_font_key(requested)
    aliases = {
        "notosanscjkkr": "notosanskr",
        "notosanscjk": "notosanskr",
        "notosanskorean": "notosanskr",
    }
    key = aliases.get(key, key)
    if key in families:
        return families[key]
    for k, family in families.items():
        if k.startswith(key) or key.startswith(k):
            return family
    return None


def _available_families() -> list[str]:
    return sorted(set(_scan_fonts().values()))


def _font_error(requested: str) -> str:
    return (
        f"ERROR: 폰트 없음 — assets/fonts 에 {requested}.ttf 를 추가하면 사용 가능. "
        f"현재 보유: {_available_families()}"
    )


# ─── ASS 빌더 ────────────────────────────────────────────────────────────────

def _ass_time(seconds: float) -> str:
    total_cs = max(0, int(round(float(seconds) * 100)))
    h, rem = divmod(total_cs, 360000)
    m, rem = divmod(rem, 6000)
    s, cs = divmod(rem, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def _escape_ass_text(text: str) -> str:
    # 중괄호는 ASS 오버라이드 블록으로 파싱되므로 안전 문자로 치환
    text = text.replace("{", "(").replace("}", ")")
    return text.replace("\r\n", "\n").replace("\n", "\\N")


def _num(value) -> str:
    return f"{float(value):g}"


def _cue_override_tags(style: dict) -> str:
    """큐 style 오버라이드 → ASS 인라인 태그 문자열."""
    tags = []
    if style.get("position") and style["position"] in _AN_MAP:
        tags.append(f"\\an{_AN_MAP[style['position']]}")
    if style.get("font"):
        family = _resolve_font_family(str(style["font"])) or str(style["font"])
        tags.append(f"\\fn{family}")
    if style.get("size") is not None:
        tags.append(f"\\fs{_num(style['size'])}")
    if style.get("bold") is not None:
        tags.append("\\b1" if style["bold"] else "\\b0")
    if style.get("color"):
        tags.append(f"\\1c{_color_to_ass(style['color'])}&")
    if style.get("stroke_color"):
        tags.append(f"\\3c{_color_to_ass(style['stroke_color'])}&")
    if style.get("stroke_width") is not None:
        tags.append(f"\\bord{_num(style['stroke_width'])}")
    if style.get("fade"):
        tags.append("\\fad(200,200)")
    return "{" + "".join(tags) + "}" if tags else ""


def _build_ass(
    doc: dict,
    video_size: tuple[int, int] | None = None,
    content_area: tuple[int, int, int, int] | None = None,
) -> str:
    """큐 문서 → ASS 파일 내용. Default 스타일 = style_defaults, 큐별 인라인 태그.

    video_size 가 주어지면 영상 방향(portrait/landscape)을 감지해 font_size,
    margin_v 를 비율 기반으로 자동 조정. content_area 가 주어지면 pad 모드 검은
    여백을 피해 자막이 콘텐츠 영역 안에 위치하도록 margin_v 를 재계산.
    """
    play_res_x = PLAY_RES_X
    if video_size and video_size[0] > 0 and video_size[1] > 0:
        play_res_x = max(1, round(PLAY_RES_Y * video_size[0] / video_size[1]))

    defaults = {**DEFAULT_STYLE, **(doc.get("style_defaults") or {})}
    if video_size:
        defaults = _apply_responsive_style(defaults, video_size[0], video_size[1], content_area)
        if video_size[1] > video_size[0]:
            defaults["size"] = _fit_portrait_font_size(
                defaults["size"],
                [str(cue.get("text", "")) for cue in doc.get("cues", [])],
                play_res_x,
            )
    family = _resolve_font_family(str(defaults["font"])) or str(defaults["font"])
    primary = _color_to_ass(defaults["color"], alpha="00")
    outline = _color_to_ass(defaults["stroke_color"], alpha="00")
    bold = -1 if defaults.get("bold") else 0
    alignment = _AN_MAP.get(defaults.get("position", "bottom"), 2)
    margin_v = int(defaults.get("margin_v", 40))
    # fade 는 [V4+ Styles] 로 표현할 수 없는 인라인 전용 태그 → scope="defaults" 로
    # 저장된 fade 는 per-cue 오버라이드가 없는 큐에 주입해야 실제로 반영된다.
    default_fade = bool(defaults.get("fade"))

    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {play_res_x}",
        f"PlayResY: {PLAY_RES_Y}",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Default,{family},{_num(defaults['size'])},{primary},&H000000FF,"
        f"{outline},&H00000000,{bold},0,0,0,100,100,0,0,1,"
        f"{_num(defaults['stroke_width'])},0,{alignment},10,10,{margin_v},1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]

    for cue in doc.get("cues", []):
        style = dict(cue.get("style") or {})
        if (
            video_size
            and video_size[1] > video_size[0]
            and style.get("size") is not None
        ):
            style["size"] = _fit_portrait_font_size(
                style["size"],
                [str(cue.get("text", ""))],
                play_res_x,
            )
        # 큐가 fade 를 명시하지 않은 경우에만 defaults 의 fade 적용
        # ("fade": false 로 끈 큐는 존중 — get() 이 아니라 키 존재로 판정).
        if default_fade and "fade" not in style:
            style = {**style, "fade": True}
        tags = _cue_override_tags(style)
        # ASS Dialogue 의 MarginV=0 은 "스타일 기본값 사용" 을 뜻해서 오버라이드 없음과
        # 명시적 margin_v=0 을 구분할 수 없다. 명시적 0 은 1 로 클램프해 사용자 의도
        # (화면 끝에 붙임)를 살린다 — 그대로 0 을 쓰면 조용히 기본 마진으로 되돌아감.
        if style.get("margin_v") is None:
            cue_margin_v = 0  # 오버라이드 없음 → Style 의 MarginV 상속
        else:
            cue_margin_v = max(1, int(style["margin_v"]))
        text = _escape_ass_text(str(cue.get("text", "")))
        lines.append(
            f"Dialogue: 0,{_ass_time(cue['start'])},{_ass_time(cue['end'])},"
            f"Default,,0,0,{cue_margin_v},,{tags}{text}"
        )

    return "\n".join(lines) + "\n"


def _run_ffmpeg(cmd: list) -> tuple[int, str]:
    result = subprocess.run(
        cmd, capture_output=True, text=True, encoding="utf-8", errors="ignore"
    )
    return result.returncode, result.stderr


# ─── 큐 매칭 ─────────────────────────────────────────────────────────────────

def _find_cue(cues: list, spec: dict) -> dict | None:
    """id > index > at_ms 우선순위로 큐 매칭."""
    if spec.get("id") is not None:
        for cue in cues:
            if cue.get("id") == spec["id"]:
                return cue
        return None
    if spec.get("index") is not None:
        idx = int(spec["index"])
        if 0 <= idx < len(cues):
            return cues[idx]
        return None
    if spec.get("at_ms") is not None:
        t = float(spec["at_ms"]) / 1000.0
        for cue in cues:
            if float(cue["start"]) <= t <= float(cue["end"]):
                return cue
        return None
    return None


def _describe_spec(spec: dict) -> str:
    for key in ("id", "index", "at_ms"):
        if spec.get(key) is not None:
            return f"{key}={spec[key]}"
    return "매칭 키 없음 (id/index/at_ms 중 하나 필요)"


# ─── Tools ───────────────────────────────────────────────────────────────────

@tool
def list_subtitle_cues(video_path: str) -> str:
    """자막 큐 문서(진실의 원천)를 조회 — 큐 ID / 타이밍 / 텍스트 / 스타일 전체 반환.

    큐 문서가 없으면 기존 전사 사이드카(videos/subtitles/<stem>.json)에서
    자동 승격 생성 (id 부여, source_video 는 현재 video_path 로 기록).
    그것도 없으면 {"status":"error","error":"no_cues"} 반환.

    Args:
        video_path: 영상 파일명 또는 경로 (videos/ 기준 상대 경로 허용)
    """
    try:
        doc, doc_path = _load_or_promote(video_path)
        if doc is None:
            return _no_cues_error()
        return json.dumps(
            {"status": "success", "cues_doc": doc_path, **doc}, ensure_ascii=False
        )
    except Exception as e:
        logger.error(f"list_subtitle_cues 오류: {e}")
        return json.dumps({"status": "error", "error": str(e)}, ensure_ascii=False)


@tool
def update_subtitle_cues(video_path: str, updates: list) -> str:
    """자막 큐를 배치 수정 — 오타 수정 / 타이밍 조정 / 개별 스타일 / 삭제.

    updates 각 항목은 매칭 키 하나(id | index | at_ms)와 변경 필드로 구성:
    [{"id": "c002", "text": "수정된 텍스트"},
     {"index": 0, "style": {"color": "#FFE600", "size": 30}},
     {"at_ms": 2500, "delete": true}]
    - id: 큐 ID (예: "c002"). index: 시간순 0부터 시작. at_ms: 해당 시각(ms)을 포함하는 큐.
    - 변경 필드: text / start / end (초) / style (병합) / delete: true
    수정 후 문서 저장. 실제 영상 반영은 render_subtitles 호출 필요.

    Args:
        video_path: 영상 파일명 또는 경로 (videos/ 기준 상대 경로 허용)
        updates: 수정 명세 리스트
    """
    try:
        doc, doc_path = _load_or_promote(video_path)
        if doc is None:
            return _no_cues_error()
        if not updates:
            return json.dumps(
                {"status": "error", "error": "updates 가 비어 있습니다."},
                ensure_ascii=False,
            )

        cues = doc.get("cues", [])
        updated, deleted, not_found, failed = [], [], [], []

        # 1단계: 변경 전에 모든 spec 을 큐 객체로 resolve.
        # 배치 중간의 삭제로 리스트가 줄면 뒤 spec 의 index/at_ms 가 다른 큐를 가리켜
        # 엉뚱한 자막이 조용히 수정된다 — 매칭 기준을 원본 리스트로 고정.
        resolved: list[tuple[dict, dict]] = []
        for spec in updates:
            if isinstance(spec, str):
                spec = json.loads(spec)
            cue = _find_cue(cues, spec)
            if cue is None:
                not_found.append(_describe_spec(spec))
                continue
            resolved.append((spec, cue))

        # 2단계: 삭제 / 수정 적용
        deleted_ids: set[str] = set()
        for spec, cue in resolved:
            if cue["id"] in deleted_ids:
                failed.append({"id": cue["id"], "error": "같은 배치에서 이미 삭제된 큐"})
                continue

            if spec.get("delete"):
                cues.remove(cue)
                deleted_ids.add(cue["id"])
                deleted.append(cue["id"])
                continue

            new_start = float(spec["start"]) if spec.get("start") is not None else float(cue["start"])
            new_end = float(spec["end"]) if spec.get("end") is not None else float(cue["end"])
            if new_end <= new_start:
                failed.append({"id": cue["id"], "error": "end 는 start 보다 커야 함"})
                continue

            style_patch = None
            if spec.get("style") is not None:
                style_patch = _parse_style_arg(spec["style"])
                error = _validate_style(style_patch)
                if error:
                    failed.append({"id": cue["id"], "error": error})
                    continue

            cue["start"] = round(new_start, 3)
            cue["end"] = round(new_end, 3)
            if spec.get("text") is not None:
                cue["text"] = str(spec["text"])
            if style_patch:
                cue["style"] = {**cue.get("style", {}), **style_patch}
            updated.append(cue["id"])

        cues.sort(key=lambda c: (float(c["start"]), float(c["end"])))
        doc["cues"] = cues
        if updated or deleted:
            _save_cues_doc(doc)

        return json.dumps({
            "status": "success" if not (not_found or failed) else "partial",
            "updated": updated,
            "deleted": deleted,
            "not_found": not_found,
            "failed": failed,
            "cue_count": len(cues),
            "cues_doc": doc_path,
            "note": "영상 반영은 render_subtitles 를 호출하세요.",
        }, ensure_ascii=False)

    except Exception as e:
        logger.error(f"update_subtitle_cues 오류: {e}")
        return json.dumps({"status": "error", "error": str(e)}, ensure_ascii=False)


@tool
def add_subtitle_cue(video_path: str, start: float, end: float, text: str, style: str = "") -> str:
    """새 자막 큐를 삽입 — 시간순 정렬 유지, 새 id 자동 발급 (기존 id 재사용 금지).

    Args:
        video_path: 영상 파일명 또는 경로 (videos/ 기준 상대 경로 허용)
        start: 시작 시간 (초)
        end: 종료 시간 (초)
        text: 자막 텍스트
        style: JSON 스타일 오버라이드 (선택)
               {'color':'#FFE600','size':30,'bold':true,'position':'top','fade':true}
    """
    try:
        doc, doc_path = _load_or_promote(video_path)
        if doc is None:
            return _no_cues_error()
        if float(end) <= float(start):
            return json.dumps(
                {"status": "error", "error": "end 는 start 보다 커야 함"},
                ensure_ascii=False,
            )

        style_dict = _parse_style_arg(style)
        if style_dict:
            error = _validate_style(style_dict)
            if error:
                return json.dumps({"status": "error", "error": error}, ensure_ascii=False)

        cue = {
            "id": _next_cue_id(doc),
            "start": round(float(start), 3),
            "end": round(float(end), 3),
            "text": str(text),
        }
        if style_dict:
            cue["style"] = style_dict

        cues = doc.get("cues", [])
        cues.append(cue)
        cues.sort(key=lambda c: (float(c["start"]), float(c["end"])))
        doc["cues"] = cues
        _save_cues_doc(doc)

        return json.dumps({
            "status": "success",
            "id": cue["id"],
            "cue_count": len(cues),
            "cues_doc": doc_path,
            "note": "영상 반영은 render_subtitles 를 호출하세요.",
        }, ensure_ascii=False)

    except Exception as e:
        logger.error(f"add_subtitle_cue 오류: {e}")
        return json.dumps({"status": "error", "error": str(e)}, ensure_ascii=False)


@tool
def set_subtitle_style(video_path: str, style: str, scope: str = "defaults") -> str:
    """자막 전체 스타일 변경 — "전부 위로", "다 크게", "폰트 바꿔줘" 류 요청 처리.

    scope="defaults" (기본): style_defaults 에 병합 — 오버라이드 없는 큐 전체에 적용.
    scope="all_cues": 모든 큐의 개별 style 오버라이드에 병합 — 기존 per-cue 스타일 위에 강제.

    Args:
        video_path: 영상 파일명 또는 경로 (videos/ 기준 상대 경로 허용)
        style: JSON 스타일 {'font':'NotoSansKR','size':30,'color':'#FFE600',
               'position':'top','margin_v':60,'bold':true}
        scope: 'defaults' | 'all_cues'
    """
    try:
        doc, doc_path = _load_or_promote(video_path)
        if doc is None:
            return _no_cues_error()

        style_dict = _parse_style_arg(style)
        if not style_dict:
            return json.dumps(
                {"status": "error", "error": "style 이 비어 있습니다."}, ensure_ascii=False
            )
        error = _validate_style(style_dict)
        if error:
            return json.dumps({"status": "error", "error": error}, ensure_ascii=False)
        if style_dict.get("font"):
            requested_font = str(style_dict["font"])
            resolved_font = _resolve_font_family(requested_font)
            if not resolved_font:
                return _font_error(requested_font)
            style_dict["font"] = resolved_font
        if scope not in ("defaults", "all_cues"):
            return json.dumps(
                {"status": "error", "error": f"scope 값이 잘못됨: {scope} (defaults | all_cues)"},
                ensure_ascii=False,
            )

        if scope == "defaults":
            doc["style_defaults"] = {**DEFAULT_STYLE, **doc.get("style_defaults", {}), **style_dict}
            applied = len(doc.get("cues", []))
        else:
            for cue in doc.get("cues", []):
                cue["style"] = {**cue.get("style", {}), **style_dict}
            applied = len(doc.get("cues", []))

        _save_cues_doc(doc)
        return json.dumps({
            "status": "success",
            "scope": scope,
            "applied_cues": applied,
            "style_defaults": doc["style_defaults"],
            "cues_doc": doc_path,
            "note": "영상 반영은 render_subtitles 를 호출하세요.",
        }, ensure_ascii=False)

    except Exception as e:
        logger.error(f"set_subtitle_style 오류: {e}")
        return json.dumps({"status": "error", "error": str(e)}, ensure_ascii=False)


@tool
def render_subtitles(video_path: str, output_path: str = "") -> str:
    """큐 문서 → ASS 자막 생성 → source_video 에 FFmpeg burn-in — 새 mp4 경로 반환.

    반드시 문서의 source_video(번인 전 소스)를 입력으로 사용 — 이미 자막이
    번인된 파일에 이중 번인하지 않음. 큐 수정 후 이 툴 1회 호출로 반영 완료.

    Args:
        video_path: 영상 파일명 또는 경로 (큐 문서 조회 기준)
        output_path: 출력 경로 (선택, 기본 outputs/<stem>_subtitled_<8hex>.mp4)
    """
    try:
        doc, _ = _load_or_promote(video_path)
        if doc is None:
            return _no_cues_error()

        stem = doc.get("video_stem") or _video_stem(video_path)
        source = doc.get("source_video", "")
        if not source:
            return "ERROR: 큐 문서에 source_video 가 없습니다 — 재렌더 기점을 알 수 없음."
        source = _resolve_video_path(source)
        if not os.path.exists(source):
            return f"ERROR: source_video 파일 없음: {source}"

        # 폰트 검증 (defaults + 모든 per-cue 오버라이드)
        defaults = {**DEFAULT_STYLE, **(doc.get("style_defaults") or {})}
        fonts_needed = {str(defaults["font"])}
        for cue in doc.get("cues", []):
            font = (cue.get("style") or {}).get("font")
            if font:
                fonts_needed.add(str(font))
        for font in sorted(fonts_needed):
            if not _resolve_font_family(font):
                return _font_error(font)

        # 영상 실제 해상도 + 콘텐츠 영역 감지 → 반응형 font_size / margin_v 계산
        video_size = _get_video_size(source)
        content_area = None
        if video_size[0] > 0:
            orientation = "portrait" if video_size[1] > video_size[0] else "landscape"
            content_area = _detect_content_area(source)
            cx, cy, cw, ch = content_area
            has_pad = ch > 0 and (video_size[1] - (cy + ch)) > video_size[1] * 0.05
            logger.info(
                "render_subtitles: %dx%d (%s)%s",
                video_size[0], video_size[1], orientation,
                f" pad_bottom={video_size[1]-(cy+ch)}px" if has_pad else "",
            )

        # ASS 생성 (고정 PlayRes — libass 가 프레임 높이에 맞춰 확대)
        ass_content = _build_ass(doc, video_size=video_size, content_area=content_area)
        os.makedirs(SUBTITLES_DIR, exist_ok=True)
        ass_path = os.path.join(SUBTITLES_DIR, f"{stem}.ass")
        with open(ass_path, "w", encoding="utf-8") as f:
            f.write(ass_content)

        # 출력 경로 해석 (edit.py 컨벤션)
        if output_path:
            if os.path.isabs(output_path):
                resolved = output_path
            elif os.path.dirname(output_path):
                resolved = os.path.join(_PROJECT_ROOT, output_path)
            else:
                resolved = os.path.join(OUTPUTS_DIR, output_path)
            resolved = os.path.normpath(resolved)
        else:
            resolved = os.path.join(OUTPUTS_DIR, f"{stem}_subtitled_{uuid.uuid4().hex[:8]}.mp4")
        parent = os.path.dirname(os.path.abspath(resolved))
        if parent:
            os.makedirs(parent, exist_ok=True)

        fonts_part = ""
        if os.path.isdir(FONTS_DIR):
            fonts_part = f":fontsdir='{_ffmpeg_filter_path(FONTS_DIR)}'"
        vf = f"subtitles='{_ffmpeg_filter_path(ass_path)}'{fonts_part}"

        cmd = ["ffmpeg", "-y", "-i", source, "-vf", vf, "-c:a", "copy", resolved]
        code, stderr = _run_ffmpeg(cmd)
        if code != 0:
            return f"ERROR: FFmpeg 렌더 실패 (rc={code}): {stderr[-800:]}"

        # 자막 번인은 시간축/콘텐츠 영역을 바꾸지 않는다. 이후 재편집과
        # 자막 재사용이 이어지도록 edit origin 및 pad 메타를 승계한다.
        for suffix in (".origin.json", ".pad.json"):
            source_sidecar = source + suffix
            if os.path.exists(source_sidecar):
                try:
                    shutil.copy2(source_sidecar, resolved + suffix)
                except OSError:
                    logger.warning("subtitle sidecar copy failed: %s", source_sidecar)

        logger.info(f"render_subtitles 완료: {resolved} ({len(doc.get('cues', []))}개 큐)")
        return resolved

    except FileNotFoundError:
        return "ERROR: FFmpeg가 설치되어 있지 않습니다."
    except Exception as e:
        logger.error(f"render_subtitles 오류: {e}")
        return f"ERROR: {e}"


TOOLS = [
    list_subtitle_cues,
    update_subtitle_cues,
    add_subtitle_cue,
    set_subtitle_style,
    render_subtitles,
]


if __name__ == "__main__":
    print("subtitle_cues tools:", [t.name for t in TOOLS])
