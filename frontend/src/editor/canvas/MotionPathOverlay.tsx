"use client";

// MotionPathOverlay — 피그마식 모션 패스 편집기.
// 선택된 요소에 motionPath.points 가 있으면 캔버스 위에 경로+앵커+핸들을 그린다.
//  - 앵커 드래그: 점 이동 (핸들도 같이 따라감 — 상대 저장이라 자동)
//  - 앵커 클릭: 활성화 -> 핸들 표시
//  - 핸들 드래그: 기본 대칭 미러(부드러운 점), Alt = 한쪽만 (꺾인 점)
//  - 선분 더블클릭: 그 지점에 점 추가 (곡선 접선 유지)
//  - 앵커 더블클릭: 점 삭제 (최소 2개 유지)
// 좌표계: 경로 점/핸들은 0..100 (캔버스 %), 오버레이는 comp px * scale.

import React from "react";
import { useEditor } from "@/editor/store";
import { getElement, type ElementPath } from "@/editor/specPath";
import { writeElementField } from "@/editor/inspector/writes";
import { pointsToD, type PathPoint } from "@engine/motion/pathLayout";
import { COMP_W, COMP_H } from "./PlayerCanvas";
import s from "./canvas.module.css";

type Drag =
  | { kind: "anchor"; idx: number }
  | { kind: "handle"; idx: number; side: "hIn" | "hOut" };

function clamp01x100(v: number): number {
  return Math.max(-50, Math.min(150, Number(v.toFixed(2))));
}

// 큐빅 세그먼트 평가 (a -> b, t 0..1)
function cubicAt(a: PathPoint, b: PathPoint, t: number): { x: number; y: number } {
  const u = 1 - t;
  const c1x = a.x + (a.hOut?.x ?? 0);
  const c1y = a.y + (a.hOut?.y ?? 0);
  const c2x = b.x + (b.hIn?.x ?? 0);
  const c2y = b.y + (b.hIn?.y ?? 0);
  return {
    x: u * u * u * a.x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * b.y,
  };
}

// de Casteljau 분할 — t 에서 세그먼트를 둘로 쪼개 새 앵커+핸들 산출 (곡선 모양 보존)
function splitSegment(a: PathPoint, b: PathPoint, t: number): { a: PathPoint; mid: PathPoint; b: PathPoint } {
  const p0 = { x: a.x, y: a.y };
  const p1 = { x: a.x + (a.hOut?.x ?? 0), y: a.y + (a.hOut?.y ?? 0) };
  const p2 = { x: b.x + (b.hIn?.x ?? 0), y: b.y + (b.hIn?.y ?? 0) };
  const p3 = { x: b.x, y: b.y };
  const lerp = (u: { x: number; y: number }, v: { x: number; y: number }) => ({ x: u.x + (v.x - u.x) * t, y: u.y + (v.y - u.y) * t });
  const q0 = lerp(p0, p1), q1 = lerp(p1, p2), q2 = lerp(p2, p3);
  const r0 = lerp(q0, q1), r1 = lerp(q1, q2);
  const m = lerp(r0, r1);
  return {
    a: { ...a, hOut: { x: q0.x - a.x, y: q0.y - a.y } },
    mid: { x: m.x, y: m.y, hIn: { x: r0.x - m.x, y: r0.y - m.y }, hOut: { x: r1.x - m.x, y: r1.y - m.y } },
    b: { ...b, hIn: { x: q2.x - b.x, y: q2.y - b.y } },
  };
}

export function MotionPathOverlay() {
  const doc = useEditor((st) => st.doc);
  const selection = useEditor((st) => st.selection);
  const rootRef = React.useRef<SVGSVGElement>(null);
  const [activeAnchor, setActiveAnchor] = React.useState<number | null>(null);
  const dragRef = React.useRef<Drag | null>(null);
  const altRef = React.useRef(false);

  React.useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === "Alt") altRef.current = true; };
    const up = (e: KeyboardEvent) => { if (e.key === "Alt") altRef.current = false; };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  const path: ElementPath | null = selection.length === 1 ? selection[0] : null;
  const el = doc && path ? getElement(doc, path) : null;
  // 편집 대상: 요소 이동 경로(motionPath.points) 또는 그룹 배치 경로(layout.points).
  // 그룹이 layout 경로로 자식을 흩어 배치 중이면 그 경로가 곧 "보이는 선" — 그걸 편집.
  const cast = el as { motionPath?: { points?: PathPoint[]; closed?: boolean; origin?: { x: number; y: number } }; layout?: { type?: string; points?: PathPoint[]; closed?: boolean; origin?: { x: number; y: number } } } | null;
  const useLayout = !!(cast?.layout?.type === "path" && cast.layout.points);
  const src = useLayout ? cast!.layout! : cast?.motionPath;
  const points = src?.points;
  if (!path || !src || !points || points.length < 2) return null;

  const fieldPrefix = useLayout ? "layout" : "motionPath";
  const closed = !!src.closed;
  const origin = src.origin ?? { x: 0, y: 0 };
  const write = (pts: PathPoint[], live: boolean, label: string) =>
    writeElementField(path, `${fieldPrefix}.points`, pts, live, label);

  // 오버레이 좌표 (px) <-> 경로 좌표 (0..100)
  // 앵커/핸들 좌표는 origin 차감한 "경로 로컬" 값으로 쓴다 (드래그 이동과 직교).
  const toPct = (e: { clientX: number; clientY: number }) => {
    const r = rootRef.current!.getBoundingClientRect();
    return {
      x: clamp01x100(((e.clientX - r.left) / r.width) * 100 - origin.x),
      y: clamp01x100(((e.clientY - r.top) / r.height) * 100 - origin.y),
    };
  };
  const px = (p: { x: number; y: number }) => {
    const r = rootRef.current?.getBoundingClientRect();
    const w = r?.width ?? COMP_W;
    const h = r?.height ?? COMP_H;
    return { x: (p.x / 100) * w, y: (p.y / 100) * h };
  };

  const onAnchorDown = (idx: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setActiveAnchor(idx);
    dragRef.current = { kind: "anchor", idx };
    try { (e.target as Element).setPointerCapture(e.pointerId); } catch { /* synthetic */ }
  };

  const onHandleDown = (idx: number, side: "hIn" | "hOut") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = { kind: "handle", idx, side };
    try { (e.target as Element).setPointerCapture(e.pointerId); } catch { /* synthetic */ }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const pt = toPct(e);
    const next = points.map((p) => ({ ...p, hIn: p.hIn && { ...p.hIn }, hOut: p.hOut && { ...p.hOut } }));
    if (d.kind === "anchor") {
      next[d.idx] = { ...next[d.idx], x: pt.x, y: pt.y };
      write(next, true, "Path point");
    } else {
      const anchor = next[d.idx];
      const rel = { x: Number((pt.x - anchor.x).toFixed(2)), y: Number((pt.y - anchor.y).toFixed(2)) };
      anchor[d.side] = rel;
      // 대칭 미러 (부드러운 점) — Alt 로 분리
      const other = d.side === "hIn" ? "hOut" : "hIn";
      if (!altRef.current && anchor[other]) anchor[other] = { x: -rel.x, y: -rel.y };
      write(next, true, "Path handle");
    }
  };

  const onPointerUp = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    // 커밋은 "지금" doc 의 점으로 — 렌더 시점 closure 의 points 를 쓰면 같은
    // 틱에 move->up 이 이어질 때 드래그 이전 값으로 되돌린다 (stale closure).
    const now = doc && path ? (getElement(useEditor.getState().doc!, path) as { motionPath?: { points?: PathPoint[] }; layout?: { points?: PathPoint[] } } | null) : null;
    const cur = useLayout ? now?.layout?.points : now?.motionPath?.points;
    if (cur) write(cur.map((p) => ({ ...p })), false, "Path edit");
  };

  // 선분 더블클릭 -> 점 추가 (클릭 지점에 가장 가까운 t 를 샘플링으로 탐색)
  const onSegmentDblClick = (segIdx: number) => (e: React.MouseEvent) => {
    e.stopPropagation();
    const pt = toPct(e);
    const a = points[segIdx];
    const b = points[(segIdx + 1) % points.length];
    let bestT = 0.5;
    let bestD = Infinity;
    for (let t = 0.05; t <= 0.95; t += 0.025) {
      const c = cubicAt(a, b, t);
      const dd = (c.x - pt.x) ** 2 + (c.y - pt.y) ** 2;
      if (dd < bestD) { bestD = dd; bestT = t; }
    }
    const { a: na, mid, b: nb } = splitSegment(a, b, bestT);
    const next = points.map((p) => ({ ...p }));
    next[segIdx] = na;
    next[(segIdx + 1) % points.length] = nb;
    next.splice(segIdx + 1, 0, mid);
    write(next, false, "Add path point");
    setActiveAnchor(segIdx + 1);
  };

  const onAnchorDblClick = (idx: number) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (points.length <= 2) return;
    const next = points.filter((_, i) => i !== idx);
    write(next, false, "Delete path point");
    setActiveAnchor(null);
  };

  const d = pointsToD(points, closed);
  const segCount = closed ? points.length : points.length - 1;

  return (
    <svg
      ref={rootRef}
      className={s.pathOverlay}
      viewBox={`0 0 ${COMP_W} ${COMP_H}`}
      preserveAspectRatio="none"
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <g transform={`translate(${((origin.x / 100) * COMP_W).toFixed(2)}, ${((origin.y / 100) * COMP_H).toFixed(2)})`}>
      {/* 경로 본체 — 표시용 (viewBox 가 comp px, 좌표는 % -> comp px 로 변환) */}
      <path
        d={d.replace(/(-?\d+\.?\d*) (-?\d+\.?\d*)/g, (_, x, y) => `${(Number(x) / 100) * COMP_W} ${(Number(y) / 100) * COMP_H}`)}
        className={s.pathCurve}
      />
      {/* 히트 영역 (두껍고 투명) — 선분 더블클릭으로 점 추가 */}
      {Array.from({ length: segCount }, (_, i) => {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        const segD = pointsToD([a, b]).replace(/(-?\d+\.?\d*) (-?\d+\.?\d*)/g, (_, x, y) => `${(Number(x) / 100) * COMP_W} ${(Number(y) / 100) * COMP_H}`);
        return <path key={`seg-${i}`} d={segD} className={s.pathHit} onDoubleClick={onSegmentDblClick(i)} />;
      })}
      {/* 활성 앵커 핸들 */}
      {activeAnchor != null && points[activeAnchor] && (["hIn", "hOut"] as const).map((side) => {
        const a = points[activeAnchor];
        const h = a[side];
        if (!h) return null;
        const ap = { x: (a.x / 100) * COMP_W, y: (a.y / 100) * COMP_H };
        const hp = { x: ((a.x + h.x) / 100) * COMP_W, y: ((a.y + h.y) / 100) * COMP_H };
        return (
          <g key={side}>
            <line x1={ap.x} y1={ap.y} x2={hp.x} y2={hp.y} className={s.pathHandleLine} />
            <rect
              x={hp.x - 8} y={hp.y - 8} width={16} height={16}
              className={s.pathHandle}
              onPointerDown={onHandleDown(activeAnchor, side)}
            />
          </g>
        );
      })}
      {/* 앵커들 */}
      {points.map((p, i) => {
        const pp = { x: (p.x / 100) * COMP_W, y: (p.y / 100) * COMP_H };
        return (
          <circle
            key={i}
            cx={pp.x} cy={pp.y} r={10}
            className={i === activeAnchor ? s.pathAnchorActive : s.pathAnchor}
            onPointerDown={onAnchorDown(i)}
            onDoubleClick={onAnchorDblClick(i)}
          />
        );
      })}
      </g>
    </svg>
  );
}
