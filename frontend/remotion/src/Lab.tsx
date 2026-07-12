import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile } from "remotion";
import { z } from "zod";
import type { MotionLayer } from "./motion/core/timing";
import { ComposedText } from "./motion/ComposedText";
import { EASING } from "./motion/core/easing";
import { WRAPPER_LAB_PRESETS } from "./motion/wrappers";
import { STRUCTURAL_LAB_PRESETS } from "./motion/structural";

// Merged atom -> preset map. Wrappers first then structurals; collisions
// would mean two atoms claimed the same name, which is a bug worth
// failing loudly on (caught at first use). The atomType enum below is
// derived from the union, so adding a new file under wrappers/ or
// structural/ with a `name` + `labPreset` makes it show up automatically.
const ALL_PRESETS = { ...WRAPPER_LAB_PRESETS, ...STRUCTURAL_LAB_PRESETS };
const ATOM_NAMES = Object.keys(ALL_PRESETS).sort();
if (ATOM_NAMES.length === 0) {
  throw new Error("Lab: no atoms registered in wrappers/ or structural/");
}
const ATOM_NAME_TUPLE = ATOM_NAMES as [string, ...string[]];

// easing dropdown is derived from the EASING table itself, so adding a
// new curve in core/easing.ts shows up here automatically.
const EASING_NAMES = Object.keys(EASING).sort();
const EASING_TUPLE = EASING_NAMES as [string, ...string[]];

export const labSchema = z.object({
  text: z.string(),
  atomType: z.enum(ATOM_NAME_TUPLE),
  duration: z.number().min(4).max(90),
  easing: z.enum(EASING_TUPLE),
  fontSize: z.number().min(1).max(12),
  glow: z.boolean(),
  showReference: z.boolean(),
  referenceStartSec: z.number().min(0).max(42),
});

type LabProps = z.infer<typeof labSchema>;

// Look the preset up at render time so hot-added atoms are picked up
// without a Lab.tsx edit. Sidebar duration / easing always override.
function buildLayers(p: LabProps): MotionLayer[] {
  const preset = ALL_PRESETS[p.atomType];
  if (!preset) return [];
  return [
    {
      type: p.atomType,
      role: preset.role,
      props: { ...preset.props, duration: p.duration, easing: p.easing },
    },
  ];
}

export const LabStage: React.FC<LabProps> = (p) => {
  const spec = {
    element: "text" as const,
    id: "lab",
    base: { text: p.text, fontSize: p.fontSize, fontWeight: 800 },
    layers: buildLayers(p),
    effects: {
      glow: { enabled: p.glow, color: "auto" as const, intensity: 0.6, radius: 40 },
    },
  };
  return (
    <AbsoluteFill style={{ backgroundColor: "#0D0B10" }}>
      {p.showReference && (
        <OffthreadVideo
          src={staticFile("reference.mp4")}
          startFrom={Math.round(p.referenceStartSec * 24)}
          style={{ position: "absolute", width: "100%", opacity: 0.4 }}
          muted
        />
      )}
      <ComposedText spec={spec} sceneFrames={72} />
    </AbsoluteFill>
  );
};
