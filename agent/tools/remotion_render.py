"""
Remotion render tool — effect_expert 가 호출하는 핵심 효과 적용 도구.

흐름:
  1. clip_path 의 메타 (fps, width, height) ffprobe 로 추출
  2. effect props JSON 구성 (effectName / effectParams / brandEnergy 등)
  3. subprocess 로 `npx remotion render` 호출
  4. 산출 mp4 경로 반환

Scene24 는 E2B sandbox 를 쓰지만 학생 프로젝트엔 과함 -> 로컬 subprocess.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from langchain_core.tools import tool

from agent import config

logger = logging.getLogger(__name__)


# =============================================================
# 경로 / 상수
# =============================================================

REMOTION_DIR = config.PROJECT_ROOT / "remotion"
REMOTION_ENTRY = REMOTION_DIR / "src" / "index.ts"
EFFECT_OUTPUT_DIR = config.VIDEOS_DIR / "effects"

# composition id (Root.tsx 에서 등록한 것)
COMPOSITION_LANDSCAPE = "ClipEffect"
COMPOSITION_SHORTS = "ClipEffectShorts"


# =============================================================
# 헬퍼
# =============================================================

def _ffprobe_meta(path: str) -> dict:
    """ffprobe 로 영상 메타 추출 (duration, fps, width, height).

    실패해도 default fallback 반환 (Remotion 이 props default 로 처리하게).
    """
    try:
        cmd = [
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height,r_frame_rate,duration",
            "-of", "json", path,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            return {}
        data = json.loads(result.stdout)
        stream = data.get("streams", [{}])[0]
        fr = stream.get("r_frame_rate", "30/1")
        num, den = fr.split("/") if "/" in fr else (fr, "1")
        fps = float(num) / float(den) if float(den) else 30.0
        return {
            "width": int(stream.get("width", 1920)),
            "height": int(stream.get("height", 1080)),
            "fps": round(fps),
            "duration": float(stream.get("duration", 0)),
        }
    except Exception as e:
        logger.warning("ffprobe failed for %s: %s", path, e)
        return {}


def _check_remotion_setup() -> str | None:
    """Remotion 프로젝트 셋업 점검. 문제 있으면 에러 메시지 반환, OK 면 None.

    팀원이 처음 클론했을 때 친절한 에러를 주기 위함.
    """
    if not REMOTION_DIR.exists():
        return f"remotion/ directory not found at {REMOTION_DIR}"

    if not (REMOTION_DIR / "node_modules").exists():
        return (
            "remotion/node_modules not found. Run:\n"
            f"  cd {REMOTION_DIR} && pnpm install   # or npm install"
        )

    if not shutil.which("npx"):
        return "npx (Node.js) not on PATH. Install Node 18+ first."

    return None


# =============================================================
# Main tool
# =============================================================

@tool
def apply_remotion_effect(
    clip_path: str,
    pattern_id: str,
    effect_params: dict | None = None,
    effect_mode: str = "overlay",
    text_overlay: str | None = None,
    brand_energy: str = "moderate",
    target_format: str = "general",
    duration_sec: float | None = None,
    output_path: str | None = None,
) -> str:
    """기존 영상 클립에 Remotion 모션 패턴 1 개를 입혀서 새 mp4 로 저장.

    Args:
        clip_path: 원본 영상 절대 경로 (또는 videos/ 상대 경로).
        pattern_id: agent/effects/INDEX.md 의 패턴 이름 (예: "FadeIn", "ZoomIntoScreen").
        effect_params: 패턴별 props. registry.json 의 default_params 참고.
        effect_mode: "overlay" (영상 위) | "wrap" (영상을 transform) | "replace" (영상 없이 효과만).
        text_overlay: 텍스트 효과 (TypewriterText / TextReveal 등) 의 텍스트.
        brand_energy: "restrained" | "moderate" | "high".
        target_format: "shorts" | "reels" 면 9:16 composition 사용, 그 외 16:9.
        duration_sec: 출력 길이. None 이면 원본 클립 길이 또는 3초 default.
        output_path: 저장 경로. None 이면 videos/effects/<timestamp>_<pattern>.mp4.

    Returns:
        JSON string: {"status": "success", "output": "...", "duration_sec": ...}
    """
    started = time.monotonic()
    effect_params = effect_params or {}

    setup_err = _check_remotion_setup()
    if setup_err:
        return json.dumps({"status": "error", "error": "remotion_not_setup", "message": setup_err}, ensure_ascii=False)

    # 1. 입력 경로 normalize
    if not os.path.isabs(clip_path) and clip_path:
        candidate = config.VIDEOS_DIR / clip_path
        if candidate.exists():
            clip_path = str(candidate.resolve())

    if clip_path and not os.path.exists(clip_path):
        return json.dumps({"status": "error", "error": "clip_not_found", "clip_path": clip_path}, ensure_ascii=False)

    # 2. 메타 추출
    meta = _ffprobe_meta(clip_path) if clip_path else {}
    fps = meta.get("fps", 30)
    src_duration = meta.get("duration", 0)
    out_duration = duration_sec or (src_duration if src_duration > 0 else 3.0)
    duration_frames = max(1, int(round(out_duration * fps)))

    # 3. composition + 비율 선택
    composition_id = COMPOSITION_SHORTS if target_format in ("shorts", "reels") else COMPOSITION_LANDSCAPE

    # 4. output path
    EFFECT_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    if output_path is None:
        ts = int(time.time())
        output_path = str(EFFECT_OUTPUT_DIR / f"{ts}_{pattern_id}.mp4")

    # 5. props JSON (file 로 박아서 큰 props 도 안전하게)
    props = {
        "clipPath": clip_path,
        "effectName": pattern_id,
        "effectMode": effect_mode,
        "effectParams": effect_params,
        "textOverlay": text_overlay,
        "brandEnergy": brand_energy,
    }
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, dir=str(REMOTION_DIR)) as f:
        json.dump(props, f, ensure_ascii=False)
        props_file = f.name

    # 6. remotion render 호출
    cmd = [
        "npx", "remotion", "render",
        "src/index.ts",
        composition_id,
        output_path,
        f"--props={props_file}",
        f"--frames=0-{duration_frames - 1}",
        f"--scale=1",
    ]
    logger.info("remotion render: %s", " ".join(cmd))

    try:
        result = subprocess.run(
            cmd,
            cwd=str(REMOTION_DIR),
            capture_output=True,
            text=True,
            timeout=600,  # 10 min
        )
    except subprocess.TimeoutExpired:
        return json.dumps({"status": "error", "error": "render_timeout", "pattern": pattern_id}, ensure_ascii=False)
    finally:
        try:
            os.unlink(props_file)
        except OSError:
            pass

    elapsed = time.monotonic() - started

    if result.returncode != 0:
        # stderr 마지막 줄 추출
        stderr_tail = "\n".join(result.stderr.strip().splitlines()[-10:])
        return json.dumps({
            "status": "error",
            "error": "render_failed",
            "returncode": result.returncode,
            "stderr_tail": stderr_tail[:1000],
            "pattern": pattern_id,
        }, ensure_ascii=False)

    if not os.path.exists(output_path):
        return json.dumps({
            "status": "error",
            "error": "output_missing",
            "expected": output_path,
        }, ensure_ascii=False)

    return json.dumps({
        "status": "success",
        "output": output_path,
        "pattern": pattern_id,
        "duration_sec": out_duration,
        "duration_frames": duration_frames,
        "fps": fps,
        "composition": composition_id,
        "render_time_sec": round(elapsed, 1),
    }, ensure_ascii=False)


# =============================================================
# Catalog query helper (LLM 이 카탈로그를 빠르게 조회)
# =============================================================

@tool
def query_effect_catalog(pattern_id: str | None = None, category: str | None = None) -> str:
    """effect 카탈로그(registry.json) 에서 정보 조회.

    Args:
        pattern_id: 특정 패턴 이름 (예: "BlurSlideIn"). None 이면 전체 카테고리 요약.
        category: 카테고리 필터 (entrance / exit / data / ambient / ...).

    Returns:
        JSON string. pattern_id 가 있으면 그 패턴의 메타데이터 전체.
        없으면 카테고리별 패턴 이름 + 한 줄 설명 리스트.
    """
    reg_path = config.PROJECT_ROOT / "agent" / "effects" / "registry.json"
    if not reg_path.exists():
        return json.dumps({"status": "error", "error": "registry_not_found"}, ensure_ascii=False)

    with open(reg_path, encoding="utf-8") as f:
        reg = json.load(f)
    patterns = reg.get("patterns", {})

    if pattern_id:
        p = patterns.get(pattern_id)
        if p is None:
            similar = [k for k in patterns if pattern_id.lower() in k.lower()]
            return json.dumps({
                "status": "not_found",
                "pattern_id": pattern_id,
                "similar": similar[:5],
            }, ensure_ascii=False)
        return json.dumps({"status": "success", "pattern": pattern_id, "data": p}, ensure_ascii=False)

    # 카테고리 요약
    summary: dict = {}
    for name, p in patterns.items():
        cat = p.get("category", "misc")
        if category and cat != category:
            continue
        summary.setdefault(cat, []).append({
            "name": name,
            "description": (p.get("description", "")[:120] + "...") if len(p.get("description", "")) > 120 else p.get("description", ""),
        })
    return json.dumps({"status": "success", "categories": summary, "total": sum(len(v) for v in summary.values())}, ensure_ascii=False)


TOOLS = [apply_remotion_effect, query_effect_catalog]
