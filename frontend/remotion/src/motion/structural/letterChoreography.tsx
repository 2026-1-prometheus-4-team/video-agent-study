// structural/letterChoreography.tsx
// 글자별 독립 키프레임 안무 atom. letterScatter 와 결정적으로 다른 점:
// letterScatter 는 "모든 글자가 같은 모션 + per-letter stagger" 라 동시에
// 움직인다. 여기서는 글자(charIdx)마다 자기만의 keyframe 배열을 가지므로
// 움직이는 시점/방향/횟수/변신이 전부 제각각이다 — "일부 먼저 움직이고,
// 다른 게 또 다른 방향으로, 남은 게 또" 같은 robotic 변신 안무용.
//
// 규칙(biasafe 레퍼런스):
//   - 대각선 이동 금지. 한 step 에서는 x 또는 y 한 축만 바꾼다(데이터 책임,
//     dev 모드에서 둘 다 바뀌면 경고). 대각선이 들어가면 AI 티가 난다.
//   - char 가 바뀌는 keyframe 에서 글자가 다른 글자/숫자로 변신(E->10, E->A,
//     M->I). char 는 보간하지 않고 그 frame 에 딱 바뀐다(step).
//   - step 마다 easing 따로.

import { clamp01, lerp, resolveEasing } from "../core/easing";
import type { Letter } from "./splitText";

export type ChoreoKeyframe = {
  frame: number; // layer local frame 기준 이 keyframe 시점
  x?: number; // px, 글자 home 대비 가로 오프셋
  y?: number; // px, 세로 오프셋
  scale?: number; // 1 = 원래 크기
  opacity?: number; // 0..1
  char?: string; // 이 frame 부터 표시할 문자(변신). 생략하면 직전 값 유지
  // named 또는 "cubic(...)" (에디터 커스텀 cubic() 지원)
  easing?: string; // 이 keyframe 으로 들어오는 보간 곡선(직전 kf -> 이 kf)
};

export type LetterChoreoProps = {
  // charIdx(문자열 키) -> keyframe 배열. 비어있는 글자는 home 에 정지
  // (또는 defaultExit 이 있으면 그 시점에 제자리 fade out).
  tracks: Record<string, ChoreoKeyframe[]>;
  // named 또는 "cubic(...)" (에디터 커스텀 cubic() 지원)
  defaultEasing?: string;
  // tracks 에 keyframe 이 없는 글자(= survivor 가 아닌 나머지)를 일괄
  // 소멸시킨다. frame 부터 duration 동안 opacity 1->0. 35글자 소멸 keyframe
  // 을 일일이 안 적어도 되는 1차 단순화용. 나중에 글자별 순차 cardinal
  // 이동으로 정교화할 땐 각 글자에 keyframe 을 주면 이 기본값을 덮어쓴다.
  defaultExit?: {
    frame: number;
    duration: number;
    spread?: number; // px, cardinal(상하좌우) 방향으로 빠지는 거리. 0이면 제자리 fade.
    stagger?: number; // 글자별 시작 지연(프레임). >0이면 순차 소멸.
    center?: number; // 이 charIdx 에서 먼 글자(양 끝)부터 소멸. 없으면 좌->우.
    maxDist?: number; // center 로부터 최대 거리(order 계산용). 기본 19.
  };
  // 중앙 수축: frame 부터 모든 글자가 center(charIdx)로 가로로 당겨진다.
  // 흩어진 글자가 양 끝에서 중앙으로 빨려드는 biasafe converge 모션.
  converge?: {
    frame: number;
    duration: number;
    perCharPx: number; // charIdx 1 거리당 중앙으로 당기는 px
    center?: number; // 수축 중심 charIdx (기본 17)
    easing?: string; // named 또는 "cubic(...)" (에디터 커스텀 cubic() 지원)
    yPull?: number; // 0..1, 흩어진 y 를 중앙선(0)으로 당기는 비율
    skip?: number[]; // converge 제외할 charIdx (survivor 등 자기 위치 유지)
  };
};

export type ChoreoState = {
  x: number;
  y: number;
  scale: number;
  opacity: number;
  char?: string; // 현재 표시 문자(변신 결과). undefined 면 원래 글자.
  visible: boolean;
};

const IDENTITY: ChoreoState = {
  x: 0,
  y: 0,
  scale: 1,
  opacity: 1,
  char: undefined,
  visible: true,
};

// 한 글자의 keyframe 배열에서 localFrame 시점 상태를 보간한다.
export function letterChoreoState(
  l: Letter,
  localFrame: number,
  p: LetterChoreoProps,
): ChoreoState {
  const base = ((): ChoreoState => {
  const kfs = p.tracks[String(l.charIdx)];
  if (!kfs || kfs.length === 0) {
    // tracks 없는 글자: defaultExit 있으면 제자리 fade out, 없으면 home 정지.
    if (p.defaultExit) {
      const { frame, duration, spread = 0, stagger = 0, center, maxDist = 19 } = p.defaultExit;
      // center 가 있으면 그 charIdx 에서 먼 글자(양 끝)부터 소멸한다(biasafe
      // 원본 소멸 순서: 양 끝 먼저 -> 중앙 ASSET 가장 늦게). 없으면 좌->우 순차.
      const order =
        center != null ? Math.max(0, maxDist - Math.abs(l.charIdx - center)) : l.charIdx;
      const start = frame + order * stagger;
      if (localFrame <= start) return IDENTITY;
      const t = clamp01((localFrame - start) / Math.max(1, duration));
      // cardinal 방향만(대각선 없음): charIdx 로 축/방향 결정. 65% 세로.
      const s = l.charIdx;
      const vertical = (s * 31) % 100 < 65;
      const dir = (s * 17) % 2 === 0 ? -1 : 1;
      const d = spread * t;
      return {
        x: vertical ? 0 : dir * d,
        y: vertical ? dir * d : 0,
        scale: 1,
        opacity: 1 - t,
        char: undefined,
        visible: t < 1,
      };
    }
    return IDENTITY;
  }

  // 첫 keyframe 이전: 첫 kf 값으로 고정(아직 안 움직임).
  const first = kfs[0];
  if (localFrame <= first.frame) {
    return resolveAt(kfs, 0, 0, first);
  }
  // 마지막 keyframe 이후: 마지막 kf 값 유지.
  const last = kfs[kfs.length - 1];
  if (localFrame >= last.frame) {
    return resolveAt(kfs, kfs.length - 1, 1, last);
  }
  // 사이 구간 찾기: kfs[i].frame <= localFrame < kfs[i+1].frame
  let i = 0;
  for (let k = 0; k < kfs.length - 1; k++) {
    if (localFrame >= kfs[k].frame && localFrame < kfs[k + 1].frame) {
      i = k;
      break;
    }
  }
  const a = kfs[i];
  const b = kfs[i + 1];
  const span = Math.max(1, b.frame - a.frame);
  const tRaw = clamp01((localFrame - a.frame) / span);
  // 에디터 커스텀 cubic() 지원 — named 는 기존과 동일, 미해석 시 easeInOut
  const easeFn = resolveEasing(b.easing ?? p.defaultEasing, "easeInOut");
  const e = easeFn(tRaw);

  // x/y/scale/opacity 는 보간. char 는 step(다음 kf frame 도달 전엔 a.char).
  const ax = carry(kfs, i, "x");
  const ay = carry(kfs, i, "y");
  const asc = carry(kfs, i, "scale", 1);
  const aop = carry(kfs, i, "opacity", 1);
  const bx = b.x ?? ax;
  const by = b.y ?? ay;
  const bsc = b.scale ?? asc;
  const bop = b.opacity ?? aop;
  const x = lerp(ax, bx, e);
  const y = lerp(ay, by, e);
  const scale = lerp(asc, bsc, e);
  const opacity = lerp(aop, bop, e);
  const char = carryChar(kfs, i);
  return { x, y, scale, opacity, char, visible: opacity > 0.001 };
  })();
  // 중앙 수축(converge): frame 부터 모든 글자가 center charIdx 로 가로로
  // 당겨진다. 흩어진 글자가 양 끝에서 중앙으로 빨려드는 biasafe 모션.
  // center 에서 먼 글자일수록 더 많이 당긴다.
  if (
    p.converge &&
    localFrame >= p.converge.frame &&
    (p.converge.skip ?? []).indexOf(l.charIdx) === -1
  ) {
    const { frame, duration, perCharPx, center = 17, easing = "easeInOut", yPull = 0 } = p.converge;
    const tRaw = clamp01((localFrame - frame) / Math.max(1, duration));
    // 에디터 커스텀 cubic() 지원 — 기본값(easeInOut)은 기존과 동일
    const e2 = resolveEasing(easing, "easeInOut")(tRaw);
    return {
      ...base,
      x: base.x - (l.charIdx - center) * perCharPx * e2,
      y: base.y * (1 - yPull * e2),
    };
  }
  return base;
}

// keyframe i 에서 어떤 속성의 "현재까지 확정된 값"을 찾는다. 생략된 kf 는
// 직전에 명시된 값을 물려받는다(carry-forward).
function carry(
  kfs: ChoreoKeyframe[],
  i: number,
  key: "x" | "y" | "scale" | "opacity",
  fallback = 0,
): number {
  for (let k = i; k >= 0; k--) {
    const v = kfs[k][key];
    if (v != null) return v;
  }
  return fallback;
}

function carryChar(kfs: ChoreoKeyframe[], i: number): string | undefined {
  for (let k = i; k >= 0; k--) {
    if (kfs[k].char != null) return kfs[k].char;
  }
  return undefined;
}

// 정확히 keyframe 위(또는 양 끝)에 있을 때의 상태.
function resolveAt(
  kfs: ChoreoKeyframe[],
  i: number,
  _t: number,
  kf: ChoreoKeyframe,
): ChoreoState {
  const x = kf.x ?? carry(kfs, i, "x");
  const y = kf.y ?? carry(kfs, i, "y");
  const scale = kf.scale ?? carry(kfs, i, "scale", 1);
  const opacity = kf.opacity ?? carry(kfs, i, "opacity", 1);
  const char = carryChar(kfs, i);
  return { x, y, scale, opacity, char, visible: opacity > 0.001 };
}

// CSS transform 으로 변환.
// scale 을 transform: scale() 로 주면 GPU 가 작은 글자(작은 fontSize)를 먼저
// 래스터화한 뒤 확대해서 픽셀이 깨진다(blur). 대신 fontSize(em) 로 키우면
// 글리프를 벡터로 다시 그려서 5배 이상 키워도 선명하다. survivor 글자는
// splitText 의 spacer + absolute overlay(flex 중앙정렬) 구조라 fontSize 를
// 키워도 칸 폭(layout)이 안 변해서 다른 글자 reflow 가 없다. 이동(x,y)만 transform.
export function choreoStyle(s: ChoreoState): React.CSSProperties {
  return {
    transform: `translate3d(${s.x.toFixed(2)}px, ${s.y.toFixed(2)}px, 0)`,
    fontSize: `${s.scale.toFixed(3)}em`,
    willChange: "transform, font-size",
    opacity: s.opacity,
  };
}

export const name = "letter_choreography";
