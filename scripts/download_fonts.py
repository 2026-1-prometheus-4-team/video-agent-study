"""Google Fonts 다운로드 스크립트 — 최초 세팅 시 한 번 실행.

사용법:
    python scripts/download_fonts.py

폰트는 assets/fonts/ 에 저장되며 이미 존재하면 건너뜀.
"""

import os
import re
import sys

try:
    import requests
except ImportError:
    print("requests 패키지가 없습니다. pip install requests 후 다시 실행하세요.")
    sys.exit(1)

FONTS_DIR = os.path.join(os.path.dirname(__file__), "..", "assets", "fonts")
HEADERS = {"User-Agent": "Mozilla/4.0 (compatible; MSIE 6.0; Windows NT 5.1)"}

FONTS = [
    ("Noto Sans KR",     "NotoSansKR-Regular.ttf"),
    ("Nanum Gothic",     "NanumGothic-Regular.ttf"),
    ("Gothic A1",        "GothicA1-Regular.ttf"),
    ("Black Han Sans",   "BlackHanSans-Regular.ttf"),
    ("IBM Plex Sans KR", "IBMPlexSansKR-Regular.ttf"),
    ("Gowun Dodum",      "GowunDodum-Regular.ttf"),
]


def download_font(family: str, filename: str, output_dir: str) -> bool:
    out_path = os.path.join(output_dir, filename)
    if os.path.exists(out_path):
        print(f"  건너뜀 (이미 존재): {filename}")
        return True

    query = family.replace(" ", "+")
    css_url = f"https://fonts.googleapis.com/css?family={query}"
    try:
        css = requests.get(css_url, headers=HEADERS, timeout=10).text
        urls = re.findall(r"url\((https://[^)]+)\)", css)
        if not urls:
            print(f"  실패 (URL 없음): {family}")
            return False

        data = requests.get(urls[0], headers=HEADERS, timeout=30).content
        with open(out_path, "wb") as f:
            f.write(data)
        print(f"  완료: {filename} ({len(data) // 1024}KB)")
        return True

    except Exception as e:
        print(f"  실패: {family} - {e}")
        return False


if __name__ == "__main__":
    os.makedirs(FONTS_DIR, exist_ok=True)
    print(f"폰트 저장 경로: {os.path.abspath(FONTS_DIR)}\n")

    success = 0
    for family, filename in FONTS:
        if download_font(family, filename, FONTS_DIR):
            success += 1

    print(f"\n완료: {success}/{len(FONTS)} 개 폰트 준비됨")
