// normalize.ts
// remotion/src/Root.tsx 의 normalizeSpec 로직 포트. specs/*.json 의 3가지 형태
// (full VideoSpec / single scene / preset scene)를 항상 full VideoSpec 으로
// 정규화한다. Root.tsx 는 스튜디오 전용 부수효과(require.context, delayRender)
// 때문에 직접 import 하지 않는다 — 규칙이 바뀌면 여기도 같이 갱신할 것.

import { audioClipList, type AudioClipSpec, type SceneSpec, type VideoSpec } from "@engine/motion/SceneRenderer";
import {
  expandPresetScene,
  isPresetName,
  type Brand,
} from "@engine/presets";

// Root.tsx 와 동일: 스튜디오는 24fps 고정. 스펙의 fps 필드는 무시된다.
export const FPS = 24;

export const SINGLE_SCENE_DEFAULTS: Brand = {
  background: "#0D0B10",
  fontFamily: "General Sans, Inter, Helvetica, Arial, sans-serif",
  colors: ["#7C4DFF", "#FF4D9D", "#4D7DFF"],
};

export type PresetSceneInput = { preset: string } & Record<string, unknown>;
export type RawScene = SceneSpec | PresetSceneInput;
export type RawVideoSpec = {
  fps?: number;
  brand?: Brand;
  brandDefaults?: Brand;
  scenes: RawScene[];
};

export function isPresetScene(s: RawScene): s is PresetSceneInput {
  return typeof (s as PresetSceneInput).preset === "string";
}

export function expandScene(raw: RawScene, brand: Brand): SceneSpec {
  if (!isPresetScene(raw)) return raw;
  const { preset, ...knobs } = raw;
  if (!isPresetName(preset)) {
    throw new Error(`Unknown preset "${preset}".`);
  }
  return expandPresetScene(preset, knobs, { brand });
}

export type SpecShape = "video" | "scene" | "preset";

export function detectShape(raw: unknown): SpecShape {
  const obj = raw as Partial<RawVideoSpec> &
    Partial<SceneSpec> &
    Partial<PresetSceneInput>;
  if (Array.isArray(obj.scenes)) return "video";
  if (typeof obj.preset === "string") return "preset";
  if (Array.isArray(obj.elements)) return "scene";
  throw new Error(
    "spec json must be a VideoSpec (scenes), a single scene (elements), or a preset (preset).",
  );
}

// 프리셋 씬 포함 여부 — 에디터에서 "확장 편집" 경고를 띄우는 근거.
export function containsPreset(raw: unknown): boolean {
  const obj = raw as Partial<RawVideoSpec> & Partial<PresetSceneInput>;
  if (typeof obj.preset === "string") return true;
  if (Array.isArray(obj.scenes)) return obj.scenes.some(isPresetScene);
  return false;
}

export function normalizeSpec(raw: unknown): VideoSpec {
  const obj = raw as Partial<RawVideoSpec> &
    Partial<SceneSpec> &
    Partial<PresetSceneInput>;

  if (Array.isArray(obj.scenes)) {
    const brand = obj.brand ?? obj.brandDefaults ?? SINGLE_SCENE_DEFAULTS;
    const reference = (obj as { reference?: VideoSpec["reference"] }).reference;
    // 에디터 doc 은 항상 클립 배열 형태 (구형 단일 객체는 로드 시 1클립으로)
    const audio: AudioClipSpec[] = audioClipList(
      (obj as { audio?: VideoSpec["audio"] }).audio,
    ).map((c, i) => ({ ...c, id: c.id ?? `audio-${i + 1}` }));
    return {
      fps: obj.fps ?? FPS,
      brandDefaults: brand,
      scenes: obj.scenes.map((s) => expandScene(s, brand)),
      // 에디터 전용 메타 — 재구성 시 버리면 레퍼런스 오버레이가 저장 안 됨
      ...(reference ? { reference } : {}),
      ...(audio.length ? { audio } : {}),
    };
  }

  if (typeof obj.preset === "string") {
    const brand = SINGLE_SCENE_DEFAULTS;
    return {
      fps: FPS,
      brandDefaults: brand,
      scenes: [expandScene(obj as PresetSceneInput, brand)],
    };
  }

  if (Array.isArray(obj.elements)) {
    return {
      fps: FPS,
      brandDefaults: SINGLE_SCENE_DEFAULTS,
      scenes: [obj as SceneSpec],
    };
  }

  throw new Error(
    "spec json must be a VideoSpec (scenes), a single scene (elements), or a preset (preset).",
  );
}
