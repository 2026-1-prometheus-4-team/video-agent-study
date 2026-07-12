// specPath.ts
// 요소 경로 모델. VideoSpec 트리에서 요소 하나를 가리키는 안정적 주소.
//
//   "0:2"       -> scenes[0].elements[2]
//   "0:2.1"     -> scenes[0].elements[2](group).children[1]
//   "0:2.1.0"   -> 그룹 중첩
//
// 씬 자체는 sceneIdx(number) 로 다루고, ElementPath 는 항상 요소를 가리킨다.
// 경로는 인덱스 기반이라 요소 추가/삭제/재정렬 시 무효화된다 — 구조 변경
// mutation 은 반드시 selection 도 함께 갱신할 것 (store.updateDoc 참고).

import type {
  SceneSpec,
  SceneElementSpec,
  GroupElementSpec,
  FrameElementSpec,
  DeviceElementSpec,
  VideoSpec,
} from "@engine/motion/SceneRenderer";

export type ElementPath = string;

export type ParsedPath = {
  sceneIdx: number;
  /** elements[] 로부터의 인덱스 체인. [2, 1] = elements[2].children[1] */
  indices: number[];
};

export function parsePath(path: ElementPath): ParsedPath {
  const [scenePart, elPart] = path.split(":");
  const sceneIdx = Number(scenePart);
  const indices = (elPart ?? "")
    .split(".")
    .filter((s) => s.length > 0)
    .map(Number);
  if (!Number.isInteger(sceneIdx) || indices.some((n) => !Number.isInteger(n))) {
    throw new Error(`invalid element path: "${path}"`);
  }
  return { sceneIdx, indices };
}

export function buildPath(sceneIdx: number, indices: number[]): ElementPath {
  return `${sceneIdx}:${indices.join(".")}`;
}

export function parentPath(path: ElementPath): ElementPath | null {
  const { sceneIdx, indices } = parsePath(path);
  if (indices.length <= 1) return null;
  return buildPath(sceneIdx, indices.slice(0, -1));
}

export function pathSceneIdx(path: ElementPath): number {
  return parsePath(path).sceneIdx;
}

export function isGroup(el: SceneElementSpec | undefined | null): el is GroupElementSpec {
  return !!el && el.element === "group";
}

/** 자식을 갖는 컨테이너(group | frame). 중첩/reparent 규칙은 이걸로. */
export function isContainer(
  el: SceneElementSpec | undefined | null,
): el is GroupElementSpec | FrameElementSpec {
  return !!el && (el.element === "group" || el.element === "frame");
}

/** children 배열을 갖는 모든 요소(group | frame | device). 트리 순회는 이걸로 —
 *  device 는 스크린 앵커 자식을 갖지만 임의 drop 대상은 아니라 isContainer 와 분리. */
export function hasChildren(
  el: SceneElementSpec | undefined | null,
): el is GroupElementSpec | FrameElementSpec | DeviceElementSpec {
  return !!el && (el.element === "group" || el.element === "frame" || el.element === "device");
}

/** 경로가 가리키는 요소. 없으면 null (경로 무효). */
export function getElement(
  spec: VideoSpec,
  path: ElementPath,
): SceneElementSpec | null {
  const { sceneIdx, indices } = parsePath(path);
  const scene = spec.scenes?.[sceneIdx];
  if (!scene || indices.length === 0) return null;
  let el: SceneElementSpec | undefined = scene.elements?.[indices[0]];
  for (let i = 1; i < indices.length; i++) {
    if (!hasChildren(el)) return null;
    el = el.children?.[indices[i]];
  }
  return el ?? null;
}

export function getScene(spec: VideoSpec, path: ElementPath): SceneSpec | null {
  return spec.scenes?.[pathSceneIdx(path)] ?? null;
}

/** 요소가 담긴 배열(부모의 elements 또는 children)과 그 안 인덱스. draft 에도 사용 가능. */
export function getContainer(
  spec: VideoSpec,
  path: ElementPath,
): { list: SceneElementSpec[]; index: number } | null {
  const { sceneIdx, indices } = parsePath(path);
  const scene = spec.scenes?.[sceneIdx];
  if (!scene || indices.length === 0) return null;
  if (indices.length === 1) {
    return scene.elements ? { list: scene.elements, index: indices[0] } : null;
  }
  const holder = getElement(spec, buildPath(sceneIdx, indices.slice(0, -1)));
  if (!hasChildren(holder) || !holder.children) return null;
  return { list: holder.children, index: indices[indices.length - 1] };
}

/** 한 씬의 모든 요소를 (path, element, depth) 로 평탄화. 레이어 트리/오버레이용. */
export function flattenScene(
  spec: VideoSpec,
  sceneIdx: number,
): Array<{ path: ElementPath; el: SceneElementSpec; depth: number }> {
  const out: Array<{ path: ElementPath; el: SceneElementSpec; depth: number }> = [];
  const scene = spec.scenes?.[sceneIdx];
  if (!scene) return out;
  const walk = (els: SceneElementSpec[], prefix: number[], depth: number) => {
    els.forEach((el, i) => {
      const indices = [...prefix, i];
      out.push({ path: buildPath(sceneIdx, indices), el, depth });
      if (hasChildren(el) && el.children) walk(el.children, indices, depth + 1);
    });
  };
  walk(scene.elements ?? [], [], 0);
  return out;
}

/** path 가 ancestor 의 자손(또는 자신)인가 */
export function isDescendantOf(path: ElementPath, ancestor: ElementPath): boolean {
  if (path === ancestor) return true;
  const p = parsePath(path);
  const a = parsePath(ancestor);
  if (p.sceneIdx !== a.sceneIdx) return false;
  if (a.indices.length >= p.indices.length) return false;
  return a.indices.every((v, i) => p.indices[i] === v);
}

/** 선택 목록 정규화: 중복 제거 + 조상이 이미 선택돼 있으면 자손 제거(그룹 우선). */
export function normalizeSelection(paths: ElementPath[]): ElementPath[] {
  const unique = [...new Set(paths)]; // 동일 경로 중복 제거(중복 React key 방지)
  return unique.filter(
    (p) => !unique.some((a) => a !== p && isDescendantOf(p, a)),
  );
}

/** 요소의 표시 이름 (id > 텍스트 앞부분 > 타입) */
export function elementLabel(el: SceneElementSpec): string {
  if (el.element === "text") {
    const t = el.base?.text ?? "";
    return el.id ?? ((t.length > 24 ? t.slice(0, 24) + "..." : t) || "text");
  }
  if (el.element === "logo") return el.id ?? "logo";
  if (el.element === "shape") return el.id ?? "도형";
  if (el.element === "gooey") return el.id ?? "gooey";
  if (el.element === "image") return el.id ?? "image";
  if (el.element === "video") return el.id ?? "video";
  if (el.element === "shader") return el.id ?? "shader";
  if (el.element === "device") return el.id ?? "device";
  if (el.element === "frame") return el.id ?? "frame";
  return el.id ?? "group";
}
