/**
 * Video Agent Studio — motion presets.
 *
 * Framer Motion v12 (`motion/react`) 를 위한 spring / ease / stagger 프리셋 모음.
 * 모든 컴포넌트는 여기서만 참조. 임의 spring config 하드코딩 금지.
 *
 * 원칙 (DESIGN.md §6):
 * - Motion 은 "상태가 바뀌었다" 신호. 데코용 idle floating / color glow 금지.
 * - prefers-reduced-motion 시 transform·scale·blur 전부 disable, opacity 만 120ms.
 */

import type { Transition, Variants } from "motion/react";

// ---------- Spring ----------

export const spring = {
  /** micro hover (~120ms) — 카드 hover, 뱃지 확대 */
  microHover: {
    type: "spring" as const,
    stiffness: 400,
    damping: 30,
    mass: 0.5,
  },
  /** tap press (~100ms) — 버튼 press-down */
  tapPress: {
    type: "spring" as const,
    stiffness: 500,
    damping: 25,
    mass: 0.4,
  },
  /** panel slide (~280ms) — 사이드바 접힘, drawer */
  panelSlide: {
    type: "spring" as const,
    stiffness: 300,
    damping: 32,
    mass: 0.9,
  },
  /** scrubber (~80ms) — 타임라인 playhead drag */
  scrub: {
    type: "spring" as const,
    stiffness: 700,
    damping: 40,
    mass: 0.3,
  },
  /** card arrive (~260ms) — thread stream 새 카드 도착 */
  cardEnter: {
    type: "spring" as const,
    stiffness: 320,
    damping: 30,
    mass: 0.6,
  },
} as const satisfies Record<string, Transition>;

// ---------- Ease (bezier / duration) ----------

export const ease = {
  fastFade: { duration: 0.16, ease: [0.16, 1, 0.30, 1] as const },
  modal: { duration: 0.24, ease: [0.32, 0.72, 0, 1] as const },
  streaming: { duration: 0.18, ease: [0.40, 0, 0.20, 1] as const },
  pulse: {
    duration: 1.60,
    ease: [0.40, 0, 0.60, 1] as const,
    repeat: Infinity,
    repeatType: "mirror" as const,
  },
} as const satisfies Record<string, Transition>;

// ---------- Durations (JS 참조용) ----------

export const durations = {
  instant: 80,
  fast: 160,
  base: 220,
  slow: 320,
  modal: 480,
} as const;

// ---------- Reusable variants ----------

/** 스레드 카드 도착 — layout + opacity + y-slide */
export const cardEnterVariants: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: spring.cardEnter },
  exit: { opacity: 0, y: -4, transition: ease.fastFade },
};

/** interrupt sticky 도착 */
export const interruptVariants: Variants = {
  hidden: { opacity: 0, y: -24, scale: 0.98 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: spring.panelSlide,
  },
  exit: { opacity: 0, y: -8, transition: ease.fastFade },
};

/** streaming 텍스트 chunk — 20ms stagger */
export const streamChunkVariants: Variants = {
  hidden: { opacity: 0 },
  visible: (i: number = 0) => ({
    opacity: 1,
    transition: {
      duration: 0.18,
      ease: ease.streaming.ease,
      delay: i * 0.02,
    },
  }),
};

/** breathing pulse (실행 중 tool card) */
export const breathingPulse: Variants = {
  idle: {
    boxShadow: "0 0 0 0 rgba(224, 138, 60, 0)",
    transition: { duration: 0 },
  },
  active: {
    boxShadow: [
      "0 0 0 0 rgba(224, 138, 60, 0)",
      "0 0 0 6px rgba(224, 138, 60, 0.12)",
      "0 0 0 0 rgba(224, 138, 60, 0)",
    ],
    transition: {
      duration: 1.6,
      ease: [0.40, 0, 0.60, 1],
      repeat: Infinity,
    },
  },
};

// ---------- Reduced motion helper ----------

/**
 * useReducedMotion() hook 결과를 받아 transform/scale 없는 fallback 리턴.
 * motion/react 의 useReducedMotion 을 컴포넌트에서 호출 후 이걸로 wrap.
 */
export function respectReducedMotion<T extends Transition>(
  transition: T,
  reduced: boolean
): Transition {
  if (!reduced) return transition;
  return { duration: 0.12, ease: [0.4, 0, 0.6, 1] };
}
