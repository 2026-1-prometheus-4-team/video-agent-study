"""
영상 종합 분석 Tool (성민)

영상 입력 -> 4개 병렬 분석 -> 타임스탬프 매칭 -> 통합 JSON 출력
  1) Whisper API: 단어 단위 타임코드 트랜스크립트
  2) Gemini 2.5 Flash: 영상 전체 흐름 (씬 경계, 구조, 타임스탬프)
  3) FFmpeg: 오디오 이벤트 (침묵, 볼륨 변화)
  4) Claude Vision: 씬별 키프레임 상세 분석 (객체, 행동, 제스처, 표정, 공간)

Gemini = 영상 전체를 보는 눈 (흐름, 구조, 타이밍)
Claude = 각 장면을 정밀하게 보는 눈 (디테일, 객체, 행동, 맥락)

편집 에이전트가 사용자의 모호한 명령("지루한 부분 빼줘", "웃긴 부분만 모아줘",
"손짓하는 부분 찾아줘", "강아지 나온 부분만")을
정확한 타임스탬프 편집 명령으로 변환할 수 있도록 최대한 풍부한 메타데이터를 생성.
기존 transcribe.py와 독립 -- 팀원 코드 충돌 방지용 별도 파일.
"""

import base64
import json
import logging
import os
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from dotenv import load_dotenv
from langchain_core.tools import tool

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


# ===========================================================================
# 1) Whisper API -- 단어 단위 타임코드
# ===========================================================================

def _extract_audio(video_path: str) -> str:
    """영상에서 오디오 추출 (Whisper 최적: 16kHz mono).

    일부 영상은 오디오 트랙에 깨진 패킷이 있을 수 있어서
    -err_detect ignore_err로 에러를 건너뛰고 추출한다.
    """
    out_path = os.path.join(tempfile.gettempdir(), f"analyze_audio_{os.getpid()}.m4a")
    result = subprocess.run(
        [
            "ffmpeg", "-y",
            "-err_detect", "ignore_err",
            "-i", video_path,
            "-vn",
            "-acodec", "aac",
            "-ab", "64k",
            "-ar", "16000",
            "-ac", "1",
            out_path,
        ],
        capture_output=True,
        text=True,
    )
    # 출력 파일이 생겼으면 성공으로 간주 (일부 프레임 에러는 무시)
    if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
        return out_path
    raise RuntimeError(f"오디오 추출 실패: {result.stderr[-500:]}")


def _whisper_word_timestamps(audio_path: str) -> dict:
    """OpenAI Whisper API로 단어 단위 타임코드 추출.

    Returns:
        {
            "language": "ko",
            "text": "전체 텍스트",
            "words": [{"word": "오늘은", "start": 12.30, "end": 12.84}, ...],
            "segments": [{"start": 12.0, "end": 18.5, "text": "..."}, ...]
        }
    """
    from openai import OpenAI

    client = OpenAI()

    with open(audio_path, "rb") as f:
        response = client.audio.transcriptions.create(
            file=f,
            model="whisper-1",
            response_format="verbose_json",
            timestamp_granularities=["word", "segment"],
        )

    words = []
    for w in getattr(response, "words", []):
        words.append({
            "word": w.word,
            "start": round(w.start, 3),
            "end": round(w.end, 3),
        })

    segments = []
    for seg in getattr(response, "segments", []):
        segments.append({
            "start": round(seg.start if hasattr(seg, "start") else seg["start"], 3),
            "end": round(seg.end if hasattr(seg, "end") else seg["end"], 3),
            "text": (seg.text if hasattr(seg, "text") else seg["text"]).strip(),
        })

    return {
        "language": getattr(response, "language", "unknown"),
        "text": getattr(response, "text", ""),
        "words": words,
        "segments": segments,
    }


# ===========================================================================
# 2) Gemini 2.5 Flash -- 시각 분석 (핵심)
# ===========================================================================

_GEMINI_VISUAL_PROMPT = """\
너는 영상 편집 AI의 눈이다. 이 영상을 보고 아래 JSON 형식으로 분석 결과를 출력해.
편집 에이전트가 이 데이터만 보고 "어디를 자르고, 어디를 살리고, 어디에 효과를 넣을지"
판단할 수 있어야 한다. 대충 하면 편집이 망가진다. 정밀하게 분석해.

반드시 아래 JSON 구조만 출력해. 설명 텍스트 없이 JSON만.

{
  "scenes": [
    {
      "id": 1,
      "start": 0.0,
      "end": 15.2,
      "summary": "한국어로 씬 내용 요약 (1-2문장, 구체적으로)",
      "content_type": "talking_head | b_roll | screen_recording | title_card | transition | interview | montage | tutorial | reaction | other",
      "visual_tags": ["person_talking", "indoor", "desk", "laptop", "whiteboard"],
      "objects": ["노트북", "커피잔", "마이크", "화이트보드", "마커"],
      "people": [
        {
          "label": "P1",
          "description": "안경 쓴 남성, 검은 후드",
          "face_visible": true,
          "speaking": true,
          "emotion": "enthusiastic",
          "body_language": "손으로 화면을 가리키며 설명"
        }
      ],
      "actions": [
        {
          "time": 3.5,
          "who": "P1",
          "action": "카메라를 보며 인사",
          "gesture": "손 흔들기"
        }
      ],
      "shot_type": "wide | medium | close_up | extreme_close_up | over_shoulder | top_down | pov",
      "camera_movement": "static | pan_left | pan_right | tilt_up | tilt_down | zoom_in | zoom_out | tracking | handheld | dolly",
      "lighting": "bright | dim | natural | artificial | backlit | mixed",
      "location": "실내 사무실 | 야외 거리 | 카페 | 차 안 | 등등 구체적으로",
      "on_screen_text": ["텍스트가 화면에 보이면 여기 적기"],
      "dominant_colors": ["#1a1a1a", "#ffffff"],
      "energy": 0.6,
      "pacing": "slow | normal | fast",
      "edit_notes": "이 씬에서 편집 시 참고할 점 (예: '말 더듬는 구간 있음', '배경 소음 큼', '핵심 내용이라 살려야 함', '반복 내용이라 잘라도 됨')"
    }
  ],
  "people_index": [
    {
      "label": "P1",
      "description": "안경 쓴 남성, 검은 후드, 메인 화자",
      "first_appearance": 0.0,
      "total_screen_time_estimate": "4분 30초"
    }
  ],
  "key_moments": [
    {
      "time": 23.5,
      "duration": 3.0,
      "type": "highlight | funny | dramatic | emotional | awkward | mistake | reaction | climax | intro | outro | cta",
      "description": "화자가 웃으며 핵심 포인트 강조",
      "edit_suggestion": "하이라이트 클립으로 뽑기 좋음"
    }
  ],
  "visual_flow": {
    "overall_structure": "영상 전체 구조 요약 (예: '인트로-본론3파트-아웃트로', '브이로그 형식 시간순')",
    "transitions": [
      {
        "time": 45.2,
        "from_scene": 1,
        "to_scene": 2,
        "type": "hard_cut | dissolve | fade_black | fade_white | swipe | zoom | jump_cut | match_cut | j_cut | l_cut",
        "smoothness": "smooth | abrupt | intentional_jump"
      }
    ],
    "repetitive_sections": [
      {
        "description": "같은 내용 반복 설명",
        "occurrences": [{"start": 30.0, "end": 45.0}, {"start": 120.0, "end": 135.0}],
        "recommendation": "하나만 남기고 나머지 제거 가능"
      }
    ]
  },
  "background_elements": {
    "music_segments": [
      {"start": 0.0, "end": 8.0, "type": "intro_bgm | background | outro_bgm | transition_sound", "mood": "upbeat"}
    ],
    "ambient_noise": [
      {"start": 30.0, "end": 60.0, "type": "traffic | crowd | wind | typing | silence", "intensity": "low | medium | high"}
    ]
  },
  "boring_candidates": [
    {
      "start": 55.0,
      "end": 72.0,
      "reason": "왜 지루한지 구체적으로 (예: '말이 느리고 반복', '화면 변화 없이 정적', '주제 벗어난 잡담')",
      "confidence": 0.8,
      "suggestion": "cut | speed_up | add_broll | add_text_overlay"
    }
  ],
  "highlight_candidates": [
    {
      "start": 88.0,
      "end": 95.0,
      "reason": "왜 하이라이트인지 (예: '핵심 인사이트 전달', '감정적 반응', '웃긴 순간')",
      "confidence": 0.9,
      "type": "key_point | funny | emotional | dramatic | surprising"
    }
  ]
}

=== 분석 규칙 ===

[씬 분리 기준]
- 카메라 앵글이 바뀔 때
- 장소가 바뀔 때
- 화면 구성이 크게 달라질 때 (예: 토킹헤드 -> 화면녹화)
- 주제/토픽이 전환될 때
- 너무 길게 하나의 씬으로 묶지 마. 30초 이상이면 나눌 수 있는지 다시 봐.
- 너무 잘게 쪼개지도 마. 같은 앵글+같은 주제면 하나로 묶어.

[사람 식별]
- 등장인물마다 P1, P2, P3... 라벨 부여
- 외모 특징(안경, 머리색, 옷 등)으로 구분
- 같은 사람이 다른 씬에 나오면 같은 라벨 유지
- people_index에 전체 등장인물 정리

[objects -- 구체적 객체 목록]
- 화면에 보이는 모든 식별 가능한 물체를 한국어로 나열
- "노트북", "강아지", "커피잔", "해골 인형", "간판" 처럼 구체적으로
- 사용자가 "~나온 부분" 검색할 때 매칭되는 키워드 역할
- 배경 가구 같은 건 생략, 주목할 만한 것만

[actions -- 행동 타임라인]
- 씬 안에서 일어나는 주요 행동/제스처를 개별 타임스탬프로 기록
- "P1이 물건을 집어 든다", "상인이 손짓으로 부른다", "P2가 고개를 끄덕인다"
- gesture 필드: 손짓, 고개 끄덕임, 손 흔들기, 가리키기, 어깨 으쓱 등
- 사용자가 "손짓한 부분", "끄덕이는 부분" 검색할 때 사용

[location -- 장소]
- 촬영 장소를 구체적으로: "멕시코시티 소노라 시장 내부", "차량 뒷좌석", "거리"
- 장소가 바뀌면 반드시 씬을 나눠야 함

[에너지/페이싱]
- energy: 0.0(완전 정적, 침묵) ~ 1.0(격앙, 빠른 움직임, 큰 소리)
- 말하는 속도, 제스처 크기, 화면 변화량, 음성 볼륨 종합 판단
- pacing: 편집 리듬 판단용. slow=늘어짐, fast=정신없음

[지루한 구간 후보 boring_candidates]
편집에서 잘라도 되는 구간. 다음 신호 중 2개 이상 해당하면 후보:
- 같은 말 반복
- 화면 변화 없이 10초 이상 정적
- 말 사이 긴 침묵 (3초+)
- "어... 음..." 같은 필러 연속
- 주제 벗어난 잡담
- 에너지가 갑자기 떨어지는 구간
- confidence: 0.0~1.0 (얼마나 확실히 지루한지)

[하이라이트 후보 highlight_candidates]
꼭 살려야 하는 구간:
- 핵심 메시지/인사이트 전달
- 감정 피크 (웃음, 놀람, 감동)
- 시각적으로 인상적인 장면
- 유튜브 쇼츠/릴스 클립으로 뽑기 좋은 구간
- "여기서 자르면 안 됨" 싶은 곳

[edit_notes]
각 씬마다 편집자에게 남기는 메모:
- "이 구간 배경 소음 심해서 노이즈 제거 필요"
- "말 더듬는 부분 있어서 점프컷 가능"
- "B-roll 삽입하면 좋을 구간"
- "자막 강조 넣으면 효과적"
- "속도 1.5배 가능한 구간"
이런 식으로 실용적인 편집 힌트.

[타임스탬프]
- 초 단위, 소수점 1자리 (예: 12.3)
- 정확하게. 대충 어림짐작 하지 마.

[중요]
- 빠뜨리는 구간 없이 영상 전체를 커버해야 한다. scenes의 시작~끝이 영상 전체를 빈틈없이 덮어야 함.
- 한국어로 작성 (visual_tags, content_type 등 enum 값은 영어, 설명은 한국어)
- JSON만 출력. 다른 텍스트 절대 넣지 마.
"""


def _gemini_visual_analysis(video_path: str) -> dict:
    """Gemini 2.5 Flash로 영상 시각 분석.

    영상 파일을 통째로 업로드 -> 씬/객체/행동/감정/카메라 등 풍부한 태깅 JSON 반환.
    """
    from google import genai
    from google.genai import types

    api_key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
    if not api_key:
        return {"error": "GOOGLE_API_KEY 또는 GEMINI_API_KEY 환경변수 필요"}

    client = genai.Client(api_key=api_key)

    # 파일 업로드
    logger.info("Gemini Files API로 영상 업로드 중...")
    uploaded = client.files.upload(file=video_path)
    logger.info(f"업로드 완료: {uploaded.name}, state={uploaded.state}")

    # 처리 대기 (영상은 서버에서 인코딩 필요)
    wait_count = 0
    while uploaded.state and uploaded.state.name != "ACTIVE":
        if wait_count > 60:
            return {"error": "Gemini 파일 처리 타임아웃 (5분 초과)"}
        time.sleep(5)
        uploaded = client.files.get(name=uploaded.name)
        wait_count += 1
        logger.info(f"Gemini 파일 처리 대기중... state={uploaded.state}")

    # 분석 요청 (structured JSON output)
    logger.info("Gemini 시각 분석 요청 중...")
    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=[uploaded, _GEMINI_VISUAL_PROMPT],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
        ),
    )

    # 업로드된 파일 정리
    try:
        client.files.delete(name=uploaded.name)
    except Exception:
        pass

    # JSON 파싱
    try:
        result = json.loads(response.text)
        logger.info(f"Gemini 응답 키: {list(result.keys()) if isinstance(result, dict) else 'not dict'}")
        return result
    except json.JSONDecodeError as e:
        logger.error(f"Gemini JSON 파싱 실패: {e}")
        logger.error(f"Gemini 응답 원문 (처음 1000자): {response.text[:1000]}")
        return {"raw_response": response.text[:3000], "error": f"JSON 파싱 실패: {e}"}


# ===========================================================================
# 3) Claude Vision -- 씬별 키프레임 상세 분석
# ===========================================================================

_CLAUDE_FRAME_PROMPT = """\
너는 영상 편집 AI의 정밀 분석기다. 아래 이미지들은 영상의 각 씬에서 추출한 키프레임이다.
각 프레임 번호 옆에 해당 씬의 타임스탬프를 알려줄 테니, 프레임마다 상세 분석을 JSON으로 출력해.

프레임별로 반드시 아래 항목을 빠짐없이 채워:

반드시 JSON 배열만 출력해. 다른 텍스트 없이.

[
  {
    "frame_index": 0,
    "scene_id": 1,
    "description": "이 프레임에서 보이는 것을 3-5문장으로 상세히 묘사. 어떤 상황인지, 누가 뭘 하고 있는지, 어떤 분위기인지 구체적으로.",
    "objects_detailed": [
      {"name": "해골 인형", "position": "화면 중앙", "size": "medium", "notable": "채색된 멕시코 전통 장식"},
      {"name": "양초", "position": "왼쪽 하단", "size": "small", "notable": "빨간색, 불이 켜져 있음"}
    ],
    "people_detailed": [
      {
        "label": "P1",
        "appearance": "빨간/검은색 체크 셔츠, 짧은 머리 남성, 20대 후반~30대 초반",
        "face_expression": "놀란 표정, 눈을 크게 뜨고 있음",
        "body_posture": "상체를 살짝 뒤로 젖힘",
        "gesture": "왼손으로 물건을 가리키고 있음",
        "gaze_direction": "카메라 왼쪽의 물건을 보고 있음",
        "speaking": true
      }
    ],
    "environment": {
      "location_type": "실내 시장 통로",
      "location_detail": "좁은 통로 양쪽에 상품이 진열된 시장, 천장에 전구 조명",
      "time_of_day": "낮 (인공 조명)",
      "weather": "실내라 해당 없음",
      "crowd_level": "주변에 2-3명의 다른 사람 보임"
    },
    "text_in_frame": [
      {"text": "곽튜브", "type": "자막/워터마크", "position": "좌측 상단"},
      {"text": "$50 MXN", "type": "가격표", "position": "상품 옆"}
    ],
    "mood": "흥미롭고 약간 긴장감 있는 분위기",
    "visual_quality": "선명, 조명 적절, 약간의 노이즈",
    "edit_relevance": "시각적으로 흥미로운 소품이 많아 B-roll 컷으로 활용 가능"
  }
]

=== 분석 규칙 ===
- objects_detailed: 화면에 보이는 물체를 구체적으로. "어떤 물건이 어디에 어떤 상태로" 수준.
  사용자가 "그 빨간 물건 나오는 부분", "해골 있는 부분"으로 검색할 수 있어야 한다.
- people_detailed: 사람마다 외모/표정/자세/제스처/시선 방향까지. "손짓하는 부분",
  "웃는 부분", "놀라는 부분" 검색용.
- gesture: 빈 문자열 대신 "특별한 제스처 없음"이라고 적어. null 금지.
- environment: 촬영 환경을 최대한 구체적으로. 장소 유형 + 세부 묘사.
- text_in_frame: 자막, 간판, 가격표, 워터마크 등 보이는 텍스트 전부.
- description: 이 한 프레임이 어떤 맥락의 장면인지 스토리텔링하듯 묘사.
  "남성이 시장 통로에서 주술용품 가게 앞에 서서 해골 인형을 가리키고 있다.
  주변에 양초와 약초 묶음이 진열돼 있고, 가게 주인이 뒤에서 지켜보고 있다."
- edit_relevance: 편집할 때 이 프레임이 어떻게 쓸 수 있는지 한 줄.
- JSON 배열만 출력. 다른 텍스트 절대 넣지 마.
"""


def _extract_keyframes(video_path: str, timestamps: list[float], out_dir: str) -> list[str]:
    """특정 타임스탬프들에서 키프레임 이미지 추출.

    Args:
        timestamps: 추출할 시점 리스트 (초 단위)
        out_dir: 이미지 저장 디렉토리

    Returns:
        추출된 이미지 파일 경로 리스트
    """
    paths = []
    for i, ts in enumerate(timestamps):
        out_path = os.path.join(out_dir, f"frame_{i:04d}_{ts:.1f}s.jpg")
        cmd = [
            "ffmpeg", "-y",
            "-ss", str(ts),
            "-i", video_path,
            "-frames:v", "1",
            "-q:v", "2",
            "-vf", "scale=1280:-2",
            out_path,
        ]
        subprocess.run(cmd, capture_output=True)
        if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
            paths.append(out_path)
    return paths


def _claude_vision_analysis(frame_paths: list[str], scenes: list[dict]) -> list[dict]:
    """Claude Vision API로 키프레임 상세 분석.

    Gemini가 잡은 씬 경계의 키프레임 이미지를 Claude에 보내서
    객체/행동/제스처/표정/환경 등 정밀 분석.
    비용 절약을 위해 최대 20장씩 배치로 처리.
    """
    import anthropic

    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        logger.warning("ANTHROPIC_API_KEY 없음 -- Claude Vision 분석 건너뜀")
        return []

    client = anthropic.Anthropic(api_key=api_key)

    all_results = []
    batch_size = 5  # 배치당 5장 -- 응답 잘림 방지 (장당 ~800토큰 출력 필요)

    for batch_start in range(0, len(frame_paths), batch_size):
        batch_paths = frame_paths[batch_start:batch_start + batch_size]
        batch_scenes = scenes[batch_start:batch_start + batch_size]

        # 이미지 + 타임스탬프 정보 구성
        content = []
        timestamp_info = []

        for i, (fpath, scene) in enumerate(zip(batch_paths, batch_scenes)):
            idx = batch_start + i
            with open(fpath, "rb") as f:
                img_data = base64.standard_b64encode(f.read()).decode()

            # Gemini 분석 컨텍스트를 같이 전달
            # Claude가 씬의 맥락을 이해하고 Gemini와 동기화된 분석을 하게
            people_desc = [p.get("description", "") for p in scene.get("people", [])]
            gemini_ctx = (
                f"--- Frame {idx} (Scene {scene.get('id', idx+1)}, "
                f"{scene.get('start', 0):.1f}s ~ {scene.get('end', 0):.1f}s) ---\n"
                f"[Gemini 분석] {scene.get('summary', 'N/A')} | "
                f"type: {scene.get('content_type', 'N/A')} | "
                f"tags: {scene.get('visual_tags', [])} | "
                f"objects: {scene.get('objects', [])} | "
                f"people: {json.dumps(people_desc, ensure_ascii=False)} | "
                f"energy: {scene.get('energy', 'N/A')} | "
                f"notes: {scene.get('edit_notes', 'N/A')}"
            )
            content.append({
                "type": "text",
                "text": gemini_ctx,
            })
            content.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/jpeg",
                    "data": img_data,
                }
            })

        content.append({
            "type": "text",
            "text": _CLAUDE_FRAME_PROMPT,
        })

        logger.info(f"Claude Vision 분석 요청 중... (프레임 {batch_start}~{batch_start + len(batch_paths) - 1})")

        try:
            response = client.messages.create(
                model="claude-sonnet-4-6",
                max_tokens=16384,
                messages=[{"role": "user", "content": content}],
            )

            response_text = response.content[0].text

            # JSON 파싱 (```json ... ``` 감싸기 대응)
            cleaned = response_text.strip()
            if cleaned.startswith("```"):
                cleaned = cleaned.split("\n", 1)[1]
                if cleaned.endswith("```"):
                    cleaned = cleaned[:-3]

            batch_result = json.loads(cleaned)
            all_results.extend(batch_result)

        except json.JSONDecodeError as e:
            logger.error(f"Claude Vision JSON 파싱 실패: {e}")
            logger.error(f"응답 원문: {response_text[:500]}")
        except Exception as e:
            logger.error(f"Claude Vision API 오류: {e}")

    return all_results


def _merge_claude_into_scenes(scenes: list[dict], claude_frames: list[dict]) -> list[dict]:
    """Claude Vision 분석 결과를 Gemini scenes에 합침.

    각 scene에 claude_detail 필드를 추가해서
    Gemini의 거시적 분석 + Claude의 미시적 분석을 하나로 통합.
    """
    frame_by_scene = {}
    for frame in claude_frames:
        sid = frame.get("scene_id")
        if sid is not None:
            frame_by_scene[sid] = frame

    for scene in scenes:
        sid = scene.get("id")
        if sid in frame_by_scene:
            detail = frame_by_scene[sid]
            scene["claude_detail"] = {
                "description": detail.get("description", ""),
                "objects_detailed": detail.get("objects_detailed", []),
                "people_detailed": detail.get("people_detailed", []),
                "environment": detail.get("environment", {}),
                "text_in_frame": detail.get("text_in_frame", []),
                "mood": detail.get("mood", ""),
                "visual_quality": detail.get("visual_quality", ""),
                "edit_relevance": detail.get("edit_relevance", ""),
            }

    return scenes


# ===========================================================================
# 4) FFmpeg -- 오디오 이벤트 감지
# ===========================================================================

def _detect_silences(video_path: str, noise_db: float = -30, min_duration: float = 1.5) -> list[dict]:
    """FFmpeg silencedetect로 침묵 구간 감지.

    Args:
        noise_db: 침묵 판정 기준 데시벨 (기본 -30dB)
        min_duration: 최소 침묵 길이 초 (기본 1.5초)

    Returns:
        [{"start": 10.2, "end": 12.8, "duration": 2.6}, ...]
    """
    cmd = [
        "ffmpeg", "-i", video_path,
        "-af", f"silencedetect=n={noise_db}dB:d={min_duration}",
        "-f", "null", "-",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="ignore")
    stderr = result.stderr

    silences = []
    current_start = None
    for line in stderr.split("\n"):
        if "silence_start:" in line:
            try:
                current_start = float(line.split("silence_start:")[1].strip().split()[0])
            except (ValueError, IndexError):
                current_start = None
        elif "silence_end:" in line and current_start is not None:
            try:
                parts = line.split("silence_end:")[1].strip().split()
                end = float(parts[0])
                duration = float(parts[-1]) if "silence_duration:" in line else end - current_start
                silences.append({
                    "start": round(current_start, 3),
                    "end": round(end, 3),
                    "duration": round(duration, 3),
                })
            except (ValueError, IndexError):
                pass
            current_start = None

    return silences


def _detect_volume_profile(video_path: str, interval: float = 2.0) -> list[dict]:
    """FFmpeg로 구간별 볼륨 프로필 추출.

    영상을 interval초 단위로 나눠서 각 구간의 평균/피크 볼륨을 측정.
    에이전트가 "조용한 부분", "시끄러운 부분" 찾을 때 사용.

    Returns:
        [{"start": 0.0, "end": 2.0, "mean_db": -25.3, "peak_db": -12.1}, ...]
    """
    # ffprobe로 영상 길이 얻기
    duration = _get_video_duration(video_path)
    if duration <= 0:
        return []

    profile = []
    t = 0.0
    while t < duration:
        seg_end = min(t + interval, duration)
        cmd = [
            "ffmpeg",
            "-ss", str(t),
            "-t", str(seg_end - t),
            "-i", video_path,
            "-af", "volumedetect",
            "-f", "null", "-",
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="ignore")
        stderr = result.stderr

        mean_db = None
        peak_db = None
        for line in stderr.split("\n"):
            if "mean_volume:" in line:
                try:
                    mean_db = float(line.split("mean_volume:")[1].strip().split()[0])
                except (ValueError, IndexError):
                    pass
            elif "max_volume:" in line:
                try:
                    peak_db = float(line.split("max_volume:")[1].strip().split()[0])
                except (ValueError, IndexError):
                    pass

        if mean_db is not None:
            profile.append({
                "start": round(t, 1),
                "end": round(seg_end, 1),
                "mean_db": round(mean_db, 1),
                "peak_db": round(peak_db, 1) if peak_db is not None else None,
            })
        t = seg_end

    return profile


def _get_video_duration(video_path: str) -> float:
    """ffprobe로 영상 길이(초) 반환."""
    cmd = [
        "ffprobe",
        "-v", "quiet",
        "-show_entries", "format=duration",
        "-of", "csv=p=0",
        video_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    try:
        return round(float(result.stdout.strip()), 3)
    except ValueError:
        return 0.0


def _get_video_metadata(video_path: str) -> dict:
    """ffprobe로 영상 기본 메타데이터 추출."""
    cmd = [
        "ffprobe",
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        video_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    try:
        probe = json.loads(result.stdout)
    except json.JSONDecodeError:
        return {}

    meta = {
        "duration": 0.0,
        "resolution": "",
        "fps": 0.0,
        "codec": "",
        "audio_codec": "",
        "file_size_mb": 0.0,
    }

    fmt = probe.get("format", {})
    meta["duration"] = round(float(fmt.get("duration", 0)), 3)
    meta["file_size_mb"] = round(int(fmt.get("size", 0)) / (1024 * 1024), 1)

    for stream in probe.get("streams", []):
        if stream.get("codec_type") == "video":
            meta["resolution"] = f"{stream.get('width', 0)}x{stream.get('height', 0)}"
            meta["codec"] = stream.get("codec_name", "")
            # fps 계산
            r_frame_rate = stream.get("r_frame_rate", "0/1")
            try:
                num, den = r_frame_rate.split("/")
                meta["fps"] = round(int(num) / int(den), 2)
            except (ValueError, ZeroDivisionError):
                pass
        elif stream.get("codec_type") == "audio":
            meta["audio_codec"] = stream.get("codec_name", "")

    return meta


# ===========================================================================
# 4) 필러 감지 + 말하기 속도 분석 (Whisper 결과 후처리)
# ===========================================================================

_FILLER_WORDS = {"어", "음", "아", "그", "뭐", "이제", "약간", "진짜", "좀", "그래서", "근데"}


def _detect_fillers(words: list[dict]) -> list[dict]:
    """Whisper 단어 리스트에서 필러(어, 음 등) 추출."""
    fillers = []
    for w in words:
        cleaned = w["word"].strip()
        if cleaned in _FILLER_WORDS:
            fillers.append({
                "word": cleaned,
                "start": w["start"],
                "end": w["end"],
            })
    return fillers


def _compute_speech_pace(words: list[dict], window_sec: float = 10.0) -> list[dict]:
    """단어 타임코드로부터 구간별 말하기 속도(WPM) 계산.

    에이전트가 "빠르게 말하는 구간", "느린 구간" 판별할 때 사용.
    한국어 평균 말하기 속도: ~200 음절/분 (약 100-120 단어/분)

    Returns:
        [{"start": 0.0, "end": 10.0, "wpm": 135.2, "pace": "normal"}, ...]
    """
    if not words:
        return []

    total_end = words[-1]["end"]
    pace_data = []
    t = 0.0

    while t < total_end:
        window_end = t + window_sec
        words_in_window = [w for w in words if w["start"] >= t and w["end"] <= window_end]
        count = len(words_in_window)
        actual_duration = min(window_end, total_end) - t

        if actual_duration > 0 and count > 0:
            wpm = round((count / actual_duration) * 60, 1)
            if wpm < 80:
                pace = "very_slow"
            elif wpm < 110:
                pace = "slow"
            elif wpm < 150:
                pace = "normal"
            elif wpm < 200:
                pace = "fast"
            else:
                pace = "very_fast"

            pace_data.append({
                "start": round(t, 1),
                "end": round(min(window_end, total_end), 1),
                "word_count": count,
                "wpm": wpm,
                "pace": pace,
            })
        t = window_end

    return pace_data


# ===========================================================================
# 5) Whisper segments + Gemini scenes 타임스탬프 매칭
# ===========================================================================

def _enrich_segments_with_scenes(segments: list[dict], scenes: list[dict]) -> list[dict]:
    """Whisper의 문장 segments에 Gemini의 시각 정보를 매칭.

    각 segment가 어느 scene에 속하는지, 그 scene의 시각 태그/에너지 등을 붙여준다.
    에이전트가 하나의 segment만 봐도 "뭘 말했고 + 뭐가 보였고 + 어떤 분위기였는지"
    전부 알 수 있게 하는 것이 목표.
    """
    enriched = []
    for seg in segments:
        seg_mid = (seg["start"] + seg["end"]) / 2

        # 이 segment의 중간 시점이 어느 scene에 속하는지 찾기
        matched_scene = None
        for scene in scenes:
            if scene.get("start", 0) <= seg_mid <= scene.get("end", 0):
                matched_scene = scene
                break

        entry = {
            **seg,
            "scene_id": matched_scene.get("id") if matched_scene else None,
            "content_type": matched_scene.get("content_type") if matched_scene else None,
            "visual_tags": matched_scene.get("visual_tags", []) if matched_scene else [],
            "energy": matched_scene.get("energy") if matched_scene else None,
            "pacing": matched_scene.get("pacing") if matched_scene else None,
        }
        enriched.append(entry)

    return enriched


# ===========================================================================
# 6) 통합 분석 함수
# ===========================================================================

def _run_analysis(video_path: str) -> dict:
    """3개 분석을 병렬 실행하고 타임스탬프 기준으로 매칭/통합."""

    # 먼저 오디오 추출 + 메타데이터 (Whisper용, 빠름)
    logger.info("오디오 추출 + 메타데이터 수집 중...")
    audio_path = _extract_audio(video_path)
    metadata = _get_video_metadata(video_path)

    # 3개 핵심 분석 병렬 실행
    results = {}
    errors = []

    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {
            executor.submit(_whisper_word_timestamps, audio_path): "whisper",
            executor.submit(_gemini_visual_analysis, video_path): "gemini",
            executor.submit(_detect_silences, video_path): "silences",
        }
        for future in as_completed(futures):
            name = futures[future]
            try:
                results[name] = future.result()
                logger.info(f"[OK] {name} 분석 완료")
            except Exception as e:
                logger.error(f"[FAIL] {name} 분석 실패: {e}")
                errors.append({"pipeline": name, "error": str(e)})
                results[name] = None

    # 임시 오디오 삭제
    try:
        os.remove(audio_path)
    except OSError:
        pass

    # --- 개별 결과 꺼내기 ---
    whisper = results.get("whisper") or {}
    gemini = results.get("gemini") or {}
    silences = results.get("silences") or []

    words = whisper.get("words", [])
    segments = whisper.get("segments", [])
    scenes = gemini.get("scenes", [])

    # --- Claude Vision: Gemini 결과 기반 키프레임 상세 분석 ---
    # Gemini가 씬 경계를 잡은 뒤, 각 씬의 중간 시점에서 프레임 추출 -> Claude에 전달
    claude_frames = []
    if scenes and os.getenv("ANTHROPIC_API_KEY"):
        frame_dir = os.path.join(tempfile.gettempdir(), f"analyze_frames_{os.getpid()}")
        os.makedirs(frame_dir, exist_ok=True)

        # 각 씬의 중간 시점에서 키프레임 추출
        mid_timestamps = [(s.get("start", 0) + s.get("end", 0)) / 2 for s in scenes]
        logger.info(f"키프레임 {len(mid_timestamps)}장 추출 중...")
        frame_paths = _extract_keyframes(video_path, mid_timestamps, frame_dir)

        if frame_paths:
            logger.info(f"Claude Vision 분석 시작 ({len(frame_paths)}장)...")
            claude_frames = _claude_vision_analysis(frame_paths, scenes)
            scenes = _merge_claude_into_scenes(scenes, claude_frames)

        # 임시 프레임 정리
        import shutil
        try:
            shutil.rmtree(frame_dir)
        except OSError:
            pass
    elif not os.getenv("ANTHROPIC_API_KEY"):
        logger.info("ANTHROPIC_API_KEY 없음 -- Claude Vision 분석 건너뜀 (Gemini 분석만 사용)")

    # --- 후처리: 파생 데이터 생성 ---
    fillers = _detect_fillers(words)
    speech_pace = _compute_speech_pace(words)
    enriched_segments = _enrich_segments_with_scenes(segments, scenes)

    # 볼륨 프로필 (영상 길이에 따라 interval 조정)
    duration = metadata.get("duration", 0)
    vol_interval = 5.0 if duration > 120 else 2.0
    volume_profile = _detect_volume_profile(video_path, interval=vol_interval)

    # --- 통합 JSON 구성 ---
    analysis = {
        # 기본 정보
        "file_path": video_path,
        "metadata": metadata,
        "language": whisper.get("language", "unknown"),

        # 트랜스크립트 (시각 정보 매칭된 버전)
        "segments": enriched_segments,
        "words": words,
        "full_text": whisper.get("text", ""),

        # 시각 분석 (Gemini)
        "scenes": scenes,
        "people_index": gemini.get("people_index", []),
        "visual_flow": gemini.get("visual_flow", {}),
        "background_elements": gemini.get("background_elements", {}),

        # 편집 판단용 핵심 데이터
        "key_moments": gemini.get("key_moments", []),
        "boring_candidates": gemini.get("boring_candidates", []),
        "highlight_candidates": gemini.get("highlight_candidates", []),

        # 오디오 이벤트
        "events": {
            "fillers": fillers,
            "silences": silences,
        },

        # 페이싱/리듬 분석
        "speech_pace": speech_pace,
        "volume_profile": volume_profile,
    }

    if errors:
        analysis["errors"] = errors

    return analysis


# ===========================================================================
# LangGraph Tool
# ===========================================================================

@tool
def analyze_video(file_path: str) -> str:
    """영상을 종합 분석하여 편집에 필요한 모든 메타데이터를 추출.

    3개 파이프라인을 병렬 실행:
    - Whisper API: 단어 단위 타임코드 + 문장 분리
    - Gemini 2.5 Flash: 씬/객체/행동/감정/카메라/편집힌트
    - FFmpeg: 침묵 감지 + 볼륨 프로필

    결과를 타임스탬프 기준으로 매칭하여 통합 JSON 반환.
    편집 에이전트는 이 결과만으로 사용자의 모호한 명령을 정확한 편집 작업으로 변환 가능.

    Args:
        file_path: 영상 파일 경로 (절대경로 또는 videos/ 폴더 기준 상대경로)
    """
    logger.info(f"analyze_video 호출 - {file_path}")

    # videos/ 폴더 기준 상대경로 처리
    if not os.path.isabs(file_path):
        videos_dir = os.path.join(os.path.dirname(__file__), "..", "..", "videos")
        file_path = os.path.join(videos_dir, file_path)

    if not os.path.exists(file_path):
        return json.dumps({"error": f"파일을 찾을 수 없음: {file_path}"}, ensure_ascii=False)

    try:
        result = _run_analysis(file_path)
        return json.dumps(result, ensure_ascii=False, indent=2)
    except Exception as e:
        logger.error(f"analyze_video 오류: {e}")
        return json.dumps({"error": str(e)}, ensure_ascii=False)


TOOLS = [analyze_video]


# ===========================================================================
# 단독 실행 테스트
# ===========================================================================

if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("사용법: python -m agent.tools.analyze <영상파일경로>")
        sys.exit(1)

    video_file = sys.argv[1]
    print(f"=== 영상 종합 분석 시작: {video_file} ===\n")

    result = analyze_video.invoke({"file_path": video_file})
    parsed = json.loads(result)

    # 요약 출력
    print(f"영상 길이: {parsed.get('metadata', {}).get('duration', 0)}초")
    print(f"해상도: {parsed.get('metadata', {}).get('resolution', 'N/A')}")
    print(f"언어: {parsed.get('language', 'N/A')}")
    print(f"씬 수: {len(parsed.get('scenes', []))}")
    print(f"문장 수: {len(parsed.get('segments', []))}")
    print(f"단어 수: {len(parsed.get('words', []))}")
    print(f"필러 수: {len(parsed.get('events', {}).get('fillers', []))}")
    print(f"침묵 구간: {len(parsed.get('events', {}).get('silences', []))}")
    print(f"지루한 구간 후보: {len(parsed.get('boring_candidates', []))}")
    print(f"하이라이트 후보: {len(parsed.get('highlight_candidates', []))}")
    print()

    # 전체 JSON 파일로 저장
    out_path = video_file.rsplit(".", 1)[0] + "_analysis.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(parsed, f, ensure_ascii=False, indent=2)
    print(f"전체 분석 결과 저장: {out_path}")
