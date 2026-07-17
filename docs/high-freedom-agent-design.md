# High-Freedom Conversational Agent 설계

2026-07-16. 전수 조사(그래프/서버/툴/프롬프트/프론트/테스트 + 자막/TTS/에디터 축) 결과를 바탕으로
"클로드 코드처럼 자유도 높은 대화형 편집"을 위한 설계와 구현 범위를 확정한다.

## 조사에서 확정된 핵심 사실

1. "한 턴 끝나면 세션 종료"는 프로토콜 문제가 아니라 버그 조합이다.
   - server.py 에 `logger` 가 정의돼 있지 않은데 9곳에서 사용 (import logging 없음).
     편집 결과가 나오는 모든 턴에서 재분석 경로(1089행 logger.info)가 NameError 를 내고
     except 핸들러(1111, 1158행)도 logger 를 불러 연쇄 NameError -> final/done 이벤트가
     전송되기 전에 WS 가 죽는다. 커밋 e122953(재분석 추가)에서 유입.
   - 프론트(studio-v2)는 done 이벤트에서 sessionStatus 를 리셋하지 않고
     "세션 종료" 라벨을 찍는다. final 없는 턴은 composer 가 90초 워치독까지 잠긴다.
   - 서버 WS 루프 자체는 무한 멀티턴을 이미 지원한다 (while True + MemorySaver thread).
2. 중간에 사용자에게 되묻는 메커니즘이 전혀 없다.
   - interrupt() 는 script 승인 게이트 단 한 곳. supervisor 내부 ReAct 루프는
     checkpointer 없는 create_react_agent 라 interrupt 불가. generic except 가
     GraphInterrupt 도 삼킨다 (graph.py:281-304).
   - SubAgentResult.status "needs_user" 는 선언만 있고 생산자/소비자가 없는 죽은 코드.
   - search_video_segments 가 계산하는 {start_ms,end_ms,description,score} 후보 리스트가
     sub-agent 텍스트 평탄화(as_tool_result_text)에서 파괴된다.
3. interrupt 대기 중 자유 채팅은 서버가 거부한다 ("계획 승인 대기 중입니다").
4. 검색은 신뢰도 신호가 없다. 0건도 status success, 임계 0.5 고정, 인접 3초 세그먼트
   병합 없음(가족 장면 30초 = 조각 10개), 분석 스키마에 인물 정보 없음.
5. 재분석은 videos/ 안 파일만 가능한데 편집 툴 기본 출력은 outputs/ 라서
   연속 편집 시 두 번째 턴이 조용히 원본 기준으로 돈다. 편집본 분석 JSON 도 없어
   체인 후 내용 검색은 구조적으로 404.
6. 자막은 전부 FFmpeg 번인(전역 force_style 1개, 색 4종, 위치 3종, 폰트 고정)이다.
   큐 ID / per-cue 스타일 / 한 큐 수정 후 재렌더 개념이 없다. 오타 수정 = 전체 재전사.
   프론트에는 큐 레이어가 두 군데(모션에디터 오버라이드, Remotion VideoSpec) 있으나
   백엔드와 연결이 없고 Save/Export 는 스텁이다.
7. TTS 는 voice_settings 하드코딩, 부분 재생성 불가, 프롬프트의 보이스 카탈로그(edge-tts id)와
   실제 툴(ElevenLabs id)이 불일치해 보이스 선택이 end-to-end 로 깨져 있다.

## 설계 원칙

- plan-and-execute 골격(script=플래너, supervisor=실행자)은 유지한다.
  LLMCompiler 류 사전 컴파일 DAG 는 human-in-the-loop clarify 와 충돌하므로 도입하지 않는다.
- 데이터는 텍스트 평탄화 대신 typed state 로 흐른다. 후보/큐/오디오 결정은 구조화된
  JSON 이 진실의 원천이고, LLM 프롬프트에는 그 요약이 들어간다.
- 확신이 없으면 굽지(bake) 않고 묻는다. 후보 타임스탬프는 클릭 가능한 카드로 제시한다.
- 자막은 데이터(큐 문서)이고 mp4 픽셀이 아니다. 렌더는 요청이 확정된 시점에만 한다.

## 아키텍처 변경

### 1. 대화 루프 (Phase A)

- server.py logger 정의 (치명 버그 수정).
- 프론트 done 핸들러: sessionStatus -> completed, "세션 종료" -> "턴 완료" 카피 교체,
  info/ping 이벤트 처리, interrupt 재전송 dedupe, resolve 는 전송 성공 후에만,
  InterruptCard 의 mock fallback 제거.
- critic_retries 를 턴마다 리셋 (_build_graph_input).
- 재분석 허용 범위를 outputs/ 로 확장 + analyze_video 가 절대경로/OUTPUTS 상대경로를
  받게 확장. 재분석이 편집본의 _analysis.json 을 남기므로 체인 검색도 함께 살아난다.
- WS 수신 루프와 턴 실행 분리 (turn 을 asyncio task 로): 실행 중에도 cancel/chat 수신.
  실행 중 chat 은 "대기 후 실행" 안내와 함께 큐잉.

### 2. Clarify 게이트 (Phase B) — 되묻기 프로토콜

그래프: supervisor -> (조건) clarify_gate -> supervisor 루프 추가.

- supervisor 의 ReAct 툴셋에 `ask_user(question, candidates?, options?)` 추가.
  이 툴은 예외를 던지지 않고 질문 페이로드를 기록한 뒤 "AWAITING_USER 를 출력하고
  즉시 종료하라"는 지시를 반환한다. supervisor_node 는 메시지에서 ask_user 호출을
  감지하면 부분 execution_trace 를 커밋하고 {pending_question} 을 반환,
  라우터가 clarify_gate 로 보낸다.
- clarify_gate 는 작은 노드에서 interrupt({type:"clarify", question, candidates}) 호출.
  resume 값 {reply?: str, selected?: [index], approved?: bool} 를 clarify_answer 로 저장하고
  supervisor 로 복귀. 재진입 supervisor 는 trace 기반으로 완료 step 을 스킵하고
  Q&A 를 런타임 메시지에 주입받는다.
- supervisor 에 search_video_segments 직접 부여 (읽기 전용, 저비용). 후보 데이터가
  sub-agent 평탄화를 거치지 않고 구조 그대로 ask_user 로 들어간다.
- interrupt 대기 중 chat: 서버가 거부하지 않고 kind-aware resume 으로 변환.
  script_approval 은 assent 휴리스틱(좋아/응/진행/ok...) -> approved, 그 외 feedback.
  clarify 는 원문 그대로 {reply} — 해석은 supervisor LLM 이 한다.
- DB Interrupt 테이블에 kind / payload 컬럼 추가 (idempotent ALTER).
- 트레이스 매핑을 expert 단독 키에서 (expert, 등장 순서) 기반으로 교정해
  같은 expert 2 step 시 스킵/재실행 오판을 없앤다.
- 라우터 노드: 편집이 필요 없는 대화 턴(질문/후속 확인)은 plan 파이프라인을 타지 않고
  상태 기반으로 바로 답한다 (cheap LLM 분류).

### 3. 검색 고도화 (Phase B)

- search_video_segments 반환에 신뢰도 메타 추가: total_above_threshold, top1-top2 margin,
  match_type, 0건일 때 near_misses (임계 미달 상위 후보). 0건은 status no_match.
- 인접/중첩 세그먼트 병합: gap <= merge_gap_ms 인 매칭을 구간 union 으로 묶어
  조각 컷 문제 해결. cut_by_description 의 padding 중첩도 union.
- 다중 쿼리 확장: queries 리스트 파라미터 (동의어/영한 교차는 호출 LLM 이 생성).
- 분석 스키마에 people(인원수/관계 추정), actions 필드 추가 (video_analysis 프롬프트).

### 4. 자막 큐 레이어 (Phase C)

진실의 원천: videos/subtitles/<stem>.cues.json
{version, video, style_defaults{font,size,color,position,...}, cues:[{id, start, end, text, style?}]}

- 신규 툴 (text_expert): list_subtitle_cues / update_subtitle_cue(id|index|time, text?, style?)
  / set_subtitle_style(defaults 병합) / render_subtitles(video, cues) — ASS 변환 후 번인.
  ASS 는 per-cue 색/크기/굵기/위치/폰트 + \fad 등 라인 단위 오버라이드를 지원하므로
  "이 자막만 노란색", "두번째 자막 오타" 가 데이터 수정 + 1회 렌더가 된다.
- add_auto_subtitle 은 큐 문서 생성 + 렌더로 재구성. 항상 "번인 전 소스 경로"를
  큐 문서에 기록해 재렌더 기점을 잃지 않는다.
- 색상 임의 hex 허용, 폰트 레지스트리(assets/fonts 스캔), 위치 9방향 + margin.
- 프론트 모션에디터 오버라이드는 큐 문서를 읽고 쓰는 REST(/session/{id}/cues 또는
  파일 기반)로 연결해 채팅과 에디터가 같은 문서를 편집한다. VideoSpec/Remotion 완전
  통합은 후속 (이번엔 계약만 맞춤).

### 5. TTS (Phase C)

- text_to_speech 에 voice_settings(stability, style, speed) + output_path 파라미터 노출.
- 보이스 카탈로그 수정: tts_voices.json 에 elevenlabs_voice_id 매핑 추가, 툴이 카탈로그
  id 를 받으면 매핑으로 해석. 미매핑 id 는 명시 오류.
- narration manifest (audio_files/<stem>.narration.json): 세그먼트별 {id,text,voice,params,
  start,file}. mix_audio 에 at_time offset 추가 -> 구간 부분 재생성 + 스플라이스 가능.

### 6. 프롬프트 오버홀 (전 단계 관통)

- SOUL/AGENTS/TOOLS.md + script/supervisor 프롬프트에 추가:
  모호 쿼리 분해 전략(주관 형용사 -> 측정 가능한 프록시, 검색 먼저 -> 후보 -> 확인),
  no_match/저신뢰 시 행동 규칙(임의 컷 금지, near_misses 를 후보로 제시),
  원본 vs 편집본 베이스 모호성 규칙(원본 암시 어휘 감지 시 확인),
  파괴적 편집(총 길이 50%+ 삭제 등) 사전 확인 의무,
  ask_user 사용 기준(저신뢰 검색, 취향 결정, 예상 밖 결과),
  타임스탬프 보고 형식(ms + m:ss 병기), 질문 품질 규칙(후보/기본값 포함, 최대 2개),
  "6 단계" 하드코딩 제거, AWAITING_USER 종료 상태 정의.

## 구현 순서

Phase A(기반 수정) -> B(clarify + 검색) -> C(자막/TTS) -> D(프론트 UI) -> 테스트/리뷰.
프론트 D 는 B 의 WS 계약 확정 후 병렬 진행.

## 적대적 리뷰에서 잡아 고친 것 (2026-07-17)

5개 관점(WS 동시성 / 그래프 상태머신 / 툴 정확성 / 프론트 / 프로토콜 정합) x 발견별
반박 검증. 38건 중 25건 확정, 13건 반박. 확정분은 전부 수정 + 회귀 테스트.

동시성 (이번 오버홀이 새로 만든 구멍):
- (critical) 취소/끊김 시 그래프 스레드가 살아있는데 run_lock 이 먼저 풀려, 다음 턴이
  같은 thread_id 에 그래프를 하나 더 붙임. 버려진 run 의 늦은 체크포인트가 "최신"으로
  이겨 취소한 편집이 부활. -> producer_done 이벤트로 스레드 종료까지 락 유지.
- run_lock 은 await 로만 잡혀서 "task 생성 ~ 락 획득" 창이 열림 -> session.busy 동기 플래그.
- _send_final(재분석 20~60초)이 락 밖 -> 락 범위를 턴 전체로.
- 두 번째 탭 닫으면 첫 탭 턴이 취소됨 (turn_stop_event 가 세션 전역) -> 소유권 확인.
- 이중 resume: 두 탭이 같은 카드에 응답하면 두 번째 값이 *다음* interrupt 를 소비 -> busy 가드.
- cancel no-op 창: stop_event 를 relay 진입 시 만들어서 "보내자마자 stop" 이 유실 -> _start_turn 에서 생성.

clarify 루프 정확성:
- (major) 재진입 시 trace step 매핑이 0 부터 세서 완료 step 재실행 + 미완료를 done 오인.
  -> prior_trace 의 *성공* 횟수부터 카운트 (실패는 재시도 대상이라 제외).
- step_id 누락 시 영영 미완료 -> script_node 백필.
- quota verdict 가 critic 에 덮여 침묵 -> terminal 플래그 + supervisor->summary 단축.

기타: 큐 문서 편집이 프론트 transcript 에 반영 안 됨(_load_transcript_sidecar 가 전사
사이드카만 읽음), GET /session 이 재분석 대신 원본 컨텍스트 반환, clarify resume 이
interrupts 테이블에 approved=True 로 기록, 빈 분석 JSON 에서 numpy AxisError,
near_misses 가 키워드 폴백을 건너뜀, cut 단일 구간에서 output_path 무시,
복합 승인("네 그렇게 해줘")이 재계획 유발, 취소 턴이 completed 로 기록.

## 이번 범위에서 제외 (후속)

- 서버 재시작 생존 (durable checkpointer / DB 세션 리하이드레이션)
- VideoSpec/Remotion 프리뷰 완전 통합 (자막 채팅 편집 <-> 에디터 실시간 양방향)
- Qdrant 도입 (현행 로컬 임베딩 검색으로 충분)
- 씬 썸네일 (후보 카드는 텍스트+시킹으로 시작)
