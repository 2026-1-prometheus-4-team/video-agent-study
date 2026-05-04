"""
음성 -> 자막 추출 Tool (은서)

TODO
- OpenAI Whisper API로 transcribe 구현 완료
- 결과를 VideoContext.transcript 형식으로 반환
"""

import json
import logging
import os
import subprocess
import tempfile
from langchain_core.tools import tool
from openai import OpenAI
from dotenv import load_dotenv

# --- 환경 변수 로드 (.env 파일에서 API 키를 읽어옵니다) ---
load_dotenv()

# 터미널에서 로그를 볼 수 있도록 로깅 기본 설정 추가
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# OpenAI 클라이언트 초기화 
client = OpenAI()

def _normalize_audio(file_path: str) -> str:
    """Whisper 최적 포맷으로 오디오 정규화 (16kHz mono 64kbps)"""
    logger.info("FFmpeg 오디오 정규화 진행 중...")
    out_path = os.path.join(tempfile.gettempdir(), "normalized.m4a")
    subprocess.run([
        "ffmpeg", "-i", file_path,
        "-vn",
        "-acodec", "aac",
        "-ab", "64k",
        "-ar", "16000",
        "-ac", "1",
        "-y", out_path,
    ], check=True, capture_output=True)
    return out_path


@tool
def transcribe_video(file_path: str) -> str:
    """영상 파일의 음성을 텍스트로 변환하고 타임스탬프 자막을 반환.

    Args:
        file_path: 영상 파일 경로
    """
    logger.info(f"transcribe_video 호출 - {file_path}")

    # 파일 존재 여부 확인
    if not os.path.exists(file_path):
        return json.dumps({"error": f"파일을 찾을 수 없습니다: {file_path}"}, ensure_ascii=False)
    
    # 실제 음성 인식 처리 (OpenAI API 호출)
    try:
        # 1. 오디오 정규화 (최적화)
        normalized_path = _normalize_audio(file_path)
        
        logger.info("OpenAI Whisper API로 최적화된 파일 전송 중...")
        
        # 2. 정규화된 파일로 API 호출
        with open(normalized_path, "rb") as audio_file:
            # 타임스탬프(start, end)를 받기 위해 response_format="verbose_json" 사용
            transcript_response = client.audio.transcriptions.create(
                file=audio_file,
                model="whisper-1",
                response_format="verbose_json",
                timestamp_granularities=["segment"]
            )

        # 응답 객체에서 언어 정보 가져오기 (기본값 설정)
        language = getattr(transcript_response, 'language', 'unknown')
        logger.info(f"언어 감지: {language}")

        # 결과를 VideoContext.transcript 형식으로 변환
        transcript_results = []
        
        # API 응답에서 segments 배열 추출
        segments = getattr(transcript_response, 'segments', [])
        for segment in segments:
            # dict 형태와 객체 형태 모두 대응
            start = segment['start'] if isinstance(segment, dict) else segment.start
            end = segment['end'] if isinstance(segment, dict) else segment.end
            text = segment['text'] if isinstance(segment, dict) else segment.text
            
            transcript_results.append({
                "start": round(start, 2),
                "end": round(end, 2),
                "text": text.strip()
            })

        # 최종 반환 형식 구성
        result = {
            "file_path": file_path,
            "language": language,
            "transcript": transcript_results,
        }
        
        # 3. 임시 파일 삭제 (용량 확보)
        try:
            os.remove(normalized_path)
            logger.info("임시 오디오 파일 삭제 완료.")
        except OSError:
            pass

        return json.dumps(result, ensure_ascii=False) 

    except subprocess.CalledProcessError as e:
        logger.error(f"FFmpeg 에러 발생: {e.stderr.decode('utf-8', errors='ignore')}")
        return json.dumps({"error": "오디오 추출 실패. FFmpeg가 설치되어 있는지 확인해주세요."}, ensure_ascii=False)
    except Exception as e:
        logger.error(f"Transcription 에러 발생: {e}")
        return json.dumps({"error": str(e)}, ensure_ascii=False)   

TOOLS = [transcribe_video]

if __name__ == "__main__":
    # 테스트할 샘플 영상 파일 경로
    sample_file = "/home/cheeyak/eunseo/video-agent-study/agent/sample/KakaoTalk_20260504_171515926.mp4" 

    print("=== 자막 추출 테스트 시작 ===")
    
    # LangChain Tool 실행 (.invoke() 사용)
    try:
        result = transcribe_video.invoke({"file_path": sample_file})
        
        print("\n=== 추출 결과 ===")
        parsed_result = json.loads(result)
        print(json.dumps(parsed_result, indent=4, ensure_ascii=False))
        
    except Exception as e:
        print(f"실행 중 오류 발생: {e}")