# Scene24 모션 엔진 스펙 (프리셋 + 실측 수치 라이브러리)

작성일: 2026-07-06
근거: 사용자(이성민) 엔진 구조 설계 + 레퍼런스 영상 8편 프레임 단위 실측
 - 이번 분석 6편: Replit Enterprise(leonmotion), Stripe 컨셉(fudail_shahzad), Ava AI(solair.motion), PREMIUM transition(editby.krish), 텍스트 프리셋 쇼케이스(akhilfilms), 폰트 쇼케이스(akhilfilms)
 - 기존 실측: LangEase, Base44, neonfuel (premium_motion_factors.md / AdOps)

목적: "씬별 프리셋 통째 정의"가 아니라, 요소 단위 고퀄 프리셋 + 파라미터 + 검증된 수치를 고정해두고, LLM이 프롬프트로 조합해 영상을 구성하는 엔진의 스펙.

---

## 0. 렌더 계층 (스택 순서)

사용자 정의 스택. 아래에서 위로 합성:

```
[6] 오디오/비트          비트 그리드에 모든 타이밍 스냅
[5] 트랜지션             씬 전환 (하드컷 기본 + 특수)
[4] 카메라 모션          줌/기울임/포인트 경로
[3] 3D 곡률 필터         원기둥/구/파노라마 캔버스 (켜면 하위 요소가 그 위에 매핑)
[2] 프레임 그룹          figma 프레임처럼 요소 묶음 (그룹 단위 효과/3D 적용)
[1] 텍스트/UI 모션       베이스 요소 (파라미터화 프리셋)
```

핵심 원칙: 각 프리셋은 단일 정의 + 효과 on/off·변수로 다형(多形). 예) 텍스트 모션 하나가 "단어 단위 / 글자 단위", "glow on/off", "색전환 on/off" 조합으로 수십 변형. 고퀄 수치는 아래 고정.

전역 발견 (8편 교차, 반드시 지킬 것):
- 하드컷이 전환의 지배 문법. dissolve/cross-fade는 편당 0-2회, 1-6프레임으로 극히 짧게.
- spring/overshoot는 거의 안 씀. ease-out(등장) / ease-in-out(3D·양방향) / linear(drift·pan·counter) / 하드스냅+ease-out(섬광)이 전부. bounce는 악센트로 1회 정도.
- "정지 hold"는 거의 없음. hold 위엔 drift/breathing/glow travel이 상시 깔림 (mean-luma diff 측정상 항상 nonzero).
- 프리미엄 감각의 출처는 카메라 트랜스폼이 아니라 라이팅(glow bloom / specular sweep / rim-light) + 비트 동기 타이밍.
- 비트 그리드 약 0.6s (100BPM)에 컷/단어를 스냅하면 원본 리듬이 난다.

---

## 1. 텍스트 모션 프리셋

### 1-1. 파라미터 (모든 텍스트 프리셋 공통 입력)

- unit: `word` | `char` (단어 단위 / 글자 단위). 한 문장 안에서 텍스트박스를 여러 개로 쪼개 박스별 다른 unit·효과 부여 가능 (예: 앞 단어는 word bounce, 뒷 단어는 char typing).
- text, color, gradient, glow(색/blur/intensity), font, fontWeight, letterSpacing
- stagger: 요소 간 지연(프레임). char 단위일 때 글자별 2-3프레임 지연이 표준.
- easing, duration, startFrame

### 1-2. 등장 프리셋 (실측 수치 포함)

Fade 계열
- `fade_in` — opacity 0→1 제자리. duration 8-12f, ease-out.
- `fade_up` — 아래→위 이동 + fade. 이동 40-80px, ease-out.
- `fade_down` — 위→아래 + fade.

단어(word) 단위
- `words_up` — 단어별 line-mask 아래에서 올라옴 (마스크 reveal). stagger.
- `words_down` — 단어별 위에서 내려옴. Down은 우상단에서 arc(rotateZ ~-15° 시작) 그리며 하강하는 변형 있음 [akhil 실측].
- `bounce_up` — 아래서 튀어오름. overshoot 있는 유일 계열이나 진동 1회로 절제.
- `pop_up` — scale 0→1 팝. spring 살짝, overshoot 소량.
- `sequential_build` — 문장을 단어씩 추가. 새로 들어온 단어는 강조색(레드/블루)으로 등장 후 기본색(블랙/화이트)으로 정착. 단어당 0.15-0.2s [Replit/Stripe/Ava 공통].

글자(char) 단위
- `typewriter` — 글자 순차 + 커서 깜빡임. char당 1-2프레임(30fps). 단어 첫 글자만 char, 나머지 word로 붙는 하이브리드 흔함 [Ava].
- `characters_snap` (scatter-assemble) — 글자가 흩어진 Y오프셋+미세회전에서 공통 baseline으로 수렴. 총 ~0.30s(9프레임@30fps), ease-out, overshoot 없음(baseline 안 지나침), 글자별 2-3f stagger [akhil "3D Characters Up" 실측].
- `characters_down` — 글자별 위→아래 순차.
- `scale_rotation_snap` — 글자가 확대+회전 상태에서 정위치 안착.
- `scale_words` — 단어가 흐린 소형(40% scale)→오버사이즈(~180%, 앞 단어와 겹침)→축소 정착. 자간 넓게 시작→좁게 수렴 동시. scale-down ease-out [akhil 실측].
- `tracking_words` — 자간(letterSpacing) 좁게→넓게 또는 그 반대. 진입 단어에 motion-blur 트레일.
- `flip_text` (rotateY 3D) — 최고 퀄 기법. 단어 전체가 Y축 3D 플립: 정면→90°(scaleX→0 원근 압축)→미러 반전("noitatoR")→정면 복귀. perspective 필요. ease-in-out. rotateY 0→180(→360) [akhil "Rotation Words" 실측].
- `flicker` — 글자 opacity on/off 깜빡이며 등장.

특수
- `apple_text` — 강블러 + 흰 glow에서 선명해지며 단어별 등장 (Apple 키노트풍). blur 20-40px→0.
- `glitch` — RGB 분리/노이즈 글리치 등장.
- `word_glow_bloom` — 새 단어 도착 시 뒤에 밝은 소프트 후광(blur 15-20px, 고휘도)이 같이 들어왔다가 3-4프레임(0.15-0.2s) ease-out으로 crisp하게 감쇠 [Ava 실측, 프리미엄감 큼].
- `neon_outline_flicker` — 문구가 한순간 네온 stroke 아웃라인(글로우 윤곽)으로 렌더 → 1-2프레임 후 솔리드로 안착. 네온사인 켜지는 느낌 [Ava].
- `number_count` — 숫자 카운트업. 빠르게 오르다 마지막에 ease-out 감속 lock, 정착 순간 빨강 깜빡(flash) 후 멈춤 [사용자 지정 + Replit 카운터 실측: +30-35/sec, ease-out lock]. 두 카운터를 바(dumbbell)로 연결해 lockstep 동기 카운트 변형 있음.

### 1-3. 퇴장

- 표준 퇴장 = fade + shrink(scale down) + 위로 소폭 슬라이드 동시 3속성, 다음 씬 컷과 겹침 [Ava 실측].

---

## 2. 트랜지션 프리셋

- `hard_cut` — 기본. 전환의 지배 문법.
- `slide_through` — 씬 전체가 좌/우/상/하로 밀려나가며 다음 씬이 반대편에서 진입(요소 exit/enter 겹침). 아이콘·웨이브폼 등 요소가 연결된 채 함께 이동 [Replit].
- `zoom_focus_cut` (★ 사용자 지목 기법, 정체 규명) — scale 트윈 아님. 하드컷 IN(작은 문구→초대형 1프레임 급등, 확대 ~4.5x) → 초대형 홀드 ~0.77s + 좌측 linear pan ~420px/s@1180 → 하드컷 OUT(초대형→전체 작게 1프레임 급축소). 착시 조건 3개: (1) 홀드 중 pan이 컷 점프를 시선에서 가림 (2) 컷이 다음 단어 진입 프레임에 정렬된 content-matched cut (3) 컷 직후 1프레임만 미세 모션블러. spring/overshoot 0 [Replit 30fps 실측].
- `whip_pan_blur` — 씬 전체가 회전/휘두르며 강한 directional 모션블러로 뭉개졌다 resolve. 스팬 0.6-0.8s, edge energy 2.3배 감소 피크 ~0.13s 유지, 대칭 ease-in-blur→hold→ease-out-sharpen. 하드컷 아님 [Stripe 30fps 실측].
- `expand_reveal` — 원 또는 단어 텍스트가 크게 확장되며 다음 요소 등장(확장체가 다음 씬을 덮거나 뚫음).
- `specular_strobe` — 대각(-45°) 라이트 섬광이 카드/화면을 스침. 1프레임 하드스냅(블랙 4→피크 190)→0.25s(5f) ease-out 감쇠→0.3s near-black hold, 0.6s(100BPM) 주기 반복. 부드러운 morph 아님(샤프 스트로브) [editby.krish 60fps 실측].
- `flash_crossfade` — 밝기 스파이크(2-3f) 동반 짧은 크로스디졸브(~0.15s), 이전 exit와 신규 enter 겹침 [Ava].
- `concentric_ripple` — 로고/포인트 중심에서 glowing ring이 바깥으로 확장(소나/radar-ping) [Stripe].
- `dot_grid_fill` — 화면이 솔리드 도트로 채워지며(원 확대/fill) 다음 씬으로 [Replit].

---

## 3. 카메라 모션

가상 카메라 = 캔버스 scale/translate/rotate. 실측상 대부분 영상은 카메라 고정 + 라이팅으로 다이내믹을 냈으나, 사용자 엔진은 아래를 파라미터로 제공:

- `zoom_in` (push) — scale 1.0→1.1x대, 미세 pan 동반(Ken Burns). idle용은 0.2-0.5%/sec 극미세.
- `zoom_out` (pull) — 디테일→컨텍스트.
- `tilt_3d` — 좌우로 입체 기울여 이동(rotateY + translate, perspective).
- `roll` — 위/아래로 카메라 회전(rotateX).
- `point_path` — 시작/끝 포인트를 연속으로 찍어 경로 이동. 각 구간 속도는 사용자 지정(엔진이 그 속도로 보간, LLM은 포인트만 배치).
- `parallax_pan` — 카메라 pan 중 depth 레이어별 다른 속도(전경 빠름/배경 느림) [Stripe 카드 팬].
- `micro_drift` — 모든 hold 위에 상시. 100-540px/s linear 또는 slow push-in 가속 [전 영상 hold diff nonzero로 확인].

---

## 4. 3D 곡률 효과

씬에 켜면 의존성 등록된 요소가 곡률 캔버스 위에 3D로 매핑됨. 곡률 정도 조절 가능(끝쪽만 살짝 휘게 ~ 강한 원통).

주: 이번 8편 실측엔 곡률 캔버스 없음(전부 평면 2D 또는 3D 공간감/포디움까지). 곡률은 사용자 신규 요구이므로 구현 가이드:

- 원기둥(cylinder) 매핑: 요소를 수평축 기준 rotateY로 원통 둘레에 배치. CSS `transform: perspective() rotateY(θ) translateZ(r)` per 요소, 또는 텍스트를 글자별로 각도 분배.
- 구(sphere)/볼록렌즈: Canvas/WebGL warp mesh(정점 그리드를 구면/렌즈 함수로 변위) 또는 SVG feDisplacementMap.
- 곡률 정도 커서 조절 = superellipse/곡률 파라미터. figma의 "선 곡률 조절"은 두 가지 중 하나:
  - corner smoothing(squircle) = superellipse 지수 n을 0(사각)~1(원)으로 조절.
  - 경로 곡률(curvature comb) = Catmull-Rom spline의 tension/각 정점 bezier 핸들 길이 조절. 커서로 핸들 당기면 곡률 반경 변화.
  → 곡률 슬라이더는 결국 "베지어 핸들 길이 또는 superellipse 지수"를 0~1로 노출하면 된다.
- glass morphism (곡률과 별개, 실측 다수): 반투명 fill + backdrop blur + 대각 specular 하이라이트 + rim light. Stripe/editby/akhil의 "프리미엄" 카드 질감이 이것.
- 3D depth 레이어(포디움/카드 스택): 요소를 translateZ로 앞뒤 배치, rim light + 바닥 glow 반사 [Stripe].

---

## 5. UI 모션

UI는 기본적으로 LLM이 코드 생성 → 캡처 파이프라인이 DOM에서 추출. 아래는 미리 구축해둘 에셋/모션:

- UI 프리미티브: 원/사각형(라운드 코너, 곡률 조절), 카드. 내부에 사진/그라디언트/glow 삽입 가능.
- `neon_border_runner` — 라운드 카드 테두리를 핑크/마젠타 네온 glow가 시계방향으로 도는 light-runner. 핫 세그먼트 perimeter의 25-30%, 1바퀴 ~1.5s(40-50f). 나머지는 dim 베이스 glow [akhil 실측, 카드 템플릿에 즉시 유용].
- `counter` — 숫자 카운트업(1-2절 참고). 원↔덤벨 morph 변형.
- `light_burst` — 텍스트 뒤에서 수평 빛줄기가 좌→우/중앙→양옆 확산하며 글자를 밝힘. 강한 motion blur, 등장 직후 강→감쇠 [Ava].
- `light_sweep` — 카드 좌상단에서 대각 소프트 라이트가 가로질러 스윕(글래스 반사) [Ava].
- `spotlight_breathing` — 카드 하단 중앙 돔형 glow가 위로. 밝기 사인 호흡 주기 1.5-2s, 진폭 작음, 단어 도착과 동기 [Ava 실측].
- `wave_ribbon` — 가로 sine 웨이브 리본(오디오 비주얼라이저풍). 연속 traveling(정지 안 함), 블러 8-12px glow [akhil].
- `liquid_metaball_morph` — 발광 capsule/dot 요소가 흩어져 등장→색전이(화이트→브랜드색)+간격 수렴(loose→tight)+glow 감쇠 동시 3-4속성 → 로고 마크로 응집. 0.6-1.0s [Ava 로고 실측, 최고 프리미엄].
- `photo_collage` — 사진 여러 장이 살짝 회전된 카드로 클러스터 슬라이드인(겹치며 쌓임) [Ava].
- `cursor` — 여러 커서 모양(포인터/그랩핸드) + 이동/클릭(bounce feedback).
- `liquid_glass` — 반투명 유리 재질 파일(backdrop blur + specular).
- 커서·아이콘 morph/cycle: 앱 아이콘이 eye→audio-bars→$ 순환 [Stripe].

---

## 6. 프레임 그룹 (figma 프레임형 묶음 레이어)

낮은 계층 요소(텍스트/UI 여러 개)를 하나로 묶는 컨테이너. 그룹 단위로 효과/3D/카메라 적용.
- 예: 텍스트 여러 개 세로 정렬 → 롤링(단어별 순차 포커싱하며 회전). 이건 그룹에 rolling 효과 적용.
- 그룹에만 3D 곡률 적용 가능 → 묶은 요소들이 함께 원통/구 위에 매핑.
- 구현: 요소 트리에 group 노드, group에 transform/effect 스택. 자식은 group 로컬 좌표.

---

## 7. 전역 이징 / 스케일 / 타이밍 수치표 (핵심)

수학적으로 검증된 값. 프리셋이 임의값 대신 이 표에서 가져옴.

이징 (용도별)
- 등장 기본: ease-out. cubic-bezier(0.16,1,0.3,1) 또는 (0.5,0,0,1)
- 양방향/3D 플립: ease-in-out. cubic-bezier(0.65,0,0.35,1)
- drift/pan/counter travel/웨이브: linear
- 섬광/스트로브: 1프레임 하드스냅 + ease-out 감쇠
- 악센트 bounce(절제): overshoot 1회, cubic-bezier(0.34,1.56,0.64,1)
- spring/overshoot 남발 금지 (8편 실측상 거의 0)

스케일
- push_in(카메라): 110-120%/샷
- zoom transition: 1.0→1.5
- scale_words 오버사이즈: ~180%
- zoom_focus_cut 확대배율: ~4.5x (초대형↔전체)
- breathing scale: 1.0-1.03
- pop/scatter 시작: 0.4-0.9

속도
- drift: 100-540 px/s @1180 (LangEase 240-540, Base44 250, Replit)
- zoom_focus pan: ~420 px/s @1180 linear
- counter: +30-35 /sec, 마지막 ease-out lock
- neon runner: 1바퀴 1.5s (40-50f)
- 웨이브: 연속 traveling(정지 0)

타이밍
- 비트 그리드: 0.6s (100BPM). 컷/단어를 여기 스냅.
- 단어 등장 리듬: 0.15-0.25s/단어
- char typing: 1-2f/글자 (30fps), char당 2-3f stagger
- scatter-assemble: ~0.30s
- glow bloom 감쇠: 0.15-0.2s ease-out
- dissolve: 1-6f (편당 0-2회)
- whip blur: 0.6-0.8s (피크 hold 0.13s)
- specular strobe: 1f snap + 0.25s 감쇠 + 0.3s hold, 0.6s 주기
- zoom_focus 초대형 hold: ~0.77s
- 씬/카드 점유: 0.47-1.1s

색/라이팅
- glow는 대부분 단색 soft halo (blur 15-30px). 프리미엄감의 핵심.
- rim-light(테두리 네온), specular(대각 하이라이트) = glass 질감.
- 2색 시스템(강조색 1 + 기본색 1) on 단색/그라디언트 배경이 텍스트 표준.

---

## 8. 오디오 / 비트 동기화

- 모션 구현 전 비트를 먼저 추출. 브랜딩·레퍼런스 영상의 비트 에너지를 분석한 프롬프트를 넣어 비트 생성.
- 생성된 비트를 분석해 비트 에너지를 "초 단위 말"로 표현(예: 0-2s 빌드업, 2s 드롭, 2-8s 하이에너지 컷 리듬 0.6s).
- 이 비트 그리드에 컷/단어 등장을 스냅해 리듬감. 위 0.6s(100BPM)이 실측 기준.
- 나래이션: 단어 등장 타이밍과 싱크(단어 나올 때 해당 음절).

## 9. 영상 / 이미지 생성

- 중간 삽입 영상(예: Base44식 짧은 제품 영상): 프롬프트 자동 생성해 삽입.
- 이미지: 필요 시 생성(콜라주/배경/제품샷).

## 10. 자동 컷편집

- 녹화본을 자동 컷편집(무음/실수/침묵 제거, jump cut)해 전체 영상에서 사용.

---

## 11. 부록 — 8편 실측 원본 매핑

| 영상 | 브랜드/제작 | 톤 | 시그니처 기법 | 핵심 수치 |
|---|---|---|---|---|
| 03-52-10 | Replit Ent / leonmotion | 크림+레드 flat | zoom_focus_cut(하드컷2+pan) | 확대4.5x, hold0.77s, pan420px/s |
| 03-50-02 | Stripe 컨셉 / fudail | 다크 네이비 glow | whip_pan_blur, ripple, parallax | whip0.6-0.8s, edge2.3배↓ |
| 03-45-01 | Ava AI / solair | 다크+블루 | glow_bloom, metaball morph, light_burst | bloom0.15-0.2s, morph0.6-1.0s |
| 03-42-51 | PREMIUM / editby.krish | 빨강+컬러카드 | specular_strobe | 1f snap+0.25s+0.3s, 0.6s/100BPM |
| 03-41-30 | 프리셋쇼케이스 / akhil | 검정+블루웨이브 | flip_text(rotateY), scatter-assemble | scatter0.30s, flip ease-in-out |
| 03-40-56 | 폰트쇼케이스 / akhil | 마젠타 네온 | neon_border_runner | 1바퀴1.5s, 폰트카드0.47s 하드컷 |
| (기존) LangEase | SaaS launch | 그라디언트 | 5단계 단어등장, drift | drift240-540px/s |
| (기존) Base44 | AI앱 | 다채색 | swirl orb, color sweep | zoom0.3s, push250px/s |
| (기존) neonfuel | 칼로리앱 | 검정+주황 | 도넛 ring glow, 키네틱 | ring draw, 배경 검정↔흰 |

공통 결론: 하드컷 지배 + ease-out/linear/하드스냅 + spring 절제 + hold 위 상시 미세모션 + 라이팅으로 프리미엄. 카메라 곡률/휨은 실측엔 없고 사용자 신규 요구(4절 구현 가이드).

---

*이 문서는 엔진 설계 근거. 프리셋 구현 시 7절 수치표를 임의값 대신 사용. 곡률/오디오/생성/컷편집은 신규 구현 영역.*
