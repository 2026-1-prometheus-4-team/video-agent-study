// compose/transitionsSample.ts
// 2026-07-07 A축(요소 exit wrapper: shrink_out/fly_out/typewriter_erase) + B축
// (씬 전체 transitionOut/camera: slide_push/zoom_punch/wipe_collapse/
// light_sweep/text_collapse_fill + push_in/follow_caret) 을 compose 입력
// (LLM 이 실제로 뱉을 shape)으로 검증하는 샘플. survey/transitions-survey.json
// 은 SceneRenderer 가 직접 먹는 raw SceneSpec 이었고, 이건 그 위 레이어인
// compose()/composeAd() 를 통과시켜 같은 결과가 나오는지 확인하는 용도 —
// "LLM 이 이렇게 뱉으면 실제로 이렇게 렌더된다"를 눈으로 보는 게 목적.
// composeAd(TRANSITIONS_SAMPLE) -> Root 의 "ComposeTransitions" 컴포.

import type { AdInput } from "./compose";

export const TRANSITIONS_SAMPLE: AdInput = {
  fps: 24,
  fontFamily: "General Sans",
  background: "#0D0B10",
  scenes: [
    // A축: shrink_out — 훅 임팩트 후 빠르게 쪼그라들며 퇴장.
    {
      id: "a-shrink-out",
      duration: 2,
      transitionOut: "hard_cut",
      elements: [
        {
          structural: { effect: "typewriter" },
          wrappers: [{ type: "shrink_out" }],
          surface: { text: "A: shrink_out", fontSize: 5, fontWeight: 600, color: "#7C4DFF" },
        },
      ],
    },
    // A축: fly_out + motionBlur — hero_zoom 급 강한 퇴장(방향성 블러 포함).
    {
      id: "a-fly-out",
      duration: 2.2,
      transitionOut: "hard_cut",
      elements: [
        {
          structural: { effect: "apple_text" },
          wrappers: [{ type: "fly_out", dir: "right" }],
          surface: { text: "A: fly_out + motionBlur", fontSize: 4.4, fontWeight: 600, color: "#FF4D9D" },
          effects: { motionBlur: true },
        },
      ],
    },
    // A축: typewriter(등장) + typewriter_erase(퇴장) — 타이핑 후 지워짐.
    {
      id: "a-typewriter-erase",
      duration: 2.4,
      transitionOut: "hard_cut",
      elements: [
        {
          structural: { effect: "typewriter" },
          structuralOut: { effect: "typewriter_erase", eraseFrom: "left" },
          surface: { text: "A: type then erase", fontSize: 4, fontWeight: 600, color: "#4D7DFF" },
        },
      ],
    },
    // B축: slide_push(down) — 화면 전체가 아래로 밀려나며 컷.
    {
      id: "b-slide-push",
      duration: 2,
      transitionOut: { type: "slide_push", direction: "down" },
      elements: [
        {
          structural: { effect: "typewriter" },
          surface: { text: "B: slide_push down", fontSize: 4.4, fontWeight: 600, color: "#FFFFFF" },
        },
      ],
    },
    // B축: zoom_punch(zoom_out variant) + camera push_in 동시.
    {
      id: "b-zoom-punch-camera",
      duration: 2,
      camera: { type: "push_in" },
      transitionOut: { type: "zoom_punch", feel: "zoom_out" },
      elements: [
        {
          structural: { effect: "typewriter" },
          surface: { text: "B: zoom_punch(out) + push_in", fontSize: 3.6, fontWeight: 600, color: "#7C4DFF" },
        },
      ],
    },
    // B축: wipe_collapse + text_collapse_fill — 두 시그니처 리빌 컷.
    {
      id: "b-wipe-collapse",
      duration: 2,
      transitionOut: { type: "wipe_collapse", direction: "left" },
      elements: [
        {
          structural: { effect: "typewriter" },
          surface: { text: "B: wipe_collapse left", fontSize: 4.4, fontWeight: 600, color: "#FF4D9D" },
        },
      ],
    },
    {
      id: "b-text-collapse-fill",
      duration: 2.2,
      transitionOut: { type: "text_collapse_fill", stops: ["#7C4DFF", "#FF4D9D"] },
      elements: [
        {
          structural: { effect: "typewriter" },
          surface: { text: "B: text_collapse_fill", fontSize: 4.2, fontWeight: 600, color: "#4D7DFF" },
        },
      ],
    },
    // 콤보: A축(shrink_out)+B축(slide_push) 동시 — 두 축 독립 스택 증명.
    {
      id: "combo",
      duration: 2.2,
      transitionOut: { type: "slide_push", direction: "left" },
      elements: [
        {
          structural: { effect: "typewriter" },
          wrappers: [{ type: "shrink_out" }],
          surface: { text: "COMBO: shrink_out + slide_push", fontSize: 3.6, fontWeight: 600, color: "#FFFFFF" },
        },
      ],
    },
  ],
};
