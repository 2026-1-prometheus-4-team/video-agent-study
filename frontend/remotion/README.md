# Scene24 Labs - Text Motion MVP

분석한 키네틱 타이포그래피 영상의 텍스트 문법을 일반화한 모션 라이브러리와,
Gemini가 spec JSON을 출력해 영상을 생성하는 테스트 파이프라인.

## 구조

```
src/motion/
  core.ts            이징, role -> 프레임 구간 변환(resolveTimings), 시드 랜덤
  color.ts           색 타임라인 엔진 (OKLab 보간, solid/gradient/palette, 글자별 오프셋)
  wrappers.ts        Type A wrapper: fade / move / scale / blur + composeStyle
  structural.tsx     Type A 구조형: typewriter / letter_stagger / path_in / marquee_rows
  ComposedText.tsx   element 진입점: 검증 폴백, 분기, glow/life(Type B) 적용
  SceneRenderer.tsx  Type D: 씬 시퀀싱, 전환, 배경(Aurora)
src/demo-spec.json   원본 영상 4개 씬 재현 스펙 (수작업 레퍼런스)
src/generated-spec.json  Gemini 출력이 저장되는 곳
src/Root.tsx         Demo / Generated 두 컴포지션 등록
prompt/system-prompt.md  Gemini 시스템 프롬프트 (계약서 전체)
scripts/generate.mjs     Gemini 호출 -> generated-spec.json 저장
```

## 셋업

```bash
pnpm install
cp .env.example .env   # 또는 직접 .env 작성 — GEMINI_API_KEY=... 한 줄
```

`.env` 는 git ignore. tsconfig 는 `resolveJsonModule: true` 설정됨 (spec JSON import 용).

## 실행

1. 수작업 레퍼런스 확인 (Gemini 없이 라이브러리 품질부터 검증):

```bash
pnpm dev
# Studio (http://localhost:3001) 에서 'Demo' 컴포지션 선택 -> 원본 영상 재현 4개 씬 확인
```

2. Gemini 생성 테스트 (Node 20.6+ 의 --env-file 사용):

```bash
node --env-file=.env scripts/generate.mjs "15초짜리 에너지 넘치는 SaaS 런칭 키네틱 타이포. 다크 배경, 네온 핑크/퍼플"
# Studio 에서 'Generated' 컴포지션 새로고침
```

모델 바꾸려면 `GEMINI_MODEL=gemini-2.5-pro` 같이 환경변수로 (`.env` 에 추가하거나 inline).

## 품질 평가 체크리스트

Generated 결과를 볼 때 다음을 확인:

1. 정지 구간이 죽어 보이지 않는가 (life/색 타임라인/드리프트가 들어갔는가)
2. 화려한 진입이 화이트/브랜드색으로 수렴(settle)하는가
3. 히어로 단어와 보조 문장의 위계가 지켜졌는가 (폰트 크기, 모션 강도)
4. 퇴장이 진입을 미러링하는가 (typewriter -> erase 등)
5. JSON이 한 번에 파싱되는가 (실패 시 out-raw.json 확인)

같은 프롬프트로 3회 생성해서 다양성과 일관성을 함께 평가할 것.

## 현재 스코프와 한계 (MVP)

- path_in의 글자 베이스라인 휨(리본 워프)은 미구현. 텍스트 블록 전체가
  곡선을 따라 이동+회전하는 수준. 글자별 textPath 배치는 다음 단계.
- 비트/나레이션 동기(bpm, settleAt) 미구현. duration은 초 단위 수동.
- 검증은 폴백 클램프 수준. zod 스키마 + 에러 코드 체계는 다음 단계.
- marquee_rows는 단순 버전 (속도 연동 모션 블러 없음).

## 다음 단계 후보

1. velocity-linked motion blur (composeStyle을 frame +-1 샘플링)
2. settleAt: "beat_N" (bpm -> beatGrid -> 프레임 스냅)
3. path_in 리본 워프 (글자별 곡선 배치)
4. JSONL 패치 스트리밍 (json-render 방식) + 부분 재생성
