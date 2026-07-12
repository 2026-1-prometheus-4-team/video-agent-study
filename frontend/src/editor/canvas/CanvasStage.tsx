"use client";

// CanvasStage — 중앙 스테이지. fit/줌/팬 뷰포트 안에 PlayerCanvas + SelectionOverlay.
// cmd/ctrl+wheel 로 커서 기준 줌, space/middle 드래그로 팬, 빈 곳 클릭은 오버레이가
// 처리(선택 해제).

import React from "react";
import { useEditor } from "@/editor/store";
import { PlayerCanvas, COMP_W, COMP_H } from "./PlayerCanvas";
import { SelectionOverlay } from "./SelectionOverlay";
import { MotionPathOverlay } from "./MotionPathOverlay";
import { RefVideo } from "@/editor/reference/RefVideo";
import { RefControls } from "@/editor/reference/RefControls";
import { applyCameraDelta } from "@/editor/camera";
import { sceneStarts } from "@/editor/timing";
import { getPlayer } from "@/editor/playerBridge";
import { FPS } from "@/engine/normalize";
import ref from "@/editor/reference/reference.module.css";
import s from "./canvas.module.css";

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 4;

export default function CanvasStage() {
  const doc = useEditor((st) => st.doc);
  const canvasZoom = useEditor((st) => st.ui.canvasZoom);
  const tool = useEditor((st) => st.ui.tool);
  const refOverlay = useEditor((st) => st.ui.refOverlay);
  const cameraManip = useEditor((st) => st.ui.cameraManip);
  const activeScene = useEditor((st) => st.activeScene);
  const setUI = useEditor((st) => st.setUI);

  const stageRef = React.useRef<HTMLDivElement>(null);
  const [fitScale, setFitScale] = React.useState(0.4);
  const [pan, setPan] = React.useState({ x: 0, y: 0 });
  const [spaceDown, setSpaceDown] = React.useState(false);
  const [zoomMenu, setZoomMenu] = React.useState(false);

  const scale = canvasZoom === "fit" ? fitScale : canvasZoom;

  // fit 계산 (좌우 분할이면 두 컴포지션 폭을 담아야 하므로 가로를 2배로 나눔)
  const sideMode = !!refOverlay.video && refOverlay.mode === "side";
  React.useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const compute = () => {
      const r = el.getBoundingClientRect();
      const wDivisor = sideMode ? 2 * COMP_W + 12 : COMP_W;
      const fit = Math.min((r.width - 96) / wDivisor, (r.height - 96) / COMP_H);
      setFitScale(Math.max(MIN_ZOOM, Math.min(1, fit)));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sideMode]);

  // fit 모드로 돌아가면 팬 리셋
  React.useEffect(() => {
    if (canvasZoom === "fit") setPan({ x: 0, y: 0 });
  }, [canvasZoom]);

  // space 팬 토글 (인풋 타이핑 중 제외)
  React.useEffect(() => {
    const isTyping = () => {
      const a = document.activeElement;
      return (
        a instanceof HTMLElement &&
        (a.tagName === "INPUT" ||
          a.tagName === "TEXTAREA" ||
          a.isContentEditable)
      );
    };
    const kd = (e: KeyboardEvent) => {
      if (e.code === "Space" && !isTyping()) setSpaceDown(true);
    };
    const ku = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceDown(false);
    };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    return () => {
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
    };
  }, []);

  // 휠은 네이티브 non-passive 로 등록 — React onWheel 은 passive 라 preventDefault 가
  // "Unable to preventDefault inside passive event listener" 를 도배한다.
  const onWheel = (e: WheelEvent) => {
    // 카메라 조작 모드: 일반 휠 = 카메라 줌(플레이헤드에 자동 키). cmd+휠은 여전히 뷰 줌.
    if (cameraManip && !(e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const d = doc;
      if (!d) return;
      const st = sceneStarts(d, FPS)[activeScene] ?? 0;
      const local = Math.max(0, Math.round((getPlayer()?.getCurrentFrame() ?? 0) - st));
      applyCameraDelta(activeScene, local, { dScale: -e.deltaY * 0.002 }, false);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const el = stageRef.current!;
      const r = el.getBoundingClientRect();
      // 커서 기준 줌: 커서 아래 지점이 고정되도록 pan 보정
      const cx = e.clientX - r.left - r.width / 2 - pan.x;
      const cy = e.clientY - r.top - r.height / 2 - pan.y;
      const cur = scale;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cur * factor));
      const ratio = next / cur;
      setPan({
        x: pan.x - cx * (ratio - 1),
        y: pan.y - cy * (ratio - 1),
      });
      setUI({ canvasZoom: next });
    } else {
      // 팬 (줌됐을 때)
      setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
    }
  };
  // 최신 클로저를 ref 로 유지 + 마운트 시 한 번만 non-passive 등록.
  const onWheelRef = React.useRef(onWheel);
  onWheelRef.current = onWheel;
  React.useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const h = (e: WheelEvent) => onWheelRef.current(e);
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, []);

  // 팬 드래그 (space 또는 middle 버튼)
  const panRef = React.useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    const panning = spaceDown || tool === "hand" || e.button === 1;
    if (!panning) return;
    e.preventDefault();
    panRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = panRef.current;
    if (!d) return;
    setPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (panRef.current) {
      panRef.current = null;
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    }
  };

  const cursor = spaceDown || tool === "hand" ? (panRef.current ? "grabbing" : "grab") : "default";

  const zoomPct = canvasZoom === "fit" ? "Fit" : `${Math.round(scale * 100)}%`;

  return (
    <div
      ref={stageRef}
      className={s.stage}
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {doc ? (
        <div
          className={s.stageInner}
          style={{ transform: `translate(${pan.x}px, ${pan.y}px)`, display: "flex", gap: refOverlay.video && refOverlay.mode === "side" ? 12 : 0, flexDirection: refOverlay.side === "left" ? "row-reverse" : "row" }}
        >
          <div
            className={s.playerWrap}
            style={{ width: COMP_W * scale, height: COMP_H * scale }}
          >
            <PlayerCanvas scale={scale} />
            <SelectionOverlay />
            <MotionPathOverlay />
            {/* 오버레이 모드: 레퍼런스를 플레이어 위에 겹침 (숨김이면 렌더 안 함) */}
            {refOverlay.video && refOverlay.visible && refOverlay.mode === "overlay" && (
              <RefVideo
                url={`/reference/${refOverlay.video}`}
                startFrame={refOverlay.startFrame}
                endFrame={refOverlay.endFrame}
                className={ref.overlayVideo}
                style={{ opacity: refOverlay.opacity }}
              />
            )}
          </div>
          {/* 좌우 분할 모드 (숨김이면 렌더 안 함) */}
          {refOverlay.video && refOverlay.visible && refOverlay.mode === "side" && (
            <div className={ref.sideBox} style={{ width: COMP_W * scale, height: COMP_H * scale }}>
              <span className={ref.sideLabel}>Reference</span>
              <RefVideo
                url={`/reference/${refOverlay.video}`}
                startFrame={refOverlay.startFrame}
                endFrame={refOverlay.endFrame}
                className={ref.sideVideo}
              />
            </div>
          )}
        </div>
      ) : (
        <div className={s.empty}>
          <div className={s.emptyIcon}>
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
              <rect
                x="6"
                y="10"
                width="28"
                height="20"
                rx="2"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path d="M16 20l5 3-5 3v-6z" fill="currentColor" />
            </svg>
          </div>
          <div>Open a spec from the list on the left, or create a new document</div>
        </div>
      )}

      {/* 레퍼런스 컨트롤 바 */}
      {doc && <RefControls />}

      {/* 줌 리드아웃 칩 */}
      {doc && (
        <div className={s.zoomChip}>
          <button
            className={s.zoomBtn}
            onClick={() => setZoomMenu((v) => !v)}
            onBlur={() => setTimeout(() => setZoomMenu(false), 150)}
          >
            <span className="tnum">{zoomPct}</span>
          </button>
          {zoomMenu && (
            <div className={s.zoomMenu}>
              {(["fit", 0.5, 1, 2] as const).map((z) => (
                <button
                  key={String(z)}
                  className={s.zoomItem}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setUI({ canvasZoom: z });
                    setZoomMenu(false);
                  }}
                >
                  {z === "fit" ? "Fit" : `${z * 100}%`}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
