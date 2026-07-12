"""
Research expert — External API tools.

- web_search       : Tavily API (https://tavily.com)
- youtube_trend    : YouTube Data API v3 — videos.list (chart=mostPopular)
- youtube_search   : YouTube Data API v3 — search.list
- channel_analysis : YouTube Data API v3 — search.list + videos.list 조합

환경변수
- TAVILY_API_KEY   : https://app.tavily.com 에서 발급 (월 1000 검색 무료)
- YOUTUBE_API_KEY  : Google Cloud Console > YouTube Data API v3 활성화 후 발급 (일 10k unit 무료)

키 없으면 친절한 에러 반환 (silent fail X).
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any

import requests
from dotenv import load_dotenv
from langchain_core.tools import tool

load_dotenv()
logger = logging.getLogger(__name__)


# =============================================================
# 공용 헬퍼
# =============================================================

def _err(code: str, message: str, **extra) -> str:
    out = {"status": "error", "error": code, "message": message}
    out.update(extra)
    return json.dumps(out, ensure_ascii=False)


def _ok(data: Any, **extra) -> str:
    out = {"status": "success", "data": data}
    out.update(extra)
    return json.dumps(out, ensure_ascii=False)


# =============================================================
# Tavily — web_search
# =============================================================

@tool
def web_search(query: str, max_results: int = 5) -> str:
    """일반 웹 검색 (Tavily API).

    Args:
        query: 검색어 (한국어/영문 무관).
        max_results: 결과 수 (1-10).

    Returns:
        JSON {status, data: [{title, url, content, score}]}
    """
    api_key = os.getenv("TAVILY_API_KEY")
    if not api_key:
        return _err(
            "missing_api_key",
            "TAVILY_API_KEY not set. Get a key at https://app.tavily.com and add to .env",
        )

    max_results = max(1, min(max_results, 10))
    try:
        resp = requests.post(
            "https://api.tavily.com/search",
            json={
                "api_key": api_key,
                "query": query,
                "max_results": max_results,
                "search_depth": "basic",
                "include_answer": False,
            },
            timeout=30,
        )
    except requests.RequestException as e:
        return _err("network_error", str(e))

    if resp.status_code != 200:
        return _err("api_error", f"Tavily {resp.status_code}", body=resp.text[:300])

    data = resp.json()
    results = [
        {
            "title": r.get("title", ""),
            "url": r.get("url", ""),
            "content": (r.get("content", "") or "")[:500],
            "score": r.get("score", 0),
        }
        for r in data.get("results", [])
    ]
    return _ok(results, query=query, count=len(results))


# =============================================================
# YouTube Data API — 공통 호출
# =============================================================

YOUTUBE_BASE = "https://www.googleapis.com/youtube/v3"


def _yt_call(endpoint: str, params: dict) -> dict | None:
    api_key = os.getenv("YOUTUBE_API_KEY")
    if not api_key:
        return {"_error": "missing_api_key", "_message": "YOUTUBE_API_KEY not set."}
    params = {**params, "key": api_key}
    try:
        resp = requests.get(f"{YOUTUBE_BASE}/{endpoint}", params=params, timeout=30)
    except requests.RequestException as e:
        return {"_error": "network_error", "_message": str(e)}
    if resp.status_code != 200:
        return {
            "_error": "api_error",
            "_status": resp.status_code,
            "_body": resp.text[:300],
        }
    return resp.json()


def _format_video(item: dict) -> dict:
    """videos.list / search.list 결과 -> 통일된 형식."""
    is_search = item.get("id", {}).get("kind") == "youtube#searchResult"
    vid = item["id"]["videoId"] if is_search else item.get("id", "")
    s = item.get("snippet", {})
    stats = item.get("statistics", {})
    return {
        "video_id": vid,
        "title": s.get("title", ""),
        "channel": s.get("channelTitle", ""),
        "channel_id": s.get("channelId", ""),
        "published_at": s.get("publishedAt", ""),
        "url": f"https://www.youtube.com/watch?v={vid}",
        "thumbnail": (s.get("thumbnails", {}).get("medium") or {}).get("url", ""),
        "description": (s.get("description", "") or "")[:300],
        "view_count": int(stats.get("viewCount", 0)) if stats else None,
        "like_count": int(stats.get("likeCount", 0)) if stats else None,
        "comment_count": int(stats.get("commentCount", 0)) if stats else None,
    }


# =============================================================
# youtube_trend
# =============================================================

# YouTube category id 매핑 (region=KR / US 동일)
YOUTUBE_CATEGORIES = {
    "music": "10",
    "entertainment": "24",
    "people_blogs": "22",
    "comedy": "23",
    "education": "27",
    "howto_style": "26",
    "gaming": "20",
    "news_politics": "25",
    "science_tech": "28",
    "sports": "17",
    "film_animation": "1",
    "autos_vehicles": "2",
    "pets_animals": "15",
    "travel_events": "19",
}


@tool
def youtube_trend(category: str = "entertainment", region: str = "KR", count: int = 10) -> str:
    """YouTube 트렌딩 (mostPopular).

    Args:
        category: youtube_trend 카테고리 키 (entertainment / music / education / howto_style / gaming 등)
                  또는 raw category id ("24" 등).
        region: ISO 3166-1 alpha-2 (KR / US / JP / GB ...).
        count: 결과 수 (1-50).
    """
    count = max(1, min(count, 50))
    category_id = YOUTUBE_CATEGORIES.get(category, category)

    data = _yt_call("videos", {
        "part": "snippet,statistics",
        "chart": "mostPopular",
        "regionCode": region,
        "videoCategoryId": category_id,
        "maxResults": count,
    })
    if "_error" in data:
        return _err(data["_error"], data.get("_message", ""), **{k: v for k, v in data.items() if k.startswith("_")})

    videos = [_format_video(item) for item in data.get("items", [])]
    return _ok(videos, category=category, region=region, count=len(videos))


# =============================================================
# youtube_search
# =============================================================

@tool
def youtube_search(query: str, sort_by: str = "relevance", count: int = 10) -> str:
    """YouTube 키워드 검색.

    Args:
        query: 검색어.
        sort_by: "relevance" | "viewCount" | "date" | "rating".
        count: 결과 수 (1-25, search.list 는 quota 100/call).
    """
    count = max(1, min(count, 25))
    if sort_by not in ("relevance", "viewCount", "date", "rating"):
        sort_by = "relevance"

    data = _yt_call("search", {
        "part": "snippet",
        "q": query,
        "type": "video",
        "order": sort_by,
        "maxResults": count,
    })
    if "_error" in data:
        return _err(data["_error"], data.get("_message", ""))

    videos = [_format_video(item) for item in data.get("items", [])]

    # statistics 보강 (각 비디오 viewCount / likeCount 별도 호출)
    ids = [v["video_id"] for v in videos if v["video_id"]]
    if ids:
        stats_data = _yt_call("videos", {"part": "statistics", "id": ",".join(ids)})
        if isinstance(stats_data, dict) and "items" in stats_data:
            id_to_stats = {it["id"]: it.get("statistics", {}) for it in stats_data["items"]}
            for v in videos:
                stats = id_to_stats.get(v["video_id"], {})
                v["view_count"] = int(stats.get("viewCount", 0)) if stats else None
                v["like_count"] = int(stats.get("likeCount", 0)) if stats else None

    return _ok(videos, query=query, sort_by=sort_by)


# =============================================================
# channel_analysis
# =============================================================

@tool
def channel_analysis(channel_id: str, recent_n: int = 10) -> str:
    """특정 채널의 최근 N 개 영상 패턴 분석.

    Args:
        channel_id: YouTube 채널 id (UC... 형식). 사용자가 핸들 (@xxx) 만 줬으면 search 로 우선 찾아야.
        recent_n: 분석할 최근 영상 수 (1-25).

    Returns:
        JSON {patterns: {avg_duration_sec, avg_view_count, common_keywords, upload_cadence_days, recent_videos: [...]}}
    """
    recent_n = max(1, min(recent_n, 25))

    # 1. 채널의 uploads playlist 찾기
    ch_data = _yt_call("channels", {"part": "contentDetails,snippet,statistics", "id": channel_id})
    if "_error" in ch_data:
        return _err(ch_data["_error"], ch_data.get("_message", ""))
    if not ch_data.get("items"):
        return _err("channel_not_found", f"channel_id={channel_id}")

    ch = ch_data["items"][0]
    uploads_pl = ch["contentDetails"]["relatedPlaylists"]["uploads"]
    ch_title = ch["snippet"]["title"]
    ch_subs = int(ch.get("statistics", {}).get("subscriberCount", 0))

    # 2. uploads playlist 의 최근 N 비디오
    pl_data = _yt_call("playlistItems", {
        "part": "snippet,contentDetails",
        "playlistId": uploads_pl,
        "maxResults": recent_n,
    })
    if "_error" in pl_data:
        return _err(pl_data["_error"], pl_data.get("_message", ""))

    video_ids = [it["contentDetails"]["videoId"] for it in pl_data.get("items", [])]
    if not video_ids:
        return _err("no_videos", "channel has no recent uploads")

    # 3. 비디오별 statistics + contentDetails (duration)
    v_data = _yt_call("videos", {
        "part": "snippet,statistics,contentDetails",
        "id": ",".join(video_ids),
    })
    if "_error" in v_data:
        return _err(v_data["_error"], v_data.get("_message", ""))

    videos = []
    durations = []
    views = []
    titles = []
    published = []
    for item in v_data.get("items", []):
        v = _format_video(item)
        dur_iso = item.get("contentDetails", {}).get("duration", "PT0S")
        dur_sec = _parse_iso_duration(dur_iso)
        v["duration_sec"] = dur_sec
        durations.append(dur_sec)
        if v["view_count"]:
            views.append(v["view_count"])
        titles.append(v["title"])
        published.append(v["published_at"])
        videos.append(v)

    # 4. 패턴 추출
    avg_duration = sum(durations) / len(durations) if durations else 0
    avg_views = sum(views) / len(views) if views else 0

    # 업로드 주기 (최근 / 처음 사이 일수 / 영상 수)
    cadence_days = None
    if len(published) >= 2:
        try:
            from datetime import datetime
            ts = sorted(datetime.fromisoformat(p.replace("Z", "+00:00")) for p in published if p)
            if len(ts) >= 2:
                cadence_days = round((ts[-1] - ts[0]).days / max(1, len(ts) - 1), 1)
        except Exception:
            cadence_days = None

    # 제목 키워드 추출 (간단한 단어 빈도)
    from collections import Counter
    words = []
    for t in titles:
        words.extend(w for w in t.replace("|", " ").replace("-", " ").split() if len(w) > 1)
    common = [w for w, _ in Counter(words).most_common(10)]

    return _ok({
        "channel_id": channel_id,
        "channel_title": ch_title,
        "subscriber_count": ch_subs,
        "videos_analyzed": len(videos),
        "patterns": {
            "avg_duration_sec": round(avg_duration, 1),
            "avg_view_count": round(avg_views, 0),
            "upload_cadence_days": cadence_days,
            "common_title_keywords": common,
        },
        "recent_videos": videos,
    })


def _parse_iso_duration(iso: str) -> float:
    """ISO 8601 PT#M#S -> seconds. 매우 가벼운 파서."""
    import re as _re
    m = _re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", iso or "")
    if not m:
        return 0.0
    h, mn, s = (int(x) if x else 0 for x in m.groups())
    return h * 3600 + mn * 60 + s


TOOLS = [web_search, youtube_trend, youtube_search, channel_analysis]
