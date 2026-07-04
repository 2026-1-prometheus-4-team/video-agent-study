# research_expert — Tools

## LLM-only tools (실제 구현됨)

| tool                       | 시그니처                                                                        | 설명 |
|----------------------------|---------------------------------------------------------------------------------|------|
| `concept_brainstorm`       | `(topic, format, audience, count=3) -> JSON {concepts: [...]}`                  | 주제 + 포맷 + 청중 → 컨셉 N 개 (CONCEPT_PATTERNS.md 의 스토리텔링 패턴 활용) |
| `storyboard_from_concept`  | `(concept_title, story_pattern, scenes_count=5) -> JSON {scenes: [...]}`        | 컨셉 → 씬별 스토리보드 (시간 / 비주얼 / 자막 / 음성) |
| `hook_suggest`             | `(topic, format, count=3) -> JSON {hooks: [...]}`                               | 첫 1-3 초 후킹 멘트 (HOOKS_LIBRARY.md 패턴 활용) |
| `cta_suggest`              | `(topic, goal, count=3) -> JSON {ctas: [...]}`                                  | 마지막 Call-to-Action 멘트 |
| `music_mood_recommend`     | `(concept, format) -> JSON {mood, keywords, tempo_bpm, energy}`                 | BGM 무드 추천 (실제 음원 찾기는 별도) |

## External API tools (실제 구현됨)

| tool                       | 시그니처                                                                        | 설명 |
|----------------------------|---------------------------------------------------------------------------------|------|
| `web_search`               | `(query, max_results=5) -> JSON {results: [{title, url, snippet}]}`             | Tavily API. 일반 웹 검색. |
| `youtube_trend`            | `(category, region="KR", count=10) -> JSON {videos: [...]}`                     | YouTube Data API 트렌딩. |
| `youtube_search`           | `(query, sort_by="relevance", count=10) -> JSON {videos: [...]}`                | YouTube 키워드 검색. sort_by: relevance / viewCount / date |
| `channel_analysis`         | `(channel_id, recent_n=10) -> JSON {patterns: {...}}`                           | 특정 채널 최근 영상의 공통 패턴 (평균 길이 / 자막 / 후킹 패턴 / 카테고리) |

## 환경변수 (외부 API)

`.env` 에 다음 키 필요. 없으면 해당 tool 이 친절한 에러 반환.

```
TAVILY_API_KEY=tvly-...
YOUTUBE_API_KEY=AIza...   # Google Cloud Console > YouTube Data API v3 활성화
```

YouTube Data API 무료 quota: 10,000 units/day. `youtube_trend` = 1 unit, `youtube_search` = 100 units, `channel_analysis` = ~50 units (videos.list * recent_n).

## 카탈로그 자산

LLM-only 도구는 system prompt 에 다음 문서를 *stable prefix 일부* 로 받음 → 추가 컨텍스트 검색 없이 양질 출력 가능.

- `TREND_RESEARCH.md` — 포맷별 / 카테고리별 트렌드 분석 방법 + 한국 시장 특수성
- `CONCEPT_PATTERNS.md` — 12 가지 스토리텔링 패턴 (problem-solution, before-after, listicle, tutorial, transformation, day-in-life, challenge, journey, mystery, fail-success, comparison, demonstration)
- `HOOKS_LIBRARY.md` — 5 가지 후킹 카테고리 (충격 통계 / 의외성 / 질문 / 약속 / 5W1H) 각 5-10 예시

## 운영 가이드

- web_search / youtube_* 는 *네트워크 의존*. timeout 30 초.
- 결과는 .cache/research/ 에 24 시간 TTL 캐싱 권장 (트렌드는 매일 바뀜).
- channel_analysis 는 quota 큼 — 같은 채널 24 시간 내 재호출 시 캐시 사용.
- 사용자에게 검색 결과 보일 때 *반드시* 출처 URL 첨부.
