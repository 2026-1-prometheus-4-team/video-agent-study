"use client";

// LayersPanel — 활성 씬 요소 트리. 선택/이름변경/컨텍스트메뉴/드래그 재정렬·리페어런트.
//
// 표시 순서는 Figma 관례: 패널 위쪽 = 앞(frontmost). 엔진은 배열 뒤쪽이 앞에
// 그려지므로(SceneRenderer 페인트 순서) 각 컨테이너의 children 을 역순으로 걷는다.
// 드롭 인덱스 계산도 이 역방향 기준 — "행 위 절반" = 그 요소 앞(arrayIdx+1),
// "행 아래 절반" = 그 요소 뒤(arrayIdx).

import React from "react";
import { useEditor } from "@/editor/store";
import {
  buildPath,
  elementLabel,
  getElement,
  isContainer,
  hasChildren,
  isDescendantOf,
  isGroup,
  parsePath,
  type ElementPath,
} from "@/editor/specPath";
import type { SceneElementSpec } from "@engine/motion/SceneRenderer";
import {
  duplicateElements,
  deleteElements,
  groupElements,
  ungroupElement,
  convertGroupToFrame,
  reorderElements,
  moveElements,
} from "@/editor/mutations";
import s from "./layers.module.css";

type Row = {
  path: ElementPath;
  el: SceneElementSpec;
  depth: number;
  /** 부모 컨테이너 경로 (null = 씬 최상위) */
  parent: ElementPath | null;
  /** 부모 배열 안 인덱스 (스펙 순서 — 클수록 앞) */
  arrayIdx: number;
  container: boolean;
};

type DropSpot =
  | { kind: "into"; container: ElementPath }
  | {
      kind: "line";
      container: ElementPath | null;
      index: number;
      rowPath: ElementPath;
      edge: "top" | "bottom";
      indent: number;
    };

const DRAG_THRESHOLD = 5;

export default function LayersPanel() {
  const doc = useEditor((st) => st.doc);
  const activeScene = useEditor((st) => st.activeScene);
  const selection = useEditor((st) => st.selection);
  const hovered = useEditor((st) => st.hovered);
  const select = useEditor((st) => st.select);
  const toggleSelect = useEditor((st) => st.toggleSelect);
  const setHovered = useEditor((st) => st.setHovered);

  const [menu, setMenu] = React.useState<{ x: number; y: number; path: ElementPath } | null>(null);
  const [renaming, setRenaming] = React.useState<ElementPath | null>(null);

  // --- 드래그 상태 ---
  const treeRef = React.useRef<HTMLDivElement | null>(null);
  const dragRef = React.useRef<{
    startX: number;
    startY: number;
    paths: ElementPath[];
    started: boolean;
  } | null>(null);
  const clickGuard = React.useRef(false); // 드래그 직후 click 으로 선택이 튀는 것 방지
  const [dragPaths, setDragPaths] = React.useState<ElementPath[] | null>(null);
  const [drop, setDrop] = React.useState<DropSpot | null>(null);
  // pointerup 은 렌더 클로저 대신 ref 로 읽는다 — 빠른 플릭-릴리즈에서 마지막
  // setDrop 이 커밋되기 전에 up 이 오면 한 스텝 뒤 위치에 드롭되는 레이스 방지.
  const dropRef = React.useRef<DropSpot | null>(null);
  const [ghost, setGhost] = React.useState<{ x: number; y: number } | null>(null);

  const setDropSpot = React.useCallback((d: DropSpot | null) => {
    dropRef.current = d;
    setDrop(d);
  }, []);

  // 드래그 뒤 따라오는 click 1회 무시. pointerup 유실(cmd-tab 등)로 click 이 아예
  // 안 오면 가드가 남아 다음 정상 클릭을 먹으므로 짧게 자동 해제.
  const armClickGuard = React.useCallback(() => {
    clickGuard.current = true;
    window.setTimeout(() => {
      clickGuard.current = false;
    }, 250);
  }, []);

  const endDrag = React.useCallback(() => {
    dragRef.current = null;
    setDragPaths(null);
    dropRef.current = null;
    setDrop(null);
    setGhost(null);
  }, []);

  // Esc = 드래그 취소 (capture 로 전역 단축키의 선택 해제보다 먼저 먹는다)
  React.useEffect(() => {
    if (!dragPaths) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      armClickGuard();
      endDrag();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [dragPaths, endDrag, armClickGuard]);

  // 드래그 중 doc 이 바뀌면(⌘Z/삭제/추가 등 전역 단축키는 드래그 중에도 살아있다)
  // dragRef 의 인덱스 경로가 다른 요소를 가리키게 되므로 드래그를 취소한다.
  // 정상 드롭은 endDrag 가 moveElements 직후 실행돼 이 효과 시점엔 이미 비어있다.
  React.useEffect(() => {
    if (dragRef.current) {
      armClickGuard();
      endDrag();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  if (!doc) return <div className={s.hint}>No spec</div>;

  // 표시용 트리 — 각 레벨을 역순(앞→뒤)으로. 컨테이너 행 다음에 자식들.
  const rows: Row[] = [];
  {
    const walk = (
      els: SceneElementSpec[],
      prefix: number[],
      depth: number,
      parent: ElementPath | null,
    ) => {
      for (let i = els.length - 1; i >= 0; i--) {
        const el = els[i];
        const indices = [...prefix, i];
        const path = buildPath(activeScene, indices);
        // container: drop-into 대상 (group/frame). 순회는 hasChildren —
        // device 의 스크린 frame 도 트리에 보이되 device 자체는 drop 대상 아님.
        rows.push({ path, el, depth, parent, arrayIdx: i, container: isContainer(el) });
        if (hasChildren(el) && el.children) walk(el.children, indices, depth + 1, path);
      }
    };
    walk(doc.scenes[activeScene]?.elements ?? [], [], 0, null);
  }
  const rowByPath = new Map(rows.map((r) => [r.path, r]));

  const isDragged = (path: ElementPath) =>
    !!dragPaths && dragPaths.some((d) => isDescendantOf(path, d));

  const computeDrop = (clientX: number, clientY: number, dragged: ElementPath[]): DropSpot | null => {
    let hitEl = document
      .elementFromPoint(clientX, clientY)
      ?.closest?.("[data-path]") as HTMLElement | null;
    const inDragged = (p: ElementPath) => dragged.some((d) => isDescendantOf(p, d));
    const tr = treeRef.current?.getBoundingClientRect();
    if (!tr || rows.length === 0) return null;
    if (clientX < tr.left || clientX > tr.right || clientY < tr.top || clientY > tr.bottom)
      return null;
    if (!hitEl) {
      // 행 좌우 패딩/스크롤바 틈에서 elementFromPoint 가 빗나가면 Y 대역으로 직접 스캔
      for (const n of treeRef.current?.querySelectorAll<HTMLElement>("[data-path]") ?? []) {
        const r = n.getBoundingClientRect();
        if (clientY >= r.top && clientY <= r.bottom) {
          hitEl = n;
          break;
        }
      }
    }
    if (!hitEl || !hitEl.dataset.path) {
      // 첫 행 위 = 씬 최상위 맨 앞, 마지막 행 아래(트리 여백) = 씬 최상위 맨 뒤
      const firstRect = treeRef.current
        ?.querySelector<HTMLElement>("[data-path]")
        ?.getBoundingClientRect();
      if (firstRect && clientY < firstRect.top) {
        const first = rows[0];
        return { kind: "line", container: first.parent, index: first.arrayIdx + 1, rowPath: first.path, edge: "top", indent: 8 };
      }
      const last = rows[rows.length - 1];
      return { kind: "line", container: null, index: 0, rowPath: last.path, edge: "bottom", indent: 8 };
    }
    const row = rowByPath.get(hitEl.dataset.path);
    if (!row) return null;
    if (inDragged(row.path)) return null; // 자기 자신/자기 자손 위엔 드롭 불가
    const rect = hitEl.getBoundingClientRect();
    const rel = (clientY - rect.top) / Math.max(1, rect.height);
    // 컨테이너(group/frame) 행: 위 얇은 띠(15%)만 "앞에 형제", 나머지 = 컨테이너
    // 안으로 드롭. 예전엔 30% 라 상단 sliver 가 "형제 삽입 함정"이라 그룹 안에
    // 넣기가 까다로웠다 (실측 리포트). 15% 로 좁혀 넣기를 관대하게.
    if (row.container && rel >= 0.15) {
      return { kind: "into", container: row.path };
    }
    // 컨테이너의 "자식 행" 위에 놓으면 = 그 부모 컨테이너 안으로 (그룹 몸통
    // 전체가 nesting zone 처럼 동작). 그냥 형제 재정렬 line 이 아니라 into 로
    // 표시해 피드백을 명확히 (자식들 사이 특정 위치가 아니라 컨테이너로 넣기).
    if (row.parent && !inDragged(row.parent)) {
      const parentRow = rowByPath.get(row.parent);
      if (parentRow?.container) {
        // 자식 행의 상/하 절반으로 그 자식 앞/뒤 형제 위치는 유지하되,
        // 컨테이너 소속은 부모로 (line 이 이미 container=parent 라 정상 nesting).
        const lc = row.parent;
        return rel < 0.5
          ? { kind: "line", container: lc, index: row.arrayIdx + 1, rowPath: row.path, edge: "top", indent: 8 + row.depth * 14 }
          : { kind: "line", container: lc, index: row.arrayIdx, rowPath: row.path, edge: "bottom", indent: 8 + row.depth * 14 };
      }
    }
    const lineContainer = row.parent;
    if (lineContainer && inDragged(lineContainer)) return null;
    return rel < 0.5
      ? { kind: "line", container: lineContainer, index: row.arrayIdx + 1, rowPath: row.path, edge: "top", indent: 8 + row.depth * 14 }
      : { kind: "line", container: lineContainer, index: row.arrayIdx, rowPath: row.path, edge: "bottom", indent: 8 + row.depth * 14 };
  };

  const autoScroll = (clientY: number) => {
    const t = treeRef.current;
    if (!t) return;
    const r = t.getBoundingClientRect();
    if (clientY < r.top + 24) t.scrollTop -= 10;
    else if (clientY > r.bottom - 24) t.scrollTop += 10;
  };

  const onRowPointerDown = (e: React.PointerEvent, path: ElementPath) => {
    if (e.button !== 0 || renaming === path) return;
    // 선택은 씬 전환 후에도 유지되므로(재생 등) 다른 씬 경로가 섞일 수 있다 —
    // 활성 씬 요소만 드래그. 안 거르면 패널에 안 보이는 씬이 조용히 재배열된다.
    const paths = (selection.includes(path) ? selection : [path]).filter(
      (p) => parsePath(p).sceneIdx === activeScene,
    );
    if (paths.length === 0) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, paths, started: false };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // 이미 해제된 포인터 등 — 캡처 실패해도 행 단위 move/up 핸들러로 동작
    }
  };

  const onRowPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.started) {
      if (
        Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) <
        DRAG_THRESHOLD
      )
        return;
      d.started = true;
      setDragPaths(d.paths);
    }
    setGhost({ x: e.clientX, y: e.clientY });
    autoScroll(e.clientY);
    setDropSpot(computeDrop(e.clientX, e.clientY, d.paths));
  };

  const onRowPointerUp = () => {
    const d = dragRef.current;
    if (!d) return;
    if (d.started) {
      armClickGuard();
      const spot = dropRef.current;
      if (spot) {
        if (spot.kind === "into") {
          const el = getElement(doc, spot.container);
          const len = isContainer(el) ? (el.children?.length ?? 0) : 0;
          moveElements(d.paths, { container: spot.container, index: len });
        } else {
          moveElements(d.paths, { container: spot.container, index: spot.index });
        }
      }
    }
    endDrag();
  };

  return (
    <div className={s.root}>
      <div className={s.header}>
        <span className={s.headerTitle}>Layers · {doc.scenes[activeScene]?.id ?? `Scene ${activeScene + 1}`}</span>
      </div>
      <div className={s.tree} ref={treeRef} data-dragactive={!!dragPaths}>
        {rows.length === 0 ? (
          <div className={s.empty}>
            Empty scene <span className="keycap">T</span> to add text
          </div>
        ) : (
          rows.map(({ path, el, depth, container }) => {
            const selected = selection.includes(path);
            const dropAttr =
              drop?.kind === "into" && drop.container === path
                ? "into"
                : drop?.kind === "line" && drop.rowPath === path
                  ? drop.edge
                  : undefined;
            return (
              <div
                key={path}
                data-path={path}
                className={s.row}
                data-selected={selected}
                data-hovered={hovered === path && !dragPaths}
                data-dragging={isDragged(path) || undefined}
                data-drop={dropAttr}
                style={{
                  paddingLeft: 8 + depth * 14,
                  ...(drop?.kind === "line" && drop.rowPath === path
                    ? ({ "--drop-indent": `${drop.indent}px` } as React.CSSProperties)
                    : null),
                }}
                onMouseEnter={() => setHovered(path)}
                onMouseLeave={() => setHovered(null)}
                onPointerDown={(e) => onRowPointerDown(e, path)}
                onPointerMove={onRowPointerMove}
                onPointerUp={onRowPointerUp}
                onPointerCancel={endDrag}
                onLostPointerCapture={() => {
                  // 창 밖 릴리즈/cmd-tab 등으로 up 이 유실돼도 드래그 UI 가 얼지 않게
                  if (dragRef.current) {
                    armClickGuard();
                    endDrag();
                  }
                }}
                onClick={(e) => {
                  if (clickGuard.current) {
                    clickGuard.current = false;
                    return;
                  }
                  if (e.shiftKey) toggleSelect(path);
                  else select([path]);
                }}
                onDoubleClick={() => setRenaming(path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!selected) select([path]);
                  setMenu({ x: e.clientX, y: e.clientY, path });
                }}
              >
                <Glyph kind={el.element} />
                {renaming === path ? (
                  <input
                    className={s.rename}
                    autoFocus
                    defaultValue={el.id ?? ""}
                    onBlur={(e) => {
                      useEditor.getState().updateDoc("Rename", (draft) => {
                        const t = getElement(draft, path);
                        if (t) t.id = e.target.value || undefined;
                      });
                      setRenaming(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") setRenaming(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className={s.label}>{elementLabel(el)}</span>
                )}
                {container && (
                  <span className={s.groupTag}>{el.element === "frame" ? "Frame" : "Group"}</span>
                )}
              </div>
            );
          })
        )}
      </div>

      {ghost && dragPaths && (
        <div className={s.dragGhost} style={{ left: ghost.x + 12, top: ghost.y + 10 }}>
          {(() => {
            if (dragPaths.length > 1) return `${dragPaths.length} layers`;
            const el = getElement(doc, dragPaths[0]);
            return el ? elementLabel(el) : "layer";
          })()}
        </div>
      )}

      {menu && (
        <>
          <div className={s.menuBackdrop} onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className={s.menu} style={{ left: menu.x, top: menu.y }}>
            <button className={s.menuItem} onClick={() => { duplicateElements(selection.length ? selection : [menu.path]); setMenu(null); }}>Duplicate</button>
            {selection.length >= 2 && <button className={s.menuItem} onClick={() => { groupElements(selection); setMenu(null); }}>Group</button>}
            {isGroup(getElement(doc, menu.path)) && <button className={s.menuItem} onClick={() => { ungroupElement(menu.path); setMenu(null); }}>Ungroup</button>}
            {isGroup(getElement(doc, menu.path)) && <button className={s.menuItem} onClick={() => { convertGroupToFrame(menu.path); setMenu(null); }}>Convert to Frame</button>}
            <div className={s.menuSep} />
            <button className={s.menuItem} onClick={() => { reorderElements(selection.length ? selection : [menu.path], "front"); setMenu(null); }}>Bring to front <span className={s.menuKey}>⌘]</span></button>
            <button className={s.menuItem} onClick={() => { reorderElements(selection.length ? selection : [menu.path], "forward"); setMenu(null); }}>Bring forward <span className={s.menuKey}>⌥⌘]</span></button>
            <button className={s.menuItem} onClick={() => { reorderElements(selection.length ? selection : [menu.path], "backward"); setMenu(null); }}>Send backward <span className={s.menuKey}>⌥⌘[</span></button>
            <button className={s.menuItem} onClick={() => { reorderElements(selection.length ? selection : [menu.path], "back"); setMenu(null); }}>Send to back <span className={s.menuKey}>⌘[</span></button>
            <div className={s.menuSep} />
            <button className={s.menuItem} data-danger onClick={() => { deleteElements(selection.length ? selection : [menu.path]); setMenu(null); }}>Delete</button>
          </div>
        </>
      )}
    </div>
  );
}

function Glyph({ kind }: { kind: string }) {
  if (kind === "shape")
    return <svg width="13" height="13" viewBox="0 0 13 13" className={s.glyph}><rect x="2.5" y="3.5" width="8" height="6" rx="1.5" stroke="currentColor" strokeWidth="1" fill="none" /></svg>;
  if (kind === "group")
    return <svg width="13" height="13" viewBox="0 0 13 13" className={s.glyph}><rect x="2" y="2" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="1" fill="none" strokeDasharray="2 1.5" /></svg>;
  if (kind === "frame")
    return <svg width="13" height="13" viewBox="0 0 13 13" className={s.glyph}><path d="M4 1.5v10M9 1.5v10M1.5 4h10M1.5 9h10" stroke="currentColor" strokeWidth="1" strokeLinecap="round" /></svg>;
  if (kind === "logo")
    return <svg width="13" height="13" viewBox="0 0 13 13" className={s.glyph}><circle cx="6.5" cy="6.5" r="4" stroke="currentColor" strokeWidth="1" fill="none" /></svg>;
  return <svg width="13" height="13" viewBox="0 0 13 13" className={s.glyph}><path d="M2.5 3.5h8M6.5 3.5v6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" /></svg>;
}
