// light.ts — 씬 라이트 키프레임 편집 헬퍼 (camera.ts 의 라이트판).
// 타임라인 Scene 트랙의 Light lane + 씬 인스펙터 Light 섹션 공용.
// 모델: 카메라와 동일한 "전체 상태 키프레임" — 키 추가 시 현재 보간값을 전부
// 캡처해 추가 즉시 화면이 튀지 않는다. 채널별 독립 보간은 엔진 sampleLight
// Keyframes 가 담당.

"use client";

import { useEditor } from "./store";
import { sampleLightKeyframes, lightOnAt, type SceneLightSpec, type LightKeyframe } from "@engine/motion/lighting";
export { lightOnAt };

function store() {
  return useEditor.getState();
}

export function getLightKeyframes(scene: { light?: SceneLightSpec } | undefined): LightKeyframe[] {
  return scene?.light?.keyframes ?? [];
}

/** 라이트가 애니메이션 중인가 (키 1개 이상 = armed). */
export function isLightArmed(scene: { light?: SceneLightSpec } | undefined): boolean {
  return getLightKeyframes(scene).length > 0;
}

/** 플레이헤드에 라이트 키프레임 추가 — 현재 보간 상태 전체 캡처(카메라와 동일).
 *  같은 프레임에 이미 있으면 갱신. 반환: 정렬 후 인덱스. */
export function addLightKeyframeAt(sceneIdx: number, localFrame: number): number {
  const scene = store().doc?.scenes[sceneIdx];
  const light = scene?.light;
  if (!light) return -1;
  const frame = Math.max(0, Math.round(localFrame));
  const cur = sampleLightKeyframes(light, frame);
  const pos = cur.position ?? { x: 0.35, y: 0.3 };
  const kf: LightKeyframe = {
    frame,
    x: Number(pos.x.toFixed(4)),
    y: Number(pos.y.toFixed(4)),
    ...(pos.z != null ? { z: Number(pos.z.toFixed(2)) } : {}),
    intensity: Number((cur.intensity ?? 0.8).toFixed(4)),
    ambient: Number((cur.ambient ?? 0.35).toFixed(4)),
    azimuth: Number((cur.azimuth ?? 135).toFixed(2)),
    elevation: Number((cur.elevation ?? 35).toFixed(2)),
    ...(cur.falloff != null ? { falloff: Number(cur.falloff.toFixed(4)) } : {}),
    easing: "easeInOut",
  };
  const existing = light.keyframes ?? [];
  const dupIdx = existing.findIndex((k) => k.frame === frame);
  store().updateDoc("Add light keyframe", (draft) => {
    const l = draft.scenes[sceneIdx]?.light;
    if (!l) return;
    if (!Array.isArray(l.keyframes)) l.keyframes = [];
    if (dupIdx >= 0) l.keyframes[dupIdx] = kf;
    else l.keyframes.push(kf);
    l.keyframes.sort((a, b) => a.frame - b.frame);
  });
  const after = getLightKeyframes(store().doc?.scenes[sceneIdx]);
  return after.findIndex((k) => k.frame === frame);
}

/** 키프레임 프레임 이동(드래그). live 면 히스토리 coalesce. */
export function moveLightKeyframe(sceneIdx: number, kfIndex: number, newFrame: number, live: boolean) {
  const frame = Math.max(0, Math.round(newFrame));
  store().updateDoc(
    "Move light keyframe",
    (draft) => {
      const kfs = draft.scenes[sceneIdx]?.light?.keyframes;
      if (kfs?.[kfIndex]) kfs[kfIndex].frame = frame;
    },
    { coalesceKey: live ? `light-kf-move-${sceneIdx}-${kfIndex}` : undefined },
  );
  if (!live) store().endCoalescing();
}

export function deleteLightKeyframe(sceneIdx: number, kfIndex: number) {
  store().updateDoc("Delete light keyframe", (draft) => {
    const l = draft.scenes[sceneIdx]?.light;
    if (!l?.keyframes) return;
    l.keyframes.splice(kfIndex, 1);
    if (l.keyframes.length === 0) delete l.keyframes;
  });
}

/** 라이트 필드 쓰기 — armed(키 존재)면 플레이헤드 프레임 키에 upsert(AE 시멘틱),
 *  아니면 base 필드 정적 쓰기. 필드명은 LightKeyframe 채널명 기준
 *  (x/y/z/intensity/ambient/azimuth/elevation/falloff). */
export function writeLightField(
  sceneIdx: number,
  field: "x" | "y" | "z" | "intensity" | "ambient" | "azimuth" | "elevation" | "falloff",
  v: number,
  localFrame: number,
  live: boolean,
) {
  const scene = store().doc?.scenes[sceneIdx];
  if (!scene?.light) return;
  if (isLightArmed(scene)) {
    const frame = Math.max(0, Math.round(localFrame));
    const dupIdx = (scene.light.keyframes ?? []).findIndex((k) => k.frame === frame);
    if (dupIdx >= 0) {
      store().updateDoc(
        "Light keyframe",
        (draft) => {
          const kfs = draft.scenes[sceneIdx]?.light?.keyframes;
          if (kfs?.[dupIdx]) kfs[dupIdx][field] = v;
        },
        { coalesceKey: live ? `light-kf-${sceneIdx}-${field}` : undefined },
      );
      if (!live) store().endCoalescing();
    } else {
      // 그 프레임에 키가 없으면 현재 상태 캡처로 새 키 만들고 필드 덮기
      const idx = addLightKeyframeAt(sceneIdx, frame);
      if (idx >= 0)
        store().updateDoc("Light keyframe", (draft) => {
          const kfs = draft.scenes[sceneIdx]?.light?.keyframes;
          if (kfs?.[idx]) kfs[idx][field] = v;
        });
    }
  } else {
    // 정적 base — position 필드는 light.position.* 로, 나머지는 light.* 로
    const loc = field === "x" || field === "y" || field === "z" ? `light.position.${field}` : `light.${field}`;
    store().updateDoc(
      "Light",
      (draft) => {
        const l = draft.scenes[sceneIdx]?.light as Record<string, unknown> & { position?: { x: number; y: number; z?: number } };
        if (!l) return;
        if (field === "x" || field === "y" || field === "z") {
          l.position = { ...(l.position ?? { x: 0.35, y: 0.3 }), [field]: v };
        } else {
          l[field] = v;
        }
      },
      { coalesceKey: live ? `light-${sceneIdx}-${loc}` : undefined },
    );
    if (!live) store().endCoalescing();
  }
}

/** 현재 프레임의 보간된 라이트 (표시용). 키 없으면 base 그대로. */
export function sampledLight(scene: { light?: SceneLightSpec } | undefined, localFrame: number): SceneLightSpec | null {
  if (!scene?.light) return null;
  return sampleLightKeyframes(scene.light, Math.max(0, Math.round(localFrame)));
}

/** 플레이헤드에서 라이트 on/off 토글 — 스텝 키(on: 0|1)를 그 프레임에 upsert.
 *  한 트랙에서 여러 활성 구간(A on / B off / C on)을 만든다. */
export function toggleLightAt(sceneIdx: number, localFrame: number) {
  const scene = store().doc?.scenes[sceneIdx];
  const light = scene?.light;
  if (!light) return;
  const frame = Math.max(0, Math.round(localFrame));
  const next: 0 | 1 = lightOnAt(light, frame) ? 0 : 1;
  store().updateDoc(next ? "Light on" : "Light off", (draft) => {
    const l = draft.scenes[sceneIdx]?.light;
    if (!l) return;
    if (!Array.isArray(l.keyframes)) l.keyframes = [];
    const dup = l.keyframes.findIndex((k) => k.frame === frame && typeof k.on === "number");
    if (dup >= 0) l.keyframes[dup].on = next;
    else {
      // 같은 프레임의 일반 키가 있으면 거기에 on 만 얹고, 없으면 on 전용 키
      const same = l.keyframes.findIndex((k) => k.frame === frame);
      if (same >= 0) l.keyframes[same].on = next;
      else l.keyframes.push({ frame, on: next });
    }
    l.keyframes.sort((a, b) => a.frame - b.frame);
  });
}

/** on-구간 [start, end) 목록 (타임라인 밴드 렌더용). end=null 은 씬 끝까지. */
export function lightOnSegments(scene: { light?: SceneLightSpec } | undefined): { start: number; end: number | null }[] {
  const light = scene?.light;
  if (!light) return [];
  const pts = (light.keyframes ?? []).filter((k) => typeof k.on === "number").sort((a, b) => a.frame - b.frame);
  if (pts.length === 0) return [{ start: 0, end: null }];
  const segs: { start: number; end: number | null }[] = [];
  let on = true; // 첫 on-키 이전은 켜짐
  let segStart = 0;
  for (const k of pts) {
    const v = k.on === 1;
    if (v === on) continue;
    if (on) segs.push({ start: segStart, end: k.frame });
    else segStart = k.frame;
    on = v;
  }
  if (on) segs.push({ start: segStart, end: null });
  return segs;
}

/** 스톱워치 끄기 — 현재 보간값을 base 로 bake 후 키 전부 삭제 (요소 disarm 과
 *  동일한 "화면 안 튀는" 시멘틱). */
export function disarmLight(sceneIdx: number, bakeFrame: number) {
  const scene = store().doc?.scenes[sceneIdx];
  const light = scene?.light;
  if (!light?.keyframes?.length) return;
  const cur = sampleLightKeyframes(light, Math.max(0, Math.round(bakeFrame)));
  store().updateDoc("Remove light keyframes", (draft) => {
    const l = draft.scenes[sceneIdx]?.light;
    if (!l) return;
    l.position = cur.position;
    l.intensity = cur.intensity;
    l.ambient = cur.ambient;
    l.azimuth = cur.azimuth;
    l.elevation = cur.elevation;
    if (cur.falloff != null) l.falloff = cur.falloff;
    delete l.keyframes;
  });
}
