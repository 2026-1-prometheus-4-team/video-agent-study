// camera.ts — 키프레임 카메라 편집 헬퍼. 타임라인 카메라 트랙 + 인스펙터 공용.
// 전부 store.updateDoc 경유. 카메라는 씬 소속(scene.camera).

"use client";

import { useEditor } from "./store";
import { sampleCameraKeyframes, type CameraKeyframe, type SceneSpec } from "@engine/motion/SceneRenderer";
import { getElement, type ElementPath } from "./specPath";

function store() {
  return useEditor.getState();
}

export function getKeyframes(scene: SceneSpec | undefined): CameraKeyframe[] {
  const cam = scene?.camera;
  if (cam && cam.type === "keyframes") return cam.keyframes ?? [];
  return [];
}

/** 카메라를 키프레임 모드로 전환(기존 키프레임 유지). */
export function enableKeyframeCamera(sceneIdx: number) {
  store().updateDoc("Camera keyframe mode", (draft) => {
    const scene = draft.scenes[sceneIdx];
    if (!scene) return;
    if (scene.camera?.type === "keyframes") return;
    scene.camera = { type: "keyframes", keyframes: [] };
  });
}

/** 카메라 제거. */
export function clearCamera(sceneIdx: number) {
  store().updateDoc("Remove camera", (draft) => {
    delete draft.scenes[sceneIdx].camera;
  });
  useEditor.setState((s) => ({ ui: { ...s.ui, selectedKeyframe: null } }));
}

/**
 * 플레이헤드(localFrame)에 키프레임 추가. 현재 보간된 카메라 값을 캡처해 넣어
 * 추가 즉시 화면이 튀지 않게 한다. 같은 프레임에 이미 있으면 그걸 갱신.
 * 반환: 추가된(또는 갱신된) 키프레임 인덱스.
 */
export function addCameraKeyframeAt(sceneIdx: number, localFrame: number): number {
  const scene = store().doc?.scenes[sceneIdx];
  const existing = getKeyframes(scene);
  const cur = sampleCameraKeyframes(existing, localFrame);
  const frame = Math.max(0, Math.round(localFrame));
  const dupIdx = existing.findIndex((k) => k.frame === frame);
  const kf: CameraKeyframe = {
    frame,
    scale: Number(cur.scale.toFixed(4)),
    x: Number(cur.x.toFixed(4)),
    y: Number(cur.y.toFixed(4)),
    rotate: Number(cur.rotate.toFixed(2)),
    // 3D 회전도 캡처(완전한 포즈) — 회전 중 키 삽입해도 안 튀게.
    rotateX: Number(cur.rotateX.toFixed(2)),
    rotateY: Number(cur.rotateY.toFixed(2)),
    easing: "easeInOut",
  };
  store().updateDoc("Add camera keyframe", (draft) => {
    const s = draft.scenes[sceneIdx];
    if (s.camera?.type !== "keyframes") s.camera = { type: "keyframes", keyframes: [] };
    const kfs = (s.camera as { keyframes: CameraKeyframe[] }).keyframes;
    if (dupIdx >= 0) kfs[dupIdx] = kf;
    else kfs.push(kf);
    kfs.sort((a, b) => a.frame - b.frame);
  });
  // 정렬 후 인덱스 재확인
  const after = getKeyframes(store().doc?.scenes[sceneIdx]);
  return after.findIndex((k) => k.frame === frame);
}

/** 키프레임의 한 필드 수정 (scale/x/y/rotate/easing/frame). */
export function updateCameraKeyframe(
  sceneIdx: number,
  kfIndex: number,
  patch: Partial<CameraKeyframe>,
  live: boolean,
) {
  store().updateDoc(
    "Edit camera keyframe",
    (draft) => {
      const s = draft.scenes[sceneIdx];
      if (s.camera?.type !== "keyframes") return;
      const kf = s.camera.keyframes[kfIndex];
      if (!kf) return;
      Object.assign(kf, patch);
    },
    { coalesceKey: live ? `cam-kf-${sceneIdx}-${kfIndex}` : undefined },
  );
  if (!live) store().endCoalescing();
}

/** 키프레임 프레임 이동(드래그). 정렬 후 selectedKeyframe 인덱스도 갱신. */
export function moveCameraKeyframe(sceneIdx: number, kfIndex: number, newFrame: number, live: boolean) {
  const frame = Math.max(0, Math.round(newFrame));
  store().updateDoc(
    "Move camera keyframe",
    (draft) => {
      const s = draft.scenes[sceneIdx];
      if (s.camera?.type !== "keyframes") return;
      const kf = s.camera.keyframes[kfIndex];
      if (kf) kf.frame = frame;
    },
    { coalesceKey: live ? `cam-kf-move-${sceneIdx}-${kfIndex}` : undefined },
  );
  if (!live) {
    store().updateDoc("Sort camera keyframes", (draft) => {
      const s = draft.scenes[sceneIdx];
      if (s.camera?.type === "keyframes") s.camera.keyframes.sort((a, b) => a.frame - b.frame);
    });
    store().endCoalescing();
    const after = getKeyframes(store().doc?.scenes[sceneIdx]);
    const idx = after.findIndex((k) => k.frame === frame);
    if (idx >= 0) useEditor.setState((st) => ({ ui: { ...st.ui, selectedKeyframe: { sceneIdx, kfIndex: idx } } }));
  }
}

export function deleteCameraKeyframe(sceneIdx: number, kfIndex: number) {
  store().updateDoc("Delete camera keyframe", (draft) => {
    const s = draft.scenes[sceneIdx];
    if (s.camera?.type !== "keyframes") return;
    s.camera.keyframes.splice(kfIndex, 1);
  });
  useEditor.setState((st) => ({ ui: { ...st.ui, selectedKeyframe: null } }));
}

export function selectKeyframe(sceneIdx: number, kfIndex: number) {
  useEditor.setState((st) => ({ ui: { ...st.ui, selectedKeyframe: { sceneIdx, kfIndex } } }));
}

/**
 * 선택 요소로 카메라를 "포커스"하는 키프레임을 localFrame 에 upsert.
 * 요소 중심(base.position)이 화면 중앙에 오도록 scale 배율에 맞춰 x/y 를 계산한다.
 * (transform-origin 50% 50% + scale 후 translate 기하: tx = -(px-0.5)*S)
 * 여러 요소에 순차 포커스하려면: 각 요소에서 프레임 옮기며 이 함수를 호출.
 * 반환: 키프레임 인덱스.
 */
export function focusOnElement(
  sceneIdx: number,
  localFrame: number,
  elementPath: ElementPath,
  scale = 1.8,
): number {
  const doc = store().doc;
  const el = doc ? getElement(doc, elementPath) : null;
  const base = (el as { base?: { position?: { x: number; y: number } } } | null)?.base;
  const pos = base?.position ?? { x: 0.5, y: 0.5 };
  const s = Math.max(0.2, Math.min(5, scale));
  const x = -(pos.x - 0.5) * s;
  const y = -(pos.y - 0.5) * s;
  const frame = Math.max(0, Math.round(localFrame));
  store().updateDoc("Camera focus", (draft) => {
    const sc = draft.scenes[sceneIdx];
    if (sc.camera?.type !== "keyframes") sc.camera = { type: "keyframes", keyframes: [] };
    const kfs = (sc.camera as { keyframes: CameraKeyframe[] }).keyframes;
    const kf: CameraKeyframe = { frame, scale: Number(s.toFixed(3)), x: Number(x.toFixed(4)), y: Number(y.toFixed(4)), rotate: 0, easing: "easeInOut" };
    const dup = kfs.findIndex((k) => k.frame === frame);
    if (dup >= 0) kfs[dup] = { ...kfs[dup], ...kf };
    else {
      kfs.push(kf);
      kfs.sort((a, b) => a.frame - b.frame);
    }
  });
  const after = getKeyframes(store().doc?.scenes[sceneIdx]);
  return after.findIndex((k) => k.frame === frame);
}

/**
 * 캔버스 직접 조작: localFrame 의 현재 카메라 값에 델타를 적용해 그 프레임의
 * 키프레임을 upsert(없으면 생성). 드래그/휠 연속 조작은 coalesce.
 */
export function applyCameraDelta(
  sceneIdx: number,
  localFrame: number,
  delta: { dScale?: number; dx?: number; dy?: number },
  live: boolean,
) {
  const frame = Math.max(0, Math.round(localFrame));
  store().updateDoc(
    "Camera adjust",
    (draft) => {
      const s = draft.scenes[sceneIdx];
      if (s.camera?.type !== "keyframes") s.camera = { type: "keyframes", keyframes: [] };
      const kfs = (s.camera as { keyframes: CameraKeyframe[] }).keyframes;
      const cur = sampleCameraKeyframes(kfs, frame);
      const next: CameraKeyframe = {
        frame,
        scale: Math.max(0.2, Math.min(5, cur.scale + (delta.dScale ?? 0))),
        x: cur.x + (delta.dx ?? 0),
        y: cur.y + (delta.dy ?? 0),
        rotate: cur.rotate,
        rotateX: cur.rotateX,
        rotateY: cur.rotateY,
        easing: "easeInOut",
      };
      const dup = kfs.findIndex((k) => k.frame === frame);
      if (dup >= 0) kfs[dup] = { ...kfs[dup], ...next };
      else {
        kfs.push(next);
        kfs.sort((a, b) => a.frame - b.frame);
      }
    },
    { coalesceKey: live ? `cam-manip-${sceneIdx}-${frame}` : undefined },
  );
  if (!live) store().endCoalescing();
}
