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

from agent.tools import media_paths
from agent.tools.subtitle import (
    FONTS_DIR,
    SUBTITLES_DIR,
    VIDEOS_DIR,
    _color_to_ass,
    _ffmpeg_env,
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

# 이름 있는 스타일 프리셋 — set_subtitle_style(preset=...) 의 베이스.
# 여기 값은 "기본값일 뿐" 이며 style(JSON) 오버라이드로 위치/색/크기/폰트/효과를
# 언제든 자유롭게 덮어쓸 수 있다 (프롬프트 자유도 유지). font 는 여기 넣지 않고
# resolve_style_preset() 이 assets/fonts 보유분 기준으로 동적 해석한다.
#
# 좌표계는 PLAY_RES_Y 288 기준 (DEFAULT_STYLE 과 동일). size 24 = 기본,
# 그보다 크면 화면에서 더 큼직하게 보인다 (1080p 에서 288→1080 = 3.75배 확대).
STYLE_PRESETS: dict[str, dict] = {
    # 기존 기본값 그대로 — 중간 크기, 화면 하단, 얇은 외곽선
    "clean": {
        "size": 24,
        "color": "#FFFFFF",
        "stroke_color": "#000000",
        "stroke_width": 1.5,
        "position": "bottom",
        "margin_v": 40,
        "bold": False,
    },
    # 인스타/틱톡 쇼츠 스타일 — 큰 볼드 한글, 굵은 검은 외곽선, 흰색, 하단.
    # 쇼츠 레이아웃은 제목이 위쪽 여백, 발화 자막이 아래쪽 여백이라 bottom 이 맞다
    # (예전 top 은 제목과 겹치고 "자막이 위로 간다"는 문제를 만들었다).
    "shorts_bold": {
        "size": 36,
        "color": "#FFFFFF",
        "stroke_color": "#000000",
        "stroke_width": 3,
        "position": "bottom",
        "margin_v": 40,
        "bold": True,
    },
    # 노란색 강조 캡션 — 핵심 문장 포인트용
    "caption_point": {
        "size": 30,
        "color": "#FFE600",
        "stroke_color": "#000000",
        "stroke_width": 2.5,
        "position": "middle",
        "margin_v": 40,
        "bold": True,
    },
}

# 프리셋별 선호 폰트 후보 — assets/fonts 에 있는 첫 번째를 쓰고, 없으면 다음 후보,
# 끝까지 없으면 기본 폰트(NotoSansKR)로 폴백. 쇼츠 볼드는 검은고딕(BlackHanSans)/
# 배민 주아(BMJUA) 같은 두꺼운 디스플레이 폰트가 있으면 우선 사용.
_PRESET_FONT_CANDIDATES: dict[str, list[str]] = {
    "shorts_bold": ["BlackHanSans", "BMJUA", "BMDoHyeon", "GmarketSansBold", "NotoSansKR"],
    "caption_point": ["BlackHanSans", "BMJUA", "NotoSansKR"],
    "clean": ["NotoSansKR"],
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
    "position", "margin_v", "bold", "fade", "effect",
}

# 자막 등장 효과 (per-cue "effect" 필드). ASS 인라인 애니메이션 태그로 변환된다.
# 시간 단위는 ms (ASS \t / \fad / \move 모두 ms). slide_up 은 좌표 계산이 필요해
# _slide_up_tag() 에서 별도 생성. typewriter 는 ASS 단독으로 글자별 등장 구현이
# 복잡해 fade 로 폴백 (Remotion 렌더 경로에서 정식 지원 예정).
_EFFECT_TAGS: dict[str, str] = {
    "none": "",
    "fade": "\\fad(150,150)",
    "pop": "\\fscx60\\fscy60\\t(0,180,\\fscx100\\fscy100)",
    "bounce": "\\fscx50\\fscy50\\t(0,120,\\fscx110\\fscy110)\\t(120,240,\\fscx100\\fscy100)",
    "typewriter": "\\fad(150,150)",
}
# \fad 를 이미 포함하는 효과 — fade 불리언과 겹칠 때 \fad 중복 방지("통합")
_FADE_EFFECTS = {"fade", "slide_up", "typewriter"}
_KNOWN_EFFECTS = set(_EFFECT_TAGS) | {"slide_up"}

_FONT_EXTS = {".ttf", ".otf", ".ttc"}
_FONT_WEIGHT_SUFFIX = re.compile(
    r"[-_](?:regular|bold|light|medium|thin|black|italic|semibold|demibold"
    r"|extrabold|extralight|heavy|book)$",
    re.IGNORECASE,
)


# ─── 경로 / 문서 헬퍼 ─────────────────────────────────────────────────────────

def _resolve_video_path(video_path: str) -> str:
    """edit.py 컨벤션: 절대 경로 → 그대로, 아니면 프로젝트 루트 → videos/ 순.

    편집 산출물은 outputs/ 에 있는데 이 해석기만 그곳을 못 봐서, 승격된 큐 문서가
    존재하지 않는 source_video 를 기록해왔다 (디스크에서 확인: add_bgm_16.cues.json
    이 backend/add_bgm_16.mp4 를 가리키지만 실제 파일은 backend/outputs/ 에 있다).
    공용 규칙(media_paths)에 위임하고, 못 찾을 때만 기존 위치를 그대로 돌려준다.
    """
    if os.path.isabs(video_path) and os.path.exists(video_path):
        return os.path.normpath(video_path)

    found = media_paths.find_media(video_path)
    if found is not None:
        return os.path.normpath(str(found))

    # 서버 엔드포인트는 확장자 없는 stem 을 넘긴다 ("final_video"). 큐 문서의
    # source_video 도 확장자 없이 저장된 사례가 있어 (_____.cues.json) 확장자를
    # 붙여 한 번 더 찾아본다.
    if not os.path.splitext(video_path)[1]:
        for ext in (".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"):
            found = media_paths.find_media(f"{video_path}{ext}")
            if found is not None:
                return os.path.normpath(str(found))

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
    inherit_title_from: str | None = None,
) -> tuple[dict, str]:
    """세그먼트 리스트에서 큐 문서를 새로 생성하고 저장. (doc, path) 반환.

    id 는 c001 부터 순번 부여. 기존 문서의 대사 큐는 덮어씀 (새 전사 = 새 진실).

    단 role="title" 큐는 살린다. 제목은 전사 결과가 아니라 사용자가 따로 얹은
    층이라, 자막을 다시 뽑았다고 같이 지워지면 안 된다 (그렇게 지워져서
    "제목을 넣었는데 사라졌다" 가 됐다).

    inherit_title_from: 다른 stem(예: 자막 step 의 입력 영상 stem)의 제목 큐도
    가져온다. add_title(입력 stem) -> add_auto_subtitle(출력 stem) 처럼 stem 이
    바뀌면 제목이 새 문서로 안 넘어와 최종본에서 제목이 통째로 빠지던 문제 해결.
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

    # 기존 문서에서 제목 큐만 회수. id 는 새 대사 큐와 겹치므로 뒤에서 다시 매긴다.
    # 같은 stem 문서 + (stem 이 바뀐 경우) 입력 stem 문서 둘 다에서 회수한다.
    preserved: list[dict] = []
    seen: set = set()
    for src_stem in (stem, inherit_title_from):
        if not src_stem:
            continue
        try:
            existing_path = _cues_doc_path(src_stem)
            if not os.path.exists(existing_path):
                continue
            with open(existing_path, encoding="utf-8") as f:
                old = json.load(f)
            for c in old.get("cues", []):
                if isinstance(c, dict) and c.get("role") == "title":
                    key = (str(c.get("text", "")), round(float(c.get("start", 0)), 2))
                    if key in seen:
                        continue
                    seen.add(key)
                    preserved.append(c)
        except Exception as e:
            # 회수 실패가 새 문서 생성을 막으면 안 된다. 잃은 것만 알린다.
            logger.warning(f"기존 제목 큐 회수 실패 ({src_stem}): {e}")

    for j, cue in enumerate(preserved, len(cues) + 1):
        cue["id"] = f"c{j:03d}"
        cues.append(cue)
    if preserved:
        logger.info(f"제목 큐 {len(preserved)}개 보존 ({stem})")

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


def _load_or_promote(
    video_path: str, *, allow_newest_fallback: bool = True
) -> tuple[dict | None, str]:
    """큐 문서 로드. 없으면 전사 사이드카(<stem>.json)에서 자동 승격 생성.

    allow_newest_fallback=False 면 아래 "최신 문서 폴백" 을 건너뛴다. 그 폴백은
    디렉토리 전체에서 mtime 이 가장 늦은 문서를 집어오므로, 새 내용을 *쓰는*
    경로에서 쓰면 아무 관계 없는 영상의 자막 문서에 기록된다 (실측: 사본 영상에
    제목을 넣었더니 final_video_with_subtitles 문서에 들어갔다).
    조회에는 유용하므로 기본값은 유지한다.
    """
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

    # 최종 stem 과 큐 문서 stem 이 어긋나는 경우 폴백: supervisor 가 자막 step 이후
    # 파일명을 바꾸면(예: subtitle_added_shorts.mp4 -> final_shorts_v1.mp4) 최종
    # stem 으로 큐 문서를 못 찾아 스타일 카드/내보내기가 404 났다. 가장 최근에 만든
    # 큐 문서로 폴백해 최종본의 자막 편집/번인이 이어지게 한다.
    try:
        if allow_newest_fallback and os.path.isdir(SUBTITLES_DIR):
            candidates = [
                os.path.join(SUBTITLES_DIR, f)
                for f in os.listdir(SUBTITLES_DIR)
                if f.endswith(".cues.json")
            ]
            if candidates:
                newest = max(candidates, key=os.path.getmtime)
                with open(newest, encoding="utf-8") as f:
                    logger.info(
                        "큐 문서 stem 불일치(%s) -> 최신 큐 문서 폴백: %s", stem, newest
                    )
                    return json.load(f), newest
    except OSError:
        logger.warning("최신 큐 문서 폴백 실패", exc_info=True)

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


# legacy 스타일 키(subtitle.py) → 큐 스타일 키 매핑 (platform 등 비스타일 키는 제외)
_LEGACY_STYLE_KEY_MAP = {
    "font": "font",
    "font_size": "size",
    "size": "size",
    "color": "color",
    "stroke_color": "stroke_color",
    "stroke_width": "stroke_width",
    "position": "position",
    "margin_v": "margin_v",
    "bold": "bold",
    "effect": "effect",
    "fade": "fade",
}


def explicit_style_from_legacy(style_json) -> dict:
    """사용자가 legacy style JSON 에 '명시적으로' 준 키만 큐 스타일 키로 변환.

    style_defaults_from_legacy 와 달리 기본값을 채우지 않는다 — 프리셋을 베이스로
    깔 때(add_auto_subtitle 의 쇼츠 경로) 사용자가 실제 지정한 값만 위에 얹기 위함.
    platform 같은 비스타일 키는 무시하고, 색은 hex 로 정규화한다.
    """
    try:
        raw = _parse_style_arg(style_json)
    except (ValueError, json.JSONDecodeError, TypeError):
        return {}
    out: dict = {}
    for key, value in raw.items():
        cue_key = _LEGACY_STYLE_KEY_MAP.get(key)
        if not cue_key:
            continue
        if cue_key in ("color", "stroke_color"):
            try:
                r, g, b = _hex_to_rgb(str(value))
                value = f"#{r:02X}{g:02X}{b:02X}"
            except ValueError:
                continue
        out[cue_key] = value
    return out


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
    eff = style.get("effect")
    if eff is not None and not isinstance(eff, str):
        return f"effect 는 문자열이어야 합니다: {eff}"
    # effect 값 자체는 여기서 막지 않는다 — 모르는 값은 렌더 시 무시 + 경고
    # (프롬프트 자유도: 신규 효과명을 실험적으로 넣어도 파이프라인이 죽지 않게).
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
    # 파일명 stem("NotoSansKR")이 아니라 폰트 내부 family 명("Noto Sans KR")으로
    # 매핑 — 파일명 기반 이름은 libass 가 Arial 로 조용히 폴백해 한글이 두부가 된다.
    from agent.tools.subtitle import _font_family_from_file  # 지연 임포트 (순환 방지)

    families: dict[str, str] = {}
    if not os.path.isdir(FONTS_DIR):
        return families
    for fname in sorted(os.listdir(FONTS_DIR)):
        base, ext = os.path.splitext(fname)
        if ext.lower() not in _FONT_EXTS:
            continue
        family = _font_family_from_file(fname)
        stem = _FONT_WEIGHT_SUFFIX.sub("", base)
        families.setdefault(_normalize_font_key(family), family)
        families.setdefault(_normalize_font_key(stem), family)
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


def _preferred_font(candidates: list) -> str:
    """후보 폰트 중 assets/fonts 에 실제 있는 첫 번째 패밀리, 없으면 기본 폰트."""
    for name in candidates:
        family = _resolve_font_family(str(name))
        if family:
            return family
    return _default_font_family()


def resolve_style_preset(name: str) -> dict | None:
    """프리셋 이름 → 폰트가 보유분 기준으로 해석된 style dict. 모르는 이름이면 None.

    STYLE_PRESETS 의 값(폰트 제외)을 복사하고, _PRESET_FONT_CANDIDATES 후보 중
    실제 보유한 폰트를 font 로 채운다. 이 dict 를 베이스로 깔고 사용자 style 로
    오버라이드하면 프리셋 + 자유 커스터마이즈가 함께 동작한다.
    """
    preset = STYLE_PRESETS.get(name)
    if preset is None:
        return None
    resolved = dict(preset)
    resolved["font"] = _preferred_font(_PRESET_FONT_CANDIDATES.get(name) or [])
    return resolved


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


# 이모지(그림문자) 감지 — 렌더 시 컬러 이모지 폰트 폴백 경고용. 텍스트 자체는
# 절대 건드리지 않고(그대로 보존), 폰트가 없을 때 두부(□) 렌더 가능성만 알린다.
_EMOJI_RE = re.compile(
    "["
    "\U0001F000-\U0001FAFF"   # 그림문자/이모지/확장 블록
    "\U00002600-\U000027BF"   # 기타 기호 + dingbats
    "\U00002B00-\U00002BFF"   # 추가 기호/화살표
    "\U0000FE00-\U0000FE0F"   # variation selectors (이모지 표현)
    "\U0001F1E6-\U0001F1FF"   # regional indicator (국기)
    "\U000024C2\U00002122\U00002139"
    "]",
    flags=re.UNICODE,
)


def _has_emoji(text: str) -> bool:
    """텍스트에 이모지/그림문자가 포함됐는지."""
    return bool(_EMOJI_RE.search(str(text)))


def _emoji_font_available() -> bool:
    """assets/fonts 에 컬러 이모지 폰트(NotoColorEmoji.ttf)가 있는지."""
    from agent.tools.subtitle import _EMOJI_FONT_FILE

    return os.path.exists(os.path.join(FONTS_DIR, _EMOJI_FONT_FILE))


def _slide_up_tag(style: dict) -> str:
    """아래에서 위로 슬라이드 등장.

    ASS \\move 는 절대좌표라 position/margin_v 기준 도착 지점을 캔버스(384x288)
    좌표로 계산하고, 그보다 20px 아래에서 250ms 동안 제자리로 올라오게 한다.
    \\an 정렬(도착점 기준)은 _cue_override_tags 또는 Default 스타일에서 이미 적용됨.
    """
    an = _AN_MAP.get(str(style.get("position", "bottom")), 2)
    try:
        margin_v = max(0, int(style.get("margin_v", 40)))
    except (TypeError, ValueError):
        margin_v = 40
    if an in (1, 4, 7):        # 좌측 정렬
        x = 10
    elif an in (3, 6, 9):      # 우측 정렬
        x = PLAY_RES_X - 10
    else:                      # 중앙
        x = PLAY_RES_X / 2
    if an in (7, 8, 9):        # 상단 — 위 여백에서
        y = margin_v
    elif an in (1, 2, 3):      # 하단 — 아래 여백에서
        y = PLAY_RES_Y - margin_v
    else:                      # 중앙
        y = PLAY_RES_Y / 2
    return (
        f"\\move({_num(x)},{_num(y + 20)},{_num(x)},{_num(y)},0,250)"
        "\\fad(150,0)"
    )


def _effect_tag(effect: str, style: dict) -> str:
    """effect 값 → ASS 인라인 애니메이션 태그. 모르는 값은 무시 + 경고."""
    effect = str(effect or "none")
    if effect == "slide_up":
        return _slide_up_tag(style)
    if effect in _EFFECT_TAGS:
        return _EFFECT_TAGS[effect]
    if effect != "none":
        logger.warning(
            f"알 수 없는 effect: {effect} (허용: {sorted(_KNOWN_EFFECTS)}) — 무시"
        )
    return ""


def _cue_override_tags(style: dict, effective: dict | None = None) -> str:
    """큐 style 오버라이드 → ASS 인라인 태그 문자열.

    effective 는 defaults 병합본 — slide_up 등 위치 기반 효과의 좌표 계산에 쓴다
    (position/margin_v 가 큐에 없고 defaults 에만 있을 때도 정확히 계산되도록).
    """
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

    effect = str(style.get("effect", "none") or "none")
    # fade 불리언: 효과가 이미 \fad 를 넣는 경우엔 생략 (중복 \fad 방지 = "통합")
    if style.get("fade") and effect not in _FADE_EFFECTS:
        tags.append("\\fad(200,200)")
    effect_tag = _effect_tag(effect, effective or style)
    if effect_tag:
        tags.append(effect_tag)

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
    # effect 도 인라인 전용 → 오버라이드 없는 큐에 default effect 주입 (fade 와 동일 패턴).
    default_effect = str(defaults.get("effect", "none") or "none")

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
        # effect 도 동일 — 큐가 effect 를 명시하지 않으면 defaults 의 effect 적용.
        if default_effect != "none" and "effect" not in style:
            style = {**style, "effect": default_effect}
        # slide_up 등 위치 기반 효과는 defaults 병합본으로 좌표 계산.
        effective = {**defaults, **style}
        tags = _cue_override_tags(style, effective)
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
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="ignore",
        env=_ffmpeg_env(),
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
def update_subtitle_cues(video_path: str, updates: list[dict]) -> str:
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
def set_subtitle_style(video_path: str, style: str = "", scope: str = "defaults", preset: str = "") -> str:
    """자막 전체 스타일 변경 — "쇼츠 볼드로", "전부 위로", "다 크게", "폰트 바꿔줘" 류 처리.

    preset 을 주면 STYLE_PRESETS[preset] 을 베이스로 깔고 그 위에 style(JSON) 을
    오버라이드한다 — 프리셋의 큰 틀은 유지하면서 색/위치/크기 등을 자유롭게 바꿀 수 있다.
    style 만 주면 기존처럼 개별 키만 병합, preset 만 주면 프리셋 전체 적용.

    사용 가능한 preset:
    - shorts_bold: 인스타/틱톡 쇼츠 스타일 — 큰 볼드 한글, 굵은 검은 외곽선, 흰색, 상단
    - clean: 기본 — 중간 크기, 하단, 얇은 외곽선
    - caption_point: 노란색 강조 캡션

    scope="defaults" (기본): style_defaults 에 병합 — 오버라이드 없는 큐 전체에 적용.
    scope="all_cues": 모든 큐의 개별 style 오버라이드에 병합 — 기존 per-cue 스타일 위에 강제.

    Args:
        video_path: 영상 파일명 또는 경로 (videos/ 기준 상대 경로 허용)
        style: JSON 스타일 {'font':'NotoSansKR','size':30,'color':'#FFE600',
               'position':'top','margin_v':60,'bold':true,'effect':'pop'} (선택)
        scope: 'defaults' | 'all_cues'
        preset: 'shorts_bold' | 'clean' | 'caption_point' (선택, 베이스 스타일)
    """
    try:
        doc, doc_path = _load_or_promote(video_path)
        if doc is None:
            return _no_cues_error()

        base: dict = {}
        if preset:
            base = resolve_style_preset(preset)
            if base is None:
                return json.dumps({
                    "status": "error",
                    "error": f"알 수 없는 preset: {preset} (허용: {sorted(STYLE_PRESETS)})",
                }, ensure_ascii=False)

        style_dict = _parse_style_arg(style)
        merged = {**base, **style_dict}  # 프리셋 위에 style 오버라이드
        if not merged:
            return json.dumps(
                {"status": "error", "error": "style 또는 preset 중 하나는 필요합니다."},
                ensure_ascii=False,
            )
        error = _validate_style(merged)
        if error:
            return json.dumps({"status": "error", "error": error}, ensure_ascii=False)
        if merged.get("font"):
            requested_font = str(merged["font"])
            resolved_font = _resolve_font_family(requested_font)
            if not resolved_font:
                return _font_error(requested_font)
            # 파일명 stem("NotoSansKR")이 아니라 폰트 내부 family 명("Noto Sans KR")
            # 으로 정규화해 저장 — libass 가 Arial 로 조용히 폴백하는 것을 방지.
            merged["font"] = resolved_font
        if scope not in ("defaults", "all_cues"):
            return json.dumps(
                {"status": "error", "error": f"scope 값이 잘못됨: {scope} (defaults | all_cues)"},
                ensure_ascii=False,
            )

        if scope == "defaults":
            doc["style_defaults"] = {**DEFAULT_STYLE, **doc.get("style_defaults", {}), **merged}
            applied = len(doc.get("cues", []))
        else:
            for cue in doc.get("cues", []):
                cue["style"] = {**cue.get("style", {}), **merged}
            applied = len(doc.get("cues", []))

        _save_cues_doc(doc)
        return json.dumps({
            "status": "success",
            "scope": scope,
            "preset": preset or None,
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

        # 이모지 폰트 폴백 경고 — 텍스트는 그대로 두되(강제 변형 X), 컬러 이모지
        # 폰트가 없으면 이모지가 □(두부)로 렌더될 수 있음을 알린다. libass 는
        # fontsdir 의 폰트로 폴백하므로 assets/fonts 에 NotoColorEmoji.ttf 를 두면 해결.
        from agent.tools.subtitle import _EMOJI_FONT_FILE

        emoji_cues = [
            c.get("id") for c in doc.get("cues", []) if _has_emoji(c.get("text", ""))
        ]
        if emoji_cues and not _emoji_font_available():
            logger.warning(
                f"이모지 폰트({_EMOJI_FONT_FILE}) 없음 — 큐 {emoji_cues} 의 이모지가 "
                f"□ 로 렌더될 수 있습니다. assets/fonts 에 {_EMOJI_FONT_FILE} 추가 권장."
            )

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
