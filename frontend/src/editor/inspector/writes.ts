// writes.ts — 인스펙터 공용 쓰기 헬퍼. 전부 updateDoc + setByPath 경유.

import { useEditor } from "@/editor/store";
import { getElement, getScene, type ElementPath } from "@/editor/specPath";
import { setByPath, deleteByPath } from "@/editor/setByPath";
import type { MotionLayer } from "@engine/motion/core/timing";

// 레이어 props 내부 경로 (예: "props.perLetter.easing") 쓰기
export function writeLayerKnob(
  elementPath: ElementPath,
  layerIdx: number,
  knobPath: string,
  value: unknown,
  live: boolean,
  label: string,
) {
  useEditor.getState().updateDoc(
    label,
    (draft) => {
      const el = getElement(draft, elementPath);
      if (!el || el.element === "logo") return;
      const layers = (el as { layers?: MotionLayer[] }).layers;
      const layer = layers?.[layerIdx];
      if (!layer) return;
      setByPath(layer as unknown as Record<string, unknown>, knobPath, value);
    },
    { coalesceKey: live ? `insp-layer-${elementPath}-${layerIdx}-${knobPath}` : undefined },
  );
  if (!live) useEditor.getState().endCoalescing();
}

// 요소 필드 (base.*, effects.*, color) 쓰기
export function writeElementField(
  elementPath: ElementPath,
  path: string,
  value: unknown,
  live: boolean,
  label: string,
) {
  useEditor.getState().updateDoc(
    label,
    (draft) => {
      const el = getElement(draft, elementPath);
      if (!el) return;
      setByPath(el as unknown as Record<string, unknown>, path, value);
    },
    { coalesceKey: live ? `insp-el-${elementPath}-${path}` : undefined },
  );
  if (!live) useEditor.getState().endCoalescing();
}

export function deleteElementField(elementPath: ElementPath, path: string, label: string) {
  useEditor.getState().updateDoc(label, (draft) => {
    const el = getElement(draft, elementPath);
    if (!el) return;
    deleteByPath(el as unknown as Record<string, unknown>, path);
  });
}

// 씬 필드 쓰기
export function writeSceneField(
  sceneIdx: number,
  path: string,
  value: unknown,
  live: boolean,
  label: string,
) {
  useEditor.getState().updateDoc(
    label,
    (draft) => {
      const scene = draft.scenes[sceneIdx];
      if (!scene) return;
      setByPath(scene as unknown as Record<string, unknown>, path, value);
    },
    { coalesceKey: live ? `insp-scene-${sceneIdx}-${path}` : undefined },
  );
  if (!live) useEditor.getState().endCoalescing();
}

export function deleteSceneField(sceneIdx: number, path: string, label: string) {
  useEditor.getState().updateDoc(label, (draft) => {
    const scene = draft.scenes[sceneIdx];
    if (!scene) return;
    deleteByPath(scene as unknown as Record<string, unknown>, path);
  });
}

export function removeLayer(elementPath: ElementPath, layerIdx: number, label: string) {
  useEditor.getState().updateDoc(label, (draft) => {
    const el = getElement(draft, elementPath);
    if (!el || el.element === "logo") return;
    const layers = (el as { layers?: MotionLayer[] }).layers;
    layers?.splice(layerIdx, 1);
  });
}

export function moveLayer(elementPath: ElementPath, from: number, to: number, label: string) {
  useEditor.getState().updateDoc(label, (draft) => {
    const el = getElement(draft, elementPath);
    if (!el || el.element === "logo") return;
    const layers = (el as { layers?: MotionLayer[] }).layers;
    if (!layers || to < 0 || to >= layers.length) return;
    const [l] = layers.splice(from, 1);
    layers.splice(to, 0, l);
  });
}

// scene/element 존재 확인 편의
export { getElement, getScene };
