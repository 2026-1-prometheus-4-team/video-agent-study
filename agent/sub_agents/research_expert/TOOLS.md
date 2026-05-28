# research_expert — Tools

## 구현됨

(현재 없음 — owner: 성민)

## TODO

- `web_search(query)` — Tavily API (이미 CLAUDE.md 에 키 언급).
- `youtube_trend(category, region)` — YouTube Data API trending list.
- `competitor_analysis(channel_id)` — 채널 최근 영상 N 개의 구조 (컷 수, 평균 길이, 자막 스타일) 추출.

## 구현 가이드

- Tavily SDK 또는 raw API. `.env` 의 `TAVILY_API_KEY` 추가 필요.
- YouTube Data API v3 — 일일 quota 주의.
- 결과 caching: `.cache/research/` 하루 TTL 권장 (트렌드는 매일 바뀜).
