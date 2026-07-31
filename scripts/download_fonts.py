"""Google Fonts 다운로드 스크립트 — 최초 세팅 시 한 번 실행.

사용법:
    python scripts/download_fonts.py

폰트는 backend/assets/fonts/ 에 저장된다. 유효한 폰트가 이미 존재하면 건너뛰고,
깨진 파일(EOT/HTML 등 폰트가 아닌 것)은 자동으로 다시 받는다.

과거 버전은 fonts.googleapis.com CSS 를 MSIE User-Agent 로 긁었는데, 그 경우
Google 이 IE 전용 EOT 포맷을 반환해 libass 가 읽지 못하는 깨진 파일이 저장됐다.
지금은 google/fonts GitHub 저장소에서 원본 TTF 를 직접 받는다.
"""

import os
import struct
import sys

try:
    import requests
except ImportError:
    print("requests 패키지가 없습니다. pip install requests 후 다시 실행하세요.")
    sys.exit(1)

FONTS_DIR = os.path.join(os.path.dirname(__file__), "..", "backend", "assets", "fonts")

_GH_RAW = "https://raw.githubusercontent.com/google/fonts/main"

# (GitHub 경로, 저장 파일명)
FONTS = [
    (f"{_GH_RAW}/ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf", "NotoSansKR-Regular.ttf"),
    (f"{_GH_RAW}/ofl/nanumgothic/NanumGothic-Regular.ttf", "NanumGothic-Regular.ttf"),
    (f"{_GH_RAW}/ofl/gothica1/GothicA1-Regular.ttf", "GothicA1-Regular.ttf"),
    (f"{_GH_RAW}/ofl/blackhansans/BlackHanSans-Regular.ttf", "BlackHanSans-Regular.ttf"),
    (f"{_GH_RAW}/ofl/ibmplexsanskr/IBMPlexSansKR-Regular.ttf", "IBMPlexSansKR-Regular.ttf"),
    (f"{_GH_RAW}/ofl/gowundodum/GowunDodum-Regular.ttf", "GowunDodum-Regular.ttf"),
]

# sfnt 계열 매직 (TrueType / OpenType-CFF / 구형 Mac TrueType)
_FONT_MAGIC = (b"\x00\x01\x00\x00", b"OTTO", b"true")


def is_valid_font(path: str) -> bool:
    """파일이 실제 sfnt 폰트인지 매직 바이트 + 최소 크기로 검증."""
    try:
        with open(path, "rb") as f:
            head = f.read(4)
        # 한글 폰트는 글리프 수 때문에 수백 KB 미만이면 사실상 깨진 파일이다.
        return head in _FONT_MAGIC and os.path.getsize(path) > 200_000
    except OSError:
        return False


def download_font(url: str, filename: str, output_dir: str) -> bool:
    out_path = os.path.join(output_dir, filename)
    if os.path.exists(out_path):
        if is_valid_font(out_path):
            print(f"  건너뜀 (유효한 폰트 존재): {filename}")
            return True
        print(f"  깨진 파일 재다운로드: {filename}")

    try:
        res = requests.get(url, timeout=60)
        if res.status_code != 200:
            print(f"  실패 (HTTP {res.status_code}): {filename}")
            return False
        if res.content[:4] not in _FONT_MAGIC:
            print(f"  실패 (폰트 아님 — magic {res.content[:4]!r}): {filename}")
            return False
        with open(out_path, "wb") as f:
            f.write(res.content)
        if not is_valid_font(out_path):
            os.remove(out_path)
            print(f"  실패 (검증 불통과): {filename}")
            return False
        print(f"  완료: {filename} ({len(res.content) // 1024}KB)")
        return True
    except Exception as e:
        print(f"  실패: {filename} - {e}")
        return False


if __name__ == "__main__":
    os.makedirs(FONTS_DIR, exist_ok=True)
    print(f"폰트 저장 경로: {os.path.abspath(FONTS_DIR)}\n")

    success = 0
    for url, filename in FONTS:
        if download_font(url, filename, FONTS_DIR):
            success += 1

    print(f"\n완료: {success}/{len(FONTS)} 개 폰트 준비됨")
    if success < len(FONTS):
        sys.exit(1)
