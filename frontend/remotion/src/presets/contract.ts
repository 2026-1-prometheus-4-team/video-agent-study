// presets/contract.ts
// Single declarative source of truth for the LLM-facing preset contract.
//
// Each preset's knobs are described once as plain KnobSpec data. From that
// one table we derive BOTH:
//   - a zod schema (runtime validation of the LLM's JSON, with clamping)
//   - the system-prompt menu text (so the LLM knows the knob exists)
//
// Why not introspect the zod schema to build the prompt, or vice versa:
// zod internals are unstable across versions and awkward to read back into
// human ranges/defaults. A plain data table is the stable middle layer —
// add a knob here and both the validator and the prompt update together,
// which is the whole point (the old hand-written system-prompt.md drifted
// out of sync with the presets and left the preset path unusable).

import { z } from "zod";
import { PRESET_META, type PresetName } from "./index";

// ---------------------------------------------------------------------------
// Knob spec vocabulary
// ---------------------------------------------------------------------------

export type KnobSpec =
  | { kind: "string"; required?: boolean; desc: string }
  | { kind: "number"; min?: number; max?: number; default?: number; required?: boolean; desc: string }
  | { kind: "enum"; values: readonly string[]; default?: string; desc: string }
  | { kind: "color"; required?: boolean; desc: string }
  | { kind: "colorArray"; min?: number; desc: string }
  | { kind: "boolean"; default?: boolean; desc: string }
  | { kind: "focal"; desc: string }; // {x,y} 0..1

// Type-C content knobs every text preset shares (the CommonKnobs surface).
// Spread into each preset's table. These describe the COMPOSITION — what the
// text looks like — not the scene around it.
const COMMON: Record<string, KnobSpec> = {
  fontSize: { kind: "number", min: 0.5, max: 20, desc: "Text size in vw. Hero words 6-9, sentences 2-3.5." },
  fontWeight: { kind: "number", min: 100, max: 900, desc: "Font weight. 400 body, 700-800 hero." },
  emphasis: { kind: "enum", values: ["soft", "normal", "strong"], default: "normal", desc: "Overall punch — scales motion + glow." },
};

// Type-D scene-shell fields. These wrap the preset's output at the scene
// level (orchestration), not the composition level — so they live in their
// own table, are validated separately, and are applied generically by
// expandPresetScene rather than read by any preset. Adding a future shell
// field (camera, flash, whip) is one entry here + one apply line in the
// expander, with no preset changes. SCENE_SHELL_KEYS is the split point the
// expander uses to separate shell fields from preset knobs.
export const SCENE_SHELL: Record<string, KnobSpec> = {
  background: { kind: "color", desc: "Override THIS scene's backdrop (hex). Use for a hard-cut accent beat, e.g. one black scene in a light video — set the scene's text color to contrast it. Omit to inherit brand.background." },
  transition_out: { kind: "enum", values: ["hard_cut", "fade"], default: "hard_cut", desc: "How this scene exits. hard_cut for punchy transitions, fade for soft." },
};

export const SCENE_SHELL_KEYS = Object.keys(SCENE_SHELL);

// ---------------------------------------------------------------------------
// Per-preset knob tables. Keys must match the preset's Knobs type fields.
// ---------------------------------------------------------------------------

export const PRESET_KNOBS: Record<PresetName, Record<string, KnobSpec>> = {
  punch: {
    text: { kind: "string", required: true, desc: "1-3 words. The attention grab." },
    palette: { kind: "colorArray", min: 2, desc: "2+ colors; consecutive pairs become gradients that sweep the letters." },
    baseColor: { kind: "color", desc: "Fill under the palette. Matters when palette ends solid." },
    duration: { kind: "number", min: 0.4, max: 4, required: true, desc: "Seconds." },
    ...COMMON,
  },
  roll: {
    text: { kind: "string", required: true, desc: "Single word. Slot-machine reel reveal." },
    mode: { kind: "enum", values: ["stagger", "together"], default: "stagger", desc: "stagger = reels stop left→right (hype). together = all stop at once (relaxed)." },
    baseColor: { kind: "color", desc: "Text fill." },
    duration: { kind: "number", min: 0.5, max: 5, desc: "Hint only — clamps up to the intrinsic minimum." },
    ...COMMON,
  },
  statement: {
    text: { kind: "string", required: true, desc: "A full sentence. The main message." },
    highlightWord: { kind: "number", min: -1, max: 30, desc: "0-based word index to spotlight; -1 = none." },
    highlightCycle: { kind: "colorArray", desc: "Colors the highlight gradient loops through." },
    exitSpeed: { kind: "enum", values: ["slow", "med", "fast"], default: "med", desc: "Erase speed on exit." },
    pacing: { kind: "enum", values: ["uniform", "punctuate"], default: "uniform", desc: "punctuate = anchor/filler/landing rhythm for medium sentences." },
    baseColor: { kind: "color", desc: "Text fill." },
    duration: { kind: "number", min: 1, max: 6, required: true, desc: "Seconds." },
    ...COMMON,
  },
  blur_reveal: {
    text: { kind: "string", required: true, desc: "The line or words to reveal. Words appear one by one, each blurring in." },
    blurAmount: { kind: "number", min: 0, max: 40, default: 14, desc: "Starting blur in px for each word's entrance." },
    pace: { kind: "enum", values: ["slow", "med", "fast"], default: "med", desc: "Gap between word entrances." },
    baseColor: { kind: "color", desc: "Text fill." },
    duration: { kind: "number", min: 1, max: 6, required: true, desc: "Seconds." },
    ...COMMON,
  },
  beat: {
    text: { kind: "string", required: true, desc: "One staccato word. Chain 2-3 for a chant." },
    baseColor: { kind: "color", desc: "Text fill." },
    duration: { kind: "number", min: 0.4, max: 2, required: true, desc: "Seconds. Keep short." },
    ...COMMON,
  },
  hero_zoom: {
    text: { kind: "string", required: true, desc: "Brand name / final line." },
    gradientStops: { kind: "colorArray", min: 2, desc: "Base colors; looped into a multi-stop sweep." },
    flowSpeed: { kind: "number", min: -6, max: 6, default: 0, desc: "Gradient drift speed (px/frame). Negative = leftward." },
    exitDir: { kind: "enum", values: ["left", "right"], default: "right", desc: "Slide-out direction." },
    baseColor: { kind: "color", desc: "Text fill." },
    duration: { kind: "number", min: 1.5, max: 5, required: true, desc: "Seconds." },
    ...COMMON,
  },
  word_swap: {
    fromText: { kind: "string", required: true, desc: "Word that scatters out." },
    toText: { kind: "string", required: true, desc: "Word that reassembles." },
    pace: { kind: "enum", values: ["fast", "med", "slow"], default: "med", desc: "Swap speed." },
    baseColor: { kind: "color", desc: "Text fill." },
    spread: { kind: "number", min: 0, max: 1, default: 0.5, desc: "Scatter distance 0..1." },
    seed: { kind: "number", min: 0, max: 9999, desc: "Deterministic scatter seed." },
    holdSeconds: { kind: "number", min: 0, max: 3, default: 0, desc: "Seconds to hold fromText oversized before scatter." },
    ...COMMON,
  },
  scatter_assemble: {
    fromText: { kind: "string", required: true, desc: "The long sentence that scatters out and dissolves." },
    assembleText: { kind: "string", required: true, desc: "Short word (1-3 chars, e.g. \"AI\") the surviving glyphs morph into and assemble at center." },
    baseColor: { kind: "color", desc: "Color of the scattering text." },
    assembleColor: { kind: "color", desc: "Final color of the assembled word (e.g. a purple accent). Defaults to baseColor." },
    spread: { kind: "number", min: 0, max: 300, default: 56, desc: "Scatter distance in px." },
    duration: { kind: "number", min: 2, max: 8, desc: "Seconds. Hint — extra time holds the assembled word longer." },
    ...COMMON,
  },
  stat_counter: {
    to: { kind: "number", required: true, desc: "Target number to count up to." },
    from: { kind: "number", default: 0, desc: "Start value." },
    prefix: { kind: "string", desc: "Leading symbol, e.g. \"$\"." },
    suffix: { kind: "string", desc: "Trailing symbol, e.g. \"M+\" or \"%\"." },
    decimals: { kind: "number", min: 0, max: 6, default: 0, desc: "Decimal places." },
    thousands: { kind: "boolean", default: true, desc: "Thousands separator." },
    caption: { kind: "string", desc: "Label above the number." },
    baseColor: { kind: "color", desc: "Number fill (solid). Ignored if gradient set." },
    gradient: { kind: "colorArray", min: 2, desc: "2+ hex stops for a gradient across the number — the emphasis. Prefer this over baseColor for headline stats." },
    pace: { kind: "enum", values: ["fast", "med", "slow"], default: "med", desc: "Count-up speed." },
    ...COMMON,
  },
  zoom_cut: {
    fromText: { kind: "string", required: true, desc: "Word the camera dollies into." },
    baseColor: { kind: "color", desc: "Text fill." },
    zoomSpeed: { kind: "number", min: 20, max: 200, default: 100, desc: "Scale units/sec. Same value = same feel at any duration." },
    duration: { kind: "number", min: 0.4, max: 3, default: 1, desc: "Seconds the zoom runs." },
    focal: { kind: "focal", desc: "Zoom origin {x,y} 0..1. Default center." },
    emergeText: { kind: "string", desc: "Optional text that pin-emerges from a dot at the focal point." },
    emergeAt: { kind: "number", min: 0, max: 1, default: 0.55, desc: "Fraction of duration when emergeText starts." },
    emergeStartPx: { kind: "number", min: 1, max: 40, default: 1, desc: "First-frame size of emerging text." },
    ...COMMON,
  },
};

// ---------------------------------------------------------------------------
// KnobSpec -> zod field
// ---------------------------------------------------------------------------

function zodField(spec: KnobSpec): z.ZodTypeAny {
  switch (spec.kind) {
    case "string":
      return z.string();
    case "color":
      // Permissive hex/word; the renderer tolerates junk, but we keep it a
      // string so a non-string (LLM error) is caught and dropped.
      return z.string();
    case "colorArray":
      return z.array(z.string()).min(spec.min ?? 1);
    case "boolean":
      return z.boolean();
    case "enum":
      return z.enum([...spec.values] as [string, ...string[]]);
    case "focal":
      return z.object({ x: z.number(), y: z.number() });
    case "number": {
      let n = z.number();
      if (spec.min !== undefined) n = n.min(spec.min);
      if (spec.max !== undefined) n = n.max(spec.max);
      return n;
    }
  }
}

function buildSchema(knobs: Record<string, KnobSpec>): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const key of Object.keys(knobs)) {
    const spec = knobs[key];
    const field = zodField(spec);
    const required = "required" in spec && spec.required;
    shape[key] = required ? field : field.optional();
  }
  // passthrough: unknown extra keys are ignored, not fatal — an LLM adding a
  // stray field shouldn't sink an otherwise-valid scene.
  return z.object(shape).passthrough();
}

// A scene's full knob set = its preset's content knobs + the universal
// scene-shell fields. Both are validated together; the expander splits them
// back apart by SCENE_SHELL_KEYS when applying.
function mergedKnobs(preset: PresetName): Record<string, KnobSpec> {
  return { ...PRESET_KNOBS[preset], ...SCENE_SHELL };
}

export const PRESET_SCHEMAS: Record<PresetName, z.ZodTypeAny> = (() => {
  const out = {} as Record<PresetName, z.ZodTypeAny>;
  for (const name of Object.keys(PRESET_KNOBS) as PresetName[]) {
    out[name] = buildSchema(mergedKnobs(name));
  }
  return out;
})();

// ---------------------------------------------------------------------------
// Validation with clamp-and-recover (used by the generate pipeline)
// ---------------------------------------------------------------------------

export type ValidateResult =
  | { ok: true; value: Record<string, unknown>; clamped: string[] }
  | { ok: false; reason: string };

// Pre-pass: clamp out-of-range numbers to their declared bounds instead of
// rejecting the scene. The whole defensive-pacing philosophy is "an LLM
// number should never sink a render" — we coerce toward the legal range and
// record what we touched so the caller can log it.
export function validateKnobs(preset: PresetName, raw: unknown): ValidateResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "knobs is not an object" };
  }
  const knobs = mergedKnobs(preset);
  const input = { ...(raw as Record<string, unknown>) };
  const clamped: string[] = [];

  for (const key of Object.keys(knobs)) {
    const spec = knobs[key];
    if (spec.kind !== "number") continue;
    const v = input[key];
    if (typeof v !== "number" || Number.isNaN(v)) continue;
    let nv = v;
    if (spec.min !== undefined && nv < spec.min) nv = spec.min;
    if (spec.max !== undefined && nv > spec.max) nv = spec.max;
    if (nv !== v) {
      input[key] = nv;
      clamped.push(key);
    }
  }

  const parsed = PRESET_SCHEMAS[preset].safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, reason: `${first.path.join(".") || "(root)"}: ${first.message}` };
  }
  return { ok: true, value: parsed.data as Record<string, unknown>, clamped };
}

// ---------------------------------------------------------------------------
// Prompt menu rendering (consumed by scripts/build-prompt.mjs)
// ---------------------------------------------------------------------------

function knobLine(name: string, spec: KnobSpec): string {
  const req = "required" in spec && spec.required ? " (required)" : "";
  let type = "";
  switch (spec.kind) {
    case "string": type = "string"; break;
    case "color": type = "hex color"; break;
    case "colorArray": type = `hex color[]${spec.min ? ` (>=${spec.min})` : ""}`; break;
    case "boolean": type = `boolean${spec.default !== undefined ? ` (default ${spec.default})` : ""}`; break;
    case "enum": type = spec.values.map((v) => `"${v}"`).join(" | ") + (spec.default ? ` (default "${spec.default}")` : ""); break;
    case "focal": type = "{ x: 0..1, y: 0..1 }"; break;
    case "number": {
      const range = spec.min !== undefined || spec.max !== undefined ? ` ${spec.min ?? ""}..${spec.max ?? ""}` : "";
      type = `number${range}${spec.default !== undefined ? ` (default ${spec.default})` : ""}`;
      break;
    }
  }
  return `    - ${name}${req}: ${type} — ${spec.desc}`;
}

export function renderPresetMenu(): string {
  const names = Object.keys(PRESET_KNOBS) as PresetName[];
  const byCategory = new Map<string, PresetName[]>();
  for (const n of names) {
    const cat = PRESET_META[n].category;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(n);
  }

  const blocks: string[] = [];

  // Scene-shell fields apply to ANY scene regardless of preset — document
  // them once up front so the model treats them as scene-level, not as
  // something it has to look up per preset.
  blocks.push("### Scene-level fields (optional on ANY scene, alongside its preset knobs)");
  for (const k of SCENE_SHELL_KEYS) {
    blocks.push(knobLine(k, SCENE_SHELL[k]));
  }
  blocks.push("");

  for (const [cat, presets] of byCategory) {
    blocks.push(`### Category: ${cat}`);
    for (const name of presets) {
      const meta = PRESET_META[name];
      blocks.push(`\n#### ${name}  (energy: ${meta.energy})`);
      blocks.push(meta.intent);
      blocks.push("  knobs:");
      const knobs = PRESET_KNOBS[name];
      for (const k of Object.keys(knobs)) {
        blocks.push(knobLine(k, knobs[k]));
      }
    }
    blocks.push("");
  }
  return blocks.join("\n");
}
