// intrinsic.ts
// Shared atom -> intrinsicDuration lookup, kept out of SceneRenderer to
// avoid a SceneRenderer <-> ComposedText import cycle. Both consumers
// (sceneFrames in SceneRenderer, resolveTimings call site in
// ComposedText) point at this single provider.

import { WRAPPER_INTRINSIC } from "./wrappers";
import { STRUCTURAL_INTRINSIC } from "./structural";
import type { IntrinsicProvider } from "./core/timing";

export const intrinsicForLayer: IntrinsicProvider = (l, ctx) => {
  const wfn = WRAPPER_INTRINSIC[l.type];
  if (wfn) return wfn(l.props ?? {}, ctx);
  const sfn = STRUCTURAL_INTRINSIC[l.type];
  if (sfn) return sfn(l.props ?? {}, ctx);
  return NaN; // timing.ts falls back to defaultDuration
};
