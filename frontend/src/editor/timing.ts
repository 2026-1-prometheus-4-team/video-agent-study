// timing.ts (에디터측)
// 엔진의 타이밍 계산을 그대로 재사용하는 얇은 래퍼. 타임라인/오버레이/인스펙터가
// 여기 하나만 보게 해서 "에디터가 보여주는 타이밍 == 엔진이 렌더하는 타이밍"을
// 보장한다. 계산 로직 복제 금지 — 반드시 엔진 함수 import.

import {
  resolveTimings,
  requiredFrames,
  type MotionLayer,
  type TimedLayer,
  type Role,
} from "@engine/motion/core/timing";
import { intrinsicForLayer } from "@engine/motion/intrinsic";
import {
  sceneFrames,
  totalFrames,
  type SceneSpec,
  type SceneElementSpec,
  type VideoSpec,
} from "@engine/motion/SceneRenderer";
import { STRUCTURAL, unitCount } from "@engine/motion/structural";
import type { TextElementSpec } from "@engine/motion/ComposedText";

export { sceneFrames, totalFrames, resolveTimings, requiredFrames, STRUCTURAL };
export type { MotionLayer, TimedLayer, Role };

/** 각 씬의 시작 프레임(누적). 마지막 원소 = 총 길이. */
export function sceneStarts(spec: VideoSpec, fps: number): number[] {
  const starts: number[] = [];
  let cursor = 0;
  for (const scene of spec.scenes ?? []) {
    starts.push(cursor);
    cursor += sceneFrames(scene, fps);
  }
  starts.push(cursor);
  return starts;
}

/** 전역 프레임 -> {sceneIdx, localFrame} */
export function frameToScene(
  spec: VideoSpec,
  fps: number,
  frame: number,
): { sceneIdx: number; localFrame: number } {
  const starts = sceneStarts(spec, fps);
  for (let i = 0; i < starts.length - 1; i++) {
    if (frame < starts[i + 1]) return { sceneIdx: i, localFrame: frame - starts[i] };
  }
  const last = Math.max(0, starts.length - 2);
  return { sceneIdx: last, localFrame: frame - starts[last] };
}

/** ComposedText 와 동일한 unitCount 계산 (SceneRenderer.unitCountForElement 미러) */
export function elementUnitCount(el: TextElementSpec): number {
  const text = el.base?.text ?? "";
  if (!text) return 1;
  const layers = el.layers ?? [];
  const firstStructural = layers.find((l) => STRUCTURAL.has(l.type));
  const unit = (firstStructural?.props?.unit as "char" | "word" | undefined) ?? "char";
  return Math.max(1, unitCount(text, unit));
}

/** 요소 트림 창(씬 로컬 in/out 프레임). 엔진 ComposedText 등과 동일 규칙. */
export function elementWindow(
  el: SceneElementSpec,
  scene: SceneSpec,
  fps: number,
): { start: number; end: number; len: number; total: number } {
  const total = sceneFrames(scene, fps);
  const timing = (el as { timing?: { start?: number; end?: number } }).timing;
  const start = Math.max(0, Math.min(total, timing?.start ?? 0));
  // end 는 씬 길이를 넘을 수 있다 (cross-scene 연장 — 엔진이 다음 씬에
  // 게스트로 이어 렌더). 상한 클램프 없음.
  const end = Math.max(start + 1, timing?.end ?? total);
  return { start, end, len: Math.max(1, end - start), total };
}

/** 요소의 레이어 타이밍(씬 로컬 프레임). 엔진 resolveTimings 그대로 + 트림 오프셋. */
export function elementTimings(
  el: SceneElementSpec,
  scene: SceneSpec,
  fps: number,
): TimedLayer[] {
  if (el.element === "logo") return [];
  const layers: MotionLayer[] = (el as { layers?: MotionLayer[] }).layers ?? [];
  if (layers.length === 0) return [];
  const win = elementWindow(el, scene, fps);
  const uCount =
    el.element === "text" ? elementUnitCount(el) : 1; // group 은 unitCount 1 (FrameGroup 과 동일)
  // 엔진은 winLen 길이 서브-타임라인으로 resolve 하고 winStart 만큼 시프트 → 그대로 미러.
  const timed = resolveTimings(
    layers,
    win.len,
    { fps, unitCount: uCount },
    intrinsicForLayer,
    scene.fit,
  );
  return win.start ? timed.map((t) => ({ ...t, startFrame: t.startFrame + win.start })) : timed;
}

/** 요소의 enter/hold/exit 페이즈 경계 + 트림 창 (타임라인 role 바 렌더용) */
export function elementPhases(
  el: SceneElementSpec,
  scene: SceneSpec,
  fps: number,
): { winStart: number; winEnd: number; enterEnd: number; exitStart: number; total: number } {
  const win = elementWindow(el, scene, fps);
  const timed = elementTimings(el, scene, fps); // 이미 winStart 오프셋됨
  let enterEnd = win.start;
  let exitStart = win.end;
  for (const t of timed) {
    if (t.role === "in") enterEnd = Math.max(enterEnd, t.startFrame + t.window);
    if (t.role === "out") exitStart = Math.min(exitStart, t.startFrame);
  }
  return { winStart: win.start, winEnd: win.end, enterEnd, exitStart, total: win.total };
}
