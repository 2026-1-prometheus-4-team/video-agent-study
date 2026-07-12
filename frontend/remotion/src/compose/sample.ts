// compose/sample.ts
// LLM 이 뱉을 조합의 샘플. 이 객체만 바꾸면 스튜디오 "Compose" 컴포가 바뀐다.
// effect 이름 / 상황 노브(from,to,prefix,suffix,direction,mode 등) / wrappers 토글
// / effects 만 건드리면 된다. 세부 수치(duration/easing/scale...)는 프리셋 고정.

import type { ComposeInput } from "./compose";

export const COMPOSE_SAMPLE: ComposeInput = {
  structural: {
    effect: "stat_reveal",
    prefix: "+",
    from: 0,
    to: 55,
    suffix: "ATMs",
    digitsAlign: "left",
    baseColor: "#111111",
    landColor: "#E23B3B",
  },
  wrappers: [],
  effects: {},
  surface: {
    fontSize: 13,
    fontWeight: 500,
    color: "#111111",
    background: "#EAF1FB",
  },
};
