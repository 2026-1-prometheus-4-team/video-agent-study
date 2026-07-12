// motion/effects/designverse.tsx
// designverse-fst 전용 합성 element 3종.
//
//   neon_pill  - 네온 그라데이션 보더 + 글로우 알약. 내용 모드 3종:
//                swap(고정 prefix + 단어 롤링 교체), type(글자 타이핑 + 커서),
//                dots(로딩 점 3개).
//   streak     - SVG 스트로크 드로우온. variant: arc(Introducing 스우시),
//                comet(수평 혜성), rect(아웃트로 라운드 사각 테두리),
//                d_trace(네온 D 라인아트 트레이스).
//   badge_logo - 솔리드 배지 아이콘(그라데이션 라운드 사각 + 레터) + 워드마크.
//                옵션으로 로딩 점 pill 동반.
//
// 왜 별도 element 인가:
//   원본 designverse.mp4 의 시그니처가 "네온 보더 안에서 벌어지는 콘텐츠 모션"
//   인데, 기존 text atom 은 보더/글로우/트레이스 개념이 없고 input_box 는
//   biasafe 태그라인 reflow 전용이라 재사용이 안 된다. 셋 다 순수 frame 의
//   결정론적 함수 - 렌더마다 동일.
//
// 타이밍 근거: designverse.mp4 를 8fps 로 추출해 측정(30fps 원본).
//   보라 pill 스왑: 9.06s Marketplace -> ~9.5 a Website -> ~9.9 an App
//   -> ~11.2 Anything (교체 롤 약 7f@24).
//   핑크 pill 타이핑: ~19.2s 시작, 46자 / 2.6s = 약 17cps.
//   아웃트로 rect 드로우: ~73.5s 시작, 약 1.2s.

import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { EASING, clamp01, lerp, type EasingName } from "../core/easing";
import { glowFilter, orbitArcRects, type OrbitSpec } from "./orbitGlow";
import { usePresetTransform, presetWrapStyle, type PresetBase } from "./presetTransform";
import type { ElementKeyframe, ElementTiming } from "../keyframes";

// ---------------------------------------------------------------- 공통

export type DrawRamp = {
  start?: number; // 로컬 프레임. 기본 0
  duration: number; // 프레임
  easing?: EasingName;
};

export function rampT(frame: number, ramp: DrawRamp | undefined, fallback = 1): number {
  if (!ramp) return fallback;
  const start = ramp.start ?? 0;
  const t = clamp01((frame - start) / Math.max(1, ramp.duration));
  return EASING[ramp.easing ?? "easeOut"](t);
}

// ---------------------------------------------------------------- neon_pill

export type NeonPillSwapWord = {
  text: string;
  frame: number; // 이 단어가 자리를 차지하기 시작하는 로컬 프레임
};

// swap 모드 첫 단어(+fixedPrefix)의 글자별 아래->위 스태거 등장.
// text element 의 letter_stagger 와 같은 느낌을 pill 안에서 낸다.
export type NeonPillLetterIn = {
  stagger?: number; // 글자당 지연(프레임). 기본 1
  duration?: number; // 글자 하나 등장 길이(프레임). 기본 5
  rise?: number; // 시작 y 오프셋(em, 아래에서 올라옴). 기본 0.35
  easing?: EasingName;
};

export type NeonPillSpec = {
  element: "neon_pill";
  id?: string;
  // 에디터 표준 transform — base.position/width/height 우선, top-level 은 폴백
  base?: PresetBase;
  keyframes?: ElementKeyframe[];
  timing?: ElementTiming;
  // 지오메트리(vw / 뷰포트 fraction)
  width: number; // vw
  height: number; // vw
  radius?: number; // vw. 기본 height*0.28 (라운드 사각). 알약이면 height/2
  position?: { x: number; y: number }; // 0..1. 기본 0.5/0.5
  // 보더/글로우
  borderColors?: [string, string]; // 좌->우 그라데이션. 기본 보라
  borderWidth?: number; // px. 기본 4
  fillColor?: string; // 기본 #0A0714
  glow?: number; // 0..1 강도. 기본 0.8
  glowPulse?: { amplitude: number; period: number }; // sin 펄스(프레임)
  // 궤도 글로우 — 밝은 호(혜성)가 테두리 둘레를 일정 속도로 돌고 나머지
  // 테두리는 dim 색으로 껌껌하게 남는다 (AI 인풋박스 레퍼런스).
  // 구현: effects/orbitGlow.tsx 공용 헬퍼 (glow_card / glow_menu 와 공유).
  orbit?: OrbitSpec;
  // pill 자체 스케일 램프. 카메라와 달리 pill 만 커지고 배경/다른 element 는
  // 그대로다. 발사 트랜지션처럼 "pill 은 커지는데 뒤의 워프는 연속이어야"
  // 할 때 카메라 대신 쓴다(카메라는 씬 전체를 키워서 다음 씬과 스케일이 끊긴다).
  scaleRamp?: { from?: number; to?: number; ramp?: DrawRamp };
  // 가로 폭만 줄이거나 늘리는 램프(vw). 원본 Build pill 이 룰렛 끝에
  // "Anything" 으로 정착하며 폭이 좁아지는 모션. to 로 목표 폭을 주고
  // 램프 타이밍은 start/duration/easing.
  widthRamp?: DrawRamp & { to: number };
  // 폭 변화 시 고정 기준. "center"(기본) = 중앙 고정(양쪽이 같이 좁아짐).
  // "left" = 왼쪽 모서리 고정 - 오른쪽(바뀌는 단어 쪽) 여백만 줄어들고
  // Build 쪽은 미동 없음(원본 방식). align "left" 와 함께 쓸 것.
  anchor?: "center" | "left";
  // 포탈 모드. pill 내부가 "창"이 되어 뒤 element(워프 등)를 보여주고,
  // pill 밖은 cover(배경과 같은 CSS background 문자열)로 덮는다.
  // scaleRamp 로 창을 키우면 창 안의 배경이 커져서 화면을 채우는 원본
  // 트랜지션이 된다. 이 모드에선 fillColor 를 쓰지 않는다.
  // innerFade 를 주면 구멍 안쪽이 fillColor 로 덮인 상태에서 시작해
  // 램프를 따라 녹으면서 뒤 element 가 드러난다(눌림 씬의 어두운 fill 과
  // 발사 씬의 워프 사이 하드 컷 방지).
  portal?: { cover: string; innerFade?: DrawRamp };
  drawIn?: DrawRamp; // 보더 등장 램프(없으면 즉시 풀 보더). fill 도 이 램프를 따른다
  // 보더 트레이스 시작 진행도(0..1). 0.8 이면 이미 80% 그려진(빈틈만 남은)
  // 상태에서 시작해 drawIn 램프 동안 마저 완성된다. 원본 Build pill 이
  // 이 방식이다. 기본 0(처음부터).
  drawFrom?: number;
  // 트레이스 빈틈의 중심 위치(rect 경로 비율 0..1, 시작점=왼쪽 위에서
  // 시계방향). 지정하면 빈틈이 그 위치에서 양쪽으로 닫히며 완성된다.
  // 원본 Build pill 은 위쪽 중앙-오른쪽(약 0.12)에서 양끝이 만난다.
  drawGap?: number;
  // swap 롤 때 두 단어의 세로 간격(em). 글자 높이보다 커야 단어가
  // 겹치지 않고 확실하게 위/아래로 분리된다. 기본 1.15
  swapGap?: number;
  // swap 롤 중 단어 모션블러 최대치(px). 롤 중간에 최대, 정착 순간 0.
  // 원본 룰렛의 "돌아가는" 잔상 느낌. 기본 10. fixedPrefix 는 안 흐려진다
  swapBlur?: number;
  // 보더 등장 방식. trace = 대시 드로우온, fade = 통짜 페이드인.
  // 원본 product pill(1.3~1.5s)처럼 "단어 먼저, 테두리 나중" 은
  // drawIn.start 를 늦추고 fade 를 쓰는 게 측정과 가장 가깝다.
  drawStyle?: "trace" | "fade";
  // pill 전체(보더+fill+콘텐츠) 페이드아웃. 발사 트랜지션처럼 글로우 속으로
  // 녹아 사라질 때 사용. 없으면 페이드아웃 안 함.
  fadeOut?: DrawRamp;
  // 콘텐츠(단어)만 통째로 아래로 가라앉으며 페이드아웃. 보더/fill 은 남는다.
  // drop 은 가라앉는 깊이(em). 기본 0.6.
  contentOut?: DrawRamp & { drop?: number };
  // 글자별 순차 낙하 퇴장(swap 모드 전용). letterOut 이 있으면 contentOut 보다
  // 우선한다. 글자 i 는 start + i*stagger 프레임부터 duration 동안 drop(em)만큼
  // 내려가며 사라진다. 원본 product pill: 글자들이 차례로 떨어지는 도중
  // 두세 번째 글자쯤에서 pill 전체가 워프에 삼켜진다(fadeOut 과 겹쳐 쓸 것).
  letterOut?: {
    start?: number;
    stagger?: number; // 글자당 지연(프레임). 기본 2
    duration?: number; // 글자 하나 낙하 길이(프레임). 기본 5
    drop?: number; // 낙하 깊이(em). 기본 0.8
    easing?: EasingName;
    // 낙하 진행도 중 페이드가 차지하는 후반 비율(0..1). 기본 0.45.
    // 예: 0.4 이면 낙하의 앞 60% 동안은 완전 불투명하게 떨어지고
    // 마지막 40% 에서만 사라진다. 낙하가 눈에 읽히려면 페이드를
    // 이동과 분리해야 한다(같이 걸면 반쯤 갔을 때 이미 반투명).
    fadePortion?: number;
  };
  // 보더/fill 지오메트리가 큰 사각형에서 pill 로 수렴하는 효과.
  // 원본 product 장면(1.29~1.7s): 테두리가 화면급 크기로 생긴 뒤 줌아웃과
  // 함께 박스로 좁혀진다. 카메라 스케일과 별개로 rect 자체를 보간한다.
  borderFrom?: {
    scaleX?: number; // 시작 폭 배율(pill 대비). 기본 1
    scaleY?: number; // 시작 높이 배율(pill 대비). 기본 1
    ramp?: DrawRamp; // 수렴 램프. 기본 {duration: 10}
  };
  fadeIn?: DrawRamp; // 전체 fade(드로우온과 병행 가능)
  // 콘텐츠
  mode: "swap" | "type" | "dots";
  fontSize?: number; // vw. 기본 height*0.42
  fontWeight?: number; // 기본 600
  color?: string; // 기본 #FFFFFF
  fontFamily?: string;
  paddingLeft?: number; // vw. 기본 width*0.07. 텍스트 좌측 여백
  align?: "left" | "center"; // 기본 swap=center, type=left
  // 콘텐츠 세로 광학 보정(vw, 양수 = 아래로). 폰트 라인박스가 베이스라인
  // 아래 공간을 더 잡아서 flex 중앙정렬이 눈으로는 위로 떠 보일 때 쓴다.
  // 위아래 공백을 맞추려면 fontSize 의 0.06~0.08배 정도가 보통이다
  contentOffsetY?: number;
  // swap 모드
  fixedPrefix?: string; // 예: "Build"
  swapWords?: NeonPillSwapWord[];
  swapDuration?: number; // 교체 롤 프레임. 기본 7
  letterIn?: NeonPillLetterIn; // 첫 단어 글자별 스태거 등장(없으면 즉시 표시)
  // type 모드
  text?: string;
  charsPerSecond?: number; // 기본 15
  typeStart?: number; // 로컬 프레임. 기본 0
  cursor?: boolean; // 기본 true
  caretColor?: string; // 커서 색. 기본 텍스트 색
  // 방금 타이핑된 글자 틴트 — 새 글자가 tint 색으로 찍혔다가 fade 프레임에
  // 걸쳐 본문 색으로 식는다 (레퍼런스: 최근 글자만 보라빛).
  freshTint?: {
    color?: string; // 기본 #A78BFA
    fade?: number; // 식는 데 걸리는 프레임. 기본 14
  };
  // dots 모드
  dotCount?: number; // 기본 3
  dotPeriod?: number; // 프레임. 기본 22
};

// 모노톤 큐빅(Fritsch-Carlson) 보간. C1 연속 + 오버슈트 없음.
// SceneRenderer 의 scaleAtKeyframes 와 같은 방식(릴 인덱스용 로컬 복사).
function monotoneEval(pts: { t: number; s: number }[], t: number): number {
  const n = pts.length;
  if (n === 0) return 0;
  if (t <= pts[0].t) return pts[0].s;
  if (t >= pts[n - 1].t) return pts[n - 1].s;
  const d: number[] = [];
  for (let k = 0; k < n - 1; k++) {
    d.push((pts[k + 1].s - pts[k].s) / (pts[k + 1].t - pts[k].t || 1e-6));
  }
  const m: number[] = [d[0]];
  for (let k = 1; k < n - 1; k++) {
    m.push(d[k - 1] * d[k] <= 0 ? 0 : (d[k - 1] + d[k]) / 2);
  }
  m.push(d[n - 2]);
  for (let k = 0; k < n - 1; k++) {
    if (d[k] === 0) {
      m[k] = 0;
      m[k + 1] = 0;
    } else {
      const a = m[k] / d[k];
      const b = m[k + 1] / d[k];
      const h = Math.hypot(a, b);
      if (h > 3) {
        m[k] = (3 / h) * a * d[k];
        m[k + 1] = (3 / h) * b * d[k];
      }
    }
  }
  let i = 0;
  while (i < n - 2 && t > pts[i + 1].t) i++;
  const p1 = pts[i];
  const p2 = pts[i + 1];
  const dt = p2.t - p1.t || 1e-6;
  const u = (t - p1.t) / dt;
  const u2 = u * u;
  const u3 = u2 * u;
  return (
    (2 * u3 - 3 * u2 + 1) * p1.s +
    (u3 - 2 * u2 + u) * m[i] * dt +
    (-2 * u3 + 3 * u2) * p2.s +
    (u3 - u2) * m[i + 1] * dt
  );
}

// 스왑 스케줄 -> 연속 릴 인덱스 k. 단어 i 의 롤 창은 [frame_i, frame_i + d]
// (d = min(swapDuration, 다음 스왑까지 간격)). 간격이 롤보다 넓으면 창 사이에
// 평평한 구간(정지)이 생겨 각 롤이 부드럽게 멈췄다 출발하고, 룰렛처럼 창이
// 맞닿으면 경계 접선이 이어져 끊김 없이 연속으로 돈다.
function reelIndexAt(
  words: NeonPillSwapWord[],
  frame: number,
  dur: number,
): number {
  if (words.length <= 1) return 0;
  const pts: { t: number; s: number }[] = [
    { t: words[0].frame ?? 0, s: 0 },
  ];
  for (let i = 1; i < words.length; i++) {
    const f = words[i].frame;
    const next = words[i + 1]?.frame;
    const d = Math.max(1, Math.min(dur, (next ?? f + dur) - f));
    const last = pts[pts.length - 1];
    if (f > last.t) pts.push({ t: f, s: i - 1 });
    pts.push({ t: f + d, s: i });
  }
  return monotoneEval(pts, frame);
}

const PillSwapContent: React.FC<{
  spec: NeonPillSpec;
  frame: number;
  emPx: number;
}> = ({ spec, frame, emPx }) => {
  const words = spec.swapWords ?? [];
  const dur = Math.max(1, spec.swapDuration ?? 7);
  let cur = 0;
  for (let i = 0; i < words.length; i++) {
    if (frame >= words[i].frame) cur = i;
  }
  const roll = (spec.swapGap ?? 1.15) * emPx;
  const longest = words.reduce(
    (a, w) => (w.text.length > a.length ? w.text : a),
    "",
  );
  // 연속 릴 인덱스: 룰렛 구간에서도 위치/속도가 끊기지 않는다
  const k = reelIndexAt(words, frame, dur);
  const kBase = Math.floor(k);
  const speed = Math.abs(k - reelIndexAt(words, frame - 1, dur));
  const shrinkStarted = spec.widthRamp
    ? frame >= (spec.widthRamp.start ?? 0)
    : false;
  // 모션블러는 룰렛(폭 축소) 구간에서만. 초반 단일 스왑은 원본처럼 선명하다
  const rollBlur = shrinkStarted
    ? Math.min(spec.swapBlur ?? 10, speed * roll * 0.55)
    : 0;
  // 슬롯 폭 규칙(원본 구조):
  //   룰렛/폭축소 시작 전 - 가장 긴 단어로 고정. 단어만 바뀌고 Build 와
  //     단어 위치는 미동도 없다.
  //   시작 후 - (정착 단어, 다음 단어) 중 긴 쪽. 시작 프레임에도 다음
  //     단어(최장)를 보므로 슬롯이 순간적으로 좁아졌다 돌아오는 튐이 없다.
  const nearText = words[Math.round(k)]?.text ?? "";
  const nextText = words[kBase + 1]?.text ?? "";
  const slotText = !shrinkStarted
    ? longest
    : nearText.length >= nextText.length
      ? nearText
      : nextText;

  // 글자별 순차 낙하 퇴장(letterOut). 현재 단어(+prefix)의 글자들이
  // 인덱스 순서대로 아래로 떨어지며 사라진다. letterIn 과 동시 사용 불가.
  if (spec.letterOut) {
    const lo = spec.letterOut;
    const prefix = spec.fixedPrefix ? `${spec.fixedPrefix} ` : "";
    const word = words[cur]?.text ?? "";
    const exitSpan = (ch: string, idx: number) => {
      const local =
        frame - ((lo.start ?? 0) + idx * (lo.stagger ?? 2));
      const t = clamp01(local / Math.max(1, lo.duration ?? 5));
      const move = EASING[lo.easing ?? "easeIn"](t);
      // 이동과 페이드 분리: 앞 (1-fadePortion) 구간은 불투명하게 떨어지고
      // 마지막 fadePortion 구간에서만 사라진다.
      const fp = Math.min(0.95, Math.max(0.05, lo.fadePortion ?? 0.45));
      const op = t <= 1 - fp ? 1 : clamp01(1 - (t - (1 - fp)) / fp);
      return (
        <span
          key={idx}
          style={{
            display: "inline-block",
            whiteSpace: "pre",
            opacity: op,
            transform: `translateY(${(move * (lo.drop ?? 0.8)).toFixed(3)}em)`,
          }}
        >
          {ch}
        </span>
      );
    };
    return (
      <span style={{ display: "inline-flex", whiteSpace: "pre" }}>
        {prefix.split("").map((c, i) => exitSpan(c, i))}
        <span style={{ position: "relative", display: "inline-block" }}>
          <span style={{ opacity: 0 }}>{longest}</span>
          <span style={{ position: "absolute", left: 0, top: 0, whiteSpace: "pre" }}>
            {word.split("").map((c, i) => exitSpan(c, prefix.length + i))}
          </span>
        </span>
      </span>
    );
  }

  // 첫 단어 글자별 스태거 등장(letterIn). 스왑이 시작되기 전(cur === 0)에만.
  if (spec.letterIn && cur === 0) {
    const li = spec.letterIn;
    const prefix = spec.fixedPrefix ? `${spec.fixedPrefix} ` : "";
    const word = words[0]?.text ?? "";
    const letterSpan = (ch: string, idx: number) => {
      const t = clamp01(
        (frame - idx * (li.stagger ?? 1)) / Math.max(1, li.duration ?? 5),
      );
      const e = EASING[li.easing ?? "easeOut"](t);
      return (
        <span
          key={idx}
          style={{
            display: "inline-block",
            whiteSpace: "pre",
            opacity: e,
            transform: `translateY(${((1 - e) * (li.rise ?? 0.35)).toFixed(3)}em)`,
          }}
        >
          {ch}
        </span>
      );
    };
    return (
      <span style={{ display: "inline-flex", whiteSpace: "pre" }}>
        {prefix.split("").map((c, i) => letterSpan(c, i))}
        <span style={{ position: "relative", display: "inline-block" }}>
          <span style={{ opacity: 0 }}>{longest}</span>
          <span style={{ position: "absolute", left: 0, top: 0, whiteSpace: "pre" }}>
            {word.split("").map((c, i) => letterSpan(c, prefix.length + i))}
          </span>
        </span>
      </span>
    );
  }

  // 릴 렌더: k 주변 인덱스의 단어들을 (j - k) * roll 위치에 그린다.
  // 새 단어는 아래(+)에서 올라오고 헌 단어는 위(-)로 나간다. 간격이 항상
  // roll 이라 겹치지 않고, 노출/은닉은 pill 의 overflow 클리핑이 담당한다.
  const reelWords: { j: number; text: string }[] = [];
  for (let j = kBase - 1; j <= kBase + 1; j++) {
    if (j >= 0 && j < words.length) {
      reelWords.push({ j, text: words[j].text });
    }
  }
  return (
    <span style={{ display: "inline-flex", whiteSpace: "pre" }}>
      {spec.fixedPrefix ? <span>{spec.fixedPrefix} </span> : null}
      <span style={{ position: "relative", display: "inline-block" }}>
        {/* 폭 자리 확보: 정착 시 현재 단어, 롤 중엔 긴 쪽 */}
        <span style={{ opacity: 0 }}>{slotText}</span>
        {reelWords.map(({ j, text }) => {
          const y = (j - k) * roll;
          // 한 칸(roll) 이상 떨어진 단어는 아예 그리지 않는다.
          // 대기 상태에서 다음 단어 글자 윗부분이 클리핑 밖으로
          // 삐져나와 미리 보이는 문제 방지 - 롤이 실제로 움직여
          // 한 칸 안으로 들어온 순간부터 보인다.
          if (Math.abs(y) >= roll * 0.98) return null;
          return (
            <span
              key={j}
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                transform:
                  Math.abs(y) > 0.05
                    ? `translateY(${y.toFixed(1)}px)`
                    : undefined,
                filter:
                  rollBlur > 0.3
                    ? `blur(${rollBlur.toFixed(1)}px)`
                    : undefined,
                whiteSpace: "pre",
              }}
            >
              {text}
            </span>
          );
        })}
      </span>
    </span>
  );
};

// hex 두 색을 t(0..1)로 섞는다. freshTint 전용 — 짧은 문자열이라 파싱 단순화.
function mixHexPair(a: string, b: string, t: number): string {
  const six = /^#[0-9a-fA-F]{6}$/;
  if (!six.test(a) || !six.test(b)) return t >= 1 ? b : a; // hex 아니면 스냅
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (sh: number) =>
    Math.round(lerp((pa >> sh) & 255, (pb >> sh) & 255, t));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

const PillTypeContent: React.FC<{
  spec: NeonPillSpec;
  frame: number;
  fps: number;
}> = ({ spec, frame, fps }) => {
  const text = spec.text ?? "";
  const cps = spec.charsPerSecond ?? 15;
  const start = spec.typeStart ?? 0;
  const shown =
    frame < start
      ? 0
      : Math.min(text.length, Math.floor(((frame - start) / fps) * cps));
  const typing = shown < text.length;
  const caretOn =
    (spec.cursor ?? true) && (typing || Math.floor(frame / 12) % 2 === 0);
  const caret = (
    <span
      style={{
        display: "inline-block",
        width: "0.09em",
        height: "1.05em",
        marginLeft: "0.06em",
        verticalAlign: "-0.16em",
        borderRadius: "0.05em",
        background: spec.caretColor ?? "currentColor",
        opacity: caretOn ? 0.9 : 0,
      }}
    />
  );
  const ft = spec.freshTint;
  if (!ft || shown === 0) {
    return (
      <span style={{ whiteSpace: "pre" }}>
        {text.slice(0, shown)}
        {caret}
      </span>
    );
  }
  // 최근 글자 틴트: 글자 i 의 등장 프레임에서 fade 프레임 동안 tint -> 본문색.
  // 아직 식는 중인 꼬리 글자들만 per-char span, 앞부분은 통짜 문자열(레이아웃 절약).
  const tint = ft.color ?? "#A78BFA";
  const fade = Math.max(1, ft.fade ?? 14);
  const base = spec.color ?? "#FFFFFF";
  const appearAt = (i: number) => start + Math.ceil(((i + 1) * fps) / cps);
  // fade 가 끝난(본문색으로 식은) 글자 수 — 그 앞까지는 통짜로
  let cold = 0;
  while (cold < shown && frame - appearAt(cold) >= fade) cold++;
  return (
    <span style={{ whiteSpace: "pre" }}>
      {text.slice(0, cold)}
      {text
        .slice(cold, shown)
        .split("")
        .map((chr, j) => {
          const t = clamp01((frame - appearAt(cold + j)) / fade);
          return (
            <span key={cold + j} style={{ color: mixHexPair(tint, base, t) }}>
              {chr}
            </span>
          );
        })}
      {caret}
    </span>
  );
};

const PillDotsContent: React.FC<{ spec: NeonPillSpec; frame: number }> = ({
  spec,
  frame,
}) => {
  const n = spec.dotCount ?? 3;
  const period = spec.dotPeriod ?? 22;
  return (
    <span style={{ display: "inline-flex", gap: "0.45em", alignItems: "center" }}>
      {Array.from({ length: n }).map((_, i) => {
        const phase = (frame / period) * Math.PI * 2 - i * 0.9;
        const o = 0.25 + 0.75 * clamp01(0.5 + 0.5 * Math.sin(phase));
        return (
          <span
            key={i}
            style={{
              width: "0.28em",
              height: "0.28em",
              borderRadius: "50%",
              background: "currentColor",
              opacity: o,
              display: "inline-block",
            }}
          />
        );
      })}
    </span>
  );
};

export const NeonPill: React.FC<{ spec: NeonPillSpec }> = ({ spec }) => {
  // 에디터 표준 transform (base + 키프레임 + 트림 게이트). frame 은 클립-로컬.
  const et = usePresetTransform(spec);
  const frame = et.frame;
  const { width, height, fps } = useVideoConfig();
  const gradId = React.useId();

  const baseW = spec.base?.width ?? spec.width;
  const baseH = spec.base?.height ?? spec.height;
  const widthVw = spec.widthRamp
    ? lerp(baseW, spec.widthRamp.to, rampT(frame, spec.widthRamp))
    : baseW;
  const pillW = (widthVw / 100) * width;
  const pillH = (baseH / 100) * width;
  const radius = ((spec.radius ?? baseH * 0.28) / 100) * width;
  const bw = spec.borderWidth ?? 4;
  const pos = et.pos;
  const [c1, c2] = spec.borderColors ?? ["#8A5CF6", "#A855F7"];
  const fill = spec.fillColor ?? "#0A0714";

  const drawFrom = Math.min(1, Math.max(0, spec.drawFrom ?? 0));
  const drawT = drawFrom + (1 - drawFrom) * rampT(frame, spec.drawIn);
  // et.opacity(base/키프레임)를 여기 한 번 곱해 portal/일반 두 분기 모두 적용
  const fadeT = rampT(frame, spec.fadeIn) * (1 - rampT(frame, spec.fadeOut, 0)) * et.opacity;
  const pulse = spec.glowPulse
    ? 1 +
      spec.glowPulse.amplitude *
        Math.sin((frame / Math.max(1, spec.glowPulse.period)) * Math.PI * 2)
    : 1;
  const glow = (spec.glow ?? 0.8) * pulse * drawT;

  const fontPx = ((spec.fontSize ?? spec.height * 0.42) / 100) * width;
  const padL = ((spec.paddingLeft ?? spec.width * 0.07) / 100) * width;
  const align = spec.align ?? (spec.mode === "type" ? "left" : "center");

  const sr = spec.scaleRamp;
  const selfScale = sr
    ? lerp(sr.from ?? 1, sr.to ?? 1, rampT(frame, sr.ramp ?? { duration: 10 }))
    : 1;

  // 포탈 모드: cover 에 pill 모양 구멍을 뚫어(clipPath evenodd) 구멍 안으로만
  // 뒤 element 가 보인다. 구멍은 균등 스케일이 아니라 "pill 모양 -> 화면 모양"
  // 으로 축별 보간된다. 그래서 다 커지면 화면 비율에 딱 맞게 꽉 찬다.
  // 성장 타이밍은 scaleRamp.ramp, 시작 크기는 scaleRamp.from 을 쓴다
  // (scaleRamp.to 는 포탈 모드에선 무시 - 목표가 항상 화면 전체라서).
  if (!et.visible) return null; // 클립 트림 게이트
  // portal 모드는 화면 전체 이펙트라 회전/스케일 transform 을 적용하지 않는다
  if (spec.portal) {
    const growT = sr ? rampT(frame, sr.ramp ?? { duration: 10 }) : 1;
    const baseScale = sr?.from ?? 1;
    const pw = lerp(pillW * baseScale, width * 1.04, growT);
    const ph = lerp(pillH * baseScale, height * 1.04, growT);
    const pr = Math.min(lerp(radius * baseScale, 8, growT), ph / 2);
    const contentScale = ph / pillH;
    const cx = pos.x * width;
    const cy = pos.y * height;
    const x0 = cx - pw / 2;
    const y0 = cy - ph / 2;
    const hole =
      `M${(x0 + pr).toFixed(1)} ${y0.toFixed(1)}` +
      `H${(x0 + pw - pr).toFixed(1)}` +
      `A${pr.toFixed(1)} ${pr.toFixed(1)} 0 0 1 ${(x0 + pw).toFixed(1)} ${(y0 + pr).toFixed(1)}` +
      `V${(y0 + ph - pr).toFixed(1)}` +
      `A${pr.toFixed(1)} ${pr.toFixed(1)} 0 0 1 ${(x0 + pw - pr).toFixed(1)} ${(y0 + ph).toFixed(1)}` +
      `H${(x0 + pr).toFixed(1)}` +
      `A${pr.toFixed(1)} ${pr.toFixed(1)} 0 0 1 ${x0.toFixed(1)} ${(y0 + ph - pr).toFixed(1)}` +
      `V${(y0 + pr).toFixed(1)}` +
      `A${pr.toFixed(1)} ${pr.toFixed(1)} 0 0 1 ${(x0 + pr).toFixed(1)} ${y0.toFixed(1)}Z`;
    return (
      <div style={{ position: "absolute", inset: 0 }}>
        <svg width={0} height={0} style={{ position: "absolute" }}>
          <defs>
            <clipPath id={`${gradId}-hole`} clipPathUnits="userSpaceOnUse">
              <path
                clipRule="evenodd"
                d={`M0 0H${width}V${height}H0Z ${hole}`}
              />
            </clipPath>
            <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={c1} />
              <stop offset="100%" stopColor={c2} />
            </linearGradient>
          </defs>
        </svg>
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: spec.portal.cover,
            clipPath: `url(#${gradId}-hole)`,
          }}
        />
        {spec.portal.innerFade ? (
          <svg
            width={width}
            height={height}
            style={{ position: "absolute", inset: 0 }}
          >
            <path
              d={hole}
              fill={fill}
              opacity={1 - rampT(frame, spec.portal.innerFade)}
            />
          </svg>
        ) : null}
        <svg
          width={width}
          height={height}
          style={{ position: "absolute", inset: 0, overflow: "visible", opacity: fadeT }}
        >
          <rect
            x={x0}
            y={y0}
            width={pw}
            height={ph}
            rx={pr}
            fill="none"
            stroke={`url(#${gradId})`}
            strokeWidth={bw * contentScale}
            style={{ filter: glowFilter(c1, glow * Math.min(contentScale, 2.2)) }}
          />
        </svg>
        <div
          style={{
            position: "absolute",
            left: cx - pillW / 2,
            top: cy - pillH / 2,
            width: pillW,
            height: pillH,
            transform: `scale(${contentScale.toFixed(4)})`,
            transformOrigin: "50% 50%",
            display: "flex",
            alignItems: "center",
            justifyContent: align === "left" ? "flex-start" : "center",
            paddingLeft: align === "left" ? padL : 0,
            fontSize: fontPx,
            fontWeight: spec.fontWeight ?? 600,
            color: spec.color ?? "#FFFFFF",
            fontFamily: spec.fontFamily,
            overflow: "hidden",
            borderRadius: radius,
            opacity: fadeT,
          }}
        >
          {spec.mode === "swap" ? (
            <PillSwapContent spec={spec} frame={frame} emPx={fontPx} />
          ) : spec.mode === "type" ? (
            <PillTypeContent spec={spec} frame={frame} fps={fps} />
          ) : (
            <PillDotsContent spec={spec} frame={frame} />
          )}
        </div>
      </div>
    );
  }

  // anchor "left": 왼쪽 모서리를 원래 폭 기준 위치에 고정 - widthRamp 로
  // 좁아질 때 오른쪽 모서리만 안으로 들어온다
  const pillLeft =
    spec.anchor === "left"
      ? pos.x * width - ((spec.width / 100) * width) / 2
      : pos.x * width - pillW / 2;

  return (
    <div
      style={{
        position: "absolute",
        left: pillLeft,
        top: pos.y * height - pillH / 2,
        width: pillW,
        height: pillH,
        opacity: fadeT,
        // scaleRamp(selfScale) 와 에디터 transform(회전/스케일/블러) 합성
        transform: (() => {
          const parts: string[] = [];
          if (sr) parts.push(`scale(${selfScale.toFixed(4)})`);
          const wrap = presetWrapStyle(et).transform;
          if (wrap) parts.push(wrap);
          return parts.length ? parts.join(" ") : undefined;
        })(),
        filter: presetWrapStyle(et).filter,
        transformOrigin: "50% 50%",
      }}
    >
      <svg
        width={pillW}
        height={pillH}
        style={{ position: "absolute", inset: 0, overflow: "visible" }}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={c1} />
            <stop offset="100%" stopColor={c2} />
          </linearGradient>
        </defs>
        {(() => {
          // borderFrom: rect 지오메트리를 (scaleX, scaleY)배 크기에서 pill 로 수렴
          const bf = spec.borderFrom;
          const bfT = bf ? rampT(frame, bf.ramp ?? { duration: 10 }) : 1;
          const sx = lerp(bf?.scaleX ?? 1, 1, bfT);
          const sy = lerp(bf?.scaleY ?? 1, 1, bfT);
          const gw = (pillW - bw) * sx;
          const gh = (pillH - bw) * sy;
          const gx = bw / 2 + (pillW - bw - gw) / 2;
          const gy = bw / 2 + (pillH - bw - gh) / 2;
          const gr = radius * (sx + sy) / 2;
          // orbit: 밝은 혜성 호가 테두리를 돈다 — 베이스 링은 dim 색으로 깔고
          // 그 위에 공용 orbitArcRects 4겹을 얹는다.
          const orb = spec.orbit;
          const orbitArcs = orb
            ? orbitArcRects({
                orb,
                frame,
                x: gx,
                y: gy,
                w: gw,
                h: gh,
                r: gr,
                bw,
                glow,
                opacity: drawT,
                fallback: [c1, c2],
              })
            : null;
          return (
            <>
              <rect
                x={gx}
                y={gy}
                width={gw}
                height={gh}
                rx={gr}
                fill={fill}
                opacity={drawT}
              />
              <rect
                x={gx}
                y={gy}
                width={gw}
                height={gh}
                rx={gr}
                fill="none"
                stroke={orb ? (orb.dim ?? "rgba(124,92,246,0.16)") : `url(#${gradId})`}
                strokeWidth={bw}
                pathLength={1}
                strokeDasharray={
                  // drawGap 모드: 패턴 주기를 경로 길이(1)와 일치시켜야
                  // 닫힌 경로에서 wrap 이 돼 빈틈이 완전히 닫힌다
                  spec.drawStyle === "fade"
                    ? 1
                    : spec.drawGap != null
                      ? `${Math.max(drawT, 0.001).toFixed(4)} ${(1 - Math.max(drawT, 0.001)).toFixed(4)}`
                      : 1
                }
                strokeDashoffset={
                  spec.drawStyle === "fade"
                    ? 0
                    : spec.drawGap != null
                      ? -(spec.drawGap + (1 - drawT) / 2)
                      : 1 - drawT
                }
                opacity={spec.drawStyle === "fade" ? drawT : 1}
                style={{ filter: orb ? undefined : glowFilter(c1, glow) }}
              />
              {orbitArcs}
            </>
          );
        })()}
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: align === "left" ? "flex-start" : "center",
          paddingLeft: align === "left" ? padL : 0,
          fontSize: fontPx,
          fontWeight: spec.fontWeight ?? 600,
          color: spec.color ?? "#FFFFFF",
          fontFamily: spec.fontFamily,
          overflow: "hidden",
          borderRadius: radius,
          opacity: 1 - rampT(frame, spec.contentOut, 0),
          transform: (() => {
            const optical = ((spec.contentOffsetY ?? 0) / 100) * width;
            const drop = spec.contentOut
              ? rampT(frame, spec.contentOut, 0) *
                (spec.contentOut.drop ?? 0.6) *
                fontPx
              : 0;
            const y = optical + drop;
            return Math.abs(y) > 0.05 ? `translateY(${y.toFixed(1)}px)` : undefined;
          })(),
        }}
      >
        {spec.mode === "swap" ? (
          <PillSwapContent spec={spec} frame={frame} emPx={fontPx} />
        ) : spec.mode === "type" ? (
          <PillTypeContent spec={spec} frame={frame} fps={fps} />
        ) : (
          <PillDotsContent spec={spec} frame={frame} />
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------- streak

export type StreakSpec = {
  element: "streak";
  id?: string;
  variant: "arc" | "comet" | "rect" | "d_trace";
  colors?: [string, string]; // 그라데이션. 기본 보라->핑크
  strokeWidth?: number; // px. 기본 5
  glow?: number; // 0..1. 기본 0.9
  draw?: DrawRamp; // 드로우온. 기본 {duration:10}. travel 모드에선 등장 페이드로 쓰인다
  fadeOut?: DrawRamp; // 로컬 프레임 기준 fade out
  // 배치 박스(뷰포트 fraction). variant 별 기본값 있음
  box?: { x: number; y: number; w: number; h: number };
  radius?: number; // rect 전용. h 대비 fraction. 기본 0.18
  // 네온사인 빛번짐(px). 스트로크 코어와 헤일로 전체에 살짝 블러를 얹어
  // 원본의 튜브 발광 느낌을 낸다. 기본 0(없음). 원본 기준 1.2~1.8 권장
  bleed?: number;
  // arc 전용: 아치 꼭짓점의 가로 위치(box.w 대비 0..1). 기본 0.5.
  apexX?: number;
  // arc 전용: 오른쪽 훅. 아치 끝에서 오른쪽 아래로 감아 내려가는 두 번째
  // 곡선(원본 Introducing 의 "감싸는" 모양). 제어점을 아치 끝 접선 위에
  // 놓아서(k) 꺾임 없이 이어진다. 끝점은 화면 안에 두는 게 원본과 같다.
  //   x: 끝점 가로(box.w 배수, 기본 1.15 = 화면 안 오른쪽)
  //   y: 끝점 세로(box.h 배수, 기본 1.12)
  //   k: 접선 방향 제어점 거리(0.2~0.6, 클수록 완만). 기본 0.35
  hook?: { x?: number; y?: number; k?: number };
  // 이동 모드. 지정하면 스트로크가 "다 그려지고 정지"하는 대신, 보이는
  // 구간(span)이 경로를 따라 계속 미끄러진다(원본 Introducing 아크,
  // D 액센트 선의 시계방향 이동). easing 을 easeOut 으로 주면 갈수록
  // 감속한다. d_trace 에선 액센트(핑크) path 에만 적용되고 흰 D 라인아트는
  // 기존 드로우온을 유지한다.
  travel?: {
    start?: number; // 이동 시작 로컬 프레임. 기본 0
    duration?: number; // 이동 프레임. 기본 24
    span?: number; // 보이는 구간 비율(0..1). 기본 0.7
    from?: number; // 시작 위치(경로 비율). growMode 에 따라 꼬리 또는 중심. 기본 0
    distance?: number; // 총 이동량(경로 비율, 음수면 반대 방향). 기본 0.5
    easing?: EasingName;
    // 속도 프로파일. "ease"(기본) = easing 하나로 진행.
    // "out_in" = 빠르게 출발 -> 중간 감속 -> 씬 끝으로 갈수록 재가속.
    // out_in 일 땐 easing 은 무시된다.
    profile?: "ease" | "out_in";
    // 구간 길이 성장 램프. 지정하면 선이 spanFrom 에서 span 까지 자라며
    // 등장한다(원본 Introducing 아크: 왼쪽~중간까지 이미 있고 오른쪽으로
    // 길어짐 = from 0 + spanFrom 0.55). 없으면 처음부터 풀 길이.
    grow?: DrawRamp;
    // 성장 시작 길이(경로 비율). 기본 0. grow 와 함께 쓴다.
    spanFrom?: number;
    // grow 시 from 해석. "forward"(기본) = from 이 꼬리(성장은 진행 방향).
    // "center" = from 이 중심(양쪽으로 길어짐).
    growMode?: "forward" | "center";
    // d_trace 전용: 흰 D 라인아트에 적용할 크롤 대시. travel 이 있으면
    // 흰 선은 빈틈이 보이는 반복 대시로 천천히 기어간다.
    // from 은 빈틈 위치 조정용(원본: 왼쪽 아래 획, 위로 크롤 = 음수 distance).
    white?: { span?: number; distance?: number; from?: number };
  };
};

const STREAK_DEFAULT_BOX: Record<StreakSpec["variant"], { x: number; y: number; w: number; h: number }> = {
  arc: { x: 0.11, y: 0.14, w: 0.76, h: 0.2 },
  comet: { x: 0.08, y: 0.18, w: 0.34, h: 0 },
  rect: { x: 0.29, y: 0.18, w: 0.42, h: 0.64 },
  d_trace: { x: 0.38, y: 0.2, w: 0.24, h: 0.6 },
};

// d_trace 라인아트: (0..1, 0..1) 로컬 좌표의 path 4개.
// 순서대로 약간씩 늦게 드로우 - 스템/스터브 -> 외곽 보울 -> 내부 보울 -> 액센트.
// crawl: travel 지정 시 빈틈 크롤 대시를 적용할 흰 path (왼쪽 스템만.
// 원본에서 맨 오른쪽 외곽 보울은 틈 없이 통짜다).
const D_PATHS: {
  d: string;
  accent?: boolean;
  crawl?: boolean;
  delay: number;
  span: number;
}[] = [
  {
    d: "M 0.46 0.10 L 0.24 0.10 L 0.24 0.90 L 0.46 0.90",
    crawl: true,
    delay: 0,
    span: 0.45,
  },
  { d: "M 0.46 0.10 C 0.86 0.10 0.86 0.90 0.46 0.90", delay: 0.2, span: 0.45 },
  { d: "M 0.42 0.32 C 0.64 0.32 0.64 0.68 0.42 0.68 L 0.42 0.32", delay: 0.45, span: 0.4 },
  {
    d: "M 0.60 0.00 C 0.96 0.00 1.04 0.14 1.04 0.50 C 1.04 0.86 0.96 1.00 0.60 1.00",
    accent: true,
    delay: 0.3,
    span: 0.7,
  },
];

export const Streak: React.FC<{ spec: StreakSpec }> = ({ spec }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const gradId = React.useId();

  const box = spec.box ?? STREAK_DEFAULT_BOX[spec.variant];
  const [c1, c2] = spec.colors ?? ["#8A5CF6", "#FF2EA6"];
  const sw = spec.strokeWidth ?? 5;
  const glow = spec.glow ?? 0.9;
  const drawT = rampT(frame, spec.draw ?? { duration: 10 });
  const fade =
    spec.fadeOut == null ? 1 : 1 - rampT(frame, spec.fadeOut, 0);

  const bx = box.x * width;
  const by = box.y * height;
  const bw = box.w * width;
  const bh = box.h * height;

  // 네온 빛번짐: 글로우 헤일로 뒤에 전체 블러를 살짝 얹는다
  const withBleed = (f: string | undefined): string | undefined => {
    const b = spec.bleed ?? 0;
    if (b <= 0) return f;
    return `${f ?? ""} blur(${b}px)`.trim();
  };

  const stroke = `url(#${gradId})`;
  const common = {
    fill: "none" as const,
    strokeLinecap: "round" as const,
    strokeWidth: sw,
    pathLength: 1,
  };

  // travel 모드: 대시 구간을 경로 위에서 이동. 진행도는 travel.easing 을
  // 따르므로 easeOut 이면 감속하며 계속 흐른다.
  const tv = spec.travel;
  const travLinear = tv
    ? clamp01((frame - (tv.start ?? 0)) / Math.max(1, tv.duration ?? 24))
    : 0;
  // out_in: 전반은 easeOut(감속), 후반은 easeIn(재가속) 을 이어붙인 프로파일
  const travT = !tv
    ? 0
    : tv.profile === "out_in"
      ? travLinear < 0.5
        ? EASING.easeOut(travLinear * 2) * 0.5
        : 0.5 + EASING.easeIn(travLinear * 2 - 1) * 0.5
      : EASING[tv.easing ?? "easeOut"](travLinear);
  const dashProps = (drawnOffset: number) => {
    if (!tv) {
      return { strokeDasharray: 1, strokeDashoffset: drawnOffset, opacity: 1 };
    }
    const span = Math.min(0.98, Math.max(0.05, tv.span ?? 0.7));
    // grow: 구간 길이가 spanFrom -> span 으로 자라며 등장
    const spanT = Math.max(
      0.001,
      lerp(tv.spanFrom ?? 0, span, rampT(frame, tv.grow, 1)),
    );
    // growMode center 면 from 이 중심이라 꼬리 = from - spanT/2 (양쪽 성장)
    const tail =
      tv.growMode === "center" ? (tv.from ?? 0) - spanT / 2 : (tv.from ?? 0);
    // 갭을 경로(pathLength=1)보다 훨씬 길게 잡아 패턴 반복을 차단한다.
    // 갭이 (1 - span) 이면 구간이 경로 끝을 넘을 때 반대쪽 끝에 조각이
    // 하나 더 생겨 선이 끊겨 보인다.
    return {
      strokeDasharray: `${spanT.toFixed(4)} 3`,
      strokeDashoffset: -(tail + (tv.distance ?? 0.5) * travT),
      opacity: drawT,
    };
  };

  return (
    <svg
      width={width}
      height={height}
      style={{
        position: "absolute",
        inset: 0,
        overflow: "visible",
        opacity: fade,
      }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={c1} />
          <stop offset="100%" stopColor={c2} />
        </linearGradient>
      </defs>
      {spec.variant === "arc" ? (
        <path
          d={(() => {
            // 훅 제어점을 아치 끝 접선 위에 놓아 접선 연속(꺾임 없음)을 보장
            const apex = spec.apexX ?? 0.5;
            const arch = `M ${bx} ${by + bh * 0.45} Q ${bx + bw * apex} ${by} ${bx + bw} ${by + bh * (spec.hook ? 0.55 : 0.9)}`;
            if (!spec.hook) return arch;
            const k = spec.hook.k ?? 0.35;
            const c2x = bx + bw + k * bw * (1 - apex);
            const c2y = by + bh * 0.55 + k * bh * 0.55;
            const ex = bx + bw * (spec.hook.x ?? 1.15);
            const ey = by + bh * (spec.hook.y ?? 1.12);
            return `${arch} Q ${c2x} ${c2y} ${ex} ${ey}`;
          })()}
          {...common}
          stroke={stroke}
          {...dashProps(1 - drawT)}
          style={{ filter: withBleed(glowFilter(c2, glow * drawT)) }}
        />
      ) : null}
      {spec.variant === "comet" ? (
        <path
          d={`M ${bx} ${by} L ${bx + bw} ${by}`}
          {...common}
          stroke={stroke}
          {...dashProps(1 - drawT)}
          style={{ filter: withBleed(glowFilter(c1, glow * drawT)) }}
        />
      ) : null}
      {spec.variant === "rect" ? (
        <rect
          x={bx}
          y={by}
          width={bw}
          height={bh}
          rx={bh * (spec.radius ?? 0.18)}
          {...common}
          stroke={stroke}
          {...dashProps(1 - drawT)}
          style={{ filter: withBleed(glowFilter(c2, glow * drawT)) }}
        />
      ) : null}
      {spec.variant === "d_trace"
        ? D_PATHS.map((p, i) => {
            const local = clamp01((drawT - p.delay) / p.span);
            if (local <= 0) return null;
            // 로컬 0..1 좌표를 배치 박스로 스케일
            const d = p.d.replace(
              /(-?\d*\.?\d+)\s+(-?\d*\.?\d+)/g,
              (_, xs: string, ys: string) =>
                `${(bx + parseFloat(xs) * bw).toFixed(1)} ${(by + parseFloat(ys) * bh).toFixed(1)}`,
            );
            // travel 지정 시: 액센트(핑크)는 끊김 없는 슬라이드,
            // crawl 표시된 흰 path 만 빈틈 크롤 대시(원본: 왼쪽 스템),
            // 나머지 흰 path(오른쪽 외곽 보울 등)는 틈 없이 드로우온 후 정지.
            const wSpan = Math.min(
              0.95,
              Math.max(0.3, tv?.white?.span ?? 0.85),
            );
            const wDist = tv?.white?.distance ?? (tv?.distance ?? 0.5) * 0.3;
            const dash =
              !tv || (!p.accent && !p.crawl)
                ? {
                    strokeDasharray: 1 as number | string,
                    strokeDashoffset: 1 - local,
                    opacity: 1,
                  }
                : p.accent
                  ? dashProps(1 - local)
                  : {
                      strokeDasharray: `${wSpan} ${(1 - wSpan).toFixed(3)}`,
                      strokeDashoffset: -(
                        (tv.white?.from ?? tv.from ?? 0) +
                        wDist * travT
                      ),
                      opacity: Math.min(1, local * 1.5),
                    };
            return (
              <path
                key={i}
                d={d}
                {...common}
                strokeWidth={p.accent ? sw : sw * 0.9}
                stroke={p.accent ? stroke : "#F4EFFA"}
                {...dash}
                style={{
                  filter: withBleed(
                    glowFilter(p.accent ? c2 : "#C9B8F0", glow * local),
                  ),
                }}
              />
            );
          })
        : null}
    </svg>
  );
};

// ---------------------------------------------------------------- badge_logo

type EnterRamp = {
  duration: number;
  delay?: number;
  easing?: EasingName;
};

export type BadgeLogoSpec = {
  element: "badge_logo";
  id?: string;
  letter: string; // 배지 안 레터. 예: "D"
  wordmark?: string; // 옆 워드마크. 예: "DesignVerse"
  size?: number; // 배지 한 변(vw). 기본 7
  wordmarkSize?: number; // vw. 기본 size*0.78
  gap?: number; // 배지-워드마크 간격(vw). 기본 1.6
  position?: { x: number; y: number }; // 묶음 중심. 기본 0.5/0.5
  badgeColors?: [string, string]; // 기본 보라 그라데이션
  rimColor?: string; // 외곽 글로우. 기본 #FF2EA6
  letterColor?: string; // 기본 #FFFFFF
  wordmarkColor?: string; // 기본 #F4EFFA
  wordmarkWeight?: number; // 기본 700
  fontFamily?: string;
  scaleIn?: EnterRamp & { from?: number }; // 배지 팝인. 기본 {duration:10, from:0.6}
  wordmarkIn?: EnterRamp; // 워드마크 페이드+슬라이드. 기본 {duration:9, delay:4}
  loader?: { period?: number; width?: number; height?: number }; // 로딩 점 pill 동반
};

export const BadgeLogo: React.FC<{ spec: BadgeLogoSpec }> = ({ spec }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  const size = ((spec.size ?? 7) / 100) * width;
  const wmSize = ((spec.wordmarkSize ?? (spec.size ?? 7) * 0.78) / 100) * width;
  const gap = ((spec.gap ?? 1.6) / 100) * width;
  const pos = spec.position ?? { x: 0.5, y: 0.5 };
  const [b1, b2] = spec.badgeColors ?? ["#8A5CF6", "#C026D3"];
  const rim = spec.rimColor ?? "#FF2EA6";

  const sIn = spec.scaleIn ?? { duration: 10 };
  const sT = rampT(frame, { ...sIn, start: sIn.delay ?? 0 });
  const scale = lerp(sIn.from ?? 0.6, 1, EASING[sIn.easing ?? "easeOutBack"](
    clamp01((frame - (sIn.delay ?? 0)) / Math.max(1, sIn.duration)),
  ));

  const wIn = spec.wordmarkIn ?? { duration: 9, delay: 4 };
  const wT = clamp01((frame - (wIn.delay ?? 0)) / Math.max(1, wIn.duration));
  const wEase = EASING[wIn.easing ?? "easeOut"](wT);

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width,
        height,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transform: `translate(${(pos.x - 0.5) * width}px, ${(pos.y - 0.5) * height}px)`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap }}>
        <div
          style={{
            width: size,
            height: size,
            borderRadius: size * 0.3,
            background: `linear-gradient(135deg, ${b1}, ${b2})`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transform: `scale(${scale.toFixed(3)})`,
            opacity: sT,
            boxShadow: `0 0 ${size * 0.25}px ${rim}66, 0 0 ${size * 0.6}px ${b1}55`,
          }}
        >
          <span
            style={{
              fontSize: size * 0.6,
              fontWeight: 800,
              color: spec.letterColor ?? "#FFFFFF",
              fontFamily: spec.fontFamily,
              lineHeight: 1,
            }}
          >
            {spec.letter}
          </span>
        </div>
        {spec.wordmark ? (
          <span
            style={{
              fontSize: wmSize,
              fontWeight: spec.wordmarkWeight ?? 700,
              color: spec.wordmarkColor ?? "#F4EFFA",
              fontFamily: spec.fontFamily,
              opacity: wEase,
              transform: `translateX(${lerp(-size * 0.2, 0, wEase).toFixed(1)}px)`,
              whiteSpace: "nowrap",
            }}
          >
            {spec.wordmark}
          </span>
        ) : null}
        {spec.loader ? (
          <div
            style={{
              marginLeft: gap * 0.5,
              width: ((spec.loader.width ?? 11) / 100) * width,
              height: ((spec.loader.height ?? 4.2) / 100) * width,
              borderRadius: 9999,
              border: `3px solid ${b1}`,
              boxShadow: `0 0 18px ${b1}88`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "0.5em",
              color: "#F4EFFA",
              fontSize: wmSize * 0.5,
              opacity: wEase,
            }}
          >
            {[0, 1, 2].map((i) => {
              const phase =
                (frame / Math.max(1, spec.loader?.period ?? 22)) * Math.PI * 2 -
                i * 0.9;
              const o = 0.25 + 0.75 * clamp01(0.5 + 0.5 * Math.sin(phase));
              return (
                <span
                  key={i}
                  style={{
                    width: "0.3em",
                    height: "0.3em",
                    borderRadius: "50%",
                    background: "currentColor",
                    opacity: o,
                  }}
                />
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------- guide_frame

// MUCH 규격 crosshair. 글자의 상/하/좌/우 경계에 시안색 선을 화면 전체로 긋는다
// (가로선 2 = cap/baseline, 세로선 2 = 좌/우 엣지). 원본 05 "MUCH faster" 줌인
// 구간에서 MUCH 의 규격을 보여주는 가이드라인. 등장은 페이드, 퇴장은 4변이 각자
// 바깥으로 슬라이드하며 사라진다(가로선 위/아래로, 세로선 좌/우로 = 사방으로 열림).
export type GuideFrameSpec = {
  element: "guide_frame";
  id?: string;
  color?: string; // 선 색. 기본 시안
  strokeWidth?: number; // px. 기본 2
  // MUCH 경계(뷰포트 fraction). top/bottom = 가로선 y(vh), left/right = 세로선 x(vw)
  top: number;
  bottom: number;
  left: number;
  right: number;
  appear?: DrawRamp; // 등장 페이드(로컬 프레임). 기본 {duration:8}
  // 퇴장: exit.start 부터 4변이 바깥으로 distance(화면 비율)만큼 슬라이드 + 페이드
  exit?: {
    start: number;
    duration: number;
    easing?: EasingName;
    distance?: number; // 슬라이드 거리(화면 비율). 기본 0.6
  };
  glow?: number; // 0..1. 선 글로우. 기본 0.35
  opacity?: number; // 선 기본 불투명도. 기본 0.9
  // MUCH self scale 애니와 동기. 규격선을 중심 기준으로 from->to 확대해서
  // MUCH 가 커질 때 규격선도 같이 커져 항상 딱 맞게 한다.
  scaleRamp?: {
    from?: number;
    to?: number;
    start?: number;
    duration: number;
    easing?: EasingName;
  };
  // MUCH 실제 렌더 크기를 canvas measureText 로 재서 규격선 좌우/아래를 자동
  // 정렬한다. cx = 글자 중심 x(뷰포트 fraction). 없으면 spec 좌표를 그대로 쓴다.
  measure?: {
    text: string;
    fontSize: number;
    fontWeight?: number;
    fontFamily?: string;
    cx: number;
  };
};

export const GuideFrame: React.FC<{ spec: GuideFrameSpec }> = ({ spec }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const color = spec.color ?? "#3DE0E0";
  const sw = spec.strokeWidth ?? 2;
  const baseOp = spec.opacity ?? 0.9;
  const appearT = rampT(frame, spec.appear ?? { duration: 8 });

  // 퇴장 진행도(0..1) 와 슬라이드 이징
  const ex = spec.exit;
  const exT = ex ? clamp01((frame - ex.start) / Math.max(1, ex.duration)) : 0;
  const exE = ex ? EASING[ex.easing ?? "easeIn"](exT) : 0;
  const dist = ex?.distance ?? 0.6;

  const op = baseOp * appearT * (1 - exE);
  const glow = spec.glow ?? 0.35;
  const filter =
    glow > 0 ? `drop-shadow(0 0 ${(6 * glow).toFixed(1)}px ${color})` : undefined;

  // scaleRamp: 중심 기준으로 규격선을 from->to 확대(MUCH self scale 과 동기)
  const sr = spec.scaleRamp;
  const ss = sr
    ? lerp(
        sr.from ?? 1,
        sr.to ?? 1,
        rampT(frame, {
          start: sr.start,
          duration: sr.duration,
          easing: sr.easing,
        }),
      )
    : 1;
  // measure: MUCH 실제 렌더 폭/cap높이를 canvas measureText 로 재서 규격선을
  // 글자에 자동 정렬. 좌우(폭)와 아래(top+capHeight)를 측정값으로 잡고, 위(top)
  // 는 spec.top(광학 보정 수동값)을 그대로 쓴다. 측정 실패 시 spec 좌표 폴백.
  let mLeft = spec.left;
  let mRight = spec.right;
  let mBottom = spec.bottom;
  if (spec.measure) {
    const cvs =
      typeof document !== "undefined" ? document.createElement("canvas") : null;
    const mctx = cvs?.getContext("2d") ?? null;
    if (mctx) {
      const fpx = (spec.measure.fontSize / 100) * width;
      mctx.font = `${spec.measure.fontWeight ?? 700} ${fpx}px ${spec.measure.fontFamily ?? "Inter, sans-serif"}`;
      const mt = mctx.measureText(spec.measure.text);
      if (mt.width > 0) {
        const halfW = mt.width / 2 / width;
        mLeft = spec.measure.cx - halfW;
        mRight = spec.measure.cx + halfW;
        const cap = mt.actualBoundingBoxAscent / height;
        if (cap > 0) mBottom = spec.top + cap;
      }
    }
  }
  // baseline 정렬: 아래선(baseline)은 ss(=MUCH self scale) 무관하게 고정하고
  // (faster 아래선과 동일), 위선/좌우선만 ss 로 축소한다. MUCH 가 작아지면
  // baseline 은 그대로, cap top 이 내려오고 폭이 줄어든다.
  const capH = mBottom - spec.top; // self 1.0 기준 cap 높이(top~baseline)
  const fullW = mRight - mLeft;
  const topY = (mBottom - capH * ss) * height;
  const botY = mBottom * height;
  // 오른쪽 아래(baseline + 오른끝) 고정 축소: MUCH 가 작아져도 faster 쪽 오른끝이
  // 고정돼 둘 사이 공백이 안 벌어진다. 왼끝/위선만 ss 로 줄어든다.
  const rightX = mRight * width;
  const leftX = (mRight - fullW * ss) * width;

  // 퇴장 슬라이드 오프셋(px). 가로선은 상/하, 세로선은 좌/우로 밀려난다.
  const dy = exE * dist * height;
  const dx = exE * dist * width;

  const line = (extra: React.CSSProperties): React.CSSProperties => ({
    position: "absolute",
    background: color,
    opacity: op,
    filter,
    ...extra,
  });

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {/* 위 가로선 - 퇴장시 왼쪽으로 */}
      <div
        style={line({
          left: 0,
          width,
          top: topY - sw / 2,
          height: sw,
          transform: `translateX(${(-dx).toFixed(1)}px)`,
        })}
      />
      {/* 아래 가로선 - 퇴장시 오른쪽으로 */}
      <div
        style={line({
          left: 0,
          width,
          top: botY - sw / 2,
          height: sw,
          transform: `translateX(${dx.toFixed(1)}px)`,
        })}
      />
      {/* 왼 세로선 - 퇴장시 위로 */}
      <div
        style={line({
          top: 0,
          height,
          left: leftX - sw / 2,
          width: sw,
          transform: `translateY(${(-dy).toFixed(1)}px)`,
        })}
      />
      {/* 오른 세로선 - 퇴장시 위로 */}
      <div
        style={line({
          top: 0,
          height,
          left: rightX - sw / 2,
          width: sw,
          transform: `translateY(${(-dy).toFixed(1)}px)`,
        })}
      />
    </div>
  );
};
