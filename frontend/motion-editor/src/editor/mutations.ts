// mutations.ts
// 구조 변경 공용 헬퍼. 캔버스(alt-드래그 복제), 단축키, 레이어 패널이 전부
// 여기 함수를 쓴다 — 각자 구현 금지 (selection 갱신 규칙이 한 곳에 살아야 함).
// 모든 함수는 store.updateDoc 을 감싼 "커맨드"다.

"use client";

import type {
  GroupElementSpec,
  SceneElementSpec,
  SceneSpec,
  VideoSpec,
} from "@engine/motion/SceneRenderer";
import { sceneFrames, sampleCameraKeyframes, type CameraKeyframe } from "@engine/motion/SceneRenderer";
import { sampleLightKeyframes } from "@engine/motion/lighting";
import { chromeInsets } from "@engine/motion/chrome";
import type { MotionPathSpec, GroupLayoutSpec, PathPoint } from "@engine/motion/pathLayout";
import { FPS } from "@/engine/normalize";
import { COMP_W, COMP_H } from "./canvas/PlayerCanvas";
import { useEditor } from "./store";
import { decomposePreset, edgeLightLapKeys } from "./detachPresets";
import {
  buildPath,
  getContainer,
  getElement,
  parsePath,
  parentPath,
  normalizeSelection,
  isContainer,
  isDescendantOf,
  type ElementPath,
} from "./specPath";
import type { FrameElementSpec } from "@engine/motion/SceneRenderer";

function store() {
  return useEditor.getState();
}

/** 선택 요소들 삭제 */

// 문서 전체에서 유일한 복제 id — "-copy" 가 이미 있으면 -copy2, -copy3 ...
// (중복 id 는 React key 충돌 + 레이어 패널 오동작의 원인이 됐다)
function uniqueCopyId(doc: { scenes: Array<{ elements: unknown[] }> }, baseId: string, extra?: Set<string>): string {
  const ids = new Set<string>(extra ?? []);
  const walk = (els: unknown[]) => {
    for (const e of els as Array<{ id?: string; children?: unknown[] }>) {
      if (e.id) ids.add(e.id);
      if (Array.isArray(e.children)) walk(e.children);
    }
  };
  for (const sc of doc.scenes) walk(sc.elements as unknown[]);
  const root = baseId.replace(/-copy\d*$/, "");
  let cand = `${root}-copy`;
  let n = 2;
  while (ids.has(cand)) {
    cand = `${root}-copy${n}`;
    n += 1;
  }
  return cand;
}

export function deleteElements(paths: ElementPath[]) {
  const norm = normalizeSelection(paths);
  if (norm.length === 0) return;
  // 깊은 경로부터 지워야 얕은 인덱스가 안 밀린다
  const sorted = [...norm].sort((a, b) => {
    const pa = parsePath(a);
    const pb = parsePath(b);
    if (pa.sceneIdx !== pb.sceneIdx) return pb.sceneIdx - pa.sceneIdx;
    if (pa.indices.length !== pb.indices.length)
      return pb.indices.length - pa.indices.length;
    for (let i = pa.indices.length - 1; i >= 0; i--) {
      if (pa.indices[i] !== pb.indices[i]) return pb.indices[i] - pa.indices[i];
    }
    return 0;
  });
  store().updateDoc(
    `delete ${norm.length} element(s)`,
    (draft) => {
      for (const p of sorted) {
        const c = getContainer(draft, p);
        if (c) c.list.splice(c.index, 1);
      }
    },
    { selectAfter: [] },
  );
}

/** 선택 요소 복제 (같은 컨테이너 바로 뒤에 삽입). 반환: 새 경로들 */
export function duplicateElements(paths: ElementPath[]): ElementPath[] {
  const norm = normalizeSelection(paths);
  if (norm.length === 0) return [];

  // 컨테이너별로 묶는다(부모 경로 기준). 같은 컨테이너 안에서 클론을 앞쪽에
  // 삽입하면 뒤 원본 인덱스가 밀리므로, newPath 계산에 그 시프트를 반영해야 한다.
  // (버그 이력: idx+1 만 계산해 두 개 이상 복제 시 selection 이 원본을 가리켰다.)
  const doc = store().doc;
  if (!doc) return [];
  const containerKey = (p: ElementPath) => parentPath(p) ?? `${parsePath(p).sceneIdx}:`;
  const groups = new Map<string, { paths: ElementPath[]; lastIdx: number[] }>();
  for (const p of norm) {
    const key = containerKey(p);
    const g = groups.get(key) ?? { paths: [], lastIdx: [] };
    g.paths.push(p);
    g.lastIdx.push(parsePath(p).indices.at(-1)!);
    groups.set(key, g);
  }

  // 클론은 producer 밖에서 평문(비-draft) 요소로 만든다. immer draft 는 Proxy 라
  // structuredClone 이 DataCloneError 를 던진다(컨테이너#인덱스 → 클론 매핑).
  const cloneByKeyIdx = new Map<string, SceneElementSpec>();
  const takenIds = new Set<string>();
  for (const p of norm) {
    const el = getElement(doc, p);
    if (!el) continue;
    const clone = structuredClone(el) as SceneElementSpec;
    if (clone.id) {
      clone.id = uniqueCopyId(doc as unknown as { scenes: Array<{ elements: unknown[] }> }, clone.id, takenIds);
      takenIds.add(clone.id);
    }
    cloneByKeyIdx.set(`${containerKey(p)}#${parsePath(p).indices.at(-1)!}`, clone);
  }

  const newPaths: ElementPath[] = [];
  // 각 원본의 클론이 최종적으로 앉는 인덱스 = 원본인덱스 + 1 + (같은 컨테이너에서
  // 자기보다 앞선 선택 개수). 컨테이너 참조는 draft 에서 한 번에 확보해 삽입한다.
  store().updateDoc(
    `duplicate ${norm.length} element(s)`,
    (draft) => {
      // 컨테이너 list 참조를 먼저 전부 확보(참조는 splice 로도 불변) → 한 컨테이너
      // 조작이 다른 컨테이너 경로를 무효화하지 않는다.
      const lists = new Map<string, SceneElementSpec[]>();
      for (const [key, g] of groups) {
        const c = getContainer(draft, g.paths[0]);
        if (c) lists.set(key, c.list);
      }
      for (const [key, g] of groups) {
        const list = lists.get(key);
        if (!list) continue;
        // 큰 인덱스부터 삽입해야 앞 인덱스가 안 밀린다
        const desc = [...g.lastIdx].sort((a, b) => b - a);
        for (const idx of desc) {
          const clone = cloneByKeyIdx.get(`${key}#${idx}`);
          if (!clone) continue;
          list.splice(idx + 1, 0, clone);
        }
      }
    },
  );

  // 클론 최종 경로 계산 (컨테이너별 rank 시프트 반영)
  for (const [key, g] of groups) {
    const asc = [...g.lastIdx].sort((a, b) => a - b);
    for (const p of g.paths) {
      const { sceneIdx, indices } = parsePath(p);
      const origIdx = indices.at(-1)!;
      const rank = asc.filter((i) => i < origIdx).length;
      const next = [...indices];
      next[next.length - 1] = origIdx + 1 + rank;
      newPaths.push(buildPath(sceneIdx, next));
    }
    void key;
  }

  const sel = normalizeSelection(newPaths);
  store().select(sel);
  return sel;
}

/** 같은 컨테이너의 요소들을 group 으로 묶는다. 반환: 그룹 경로 (실패 null) */
export function groupElements(paths: ElementPath[]): ElementPath | null {
  const norm = normalizeSelection(paths);
  if (norm.length < 2) return null;
  const parsed = norm.map(parsePath);
  const sceneIdx = parsed[0].sceneIdx;
  const prefix = parsed[0].indices.slice(0, -1);
  const sameContainer = parsed.every(
    (p) =>
      p.sceneIdx === sceneIdx &&
      p.indices.length === prefix.length + 1 &&
      prefix.every((v, i) => p.indices[i] === v),
  );
  if (!sameContainer) return null; // 다른 컨테이너 간 그룹핑은 미지원

  const localIdx = parsed.map((p) => p.indices[p.indices.length - 1]).sort((a, b) => a - b);
  const insertAt = localIdx[0];
  const groupPath = buildPath(sceneIdx, [...prefix, insertAt]);

  store().updateDoc(
    `group ${norm.length} elements`,
    (draft) => {
      const c = getContainer(draft, norm[0]);
      if (!c) return;
      const members: SceneElementSpec[] = [];
      // 큰 인덱스부터 빼내기
      for (let i = localIdx.length - 1; i >= 0; i--) {
        members.unshift(...c.list.splice(localIdx[i], 1));
      }
      const group: GroupElementSpec = {
        element: "group",
        id: `group-${members.length}`,
        layers: [],
        children: members,
      };
      c.list.splice(insertAt, 0, group);
    },
    { selectAfter: [groupPath] },
  );
  return groupPath;
}

/** 그룹 해제 — 자식들을 그룹 자리에 풀어놓는다 */
// ---- 애니메이션 복사/스태거 붙여넣기 (AE copy keyframes + Sequence Layers) ----
// 한 요소의 layers(래퍼/구조 효과) + keyframes 를 복사해 다른 여러 요소에
// 붙여넣되, 요소마다 시간 offset(stagger)을 자동으로 줘서 "비슷한데 타이밍
// 살짝 다른" 무빙을 만든다. 마스터 추종(delay chain) 룩도 이걸로 커버.
type AnimClip = { layers: unknown[]; keyframes: unknown[] };
let animClipboard: AnimClip | null = null;

/** 요소의 애니메이션(layers+keyframes)을 복사. */
export function copyElementAnimation(path: ElementPath): boolean {
  const doc = store().doc;
  if (!doc) return false;
  const el = getElement(doc, path) as { layers?: unknown[]; keyframes?: unknown[] } | null;
  if (!el) return false;
  const layers = Array.isArray(el.layers) ? el.layers : [];
  const keyframes = Array.isArray(el.keyframes) ? el.keyframes : [];
  if (layers.length === 0 && keyframes.length === 0) return false;
  animClipboard = structuredClone({ layers, keyframes });
  return true;
}

export function hasAnimClipboard(): boolean {
  return !!animClipboard && ((animClipboard.layers?.length ?? 0) > 0 || (animClipboard.keyframes?.length ?? 0) > 0);
}

/** 복사한 애니메이션을 대상 요소들에 붙여넣기. staggerFrames>0 이면 대상 순서
 *  마다 layers 의 delay 와 keyframes 의 frame 을 index*stagger 만큼 밀어 시차. */
export function pasteElementAnimation(paths: ElementPath[], staggerFrames = 0): void {
  const clip = animClipboard;
  if (!clip) return;
  const targets = normalizeSelection(paths);
  if (targets.length === 0) return;
  store().updateDoc(
    `paste animation${staggerFrames ? " (stagger)" : ""}`,
    (draft) => {
      targets.forEach((tp, i) => {
        const el = getElement(draft, tp) as { layers?: unknown[]; keyframes?: unknown[] } | null;
        if (!el) return;
        const off = Math.round(i * staggerFrames);
        // layers — delay 에 offset 누적 (in/out/hold 모두 resolveTimings 가 소비)
        el.layers = (clip.layers as Array<{ props?: Record<string, unknown> }>).map((l) => {
          const c = structuredClone(l) as { props?: Record<string, number> };
          if (off) {
            c.props = { ...(c.props ?? {}) };
            c.props.delay = (Number(c.props.delay) || 0) + off;
          }
          return c;
        });
        // keyframes — frame 에 offset (음수 방지)
        el.keyframes = (clip.keyframes as Array<{ frame: number }>).map((k) => {
          const c = structuredClone(k) as { frame: number };
          if (off) c.frame = Math.max(0, c.frame + off);
          return c;
        });
        if ((el.keyframes as unknown[]).length === 0) delete el.keyframes;
        if ((el.layers as unknown[]).length === 0) delete el.layers;
      });
    },
    { selectAfter: targets },
  );
}

export function ungroupElement(path: ElementPath) {
  const doc = store().doc;
  if (!doc) return;
  const el = getElement(doc, path);
  if (!el || el.element !== "group") return;
  const { sceneIdx, indices } = parsePath(path);
  const childCount = el.children?.length ?? 0;
  const prefix = indices.slice(0, -1);
  const at = indices[indices.length - 1];
  const newPaths = Array.from({ length: childCount }, (_, i) =>
    buildPath(sceneIdx, [...prefix, at + i]),
  );
  store().updateDoc(
    "ungroup",
    (draft) => {
      const c = getContainer(draft, path);
      if (!c) return;
      const group = c.list[c.index] as GroupElementSpec;
      const children = group.children ?? [];
      c.list.splice(c.index, 1, ...children);
    },
    { selectAfter: newPaths },
  );
}

/** 그룹 자식 콘텐츠 중심(comp fraction) — leaf position 극값의 중점.
 *  frame 자식은 position 이 comp 기준이라 leaf 취급(내부 재귀 X — frame 내부
 *  좌표는 박스-로컬이라 comp 로 섞으면 틀림). group 만 재귀. */
function groupContentCenter(g: { children?: unknown[] }): { x: number; y: number } | null {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const walk = (els: unknown[]) => {
    for (const e of els as Array<{ element?: string; children?: unknown[]; base?: { position?: { x: number; y: number } } }>) {
      if (!e) continue;
      if (e.element === "group" && Array.isArray(e.children)) { walk(e.children); continue; }
      const pos = e.base?.position ?? { x: 0.5, y: 0.5 };
      minX = Math.min(minX, pos.x); maxX = Math.max(maxX, pos.x);
      minY = Math.min(minY, pos.y); maxY = Math.max(maxY, pos.y);
    }
  };
  walk(g.children ?? []);
  if (!Number.isFinite(minX)) return null;
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

/** 그룹 scale/rotate 피벗(base.anchor)을 자식 콘텐츠 중심으로 유지 — 콘텐츠가
 *  comp 중앙 밖에 있어도 제자리에서 수축/회전 (실측: 중앙 정렬 후 scale 시
 *  드리프트). 이미 같은 값이면 no-op — 편집 때마다 불러도 히스토리 안 쌓임. */
export function ensureGroupAnchor(path: ElementPath) {
  const doc = store().doc;
  const el = doc ? getElement(doc, path) : null;
  if (!el || el.element !== "group") return;
  const c = groupContentCenter(el as { children?: unknown[] });
  if (!c) return;
  const nx = Number(c.x.toFixed(4));
  const ny = Number(c.y.toFixed(4));
  const cur = (el.base as { anchor?: { x: number; y: number } } | undefined)?.anchor;
  if (cur && Math.abs(cur.x - nx) < 0.001 && Math.abs(cur.y - ny) < 0.001) return;
  store().updateDoc("Group pivot", (draft) => {
    const d = getElement(draft, path);
    if (!d || d.element !== "group") return;
    const g = d as { base?: Record<string, unknown> };
    if (!g.base) g.base = {};
    g.base.anchor = { x: nx, y: ny };
  });
}

/** Group -> Frame 전환(제자리). 그룹은 inset:0 컨테이너라 자식 position(0..1)이
 *  comp 전체 기준인데, position 0.5/0.5·width 100·height 100 인 frame 은 콘텐츠
 *  박스가 comp 전체와 일치 -> 자식 로컬좌표 == comp 좌표 == 그룹 때와 동일. 따라서
 *  base(위치/회전/3D/z/opacity)·layers·keyframes·children·curve3d 를 그대로 옮기고
 *  width/height=100, clipsContent=false(그룹은 클립 안 함) 만 얹으면 화면 불변.
 *  group.layout(path/orbit) 은 frame 이 소비 못 하므로 버린다(드문 케이스). */
export function convertGroupToFrame(path: ElementPath) {
  const doc = store().doc;
  if (!doc) return;
  const el = getElement(doc, path);
  if (!el || el.element !== "group") return;
  store().updateDoc(
    "Convert group to frame",
    (draft) => {
      const c = getContainer(draft, path);
      if (!c) return;
      const g = c.list[c.index] as GroupElementSpec;
      const gb = g.base ?? {};
      // 정의된 base 필드만 옮겨 스펙을 깔끔히 유지
      const base: FrameElementSpec["base"] = {
        position: gb.position ?? { x: 0.5, y: 0.5 },
        width: 100,
        height: 100,
        clipsContent: false,
      };
      if (gb.rotate !== undefined) base.rotate = gb.rotate;
      if (gb.rotateX !== undefined) base.rotateX = gb.rotateX;
      if (gb.rotateY !== undefined) base.rotateY = gb.rotateY;
      if (gb.opacity !== undefined) base.opacity = gb.opacity;
      const frame: FrameElementSpec = {
        element: "frame",
        base,
        children: g.children ?? [],
        ...(g.id !== undefined ? { id: g.id } : {}),
        ...(g.layers ? { layers: g.layers } : {}),
        ...(g.keyframes ? { keyframes: g.keyframes } : {}),
        ...(g.curve3d ? { curve3d: g.curve3d } : {}),
      };
      c.list[c.index] = frame;
    },
    { selectAfter: [path] },
  );
}

/** 위치 넛지 (viewport fraction). 텍스트/로고만 (group 은 position 이 없음) */
export function nudgeElements(paths: ElementPath[], dx: number, dy: number) {
  const norm = normalizeSelection(paths);
  if (norm.length === 0) return;
  store().updateDoc(
    "nudge",
    (draft) => {
      for (const p of norm) {
        const el = getElement(draft, p);
        if (!el) continue; // 그룹도 base.position(오프셋) 넛지 가능
        // gooey 위치는 base.fromShape (감사 #8 — position 을 쓰면 조용한 no-op)
        const holder = el as { base?: { position?: { x: number; y: number }; fromShape?: { x: number; y: number } } };
        if (!holder.base) holder.base = {}; // 그룹은 base 가 없을 수 있다
        const base = holder.base;
        const key = el.element === "gooey" ? "fromShape" : "position";
        const pos = base[key] ?? { x: 0.5, y: 0.5 };
        base[key] = {
          x: Math.min(11, Math.max(-10, pos.x + dx)),
          y: Math.min(11, Math.max(-10, pos.y + dy)),
        };
      }
    },
    { coalesceKey: "nudge" },
  );
}

/** 새 텍스트 요소 추가 (활성 씬 중앙). 반환: 경로 */
export function addTextElement(sceneIdx: number, text = "Text"): ElementPath | null {
  const doc = store().doc;
  if (!doc?.scenes?.[sceneIdx]) return null;
  const scene: SceneSpec = doc.scenes[sceneIdx];
  const newIdx = scene.elements?.length ?? 0;
  const path = buildPath(sceneIdx, [newIdx]);
  store().updateDoc(
    "add text",
    (draft) => {
      const s = draft.scenes[sceneIdx];
      if (!s.elements) s.elements = [];
      s.elements.push({
        element: "text",
        id: `text-${newIdx + 1}`,
        base: { text, fontSize: 5, color: "#FFFFFF", position: { x: 0.5, y: 0.5 } },
        // 등장 애니메이션 없음 — 에디터 생성 요소는 즉시 보인다 (Figma/AE 관례).
        // 기본 fade-in 이 있으면 f0 에서 opacity 0 이라 "만들자마자 사라지는"
        // 혼란을 만든다 (실측 리포트). 애니메이션은 Layers 섹션에서 명시 추가.
        layers: [],
      });
    },
    { selectAfter: [path] },
  );
  return path;
}

/** 새 도형(shape) 요소 추가. kind: rectangle/ellipse/line. 반환: 경로 */
export function addShapeElement(
  sceneIdx: number,
  kind: "rectangle" | "ellipse" | "line" = "rectangle",
): ElementPath | null {
  const doc = store().doc;
  if (!doc?.scenes?.[sceneIdx]) return null;
  const scene: SceneSpec = doc.scenes[sceneIdx];
  const newIdx = scene.elements?.length ?? 0;
  const path = buildPath(sceneIdx, [newIdx]);
  const base =
    kind === "ellipse"
      ? { kind, width: 16, height: 16, fill: "#7C4DFF", position: { x: 0.5, y: 0.5 } }
      : kind === "line"
        ? { kind, width: 30, height: 1, stroke: "#FFFFFF", strokeWidth: 3, position: { x: 0.5, y: 0.5 } }
        : { kind, width: 24, height: 14, fill: "#7C4DFF", radius: 16, position: { x: 0.5, y: 0.5 } };
  store().updateDoc(
    `add ${kind}`,
    (draft) => {
      const s = draft.scenes[sceneIdx];
      if (!s.elements) s.elements = [];
      s.elements.push({
        element: "shape",
        id: `${kind}-${newIdx + 1}`,
        base,
        layers: [],
      });
    },
    { selectAfter: [path] },
  );
  return path;
}

/** Frame 툴 드래그 생성 — rect 는 comp fraction(0..1) 좌상단 기준.
 *  Figma 관례: 새 frame 은 흰 fill + clip content ON. 반환: 경로 */
export function addFrameAt(
  sceneIdx: number,
  rect: { x: number; y: number; w: number; h: number },
): ElementPath | null {
  const doc = store().doc;
  if (!doc?.scenes?.[sceneIdx]) return null;
  const scene: SceneSpec = doc.scenes[sceneIdx];
  const newIdx = scene.elements?.length ?? 0;
  const path = buildPath(sceneIdx, [newIdx]);
  store().updateDoc(
    "add frame",
    (draft) => {
      const s = draft.scenes[sceneIdx];
      if (!s.elements) s.elements = [];
      s.elements.push({
        element: "frame",
        id: `frame-${newIdx + 1}`,
        base: {
          width: Math.round(rect.w * 1000) / 10,
          height: Math.round(rect.h * 1000) / 10,
          position: {
            x: Math.round((rect.x + rect.w / 2) * 10000) / 10000,
            y: Math.round((rect.y + rect.h / 2) * 10000) / 10000,
          },
          fill: { type: "solid", color: "#FFFFFF", visible: true },
          clipsContent: true,
        },
        children: [],
      } as unknown as SceneElementSpec);
    },
    { selectAfter: [path] },
  );
  return path;
}

/** 새 셰이더(living gradient 배경) 요소 추가. 반환: 경로 */
export function addShaderElement(sceneIdx: number): ElementPath | null {
  const doc = store().doc;
  if (!doc?.scenes?.[sceneIdx]) return null;
  const scene: SceneSpec = doc.scenes[sceneIdx];
  const count = scene.elements?.length ?? 0;
  // 셰이더는 배경 요소 — 레이어 맨 뒤(배열 index 0)에 삽입. 뒤에 만들어도
  // 기존/신규 콘텐츠(텍스트 등)가 항상 그 위에 그려진다. 필요하면 레이어
  // 패널에서 올릴 수 있다.
  const path = buildPath(sceneIdx, [0]);
  store().updateDoc(
    "add shader",
    (draft) => {
      const s = draft.scenes[sceneIdx];
      if (!s.elements) s.elements = [];
      s.elements.unshift({
        element: "shader",
        id: `shader-${count + 1}`,
        preset: "living_gradient",
        palette: ["#0B0E1A", "#31226E", "#7C4DFF", "#52C5FF"],
        speed: 1,
        base: { width: 100, height: 100, position: { x: 0.5, y: 0.5 } },
      });
    },
    { selectAfter: [path] },
  );
  return path;
}

/** Title reveal 프리셋 — 히어로 타이틀 리빌 (레퍼런스 실측 레시피).
 *  전 단어가 흐림 고스트로 자리해 있고(preReveal), 간격이 쫀득하게 좁아지며
 *  블러가 첫 단어부터 순차 해제(word_gap_settle 계열 튜닝). 마지막엔
 *  easeInCirc 로 점점 빠르게 멀어지는 recede 퇴장(scale+blur+fade out). */
/** Title reveal 프리셋의 요소 스펙 — 삽입 mutation 과 Insert 모달 hover
 *  프리뷰가 공유 (중복 정의 방지). suffix 는 id 충돌 방지용. */
export function titleRevealElementSpec(suffix: number): SceneElementSpec {
  const word = (
    id: string,
    text: string,
    baseX: number,
    kfs: { frame: number; x: number; easing: string }[],
  ) => ({
    element: "text",
    id: `${id}-${suffix}`,
    base: { text, fontSize: 7, fontWeight: 600, color: "#C9CEDC", position: { x: baseX, y: 0.4962 }, fill: "#FFFFFF" },
    layers: [
      { type: "blur", role: "in", props: { from: 21.293, to: 0, duration: 12, easing: "cubic(0.237,0.670,0.442,1.032)" } },
    ],
    keyframes: kfs,
  });
  return {
    element: "group",
    id: `title-reveal-${suffix}`,
    layers: [
      { type: "move", role: "in", props: { fromX: 0.025, toX: 0, duration: 32, easing: "easeInQuart" } },
    ],
    children: [
      word("word-build", "Build", 0.26, [
        { frame: 0, x: 0.3194, easing: "easeOut" },
        { frame: 10, x: 0.2623, easing: "easeOut" },
      ]),
      word("word-saas", "SaaS", 0.5, [
        { frame: 0, x: 0.5843, easing: "easeOut" },
        { frame: 10, x: 0.4479, easing: "easeOutCirc" },
      ]),
      word("word-promo", "Promo", 0.72, [
        { frame: 0, x: 0.8474, easing: "easeOut" },
        { frame: 10, x: 0.6608, easing: "easeOutCirc" },
      ]),
    ],
  } as unknown as SceneElementSpec;
}

/** Stat counter 프리셋의 요소 스펙 — 색은 배경 대비로 호출부가 결정. */
export function statCounterElementSpec(numColor: string, labelColor: string, suffix: number): SceneElementSpec {
  return {
    element: "group",
    id: `stat-${suffix}`,
    layers: [],
    children: [
      {
        element: "text",
        id: "count",
        base: { text: "0", fontSize: 11, fontWeight: 600, color: numColor, anchor: "right", position: { x: 0.52, y: 0.5 } },
        layers: [
          {
            type: "stat_reveal",
            role: "in",
            props: {
              prefix: "+", suffix: "", from: 0, to: 55, prefixSide: "left",
              countDuration: 55, countEasing: "linear", baseColor: numColor,
              landColor: "#E23B3B", colorDrainDur: 14, scaleFrom: 1.06,
              settleFrac: 0.7, landBounce: 0.12, slideDelay: 0,
              slideDuration: 10, slideEasing: "easeOutBack",
            },
          },
        ],
      },
      {
        element: "text",
        id: "label",
        base: { text: "ATMs", fontSize: 5, fontWeight: 500, color: labelColor, anchor: "left", position: { x: 0.55, y: 0.545 } },
        layers: [
          { type: "blur", role: "in", props: { from: 8, to: 0, duration: 10, delay: 10, easing: "easeOut" } },
          { type: "move", role: "in", props: { fromY: 0.04, toY: 0, duration: 12, delay: 10, easing: "easeOutExpo" } },
          { type: "fade", role: "in", props: { duration: 10, delay: 10 } },
        ],
      },
    ],
  } as unknown as SceneElementSpec;
}

/** Glow input 프리셋 — 궤도 스침광 + 타이핑 커서 알약 (neon_pill).
 *  AI 프롬프트 박스 레퍼런스 실측 튜닝본. */
export function glowInputElementSpec(suffix: number): SceneElementSpec {
  return {
    element: "neon_pill",
    id: `glow-input-${suffix}`,
    base: { width: 46, height: 6.2, position: { x: 0.5, y: 0.5 } },
    radius: 3.1,
    borderColors: ["#B47CFF", "#7C3AED"],
    borderWidth: 3,
    fillColor: "#0B0714",
    glow: 0.85,
    orbit: { period: 110, span: 0.42, colors: ["#C9A0FF", "#7C3AED"], dim: "rgba(124,92,246,0.14)", bloom: 1.15, easing: "easeInOut" },
    drawIn: { duration: 14, easing: "easeOut" },
    drawStyle: "fade",
    mode: "type",
    text: "Create a landing page for my coffee brand",
    charsPerSecond: 14,
    typeStart: 12,
    fontSize: 1.9,
    fontWeight: 500,
    color: "#EDE9F8",
    paddingLeft: 3.2,
    align: "left",
    caretColor: "#C9A0FF",
    freshTint: { color: "#A78BFA", fade: 16 },
  } as unknown as SceneElementSpec;
}

/** Glow card 프리셋 — "일반 요소로 분해된" 조립본 (Figma detach 상태로 삽입).
 *  frame(유리 표면/테두리) + edge_light(스침광, progress 키프레임) +
 *  shape/text(아이콘 박스·타이틀·설명). 전부 표준 패널에서 편집 가능. */
export function glowCardElementSpec(suffix: number, coverFrames = 240): SceneElementSpec {
  // 카드 지오메트리: 22vw x 15vw (1920 기준 422 x 288px). frame 높이는 %H.
  const W = 22; // %W
  const hPctH = Number((((15 / 100) * COMP_W / COMP_H) * 100).toFixed(3)); // 15vw -> 26.667%H
  const framePxW = (W / 100) * COMP_W; // 422.4
  const framePxH = (15 / 100) * COMP_W; // 288
  const padPx = (1.6 / 100) * COMP_W; // 30.7
  const iconPx = (2.6 / 100) * COMP_W; // 49.9
  const iconCx = (padPx + iconPx / 2) / framePxW;
  const iconCy = (padPx + iconPx / 2) / framePxH;
  const leftX = padPx / framePxW;
  return {
    element: "frame",
    id: `glow-card-${suffix}`,
    base: {
      position: { x: 0.5, y: 0.5 },
      width: W,
      height: hPctH,
      radius: Math.round((1.3 / 100) * COMP_W), // 25px
      fill: { type: "solid", color: "rgba(16,13,24,0.62)" },
      backdropBlur: 14,
      stroke: "rgba(255,255,255,0.09)",
      strokeWidth: 1,
      clipsContent: false, // 스침광 halo 가 카드 밖으로 번져야 함
    },
    children: [
      {
        element: "edge_light",
        id: "edge-light",
        base: {
          position: { x: 0.5, y: 0.5 },
          radius: 1.3,
          span: 0.34,
          thickness: 2.5,
          colors: ["#C9A0FF", "#7C3AED"],
          dim: "rgba(124,92,246,0.13)",
          bloom: 1,
          glow: 1,
        },
        keyframes: edgeLightLapKeys(120, coverFrames),
      },
      {
        // sheen — 위쪽 하이라이트. 일반 shape + CSS 그라디언트 fill 로 재현
        element: "shape",
        id: "sheen",
        base: {
          kind: "rectangle",
          width: W,
          height: hPctH,
          radius: Math.round((1.3 / 100) * COMP_W),
          position: { x: 0.5, y: 0.5 },
          fill: { type: "gradient", css: "linear-gradient(175deg, rgba(255,255,255,0.035) 0%, transparent 38%)" },
        },
        layers: [],
      },
      {
        element: "shape",
        id: "icon-box",
        base: {
          kind: "rectangle",
          width: 2.6,
          height: Number(((iconPx / COMP_H) * 100).toFixed(3)),
          radius: 11,
          position: { x: iconCx, y: iconCy },
          fill: "rgba(255,255,255,0.04)",
          stroke: "rgba(255,255,255,0.12)",
          strokeWidth: 1,
        },
        layers: [],
      },
      {
        element: "text",
        id: "icon-glyph",
        base: { text: "S", fontSize: 1.3, fontWeight: 500, color: "#E7E2F2", position: { x: iconCx, y: iconCy } },
        layers: [],
      },
      {
        element: "text",
        id: "title",
        base: { text: "Orbiting border", fontSize: 1.5, fontWeight: 600, color: "#F4F1FA", anchor: "left", position: { x: leftX, y: 0.74 } },
        layers: [],
      },
      {
        element: "text",
        id: "description",
        base: { text: "A grazing light travels the card perimeter.", fontSize: 1.0, fontWeight: 400, color: "rgba(228,222,244,0.55)", anchor: "left", position: { x: leftX, y: 0.86 } },
        layers: [],
      },
    ],
  } as unknown as SceneElementSpec;
}

/** Glow menu 프리셋 — 활성 항목이 스텝 키로 옮겨가는 알약 메뉴바 (glow_menu). */
export function glowMenuElementSpec(suffix: number): SceneElementSpec {
  return {
    element: "glow_menu",
    id: `glow-menu-${suffix}`,
    base: { position: { x: 0.5, y: 0.5 } },
    items: [
      { label: "Home", color: "#5B8CFF" },
      { label: "Templates", color: "#A855F7" },
      { label: "Assets", color: "#22C55E" },
      { label: "Publish", color: "#F97316" },
    ],
    active: [
      { frame: 0, index: 0 },
      { frame: 40, index: 1 },
      { frame: 80, index: 2 },
      { frame: 120, index: 3 },
    ],
    switchDuration: 12,
    fadeIn: { duration: 12 },
  } as unknown as SceneElementSpec;
}

// UI 프리셋 공용 삽입 — addTitleReveal 과 같은 커맨드 패턴
function addPresetElement(sceneIdx: number, label: string, build: (suffix: number) => SceneElementSpec): ElementPath | null {
  const doc = store().doc;
  if (!doc?.scenes?.[sceneIdx]) return null;
  const scene: SceneSpec = doc.scenes[sceneIdx];
  const newIdx = scene.elements?.length ?? 0;
  const path = buildPath(sceneIdx, [newIdx]);
  const el = build(newIdx + 1);
  store().updateDoc(
    label,
    (draft) => {
      const s = draft.scenes[sceneIdx];
      if (!s.elements) s.elements = [];
      s.elements.push(el);
    },
    { selectAfter: [path] },
  );
  return path;
}

export function addGlowInput(sceneIdx: number): ElementPath | null {
  const scene = store().doc?.scenes?.[sceneIdx];
  const cover = scene ? sceneFrames(scene, FPS) : 240;
  return addPresetElement(sceneIdx, "add glow input", (sfx) => {
    const mono = glowInputElementSpec(sfx) as unknown as Record<string, unknown>;
    return (decomposePreset(mono, cover) ?? mono) as unknown as SceneElementSpec;
  });
}
export function addGlowCard(sceneIdx: number): ElementPath | null {
  const scene = store().doc?.scenes?.[sceneIdx];
  const cover = scene ? sceneFrames(scene, FPS) : 240;
  return addPresetElement(sceneIdx, "add glow card", (sfx) => glowCardElementSpec(sfx, cover));
}


export function addGlowMenu(sceneIdx: number): ElementPath | null {
  const scene = store().doc?.scenes?.[sceneIdx];
  const cover = scene ? sceneFrames(scene, FPS) : 240;
  return addPresetElement(sceneIdx, "add glow menu", (sfx) => {
    const mono = glowMenuElementSpec(sfx) as unknown as Record<string, unknown>;
    return (decomposePreset(mono, cover) ?? mono) as unknown as SceneElementSpec;
  });
}



// ---- Figma Copy/Paste properties (⌥⌘C / ⌥⌘V) ----
// 시각 스타일만 복사 (크기/위치/텍스트 내용 제외 — Figma 와 동일 사상).
const STYLE_KEYS = [
  "fill", "color", "stroke", "strokeWidth", "radius", "opacity", "blur", "backdropBlur",
  "fontSize", "fontWeight", "fontFamily", "letterSpacing",
  "colors", "thickness", "span", "bloom", "glow", "dim",
] as const;
let styleClipboard: Record<string, unknown> | null = null;

let styleClipboardColor: unknown = undefined; // spec.color (그라디언트/팔레트 타임라인)

export function copyElementStyle(path: ElementPath): boolean {
  const doc = store().doc;
  const el = doc ? (getElement(doc, path) as { base?: Record<string, unknown>; color?: unknown } | null) : null;
  if (!el?.base) return false;
  const out: Record<string, unknown> = {};
  for (const k of STYLE_KEYS) {
    if (el.base[k] !== undefined) out[k] = structuredClone(el.base[k]);
  }
  styleClipboardColor = el.color !== undefined ? structuredClone(el.color) : undefined;
  if (Object.keys(out).length === 0 && styleClipboardColor === undefined) return false;
  styleClipboard = out;
  return true;
}

export function pasteElementStyle(paths: ElementPath[]): boolean {
  if (!styleClipboard || paths.length === 0) return false;
  const style = styleClipboard;
  store().updateDoc("Paste style", (draft) => {
    for (const p of paths) {
      const el = getElement(draft, p) as { base?: Record<string, unknown> } | null;
      if (!el) continue;
      if (!el.base) el.base = {};
      for (const [k, v] of Object.entries(style)) el.base[k] = structuredClone(v);
      // 그라디언트/팔레트 타임라인(spec.color)도 함께 — 텍스트 그라디언트 복사의 핵심
      if (styleClipboardColor !== undefined && (el as { element?: string }).element === "text") {
        (el as { color?: unknown }).color = structuredClone(styleClipboardColor);
      }
    }
  });
  return true;
}

export function hasStyleClipboard(): boolean {
  return styleClipboard !== null;
}

// ---- Figma K(Scale 툴) — 요소 트리 "실제 값" 비율 스케일 ----
// box 리사이즈와 달리 폰트 크기/테두리 두께/자식 크기까지 전부 k 배.
// frame 자식 위치는 부모-비율이라 그대로 두면 함께 스케일된다.
export type ScaleSnap = { path: ElementPath; clone: Record<string, unknown> };

export function snapshotForScale(paths: ElementPath[]): ScaleSnap[] {
  const doc = store().doc;
  if (!doc) return [];
  return paths
    .map((p) => ({ path: p, clone: structuredClone(getElement(doc, p)) as Record<string, unknown> | null }))
    .filter((s): s is ScaleSnap => !!s.clone);
}

function scaleFieldsDeep(el: Record<string, unknown>, k: number) {
  const kind = el.element as string;
  const b = (el.base ?? {}) as Record<string, unknown>;
  const mul = (key: string) => {
    if (typeof b[key] === "number") b[key] = Number(((b[key] as number) * k).toFixed(4));
  };
  if (kind === "group") {
    // 그룹은 base.scale 이 시각 스케일의 진실 (자식 좌표가 comp 기준이라 값 스케일 불가)
    b.scale = Number(((typeof b.scale === "number" ? (b.scale as number) : 1) * k).toFixed(4));
    (el as { base?: unknown }).base = b;
    return;
  }
  for (const key of ["width", "height", "fontSize", "size", "radius", "strokeWidth", "thickness", "borderWidth", "paddingLeft", "letterWidth"]) mul(key);
  (el as { base?: unknown }).base = b;
  const kids = el.children as Record<string, unknown>[] | undefined;
  if (Array.isArray(kids)) for (const c of kids) scaleFieldsDeep(c, k);
  const kfs = el.keyframes as Record<string, unknown>[] | undefined;
  if (Array.isArray(kfs))
    for (const kf of kfs) {
      if (typeof kf.w === "number") kf.w = Number(((kf.w as number) * k).toFixed(4));
      if (typeof kf.h === "number") kf.h = Number(((kf.h as number) * k).toFixed(4));
    }
}

/** 요소 크기를 comp fraction 으로 (앵커 스케일용). 크기 개념 없으면 null. */
export function elementBoxFrac(el: Record<string, unknown>): { w: number; h: number } | null {
  const kind = el.element as string;
  const b = (el.base ?? {}) as { width?: number; height?: number };
  if (b.width == null || b.height == null) return null;
  // vw 계열(폭 기준 %)은 세로도 W 기준 -> H fraction 환산
  if (kind === "neon_pill" || kind === "glow_card" || kind === "edge_light") {
    return { w: b.width / 100, h: (b.height / 100) * (COMP_W / COMP_H) };
  }
  return { w: b.width / 100, h: b.height / 100 };
}

/** 스냅샷 기준 k 배 적용 (드래그 중 매 move 스냅샷에서 다시 계산 — 누적 드리프트 없음).
 *  pivot:
 *   - {type:"union", x, y}: 다중 선택 — 루트 위치가 그 중심에서 벌어짐
 *   - {type:"anchor", ax, ay}: 각 요소 자기 박스의 앵커점(0..1)이 고정된 채 스케일
 *   - null: 제자리(중심 고정) */
export type ScalePivot = { type: "union"; x: number; y: number } | { type: "anchor"; ax: number; ay: number } | null;

export function applyScaleDeep(snaps: ScaleSnap[], k: number, pivot: ScalePivot, live: boolean) {
  const kk = Math.min(20, Math.max(0.05, k));
  store().updateDoc(
    "Scale",
    (draft) => {
      for (const snap of snaps) {
        const target = getElement(draft, snap.path) as Record<string, unknown> | null;
        if (!target) continue;
        const scaled = structuredClone(snap.clone);
        scaleFieldsDeep(scaled, kk);
        if (pivot) {
          const sb = (scaled.base ?? {}) as { position?: { x: number; y: number } };
          const pos = sb.position ?? { x: 0.5, y: 0.5 };
          if (pivot.type === "union") {
            sb.position = {
              x: Number((pivot.x + (pos.x - pivot.x) * kk).toFixed(4)),
              y: Number((pivot.y + (pos.y - pivot.y) * kk).toFixed(4)),
            };
          } else {
            // anchor: 자기 박스의 (ax, ay) 지점이 화면에 고정되도록 중심 이동
            const box = elementBoxFrac(snap.clone);
            if (box) {
              const offX = (pivot.ax - 0.5) * box.w;
              const offY = (pivot.ay - 0.5) * box.h;
              const anchorX = pos.x + offX;
              const anchorY = pos.y + offY;
              sb.position = {
                x: Number((anchorX - offX * kk).toFixed(4)),
                y: Number((anchorY - offY * kk).toFixed(4)),
              };
            }
          }
          (scaled as { base?: unknown }).base = sb;
        }
        for (const key of Object.keys(target)) delete target[key];
        Object.assign(target, scaled);
      }
    },
    { coalesceKey: live ? "scale-tool" : undefined },
  );
  if (!live) store().endCoalescing();
}

/** 프리셋 monolith 를 일반 요소 조립로 분해 (Figma detach). in-place 교체라
 *  선택 경로 유지. 문서 로드시 자동 분해(migrateDetachPresets)와 같은 변환. */
export function detachPresetElement(path: ElementPath): boolean {
  const doc = store().doc;
  if (!doc) return false;
  const el = getElement(doc, path) as Record<string, unknown> | null;
  if (!el) return false;
  const { sceneIdx } = parsePath(path);
  const cover = doc.scenes?.[sceneIdx] ? sceneFrames(doc.scenes[sceneIdx], FPS) : 240;
  const next = decomposePreset(el, cover);
  if (!next) return false;
  store().updateDoc("Detach preset", (draft) => {
    const target = getElement(draft, path) as Record<string, unknown> | null;
    if (!target) return;
    for (const k of Object.keys(target)) delete target[k];
    Object.assign(target, next);
  });
  return true;
}

export function addTitleReveal(sceneIdx: number): ElementPath | null {
  const doc = store().doc;
  if (!doc?.scenes?.[sceneIdx]) return null;
  const scene: SceneSpec = doc.scenes[sceneIdx];
  const newIdx = scene.elements?.length ?? 0;
  const path = buildPath(sceneIdx, [newIdx]);
  // 사용자 실측 튜닝본 고정 — 단어 등장만 (recede 는 제외, 필요 시 out 레이어
  // 직접 추가). 키프레임은 단일 채널 엔트리 -> 삽입 즉시 lane 편집 가능.
  const el = titleRevealElementSpec(newIdx + 1);
  store().updateDoc(
    "add title reveal",
    (draft) => {
      const s = draft.scenes[sceneIdx];
      if (!s.elements) s.elements = [];
      s.elements.push(el);
    },
    { selectAfter: [path] },
  );
  return path;
}

/** Stat counter 프리셋 — 카운트업 숫자 + 라벨 텍스트 2개를 그룹으로.
 *  stat_reveal 은 범용 텍스트 효과가 아니라 레이어 메뉴 대신 Insert 프리셋으로
 *  노출한다. 라벨이 필요 없으면 그룹에서 라벨만 지우면 된다 — 숫자/라벨 각각
 *  일반 텍스트 요소라 fill/폰트/위치 전부 독립 편집. 반환: 그룹 경로 */
// 씬/문서 배경의 첫 solid hex 를 뽑아 상대 휘도 반환 (0=어두움, 1=밝음).
// stat counter 숫자색을 배경 대비로 자동 선택하는 데 쓴다.
function sceneBgLuma(scene: SceneSpec, doc: VideoSpec): number {
  const firstHex = (bg: unknown): string | null => {
    if (typeof bg === "string") return /^#[0-9a-fA-F]{6}$/.test(bg) ? bg : null;
    if (bg && typeof bg === "object") {
      const fill = (bg as { fill?: unknown }).fill ?? bg;
      const arr = Array.isArray(fill) ? fill : [fill];
      for (const p of arr) {
        if (typeof p === "string" && /^#[0-9a-fA-F]{6}$/.test(p)) return p;
        if (p && typeof p === "object" && (p as { type?: string }).type === "solid") {
          const c = (p as { color?: string }).color;
          if (typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c)) return c;
        }
      }
    }
    return null;
  };
  const hex = firstHex(scene.background) ?? firstHex(doc.brandDefaults?.background) ?? "#0D0B10";
  const n = parseInt(hex.slice(1), 16);
  return (((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114) / 255;
}

export function addStatCounter(sceneIdx: number): ElementPath | null {
  const doc = store().doc;
  if (!doc?.scenes?.[sceneIdx]) return null;
  const scene: SceneSpec = doc.scenes[sceneIdx];
  const newIdx = scene.elements?.length ?? 0;
  const path = buildPath(sceneIdx, [newIdx]);
  // 배경 대비 자동 숫자색 (밝은 씬에 흰 숫자 안 보임 — 실측)
  const luma = sceneBgLuma(scene, doc);
  const numColor = luma > 0.5 ? "#111111" : "#FFFFFF";
  const labelColor = luma > 0.5 ? "#5B6472" : "#9AA3B2";
  const el = statCounterElementSpec(numColor, labelColor, newIdx + 1);
  store().updateDoc(
    "add stat counter",
    (draft) => {
      const s = draft.scenes[sceneIdx];
      if (!s.elements) s.elements = [];
      s.elements.push(el);
    },
    { selectAfter: [path] },
  );
  return path;
}

/** 새 3D 디바이스 목업 추가 (AE 의 3D 모델 임포트 등가 — 우리는 내장 모델
 *  레지스트리에서 고른다). 반환: 경로 */
export function addDeviceElement(sceneIdx: number, device: "macbook" | "iphone15" = "iphone15"): ElementPath | null {
  const doc = store().doc;
  if (!doc?.scenes?.[sceneIdx]) return null;
  const scene: SceneSpec = doc.scenes[sceneIdx];
  const newIdx = scene.elements?.length ?? 0;
  const path = buildPath(sceneIdx, [newIdx]);
  store().updateDoc(
    "add device",
    (draft) => {
      const s = draft.scenes[sceneIdx];
      if (!s.elements) s.elements = [];
      s.elements.push({
        element: "device",
        id: `device-${newIdx + 1}`,
        device,
        base: {
          width: device === "macbook" ? 62 : 34,
          height: device === "macbook" ? 74 : 78,
          position: { x: 0.5, y: 0.52 },
        },
        children: [
          // 스크린 프레임 — 3D 스크린 면에 호모그래피로 접착되는 자식 frame.
          // 좌표계 = 스크린 논리 px (엔진 deviceScreenPx). fill/자식/레이아웃이
          // 그대로 화면 콘텐츠 (2D 크롬 목업과 동일한 계층 관례).
          {
            element: "frame",
            id: "screen",
            sizeRel: true,
            base: {
              width: 100,
              height: 100,
              position: { x: 0.5, y: 0.5 },
              fill: { type: "solid", color: "#101318", visible: true },
              clipsContent: true,
            },
            children: [],
          },
        ],
      } as unknown as SceneElementSpec);
    },
    { selectAfter: [path] },
  );
  return path;
}

/** 2D 목업 프레임 (browser 창 / phone 베젤 크롬) 추가. 반환: 경로 */
export function addChromeFrame(sceneIdx: number, kind: "browser" | "phone"): ElementPath | null {
  const doc = store().doc;
  if (!doc?.scenes?.[sceneIdx]) return null;
  const scene: SceneSpec = doc.scenes[sceneIdx];
  const newIdx = scene.elements?.length ?? 0;
  const path = buildPath(sceneIdx, [newIdx]);
  store().updateDoc(
    "add mockup frame",
    (draft) => {
      const s = draft.scenes[sceneIdx];
      if (!s.elements) s.elements = [];
      s.elements.push({
        element: "frame",
        id: `${kind}-${newIdx + 1}`,
        chrome: { kind, theme: "dark" },
        base: {
          width: kind === "browser" ? 56 : 26,
          height: kind === "browser" ? 62 : 76,
          position: { x: 0.5, y: 0.5 },
          fill: { type: "solid", color: "#0B0D10", visible: true },
          clipsContent: true,
        },
        children: [
          // 스크린 프레임 — 디바이스 화면 영역에 딱 맞는 자식 frame (sizeRel:
          // 부모 콘텐츠 박스 기준 %라 목업을 키우면 함께 스케일). UI/사진/영상은
          // 이 안에 넣는다 (Figma 디바이스 프레임 관례).
          {
            element: "frame",
            id: "screen",
            sizeRel: true,
            base: {
              width: 100,
              height: 100,
              position: { x: 0.5, y: 0.5 },
              fill: { type: "solid", color: "#101318", visible: true },
              clipsContent: true,
            },
            children: [],
          },
        ],
      } as unknown as SceneElementSpec);
    },
    { selectAfter: [path] },
  );
  return path;
}

/** 새 로고 요소 추가. 반환: 경로 */
export function addLogoElement(sceneIdx: number): ElementPath | null {
  const doc = store().doc;
  if (!doc?.scenes?.[sceneIdx]) return null;
  const scene: SceneSpec = doc.scenes[sceneIdx];
  const newIdx = scene.elements?.length ?? 0;
  const path = buildPath(sceneIdx, [newIdx]);
  store().updateDoc(
    "add logo",
    (draft) => {
      const s = draft.scenes[sceneIdx];
      if (!s.elements) s.elements = [];
      s.elements.push({
        element: "logo",
        id: `logo-${newIdx + 1}`,
        base: { kind: "scene24", size: 8, position: { x: 0.5, y: 0.5 } },
      });
    },
    { selectAfter: [path] },
  );
  return path;
}

/** 새 gooey(물방울/metaball) 요소 추가. 소스 블롭에서 위로 떨어져 나가며 끈적한 목.
 *  반환: 경로 */
export function addGooeyElement(sceneIdx: number): ElementPath | null {
  const doc = store().doc;
  if (!doc?.scenes?.[sceneIdx]) return null;
  const scene: SceneSpec = doc.scenes[sceneIdx];
  const newIdx = scene.elements?.length ?? 0;
  const path = buildPath(sceneIdx, [newIdx]);
  store().updateDoc(
    "add gooey",
    (draft) => {
      const s = draft.scenes[sceneIdx];
      if (!s.elements) s.elements = [];
      s.elements.push({
        element: "gooey",
        id: `gooey-${newIdx + 1}`,
        base: {
          fromShape: { x: 0.5, y: 0.62 },
          radius: 7,
          travel: { dx: 0, dy: -0.28 },
          fill: "#7C4DFF",
          stickiness: "sticky",
          blur: 14,
          swell: 1.1,
        },
        layers: [{ type: "gooey_travel", role: "in", props: { duration: 46, easing: "easeInBack" } }],
      });
    },
    { selectAfter: [path] },
  );
  return path;
}

/** 새 image 요소 추가 (붙여넣기/드롭/업로드). src=업로드 URL, width/height=vw/vh(%).
 *  크기는 클라이언트가 이미지 비율대로 계산해 넘긴다. 반환: 경로 */
export function addImageElement(
  sceneIdx: number,
  opts: { src: string; width: number; height: number },
): ElementPath | null {
  const doc = store().doc;
  if (!doc?.scenes?.[sceneIdx]) return null;
  const scene: SceneSpec = doc.scenes[sceneIdx];
  const newIdx = scene.elements?.length ?? 0;
  const path = buildPath(sceneIdx, [newIdx]);
  store().updateDoc(
    "add image",
    (draft) => {
      const s = draft.scenes[sceneIdx];
      if (!s.elements) s.elements = [];
      s.elements.push({
        element: "image",
        id: `image-${newIdx + 1}`,
        base: {
          src: opts.src,
          width: opts.width,
          height: opts.height,
          position: { x: 0.5, y: 0.5 },
          fit: "contain",
        },
        layers: [],
      });
    },
    { selectAfter: [path] },
  );
  return path;
}

/** 새 video 요소 추가 (붙여넣기/드롭/업로드). src=업로드 URL, width/height=vw/vh(%).
 *  배경 영상 관례로 loop+muted+cover 기본. 반환: 경로 */
export function addVideoElement(
  sceneIdx: number,
  opts: { src: string; width: number; height: number },
): ElementPath | null {
  const doc = store().doc;
  if (!doc?.scenes?.[sceneIdx]) return null;
  const scene: SceneSpec = doc.scenes[sceneIdx];
  const newIdx = scene.elements?.length ?? 0;
  const path = buildPath(sceneIdx, [newIdx]);
  store().updateDoc(
    "add video",
    (draft) => {
      const s = draft.scenes[sceneIdx];
      if (!s.elements) s.elements = [];
      s.elements.push({
        element: "video",
        id: `video-${newIdx + 1}`,
        base: {
          src: opts.src,
          width: opts.width,
          height: opts.height,
          position: { x: 0.5, y: 0.5 },
          fit: "cover",
          loop: true,
          muted: true,
        },
        layers: [],
      });
    },
    { selectAfter: [path] },
  );
  return path;
}

/** 요소 클립 트림(씬-로컬 in/out 프레임) 설정. 드래그는 live 로 coalesce.
 *  start=0 & end 미지정이면 timing 제거(전체 씬 = 트림 없음). */
// ---- 씬 나누기 / 합치기 ----------------------------------------------------
// 요소/자식 키프레임(그룹 자식 포함)을 델타만큼 재귀 시프트 (씬 분할 B/병합용)
function shiftElementTimeDeep(el: Record<string, unknown>, delta: number, total: number) {
  const kfs = el.keyframes as { frame: number }[] | undefined;
  if (Array.isArray(kfs)) for (const k of kfs) k.frame = Math.max(0, Math.round(k.frame + delta));
  const t = el.timing as { start?: number; end?: number } | undefined;
  if (t) {
    const next: { start?: number; end?: number } = {};
    const ns = Math.max(0, Math.round((t.start ?? 0) + delta));
    const ne = t.end != null ? Math.round(t.end + delta) : undefined;
    if (ns > 0) next.start = ns;
    if (ne != null && ne < total) next.end = Math.max(ns + 1, ne);
    if (next.start === undefined && next.end === undefined) delete el.timing;
    else el.timing = next;
  } else if (delta > 0) {
    // timing 없던(씬 전체) 요소가 뒤 씬에서 병합되면 그 구간만 살아야 한다
    el.timing = { start: Math.round(delta) };
  }
  const children = el.children as Record<string, unknown>[] | undefined;
  if (Array.isArray(children)) for (const c of children) shiftElementTimeDeep(c, delta, total);
}

/** 씬을 씬-로컬 프레임 f 에서 둘로 나눈다. 요소는 창이 걸치는 쪽에 배치
 *  (걸치면 양쪽 다, 트림으로 잘림). 뒤 씬 요소/키프레임은 -f 시프트.
 *  카메라/라이트 키프레임도 f 기준으로 분배. A 는 hard cut, B 가 원래 전환 유지. */
export function splitSceneAt(sceneIdx: number, localFrame: number): boolean {
  const doc = store().doc;
  const scene = doc?.scenes[sceneIdx];
  if (!doc || !scene) return false;
  const total = sceneFrames(scene, FPS);
  const f = Math.round(localFrame);
  if (f <= 0 || f >= total) return false;
  // immer draft 는 프록시라 structuredClone 불가 (실측: DataCloneError) —
  // 원본 스토어 상태에서 미리 딥 클론을 떠서 draft 안에서 사용한다.
  const clone = structuredClone(scene) as SceneSpec;
  // 카메라/라이트 경계 보간 상태 — 잘린 쪽 키만 남기면 경계에서 보간이 끊겨
  // 컷 순간 점프한다 (실측: "나눠지는 시점쯤 깜빡"). f 시점 상태를 양쪽에 bake.
  const camKfs = scene.camera?.type === "keyframes" ? (scene.camera.keyframes ?? []) : [];
  const camAtF = camKfs.length ? sampleCameraKeyframes(camKfs, f) : null;
  const camBoundary: CameraKeyframe | null = camAtF
    ? {
        frame: f,
        scale: Number(camAtF.scale.toFixed(4)),
        x: Number(camAtF.x.toFixed(4)),
        y: Number(camAtF.y.toFixed(4)),
        rotate: Number(camAtF.rotate.toFixed(2)),
        rotateX: Number(camAtF.rotateX.toFixed(2)),
        rotateY: Number(camAtF.rotateY.toFixed(2)),
        easing: "easeInOut",
      }
    : null;
  const lightAtF = scene.light?.keyframes?.length ? sampleLightKeyframes(scene.light, f) : null;
  store().updateDoc("Split scene", (draft) => {
    const src = draft.scenes[sceneIdx];
    // A (원본 자리): 앞 구간
    src.duration = f / FPS;
    src.fit = undefined;
    delete src.transition_out; // 나눈 지점은 이어지는 컷 — hard cut
    src.elements = (src.elements ?? []).filter((el) => {
      const t = (el as { timing?: { start?: number } }).timing;
      return (t?.start ?? 0) < f; // f 이후 시작 요소는 B 로만
    });
    for (const el of src.elements) {
      const holder = el as { timing?: { start?: number; end?: number } };
      const end = holder.timing?.end ?? total;
      if (end > f) {
        // 컷에 걸친 요소: B 로 복제하지 않고 A 에 남겨 cross-scene guest 로
        // B 위에서 "이어" 재생한다 (클록/레이어/키프레임 연속 — 경계 깜빡임 0).
        // 복제 방식은 B 쪽 클록이 0 부터 다시 돌아 in-레이어가 재생되고,
        // A 쪽 창 끝이 f 로 줄어 out-레이어가 컷 직전에 미리 발동했다.
        holder.timing = { ...(holder.timing ?? {}), end };
      }
    }
    if (src.camera?.type === "keyframes") {
      const kept = (src.camera.keyframes ?? []).filter((k) => k.frame < f);
      // f 너머 키가 있었으면 경계 상태를 마지막 키로 bake (보간 연속)
      if (camBoundary && camKfs.some((k) => k.frame >= f)) kept.push(camBoundary);
      src.camera.keyframes = kept;
    }
    if (src.light?.keyframes) {
      const kept = src.light.keyframes.filter((k) => k.frame < f);
      if (lightAtF && src.light.keyframes.some((k) => k.frame >= f)) {
        const pos = lightAtF.position ?? { x: 0.35, y: 0.3 };
        kept.push({
          frame: f,
          x: Number(pos.x.toFixed(4)),
          y: Number(pos.y.toFixed(4)),
          ...(pos.z != null ? { z: Number(pos.z.toFixed(2)) } : {}),
          intensity: lightAtF.intensity,
          ambient: lightAtF.ambient,
          azimuth: lightAtF.azimuth,
          elevation: lightAtF.elevation,
          ...(lightAtF.falloff != null ? { falloff: lightAtF.falloff } : {}),
          easing: "easeInOut",
        });
      }
      src.light.keyframes = kept;
      if (src.light.keyframes.length === 0) delete src.light.keyframes;
    }
    // B (뒤 구간): f 이후 "시작" 하는 요소만 (-f 시프트). 걸친 요소는 A 의
    // guest 가 담당하므로 제외 — 넣으면 이중 렌더.
    clone.id = `${src.id ?? "scene"}-2`;
    clone.duration = (total - f) / FPS;
    clone.fit = undefined;
    clone.elements = (clone.elements ?? []).filter((el) => {
      const t = (el as { timing?: { start?: number } }).timing;
      return (t?.start ?? 0) >= f;
    });
    for (const el of clone.elements) shiftElementTimeDeep(el as unknown as Record<string, unknown>, -f, total - f);
    if (clone.camera?.type === "keyframes") {
      const kept = (clone.camera.keyframes ?? [])
        .filter((k) => k.frame >= f)
        .map((k) => ({ ...k, frame: k.frame - f }));
      // f 이전 키가 있었으면 경계 상태를 첫 키(frame 0)로 bake
      if (camBoundary && camKfs.some((k) => k.frame < f) && !kept.some((k) => k.frame === 0)) {
        kept.unshift({ ...camBoundary, frame: 0 });
      }
      clone.camera.keyframes = kept;
      if (clone.camera.keyframes.length === 0) delete clone.camera;
    }
    if (clone.light?.keyframes) {
      const had = clone.light.keyframes;
      const kept = had.filter((k) => k.frame >= f).map((k) => ({ ...k, frame: k.frame - f }));
      if (lightAtF && had.some((k) => k.frame < f) && !kept.some((k) => k.frame === 0)) {
        const pos = lightAtF.position ?? { x: 0.35, y: 0.3 };
        kept.unshift({
          frame: 0,
          x: Number(pos.x.toFixed(4)),
          y: Number(pos.y.toFixed(4)),
          ...(pos.z != null ? { z: Number(pos.z.toFixed(2)) } : {}),
          intensity: lightAtF.intensity,
          ambient: lightAtF.ambient,
          azimuth: lightAtF.azimuth,
          elevation: lightAtF.elevation,
          ...(lightAtF.falloff != null ? { falloff: lightAtF.falloff } : {}),
          easing: "easeInOut",
        });
      }
      clone.light.keyframes = kept;
      if (clone.light.keyframes.length === 0) delete clone.light.keyframes;
    }
    draft.scenes.splice(sceneIdx + 1, 0, clone);
  });
  return true;
}

/** 연속된 씬들을 하나로 합친다 — 뒤 씬 요소/키프레임은 앞 씬 누적 길이만큼
 *  +시프트. 배경/카메라/라이트는 첫 씬 것 유지, 전환은 마지막 씬 것.
 *  비연속 선택이면 no-op(false). */
export function mergeScenes(indices: number[]): boolean {
  const doc = store().doc;
  if (!doc) return false;
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  if (sorted.length < 2) return false;
  if (sorted[sorted.length - 1] - sorted[0] !== sorted.length - 1) return false; // 연속만
  const first = sorted[0];
  const frames = sorted.map((i) => sceneFrames(doc.scenes[i], FPS));
  const newTotal = frames.reduce((a, b) => a + b, 0);
  // draft 프록시 clone 금지 — 원본에서 미리 딥 클론
  const clonedEls = sorted.slice(1).map((i) => structuredClone(doc.scenes[i].elements ?? []));
  const lastTransition = structuredClone(doc.scenes[sorted[sorted.length - 1]].transition_out ?? null);
  store().updateDoc("Merge scenes", (draft) => {
    const base = draft.scenes[first];
    let off = frames[0];
    for (let k = 1; k < sorted.length; k++) {
      for (const el of clonedEls[k - 1]) {
        const c = el as unknown as Record<string, unknown>;
        shiftElementTimeDeep(c, off, newTotal);
        base.elements.push(c as unknown as SceneElementSpec);
      }
      off += frames[k];
    }
    if (lastTransition != null) base.transition_out = lastTransition as SceneSpec["transition_out"];
    else delete base.transition_out;
    base.duration = newTotal / FPS;
    base.fit = undefined;
    draft.scenes.splice(first + 1, sorted.length - 1);
  });
  useEditor.setState((st) => ({ ui: { ...st.ui, sceneMultiSel: [] } }));
  return true;
}

export function setElementTiming(
  path: ElementPath,
  patch: { start?: number; end?: number },
  live: boolean,
) {
  store().updateDoc(
    "Trim element",
    (draft) => {
      const el = getElement(draft, path);
      if (!el || el.element === "group") return;
      const holder = el as { timing?: { start?: number; end?: number } };
      const next = { ...(holder.timing ?? {}), ...patch };
      // 정규화: start<=0 이면 삭제, end 가 유효하면 유지. 둘 다 비면 timing 제거.
      if (next.start !== undefined && next.start <= 0) delete next.start;
      if (next.start === undefined && next.end === undefined) delete holder.timing;
      else holder.timing = next;
    },
    { coalesceKey: live ? `trim-${path}` : undefined },
  );
  if (!live) store().endCoalescing();
}

// 요소의 씬-로컬 트림 창(엔진 elementWindow 와 동일 규칙).
function elementWindowLocal(
  el: SceneElementSpec,
  scene: SceneSpec,
): { start: number; end: number; total: number } {
  const total = sceneFrames(scene, FPS);
  const timing = (el as { timing?: { start?: number; end?: number } }).timing;
  const start = Math.max(0, Math.min(total, timing?.start ?? 0));
  const end = Math.max(start + 1, Math.min(total, timing?.end ?? total));
  return { start, end, total };
}

// timing 객체를 정규화해 target 에 쓴다(start<=0/end>=total 은 생략, 둘 다 비면 제거).
function writeTiming(
  target: { timing?: { start?: number; end?: number } },
  start: number,
  end: number,
  total: number,
) {
  const t: { start?: number; end?: number } = {};
  if (start > 0) t.start = start;
  if (end < total) t.end = end;
  if (t.start !== undefined || t.end !== undefined) target.timing = t;
  else delete target.timing;
}

/** 컷 편집 — 트림: 선택 클립의 in/out 을 재생헤드(씬-로컬 f)로. */
/** 트림 벌크 적용 — 드래그 시작 스냅샷(edge0/kfs0/win0) + delta 로 매 move
 *  절대 계산. 다중 선택 시 여러 요소의 in/out 을 동시에 민다.
 *  start 트림은 키프레임 동행: 클립 시작이 밀리는 만큼 키도 민다 (사용자
 *  논리 — 시작점을 미루면 그 요소의 애니메이션 전체가 따라와야 함).
 *  end 트림은 키를 건드리지 않는다. */
export type TrimTarget = {
  path: ElementPath;
  edge0: number; // 드래그 시작 시점의 그 엣지 값
  kfs0: number[]; // 드래그 시작 시점의 키프레임 프레임들
  winStart0: number;
  winEnd0: number;
  total: number;
  /** end 드래그 상한 — 홈 씬 시작부터 comp 끝까지 (cross-scene 연장 허용). */
  maxEnd: number;
};

export function trimElementsBy(targets: TrimTarget[], edge: "start" | "end", df: number, live: boolean) {
  store().updateDoc(
    "Trim elements",
    (draft) => {
      for (const t of targets) {
        const el = getElement(draft, t.path);
        if (!el || el.element === "group") continue;
        const holder = el as { timing?: { start?: number; end?: number }; keyframes?: { frame: number }[] };
        const raw = Math.round(t.edge0 + df);
        if (edge === "start") {
          const v = Math.max(0, Math.min(t.winEnd0 - 1, raw));
          const next: { start?: number; end?: number } = { ...(holder.timing ?? {}), start: v };
          if (next.start !== undefined && next.start <= 0) delete next.start;
          if (next.start === undefined && next.end === undefined) delete holder.timing;
          else holder.timing = next;
          const shift = v - t.winStart0;
          if (shift !== 0 && Array.isArray(holder.keyframes)) {
            holder.keyframes.forEach((k, i) => {
              k.frame = Math.max(0, Math.round((t.kfs0[i] ?? k.frame) + shift));
            });
          }
        } else {
          // cross-scene: end 는 씬 길이(total)를 넘어 comp 끝(maxEnd)까지 허용
          const v = Math.max(t.winStart0 + 1, Math.min(t.maxEnd, raw));
          const next: { start?: number; end?: number } = { ...(holder.timing ?? {}), end: v };
          if (next.end !== undefined && next.end === t.total) delete next.end; // 정확히 씬 끝 = 기본
          if (next.start === undefined && next.end === undefined) delete holder.timing;
          else holder.timing = next;
        }
      }
    },
    { coalesceKey: live ? "trim-multi" : undefined },
  );
  if (!live) store().endCoalescing();
}

/** 요소의 트림 스냅샷 — 드래그/원샷 트림 공용. group 은 null. */
export function trimTargetOf(doc: VideoSpec, path: ElementPath, edge: "start" | "end"): TrimTarget | null {
  const el = getElement(doc, path);
  if (!el || el.element === "group") return null;
  const { sceneIdx } = parsePath(path);
  const scene = doc.scenes[sceneIdx];
  if (!scene) return null;
  const total = sceneFrames(scene, FPS);
  const t = (el as { timing?: { start?: number; end?: number } }).timing ?? {};
  const winStart0 = Math.max(0, Math.min(total, t.start ?? 0));
  const winEnd0 = Math.max(winStart0 + 1, t.end ?? total); // overflow 허용
  const kfs0 = ((el as { keyframes?: { frame: number }[] }).keyframes ?? []).map((k) => k.frame);
  // 홈 씬 시작부터 comp 끝까지 (cross-scene 연장 상한)
  const starts = doc.scenes.map((sc2) => sceneFrames(sc2, FPS));
  const sceneStart = starts.slice(0, sceneIdx).reduce((a, b) => a + b, 0);
  const compTotal = starts.reduce((a, b) => a + b, 0);
  const maxEnd = compTotal - sceneStart;
  return { path, edge0: edge === "start" ? winStart0 : winEnd0, kfs0, winStart0, winEnd0, total, maxEnd };
}

export function trimElementTo(
  path: ElementPath,
  edge: "start" | "end",
  localFrame: number,
) {
  const doc = store().doc;
  if (!doc) return;
  const t = trimTargetOf(doc, path, edge);
  if (!t) return;
  // 스냅샷 + delta 방식으로 통일 — start 트림이면 키프레임도 동행
  trimElementsBy([t], edge, Math.round(localFrame) - t.edge0, false);
}

/** 컷 편집 — split: 요소를 재생헤드(씬-로컬 f)에서 둘로(비압축 트림 기반).
 *  왼쪽=원본 [winStart,f], 오른쪽=복제본 [f,winEnd]. f 가 창 안쪽이 아니면 no-op.
 *  반환: 오른쪽(새) 클립 경로 또는 null. */
export function splitElementAtPlayhead(
  path: ElementPath,
  localFrame: number,
): ElementPath | null {
  const doc = store().doc;
  if (!doc) return null;
  const el = getElement(doc, path);
  if (!el || el.element === "group") return null;
  const { sceneIdx, indices } = parsePath(path);
  const scene = doc.scenes[sceneIdx];
  if (!scene) return null;
  const w = elementWindowLocal(el, scene);
  const f = Math.round(localFrame);
  if (f <= w.start || f >= w.end) return null; // 창 양끝/밖에선 못 자른다

  // 오른쪽 클론은 producer 밖에서 평범한(비-draft) el 로 만든다.
  // (immer draft 는 Proxy 라 structuredClone 이 DataCloneError 를 던진다.)
  const clone = structuredClone(el) as SceneElementSpec;
  if (clone.id) clone.id = `${clone.id}-b`;
  writeTiming(clone as { timing?: { start?: number; end?: number } }, f, w.end, w.total);

  store().updateDoc("split element", (draft) => {
    const c = getContainer(draft, path);
    if (!c) return;
    const src = c.list[c.index];
    if (!src || src.element === "group") return;
    // 왼쪽(원본): [winStart, f] / 오른쪽(클론): [f, winEnd]
    writeTiming(src as { timing?: { start?: number; end?: number } }, w.start, f, w.total);
    c.list.splice(c.index + 1, 0, clone);
  });

  const next = [...indices];
  next[next.length - 1] = indices.at(-1)! + 1;
  const newPath = buildPath(sceneIdx, next);
  store().select([newPath]);
  return newPath;
}

// ---- 복사/붙여넣기 ----
// 내부 클립보드 + 시스템 클립보드(JSON 마커) 동시 기록. 붙여넣기는 paste 이벤트에서
// 시스템 클립보드 텍스트를 우선 파싱(크로스 세션), 실패 시 내부 클립보드 폴백.
export const ELEMENT_CLIP_MARKER = "scene24:elements";
let elementClipboard: SceneElementSpec[] = [];
let pasteBump = 0; // 연속 붙여넣기 오프셋 누적

/** 선택 요소 복사. 반환: 복사 개수 */
export function copyElements(paths: ElementPath[]): number {
  const doc = store().doc;
  if (!doc) return 0;
  const norm = normalizeSelection(paths);
  elementClipboard = norm
    .map((p) => getElement(doc, p))
    .filter((e): e is SceneElementSpec => !!e)
    .map((e) => structuredClone(e) as SceneElementSpec);
  pasteBump = 0;
  const payload = JSON.stringify({ __marker: ELEMENT_CLIP_MARKER, elements: elementClipboard });
  void navigator.clipboard?.writeText(payload).catch(() => {});
  return elementClipboard.length;
}

/** 요소 붙여넣기(활성 씬 최상위). elements 미지정 시 내부 클립보드. 반환: 새 경로들 */
export function pasteElements(
  sceneIdx: number,
  elements?: SceneElementSpec[],
): ElementPath[] {
  const doc = store().doc;
  const src = elements ?? elementClipboard;
  if (!doc?.scenes?.[sceneIdx] || src.length === 0) return [];
  pasteBump += 1;
  const off = 0.02 * pasteBump; // 반복 붙여넣기 계단 오프셋
  // 계단 오프셋을 요소 종류별 "위치의 진실"에 적용 (감사 #10):
  // leaf = base.position/fromShape, motionPath = origin, 배치 그룹 = layout.origin,
  // 일반 group = 자식 재귀.
  const bump = (c: SceneElementSpec) => {
    const mp = (c as { motionPath?: { origin?: { x: number; y: number } } }).motionPath;
    if (mp) {
      mp.origin = { x: (mp.origin?.x ?? 0) + off * 100, y: (mp.origin?.y ?? 0) + off * 100 };
      return;
    }
    if (c.element === "group") {
      const gl = (c as { layout?: { type?: string; origin?: { x: number; y: number } } }).layout;
      if (gl && (gl.type === "path" || gl.type === "orbit")) {
        gl.origin = { x: (gl.origin?.x ?? 0) + off * 100, y: (gl.origin?.y ?? 0) + off * 100 };
        return;
      }
      for (const child of (c as { children?: SceneElementSpec[] }).children ?? []) bump(child);
      return;
    }
    const b = (c as { base?: { position?: { x: number; y: number }; fromShape?: { x: number; y: number } } }).base;
    if (b?.position) b.position = { x: Math.min(1, b.position.x + off), y: Math.min(1, b.position.y + off) };
    if (b?.fromShape) b.fromShape = { x: Math.min(1, b.fromShape.x + off), y: Math.min(1, b.fromShape.y + off) };
  };
  const takenPaste = new Set<string>();
  const clones = src.map((e) => {
    const c = structuredClone(e) as SceneElementSpec;
    if (c.id) {
      c.id = uniqueCopyId(doc as unknown as { scenes: Array<{ elements: unknown[] }> }, c.id, takenPaste);
      takenPaste.add(c.id);
    }
    bump(c);
    return c;
  });
  const startIdx = doc.scenes[sceneIdx].elements?.length ?? 0;
  const newPaths = clones.map((_, i) => buildPath(sceneIdx, [startIdx + i]));
  store().updateDoc(
    `paste ${clones.length} element(s)`,
    (draft) => {
      const s = draft.scenes[sceneIdx];
      if (!s.elements) s.elements = [];
      s.elements.push(...clones);
    },
    { selectAfter: newPaths },
  );
  return newPaths;
}

// ---- 정렬 (앞/뒤) ----
/** 단일 경로 편의 래퍼 — 콜사이트(LayersPanel/shortcuts/SelectionOverlay)가
 *  단수형으로 부른다. reorderElements 에 위임. */
export function reorderElement(
  path: ElementPath,
  dir: "front" | "back" | "forward" | "backward",
) {
  reorderElements([path], dir);
}

/** 선택 전체의 z-순서 이동 — 컨테이너별로 묶어 상대 순서를 유지한 채 이동.
 *  front/back = 컨테이너 양끝, forward/backward = 한 단계(묶음 기준).
 *  선택은 새 경로로 따라간다(연타 가능). 다중 컨테이너 선택은 깊은 쪽부터
 *  컨테이너 단위로 처리(각각 undo 엔트리 — 드문 케이스라 허용). */
export function reorderElements(
  paths: ElementPath[],
  dir: "front" | "back" | "forward" | "backward",
) {
  const doc = store().doc;
  if (!doc) return;
  const norm = normalizeSelection(paths).filter((p) => getElement(doc, p));
  if (norm.length === 0) return;
  const byParent = new Map<string, ElementPath[]>();
  for (const p of norm) {
    const key = parentPath(p) ?? `${parsePath(p).sceneIdx}:`;
    byParent.set(key, [...(byParent.get(key) ?? []), p]);
  }
  // 깊은 컨테이너부터 — 얕은 리스트 순서변경이 깊은 경로 prefix 를 미리 흔들지 않게
  const groups = [...byParent.values()].sort(
    (a, b) => parsePath(b[0]).indices.length - parsePath(a[0]).indices.length,
  );
  const label =
    dir === "front" ? "bring to front"
    : dir === "back" ? "send to back"
    : dir === "forward" ? "bring forward"
    : "send backward";
  const results: ElementPath[] = [];
  for (const group of groups) {
    const container = parentPath(group[0]);
    const c = getContainer(store().doc!, group[0]);
    if (!c) continue;
    const idxs = group.map((p) => parsePath(p).indices.at(-1)!);
    const index =
      dir === "front" ? c.list.length
      : dir === "back" ? 0
      : dir === "forward" ? Math.max(...idxs) + 2
      : Math.min(...idxs) - 1;
    const moved = moveElements(group, { container, index }, label);
    if (moved) results.push(...moved);
  }
  // 컨테이너가 여럿이면 moveElements 의 selectAfter 가 마지막 것만 남으므로 합쳐서 재선택
  if (byParent.size > 1 && results.length) {
    const after = store().doc;
    store().select(results.filter((p) => after && getElement(after, p)));
  }
}

// ---- 레이어 트리 이동 (재정렬 + 리페어런트 통합 — 레이어 패널 DnD) ----

export type MoveTarget = {
  /** 대상 컨테이너 경로 (null = 씬 최상위) */
  container: ElementPath | null;
  /** 대상 배열 삽입 인덱스 (0 = 맨 뒤/backmost, length = 맨 앞/frontmost) */
  index: number;
};

/** frame 의 콘텐츠 박스(부모 공간 fraction) — chrome(browser 바/phone 베젤)
 *  인셋 반영. 엔진은 자식을 인셋된 스크린 영역에 렌더하므로(FrameBox) 좌표
 *  변환도 풀 박스가 아니라 이걸 기준으로 해야 chrome frame 에서 안 튄다. */
export function frameContentBoxOf(
  f: FrameElementSpec,
): { x: number; y: number; w: number; h: number } {
  const box = frameBoxOf(f);
  if (!f.chrome) return box;
  const ins = chromeInsets(f.chrome, box.w * COMP_W, box.h * COMP_H);
  return {
    x: box.x + ins.left / COMP_W,
    y: box.y + ins.top / COMP_H,
    w: Math.max(0.001, box.w - (ins.left + ins.right) / COMP_W),
    h: Math.max(0.001, box.h - (ins.top + ins.bottom) / COMP_H),
  };
}

// 컨테이너 경로의 좌표계 박스(씬 fraction). frame 조상만 좌표를 바꾸고
// group 은 inset:0 통과라 identity (엔진 FrameBox/FrameGroup 렌더 규칙 미러).
function containerSpaceBox(
  doc: VideoSpec,
  sceneIdx: number,
  containerPath: ElementPath | null,
): { x: number; y: number; w: number; h: number } {
  let box = { x: 0, y: 0, w: 1, h: 1 };
  if (!containerPath) return box;
  const { indices } = parsePath(containerPath);
  for (let d = 1; d <= indices.length; d++) {
    const el = getElement(doc, buildPath(sceneIdx, indices.slice(0, d)));
    if (el?.element === "frame") {
      const local = frameContentBoxOf(el);
      box = {
        x: box.x + local.x * box.w,
        y: box.y + local.y * box.h,
        w: local.w * box.w,
        h: local.h * box.h,
      };
    }
  }
  return box;
}

type SpaceBox = { x: number; y: number; w: number; h: number };

function sameBox(a: SpaceBox, b: SpaceBox): boolean {
  return (
    Math.abs(a.x - b.x) < 1e-6 &&
    Math.abs(a.y - b.y) < 1e-6 &&
    Math.abs(a.w - b.w) < 1e-6 &&
    Math.abs(a.h - b.h) < 1e-6
  );
}

// frame 경계를 넘는 이동의 좌표 패치. rel = 이동 루트 기준 자식 인덱스 체인.
// group 은 자식이 같은 좌표계라 하강, frame 은 자기 position 만 바꾸면
// 자식(frame-로컬)이 따라오므로 하강 중단. 키프레임 x/y 도 같은 변환
// (reparentElement 와 동일 — 안 하면 리페어런트 순간 요소가 점프).
// motionPath(요소 공통)와 group layout(path/orbit)의 경로 좌표(0..100 캔버스 %)도
// 같은 공간이라 함께 변환 — 안 하면 pose 와 base 가 다른 공간에 남아 점프.
type PathLikePatch = {
  origin?: { x: number; y: number };
  points?: PathPoint[];
  radius?: number;
};

type CoordPatch = {
  rel: number[];
  pos?: { x: number; y: number };
  fromShape?: { x: number; y: number };
  kf?: Array<{ i: number; x?: number; y?: number }>;
  motionPath?: PathLikePatch;
  layout?: PathLikePatch;
};

// 경로류(motionPath / group layout) 좌표 변환. points 앵커는 절대 좌표(풀 변환),
// 베지어 핸들과 origin(가산 오프셋)은 스케일만. points 없는 preset/d 는 내부
// 좌표를 못 바꾸므로 중심(50,50) 앵커 근사로 origin 에 평행이동을 흡수하고
// radius 만 스케일한다 (d 문자열 내부 좌표 미변환 = 알려진 한계).
function convertPathLike(
  p: MotionPathSpec | GroupLayoutSpec,
  src: SpaceBox,
  dst: SpaceBox,
): PathLikePatch {
  const fullX = (v: number) =>
    Number((((src.x - dst.x) * 100 + v * src.w) / Math.max(0.01, dst.w)).toFixed(3));
  const fullY = (v: number) =>
    Number((((src.y - dst.y) * 100 + v * src.h) / Math.max(0.01, dst.h)).toFixed(3));
  const sclX = (v: number) => Number(((v * src.w) / Math.max(0.01, dst.w)).toFixed(3));
  const sclY = (v: number) => Number(((v * src.h) / Math.max(0.01, dst.h)).toFixed(3));
  const out: PathLikePatch = {};
  const pts = (p as { points?: PathPoint[] }).points;
  if (pts?.length) {
    out.points = pts.map((pt) => ({
      ...pt,
      x: fullX(pt.x),
      y: fullY(pt.y),
      ...(pt.hIn ? { hIn: { x: sclX(pt.hIn.x), y: sclY(pt.hIn.y) } } : null),
      ...(pt.hOut ? { hOut: { x: sclX(pt.hOut.x), y: sclY(pt.hOut.y) } } : null),
    }));
    if (p.origin) out.origin = { x: sclX(p.origin.x), y: sclY(p.origin.y) };
  } else {
    const o = p.origin ?? { x: 0, y: 0 };
    out.origin = { x: fullX(50 + o.x) - 50, y: fullY(50 + o.y) - 50 };
    if ((p as { type?: string }).type === "orbit") {
      out.radius = sclX((p as { radius?: number }).radius ?? 28);
    } else if ((p as { preset?: string }).preset === "circle") {
      out.radius = sclY((p as { radius?: number }).radius ?? 30);
    }
  }
  return out;
}

function collectCoordPatches(
  el: SceneElementSpec,
  src: SpaceBox,
  dst: SpaceBox,
  rel: number[],
  out: CoordPatch[],
) {
  const patch: CoordPatch = { rel };
  const mp = (el as { motionPath?: MotionPathSpec }).motionPath;
  if (mp) patch.motionPath = convertPathLike(mp, src, dst);
  if (el.element === "group") {
    const layout = (el as { layout?: GroupLayoutSpec }).layout;
    if (layout) patch.layout = convertPathLike(layout, src, dst);
    if (patch.motionPath || patch.layout) out.push(patch);
    (el.children ?? []).forEach((c, i) =>
      collectCoordPatches(c, src, dst, [...rel, i], out),
    );
    return;
  }
  const convX = (v: number) =>
    Number(((src.x + v * src.w - dst.x) / Math.max(0.01, dst.w)).toFixed(4));
  const convY = (v: number) =>
    Number(((src.y + v * src.h - dst.y) / Math.max(0.01, dst.h)).toFixed(4));
  const b = (el as {
    base?: { position?: { x: number; y: number }; fromShape?: { x: number; y: number } };
  }).base;
  if (el.element === "gooey") {
    const p = b?.fromShape ?? { x: 0.5, y: 0.5 };
    patch.fromShape = { x: convX(p.x), y: convY(p.y) };
  } else {
    const p = b?.position ?? { x: 0.5, y: 0.5 };
    patch.pos = { x: convX(p.x), y: convY(p.y) };
  }
  const kfs = (el as { keyframes?: Array<{ x?: number; y?: number }> }).keyframes;
  if (Array.isArray(kfs)) {
    const kf: Array<{ i: number; x?: number; y?: number }> = [];
    kfs.forEach((k, i) => {
      const e: { i: number; x?: number; y?: number } = { i };
      if (typeof k.x === "number") e.x = convX(k.x);
      if (typeof k.y === "number") e.y = convY(k.y);
      if (e.x !== undefined || e.y !== undefined) kf.push(e);
    });
    if (kf.length) patch.kf = kf;
  }
  out.push(patch);
}

/** 요소들을 target.container 의 children[target.index] 자리로 이동(상대 순서
 *  보존). 같은 컨테이너 재정렬과 group/frame 리페어런트를 모두 처리하고,
 *  frame 경계를 넘으면 position/fromShape/keyframe x·y 를 좌표계 변환.
 *  반환: 새 경로들 (no-op/불가 시 null). */
export function moveElements(
  paths: ElementPath[],
  target: MoveTarget,
  label?: string,
): ElementPath[] | null {
  const doc = store().doc;
  if (!doc) return null;
  let norm = normalizeSelection(paths);
  if (norm.length === 0) return null;

  let sceneIdx: number;
  let containerIndices: number[] = [];
  if (target.container) {
    const holder = getElement(doc, target.container);
    if (!isContainer(holder)) return null;
    const parsed = parsePath(target.container);
    sceneIdx = parsed.sceneIdx;
    containerIndices = parsed.indices;
  } else {
    sceneIdx = parsePath(norm[0]).sceneIdx;
  }
  norm = norm.filter(
    (p) => parsePath(p).sceneIdx === sceneIdx && getElement(doc, p),
  );
  // 자기 자신/자손 컨테이너 안으로는 이동 불가 (사이클)
  if (target.container && norm.some((p) => isDescendantOf(target.container!, p)))
    return null;
  if (norm.length === 0) return null;

  // 스펙 순서(뒤→앞)로 정렬해 이동 후에도 상대 z-순서 유지
  const ordered = [...norm].sort((a, b) => {
    const ia = parsePath(a).indices;
    const ib = parsePath(b).indices;
    for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
      const va = ia[i] ?? -1;
      const vb = ib[i] ?? -1;
      if (va !== vb) return va - vb;
    }
    return 0;
  });

  const sceneKey = `${sceneIdx}:`;
  const listKeyOf = (p: ElementPath) => parentPath(p) ?? sceneKey;
  const targetKey = target.container ?? sceneKey;
  const lastIdxOf = (p: ElementPath) => parsePath(p).indices.at(-1)!;

  // 단일 요소 같은 컨테이너 제자리 = no-op (쓸데없는 undo 엔트리 방지)
  if (ordered.length === 1 && listKeyOf(ordered[0]) === targetKey) {
    const cur = lastIdxOf(ordered[0]);
    if (target.index === cur || target.index === cur + 1) return null;
  }

  // frame 경계를 넘는 요소만 좌표 패치 준비
  const dstBox = containerSpaceBox(doc, sceneIdx, target.container);
  const patchesByPath = new Map<ElementPath, CoordPatch[]>();
  for (const p of ordered) {
    const srcBox = containerSpaceBox(doc, sceneIdx, parentPath(p));
    if (sameBox(srcBox, dstBox)) continue;
    const out: CoordPatch[] = [];
    collectCoordPatches(getElement(doc, p)!, srcBox, dstBox, [], out);
    if (out.length) patchesByPath.set(p, out);
  }

  // 이동 후 경로 계산 — 제거로 인한 인덱스 시프트를 미리 반영.
  const movedInList = (listKey: string) =>
    ordered.filter((p) => listKeyOf(p) === listKey);
  const adjContainer = [...containerIndices];
  for (let d = 0; d < adjContainer.length; d++) {
    const ancestorKey =
      d === 0 ? sceneKey : buildPath(sceneIdx, containerIndices.slice(0, d));
    adjContainer[d] -= movedInList(ancestorKey).filter(
      (p) => lastIdxOf(p) < containerIndices[d],
    ).length;
  }
  const targetHolder = target.container
    ? (getElement(doc, target.container) as GroupElementSpec | FrameElementSpec)
    : null;
  const targetLen = targetHolder
    ? (targetHolder.children?.length ?? 0)
    : (doc.scenes[sceneIdx].elements?.length ?? 0);
  const clamped = Math.max(0, Math.min(targetLen, target.index));
  const at =
    clamped -
    movedInList(targetKey).filter((p) => lastIdxOf(p) < clamped).length;
  const newPaths = ordered.map((_, k) =>
    buildPath(sceneIdx, [...adjContainer, at + k]),
  );

  store().updateDoc(
    label ?? (ordered.length === 1 ? "move element" : `move ${ordered.length} elements`),
    (draft) => {
      // 스플라이스 전에 draft 객체/리스트를 identity 로 전부 확보 — 이후
      // 어떤 순서로 제거해도 인덱스 시프트에 안전.
      const moved: Array<{ list: SceneElementSpec[]; el: SceneElementSpec }> = [];
      for (const p of ordered) {
        const c = getContainer(draft, p);
        if (!c || !c.list[c.index]) return;
        moved.push({ list: c.list, el: c.list[c.index] });
      }
      let targetList: SceneElementSpec[];
      if (target.container) {
        const holder = getElement(draft, target.container);
        if (!isContainer(holder)) return;
        if (!holder.children) holder.children = [];
        targetList = holder.children;
      } else {
        const s = draft.scenes[sceneIdx];
        if (!s.elements) s.elements = [];
        targetList = s.elements;
      }
      // 좌표 패치 적용 (이동 루트에서 rel 체인으로 하강)
      for (let i = 0; i < ordered.length; i++) {
        const patches = patchesByPath.get(ordered[i]);
        if (!patches) continue;
        for (const patch of patches) {
          let node: SceneElementSpec | undefined = moved[i].el;
          for (const r of patch.rel)
            node = (node as GroupElementSpec).children?.[r];
          if (!node) continue;
          const nb = node as {
            base?: { position?: { x: number; y: number }; fromShape?: { x: number; y: number } };
            keyframes?: Array<{ x?: number; y?: number }>;
            motionPath?: { origin?: unknown; points?: unknown; radius?: unknown };
            layout?: { origin?: unknown; points?: unknown; radius?: unknown };
          };
          if (patch.pos || patch.fromShape) {
            if (!nb.base) nb.base = {};
            if (patch.pos) nb.base.position = patch.pos;
            if (patch.fromShape) nb.base.fromShape = patch.fromShape;
          }
          if (patch.kf && nb.keyframes) {
            for (const k of patch.kf) {
              if (k.x !== undefined) nb.keyframes[k.i].x = k.x;
              if (k.y !== undefined) nb.keyframes[k.i].y = k.y;
            }
          }
          const applyPathLike = (
            t: { origin?: unknown; points?: unknown; radius?: unknown } | undefined,
            pp: PathLikePatch,
          ) => {
            if (!t) return;
            if (pp.origin) t.origin = pp.origin;
            if (pp.points) t.points = pp.points;
            if (pp.radius !== undefined) t.radius = pp.radius;
          };
          if (patch.motionPath) applyPathLike(nb.motionPath, patch.motionPath);
          if (patch.layout) applyPathLike(nb.layout, patch.layout);
        }
      }
      // 제거 (identity splice) → 삽입
      for (const m of moved) {
        const idx = m.list.indexOf(m.el);
        if (idx >= 0) m.list.splice(idx, 1);
      }
      const insertAt = Math.max(0, Math.min(targetList.length, at));
      targetList.splice(insertAt, 0, ...moved.map((m) => m.el));
    },
    { selectAfter: newPaths },
  );
  return newPaths;
}

// ---- Frame ----
/** Frame selection (⌥⌘G) — 선택을 패딩 없이 감싸는 frame 생성 + 자식 리페어런트.
 *  bbox: 캔버스 fraction {x,y,w,h} (호출부가 DOM 측정으로 계산해 전달 — Figma 정확 동작).
 *  자식 position 은 frame-로컬로 변환된다. 반환: frame 경로 */
export function frameSelection(
  paths: ElementPath[],
  bbox: { x: number; y: number; w: number; h: number },
): ElementPath | null {
  const doc = store().doc;
  if (!doc) return null;
  const norm = normalizeSelection(paths);
  if (norm.length === 0) return null;
  const sceneIdx = parsePath(norm[0]).sceneIdx;
  // v1: 같은 씬의 최상위 요소만 (중첩 리페어런트는 좌표 모델이 복잡)
  if (!norm.every((p) => parsePath(p).sceneIdx === sceneIdx && parsePath(p).indices.length === 1)) return null;

  const w = Math.max(0.01, bbox.w);
  const h = Math.max(0.01, bbox.h);
  const frame: FrameElementSpec = {
    element: "frame",
    id: `frame-${(doc.scenes[sceneIdx].elements?.length ?? 0) + 1}`,
    base: {
      position: { x: bbox.x + w / 2, y: bbox.y + h / 2 },
      width: w * 100,
      height: h * 100,
      clipsContent: false, // frame-selection 랩은 기존 오버플로 보존(Figma 관례)
    },
    children: [],
  };
  // 자식 클론(평문) + frame-로컬 좌표 변환 — moveElements 와 동일한 패치 수집기
  // 재사용 (감사 #7: position/fromShape 만 변환하고 keyframes x/y, motionPath,
  // layout, group 자식 좌표를 빠뜨려 frame 으로 묶는 순간 튀던 것).
  const srcBox: SpaceBox = { x: 0, y: 0, w: 1, h: 1 };
  const dstBox: SpaceBox = { x: bbox.x, y: bbox.y, w, h };
  const applyPatches = (root: SceneElementSpec, patches: CoordPatch[]) => {
    for (const patch of patches) {
      let node: SceneElementSpec | undefined = root;
      for (const r of patch.rel) node = (node as GroupElementSpec).children?.[r];
      if (!node) continue;
      const nb = node as {
        base?: { position?: { x: number; y: number }; fromShape?: { x: number; y: number } };
        keyframes?: Array<{ x?: number; y?: number }>;
        motionPath?: { origin?: unknown; points?: unknown; radius?: unknown };
        layout?: { origin?: unknown; points?: unknown; radius?: unknown };
      };
      if (patch.pos || patch.fromShape) {
        if (!nb.base) nb.base = {};
        if (patch.pos) nb.base.position = patch.pos;
        if (patch.fromShape) nb.base.fromShape = patch.fromShape;
      }
      if (patch.kf && nb.keyframes) {
        for (const k of patch.kf) {
          if (k.x !== undefined) nb.keyframes[k.i].x = k.x;
          if (k.y !== undefined) nb.keyframes[k.i].y = k.y;
        }
      }
      const applyPathLike = (
        t: { origin?: unknown; points?: unknown; radius?: unknown } | undefined,
        pp: PathLikePatch,
      ) => {
        if (!t) return;
        if (pp.origin) t.origin = pp.origin;
        if (pp.points) t.points = pp.points;
        if (pp.radius !== undefined) t.radius = pp.radius;
      };
      if (patch.motionPath) applyPathLike(nb.motionPath, patch.motionPath);
      if (patch.layout) applyPathLike(nb.layout, patch.layout);
    }
  };
  const idxs = norm.map((p) => parsePath(p).indices[0]).sort((a, b) => a - b);
  for (const i of idxs) {
    const el = doc.scenes[sceneIdx].elements?.[i];
    if (!el) continue;
    const c = structuredClone(el) as SceneElementSpec;
    const patches: CoordPatch[] = [];
    collectCoordPatches(c, srcBox, dstBox, [], patches);
    applyPatches(c, patches);
    frame.children.push(c);
  }
  const insertAt = idxs[0];
  const framePath = buildPath(sceneIdx, [insertAt]);
  store().updateDoc(
    "frame selection",
    (draft) => {
      const list = draft.scenes[sceneIdx].elements;
      if (!list) return;
      // 큰 인덱스부터 제거 → 삽입 지점 안 밀림
      for (const i of [...idxs].reverse()) list.splice(i, 1);
      list.splice(insertAt, 0, frame);
    },
    { selectAfter: [framePath] },
  );
  return framePath;
}

/** 요소를 frame 안/밖으로 리페어런트(캔버스 드래그 자동 네스팅) — moveElements
 *  위임. 대상 맨 앞(배열 끝)에 삽입하고 좌표(position/keyframes/motionPath)는
 *  frameContentBoxOf 기준으로 유지 변환. targetFramePath=null 이면 씬 최상위로.
 *  같은 부모면 no-op(null) — 캔버스 드래그가 프레임 안에서 움직일 때마다
 *  맨 앞으로 튀지 않게 하는 계약. */
export function reparentElement(
  path: ElementPath,
  targetFramePath: ElementPath | null,
): ElementPath | null {
  const doc = store().doc;
  if (!doc) return null;
  const el = getElement(doc, path);
  if (!el || isContainer(el)) return null; // v1: leaf 만 (레이어 패널은 컨테이너도 가능)
  if ((parentPath(path) ?? null) === (targetFramePath ?? null)) return null;

  if (targetFramePath) {
    const tf = getElement(doc, targetFramePath);
    if (tf?.element !== "frame") return null;
    const len = tf.children?.length ?? 0;
    return (
      moveElements([path], { container: targetFramePath, index: len }, "move into frame")?.[0] ??
      null
    );
  }
  const { sceneIdx } = parsePath(path);
  const len = doc.scenes[sceneIdx]?.elements?.length ?? 0;
  return moveElements([path], { container: null, index: len }, "move out of frame")?.[0] ?? null;
}

/** frame 의 캔버스 박스(fraction). */
export function frameBoxOf(f: FrameElementSpec): { x: number; y: number; w: number; h: number } {
  const pos = f.base?.position ?? { x: 0.5, y: 0.5 };
  const w = (f.base?.width ?? 40) / 100;
  const h = (f.base?.height ?? 30) / 100;
  return { x: pos.x - w / 2, y: pos.y - h / 2, w, h };
}

/** 씬 추가 (뒤에) */
export function addScene() {
  store().updateDoc("add scene", (draft) => {
    const n = draft.scenes.length;
    draft.scenes.push({ id: `scene-${n + 1}`, duration: 2.5, elements: [] });
  });
}

/** 씬 삭제 */
export function deleteScene(idx: number) {
  const doc = store().doc;
  if (!doc || doc.scenes.length <= 1) return; // 마지막 씬은 못 지움
  store().updateDoc(
    `delete scene ${idx + 1}`,
    (draft) => {
      draft.scenes.splice(idx, 1);
    },
    { selectAfter: [] },
  );
  const s = store();
  if (s.activeScene >= idx && s.activeScene > 0) s.setActiveScene(s.activeScene - 1);
}

/** 씬 복제 */
export function duplicateScene(idx: number) {
  const doc = store().doc;
  const srcScene = doc?.scenes[idx];
  if (!srcScene) return;
  // 클론은 producer 밖에서 평문 씬으로 (immer draft 는 Proxy → structuredClone 불가).
  const clone = structuredClone(srcScene) as SceneSpec;
  if (clone.id) {
    const sceneIds = new Set((doc?.scenes ?? []).map((s) => s.id).filter(Boolean) as string[]);
    let cand = `${clone.id}-copy`;
    let n = 2;
    while (sceneIds.has(cand)) cand = `${clone.id}-copy${n++}`;
    clone.id = cand;
  }
  store().updateDoc(`duplicate scene ${idx + 1}`, (draft) => {
    draft.scenes.splice(idx + 1, 0, clone);
  });
}

/** 씬 순서 이동 */
export function moveScene(from: number, to: number) {
  store().updateDoc(
    "reorder scenes",
    (draft) => {
      const [s] = draft.scenes.splice(from, 1);
      draft.scenes.splice(to, 0, s);
    },
    { selectAfter: [] },
  );
  store().setActiveScene(to);
}
