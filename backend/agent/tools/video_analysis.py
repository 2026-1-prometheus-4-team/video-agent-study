"""
영상 시각 분석 Tool

OpenCV 로 N초 간격 프레임 추출 -> Gemini Vision 배치 호출 -> 타임스탬프 기반 세그멘테이션 JSON 반환.
텍스트/오디오 분석은 별도 Tool에서 추가 예정.
"""

import hashlib
import json
import logging
import os
import re
from typing import Optional

import cv2
import google.generativeai as genai
from dotenv import load_dotenv
from langchain_core.tools import tool

load_dotenv()

logger = logging.getLogger(__name__)

VIDEOS_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "videos")
SUBTITLES_DIR = os.path.join(VIDEOS_DIR, "subtitles")


def _analysis_api_key() -> Optional[str]:
    """Use the dedicated video-analysis key before the shared key."""
    return os.getenv("GOOGLE_API_KEY_ANALYSIS") or os.getenv("GOOGLE_API_KEY")


def _is_rate_limit_error(exc: Exception) -> bool:
    """Recognize Gemini quota errors across SDK exception variants."""
    message = str(exc).lower()
    return any(token in message for token in (
        "429", "resource_exhausted", "resource exhausted", "rate limit",
        "quota exceeded", "too many requests",
    ))


def _load_transcript(video_path: str) -> list[dict]:
    """영상의 대사(transcript) 세그먼트 로드.

    우선순위:
    1) videos/subtitles/{name}.json (은서 add_auto_subtitle 산출물) 재사용
    2) 없으면 transcribe_video 툴 실행 후 사용
    각 세그먼트: {"start": float(sec), "end": float(sec), "text": str}
    실패 시 빈 리스트 (transcript 없이 비주얼만 분석).
    """
    name = os.path.splitext(os.path.basename(video_path))[0]
    cached = os.path.join(SUBTITLES_DIR, f"{name}.json")

    if os.path.exists(cached):
        try:
            with open(cached, encoding="utf-8") as f:
                data = json.load(f)
            segs = data.get("segments", [])
            logger.info(f"transcript 캐시 재사용 - {cached} ({len(segs)}개)")
            return segs
        except Exception as e:
            logger.warning(f"transcript 캐시 로드 실패, 재추출 시도: {e}")

    try:
        from agent.tools.transcribe import transcribe_video
        # transcribe 는 자체 경로 해석기를 쓰므로 절대경로로 넘겨 오해석 방지
        abs_path = os.path.abspath(os.path.join(VIDEOS_DIR, video_path))
        raw = transcribe_video.invoke({"video_path": abs_path})
        data = json.loads(raw)
        if data.get("status") == "success":
            segs = data.get("segments", [])
            logger.info(f"transcribe_video 완료 - {len(segs)}개 세그먼트")
            # 원본 발화 경계를 보존해 저장.
            # 분석 JSON 의 transcript 는 Gemini 가 프레임 구간에 맞춰 재가공한 것이라
            # 실제 발화 시작/끝과 다르다. 자막 싱크와 cut 경계 스냅에는 이 원본이 필요.
            try:
                os.makedirs(SUBTITLES_DIR, exist_ok=True)
                with open(cached, "w", encoding="utf-8") as f:
                    json.dump({
                        "segments": segs,
                        "language": data.get("language"),
                        "engine": data.get("engine"),
                    }, f, ensure_ascii=False, indent=2)
                logger.info(f"원본 전사 저장: {cached}")
            except OSError:
                logger.warning("전사 저장 실패 (계속 진행)", exc_info=True)
            return segs
        logger.warning(f"transcribe 실패: {data.get('error')}")
    except Exception as e:
        logger.warning(f"transcribe 호출 실패 (비주얼만 분석): {e}")
    return []


def _transcript_for_chunk(transcript: list[dict], start_ms: int, end_ms: int) -> str:
    """청크 시간 구간에 겹치는 대사만 [mm:ss] 형식으로 추려서 반환."""
    lines = []
    for seg in transcript:
        seg_start_ms = int(float(seg.get("start", 0)) * 1000)
        seg_end_ms = int(float(seg.get("end", 0)) * 1000)
        # 구간이 조금이라도 겹치면 포함
        if seg_end_ms < start_ms or seg_start_ms > end_ms:
            continue
        text = str(seg.get("text", "")).strip()
        if not text:
            continue
        s = seg_start_ms // 1000
        lines.append(f"  [{s // 60:02d}:{s % 60:02d}] {text}")
    return "\n".join(lines)


def analysis_stem(video_path: str, videos_dir: str) -> str:
    """분석 JSON 의 stem 을 결정 — videos/ 안이면 <stem>, 밖이면 <stem>_<해시8>.

    videos/ 밖(편집 결과물 outputs/ 등)의 영상이 원본과 basename 이 같으면
    (supervisor 가 output_path="london.mp4" 지정 → outputs/london.mp4 vs
    videos/london.mp4) videos/london_analysis.json 을 조용히 덮어써 원본 분석이
    사라진다. 절대경로 해시를 붙여 분리한다.

    videos/ 기준 상대경로는 기존 이름을 그대로 유지 — graph.py 의 캐시 탐색
    (videos/<stem>_analysis.json) 과 edit.py 자동 탐색이 이 이름을 기대한다.

    Args:
        video_path: 영상 경로 (절대경로 또는 videos/ 기준 상대경로)
        videos_dir: videos 루트 (호출 측 모듈 상수 — 테스트 patch 대응)
    """
    stem = os.path.splitext(os.path.basename(video_path))[0]
    if not os.path.isabs(video_path):
        return stem  # 상대경로 = videos/ 기준 (analyze_video 입력 규칙)

    videos_root = os.path.realpath(videos_dir)
    target = os.path.realpath(video_path)
    if target == videos_root or target.startswith(videos_root + os.sep):
        return stem

    digest = hashlib.sha1(target.encode("utf-8")).hexdigest()[:8]
    return f"{stem}_{digest}"


def _extract_frames(video_path: str, interval_sec: float) -> tuple[float, list[tuple[int, bytes]]]:
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration_sec = total_frames / fps if fps > 0 else 0.0

    frame_step = max(1, int(fps * interval_sec))
    frames = []

    frame_idx = 0
    while frame_idx < total_frames:
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ret, frame = cap.read()
        if not ret:
            break
        timestamp_ms = int((frame_idx / fps) * 1000)

        # 각 프레임에 타임스탬프를 새겨서 전송 -> Gemini 가 이미지 순서를 세다
        # 어긋나는 정렬 오차 방지 (이미지에 적힌 시간을 직접 읽음)
        total_s = timestamp_ms // 1000
        label = f"[{total_s // 60:02d}:{total_s % 60:02d}]"
        cv2.putText(frame, label, (16, 56), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (0, 0, 0), 10)
        cv2.putText(frame, label, (16, 56), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (0, 255, 255), 4)

        _, buffer = cv2.imencode(".jpg", frame)
        frames.append((timestamp_ms, buffer.tobytes()))
        frame_idx += frame_step

    cap.release()
    return duration_sec, frames


def _build_prompt(timestamps_ms: list[int], interval_sec: float, chunk_end_ms: int, transcript_text: str = "") -> str:
    segments_desc = []
    for i, ts in enumerate(timestamps_ms):
        end_ms = timestamps_ms[i + 1] if i + 1 < len(timestamps_ms) else chunk_end_ms
        segments_desc.append(f"  이미지 {i + 1}번째: {ts}ms ~ {end_ms}ms")

    transcript_block = ""
    if transcript_text:
        transcript_block = f"""
**이 구간의 실제 대사(음성 전사, [mm:ss] = 발화 시각):**
{transcript_text}

장면 설명(description)을 작성할 때 화면(이미지)과 위 대사를 *함께* 고려하십시오.
화면만으로 알 수 없는 상황(누가 무엇을 말하는지, 사건의 맥락)은 대사에서 파악하십시오.
"""

    return f"""아래 이미지들은 영상의 {timestamps_ms[0]}ms ~ {chunk_end_ms}ms 구간에서
{interval_sec}초 간격으로 추출한 프레임입니다.

**각 이미지 좌상단에 노란색 [mm:ss] 타임스탬프가 새겨져 있습니다.
장면의 시간을 판단할 때는 반드시 이미지에 새겨진 그 값을 기준으로 하십시오.**

이미지 순서와 타임스탬프 목록:
{chr(10).join(segments_desc)}
{transcript_block}
각 구간을 분석해서 아래 JSON 형식으로만 응답해줘. 다른 텍스트는 포함하지 말 것.
start_ms / end_ms 는 반드시 위에 적힌 타임스탬프 값만 사용할 것 (임의 값 생성 금지).
이미지에 새겨진 [mm:ss] 와 목록의 ms 값이 일치하는지 확인하며 진행할 것.
모든 이미지 구간을 빠짐없이 커버할 것.

{{
  "segments": [
    {{
      "start_ms": <시작 ms>,
      "end_ms": <끝 ms>,
      "description": "<장면 설명 한국어. 화면 + 대사 종합 — 인물 관계 추정 포함 (예: 가족으로 보이는 어른 2명과 아이)>",
      "objects": ["<주요 객체>"],
      "transcript": "<이 구간의 핵심 대사 요약 (없으면 빈 문자열)>",
      "people_count": <화면 속 사람 수, 없으면 0>,
      "people": ["<인물 짧은 묘사: 성별/연령대/관계 추정, 예: 아이, 아버지로 보이는 남성>"],
      "actions": ["<진행 중인 행동, 예: 식사, 걷기, 웃으며 대화>"],
      "scene_change": <true/false>,
      "mood": "<calm|energetic|tense|neutral 중 하나>"
    }}
  ],
  "summary": "<이 구간 한 줄 요약>"
}}"""


def _salvage_segments(json_str: str) -> dict:
    """깨진 JSON 에서 온전한 segment 객체만 건져낸다.

    LLM 이 긴 JSON 을 생성하다 문법을 깨거나 중간에 잘리는 경우가 있다.
    그 청크 전체를 버리면 해당 구간 분석이 통째로 사라지므로,
    파싱 가능한 segment 만이라도 살린다.
    """
    segments = []
    # "segments": [ 안쪽부터 스캔해야 최상위 객체가 아닌 개별 segment 를 잡는다.
    m = re.search(r'"segments"\s*:\s*\[', json_str)
    scan_from = m.end() if m else 0

    # 중괄호 균형을 세어 segment 객체 단위로 잘라낸다 (문자열 안의 중괄호는 무시).
    depth = 0
    start = None
    in_str = False
    escaped = False
    for i, ch in enumerate(json_str[scan_from:], start=scan_from):
        if in_str:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start is not None:
                    try:
                        obj = json.loads(json_str[start:i + 1])
                        if "start_ms" in obj and "end_ms" in obj:
                            segments.append(obj)
                    except json.JSONDecodeError:
                        pass
                    start = None
    return {"segments": segments, "summary": ""}


def _parse_gemini_response(text: str) -> dict:
    match = re.search(r"```(?:json)?\s*([\s\S]+?)\s*```", text)
    json_str = match.group(1) if match else text.strip()
    try:
        return json.loads(json_str)
    except json.JSONDecodeError as e:
        salvaged = _salvage_segments(json_str)
        if salvaged["segments"]:
            logger.warning(
                "JSON 파싱 실패(%s) -> segment %d개 복구", e, len(salvaged["segments"])
            )
            return salvaged
        raise


# 청크당 최대 프레임 수. 이미지가 너무 많으면 Gemini가 이미지-타임스탬프
# 정렬을 잃고 출력도 잘림 (533장 단일 호출에서 실측 확인). 청크 분할로 방지.
CHUNK_FRAMES = int(os.getenv("ANALYZE_CHUNK_FRAMES", "100"))


# 영상 길이별 권장 샘플링 간격 (상한 초, 간격 초).
# 짧은 영상은 촘촘하게, 긴 영상은 성기게 -> 프레임 수를 100~200 장 안팎으로 유지.
# 프레임이 과하면 토큰 비용이 급증하고 Gemini 정렬 정확도도 떨어진다.
_INTERVAL_TABLE = [
    (60, 1.0),      # ~1분    -> 1초  (~60장)
    (300, 3.0),     # 1~5분   -> 3초  (20~100장)
    (900, 5.0),     # 5~15분  -> 5초  (60~180장)
    (float("inf"), 10.0),  # 15분+ -> 10초
]


def _probe_duration_sec(video_path: str) -> float:
    """프레임 추출 전에 영상 길이만 빠르게 조회 (없으면 0.0)."""
    try:
        cap = cv2.VideoCapture(video_path)
        fps = cap.get(cv2.CAP_PROP_FPS)
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        cap.release()
        return total / fps if fps > 0 else 0.0
    except Exception:
        return 0.0


def _auto_interval_sec(duration_sec: float) -> float:
    """영상 길이에 맞는 샘플링 간격 선택."""
    for limit, interval in _INTERVAL_TABLE:
        if duration_sec <= limit:
            return interval
    return _INTERVAL_TABLE[-1][1]


@tool
def analyze_video(
    video_path: str,
    interval_sec: Optional[float] = None,
    use_transcript: bool = True,
) -> str:
    """영상을 일정 간격으로 프레임 샘플링하여 시각적 내용 분석 후 JSON 반환.

    각 구간의 장면 설명, 주요 객체, 분위기, 장면 전환 여부를 포함한다.
    프레임이 많으면 청크(기본 100장)로 나눠 Gemini Vision을 여러 번 호출.
    use_transcript=True 면 음성 전사(대사)를 함께 넣어 화면+대사 종합 분석.

    Args:
        video_path: 영상 파일명 (videos/ 기준 상대경로) 또는 절대경로.
            편집 결과물(outputs/...) 재분석 시 절대경로로 호출 가능.
        interval_sec: 프레임 샘플링 간격(초). 생략하면 영상 길이에 맞춰 자동 선택
            (~1분:1초 / 1~5분:3초 / 5~15분:5초 / 15분+:10초).
            더 촘촘한 분석이 필요할 때만 명시적으로 지정.
        use_transcript: 음성 대사를 분석에 포함할지. 기본 True.
            화면 자막이 충분하거나 빠른 분석이 필요하면 False.
    """
    try:
        if os.path.isabs(video_path):
            input_path = video_path
        else:
            input_path = os.path.join(VIDEOS_DIR, video_path)
        if not os.path.exists(input_path):
            return json.dumps({"error": f"파일을 찾을 수 없음: {input_path}"}, ensure_ascii=False)

        if interval_sec is None:
            probed = _probe_duration_sec(input_path)
            interval_sec = _auto_interval_sec(probed)
            logger.info(
                f"샘플링 간격 자동 선택: {interval_sec}s (영상 {probed:.0f}s)"
            )

        logger.info(f"analyze_video 호출 - {video_path} (interval={interval_sec}s, transcript={use_transcript})")

        duration_sec, frames = _extract_frames(input_path, interval_sec)

        if not frames:
            return json.dumps({"error": "프레임 추출 실패"}, ensure_ascii=False)

        transcript = _load_transcript(video_path) if use_transcript else []

        n_chunks = (len(frames) + CHUNK_FRAMES - 1) // CHUNK_FRAMES
        logger.info(
            f"프레임 추출 완료 - {len(frames)}장, 영상 길이 {duration_sec:.1f}s, "
            f"청크 {n_chunks}개, 대사 {len(transcript)}개"
        )

        api_key = _analysis_api_key()
        if not api_key:
            return json.dumps({
                "error": "GOOGLE_API_KEY_ANALYSIS 또는 GOOGLE_API_KEY 환경변수가 설정되지 않았습니다.",
                "error_code": "missing_api_key",
            }, ensure_ascii=False)

        genai.configure(api_key=api_key)
        model = genai.GenerativeModel("gemini-2.5-flash")

        all_segments: list = []
        chunk_summaries: list[str] = []

        for ci in range(0, len(frames), CHUNK_FRAMES):
            chunk = frames[ci:ci + CHUNK_FRAMES]
            timestamps_ms = [ts for ts, _ in chunk]
            # 청크 끝 = 다음 청크 첫 프레임 시각, 마지막 청크면 영상 끝
            if ci + CHUNK_FRAMES < len(frames):
                chunk_end_ms = frames[ci + CHUNK_FRAMES][0]
            else:
                chunk_end_ms = int(duration_sec * 1000)

            chunk_transcript = _transcript_for_chunk(transcript, timestamps_ms[0], chunk_end_ms)
            prompt = _build_prompt(timestamps_ms, interval_sec, chunk_end_ms, chunk_transcript)
            parts = [{"mime_type": "image/jpeg", "data": img} for _, img in chunk]
            parts.append(prompt)

            chunk_no = ci // CHUNK_FRAMES + 1
            logger.info(
                f"청크 {chunk_no}/{n_chunks} 분석 중 ({timestamps_ms[0]}ms ~ {chunk_end_ms}ms, {len(chunk)}장)"
            )
            # LLM 이 JSON 문법을 깨뜨리는 경우가 있어 재시도 (복구도 실패했을 때 대비)
            for attempt in range(1, 4):
                try:
                    response = model.generate_content(parts)
                    parsed = _parse_gemini_response(response.text)
                    all_segments.extend(parsed.get("segments", []))
                    if parsed.get("summary"):
                        chunk_summaries.append(parsed["summary"])
                    break
                except Exception as e:
                    if _is_rate_limit_error(e):
                        logger.error("chunk %s analysis rate-limited: %s", chunk_no, e)
                        return json.dumps({
                            "error": f"Gemini 영상 분석 요청 한도 초과: {e}",
                            "error_code": "rate_limited",
                            "status_code": 429,
                            "duration": round(duration_sec, 3),
                        }, ensure_ascii=False)
                    if attempt < 3:
                        logger.warning(
                            f"청크 {chunk_no} 분석 실패 ({attempt}/3), 재시도: {e}"
                        )
                    else:
                        logger.warning(f"청크 {chunk_no} 분석 최종 실패, 건너뜀: {e}")

        if not all_segments:
            return json.dumps({"error": "모든 청크 분석 실패"}, ensure_ascii=False)

        all_segments.sort(key=lambda s: s.get("start_ms", 0))
        scene_changes = [s["start_ms"] for s in all_segments if s.get("scene_change")]

        result = {
            "video_path": video_path,
            "duration": round(duration_sec, 3),
            "frame_count": len(frames),
            "interval_sec": interval_sec,
            "segments": all_segments,
            "scene_changes": scene_changes,
            "summary": " / ".join(chunk_summaries),
        }

        # 항상 VIDEOS_DIR 에 저장 — 절대경로(편집 결과물) 재분석도 검색 도구의
        # 자동 탐색에 걸리게. 단 videos/ 밖 입력은 basename 충돌로 원본 분석을
        # 덮어쓰지 않도록 stem 에 경로 해시를 붙인다 (analysis_stem 참고).
        name = analysis_stem(input_path, VIDEOS_DIR)
        output_path = os.path.join(VIDEOS_DIR, f"{name}_analysis.json")
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)

        result["saved_to"] = output_path
        logger.info(f"analyze_video 완료 - segments: {len(result['segments'])}개, 저장: {output_path}")
        return json.dumps(result, ensure_ascii=False)

    except json.JSONDecodeError as e:
        logger.error(f"Gemini 응답 파싱 실패: {e}")
        return json.dumps({"error": f"Gemini 응답 파싱 실패: {e}"}, ensure_ascii=False)
    except Exception as e:
        logger.error(f"analyze_video 오류: {e}")
        return json.dumps({"error": str(e)}, ensure_ascii=False)


TOOLS = [analyze_video]
