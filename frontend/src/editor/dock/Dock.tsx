"use client";

// Dock — Figma식 하단 플로팅 툴바. 그룹 드롭다운(선택=Move/Hand, 도형=사각형/타원/선).
// 근거: Figma UI3 툴바 리서치(Move/Hand/Scale, Shape variants). 우리 도구에 맞게 구성.

import { createPortal } from "react-dom";
import React from "react";
import { useEditor } from "@/editor/store";
import {
  addTextElement,
  addShapeElement,
  addLogoElement,
  duplicateElements,
  splitElementAtPlayhead,
  trimElementTo,
  addShaderElement,
  addDeviceElement,
  addChromeFrame,
  addStatCounter,
  addTitleReveal,
} from "@/editor/mutations";
import { getPlayer } from "@/editor/playerBridge";
import { sceneStarts } from "@/editor/timing";
import { parsePath } from "@/editor/specPath";
import { pickAndInsertMedia } from "@/editor/imageInsert";
import { FPS } from "@/engine/normalize";
import { Player, type PlayerRef } from "@remotion/player";
import { Ad, type VideoSpec, type SceneElementSpec } from "@engine/motion/SceneRenderer";
import {
  titleRevealElementSpec,
  statCounterElementSpec,
  glowInputElementSpec,
  glowCardElementSpec,
  glowMenuElementSpec,
  addGlowInput,
  addGlowCard,
  addGlowMenu,
  splitSceneAt,
  mergeScenes,
} from "@/editor/mutations";
import { frameToScene } from "@/editor/timing";
import s from "./dock.module.css";

type ShapeKind = "rectangle" | "ellipse" | "line";

export default function Dock() {
  const [mockupOpen, setMockupOpen] = React.useState(false);
  const tool = useEditor((st) => st.ui.tool);
  const setUI = useEditor((st) => st.setUI);
  const activeScene = useEditor((st) => st.activeScene);
  const selection = useEditor((st) => st.selection);
  const sceneMultiSel = useEditor((st) => st.ui.sceneMultiSel);
  const doc = useEditor((st) => st.doc);
  const hasDoc = doc !== null;
  const [shapeKind, setShapeKind] = React.useState<ShapeKind>("rectangle");
  const [open, setOpen] = React.useState<null | "select" | "shape">(null);

  // 컷 편집 — 선택 클립을 재생헤드(그 씬의 로컬 프레임) 기준으로 조작.
  const sel0 = selection[0];
  const canCut = selection.length > 0;
  const cutFrame = (path: string) => {
    const gf = getPlayer()?.getCurrentFrame() ?? 0;
    const si = parsePath(path).sceneIdx;
    const starts = doc ? sceneStarts(doc, FPS) : [];
    return Math.round(gf - (starts[si] ?? 0));
  };

  React.useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-dockgroup]")) setOpen(null);
    };
    setTimeout(() => window.addEventListener("mousedown", h), 0);
    return () => window.removeEventListener("mousedown", h);
  }, [open]);

  if (!hasDoc) return null;

  const shapeIcon = (k: ShapeKind) =>
    k === "ellipse" ? <circle cx="8" cy="8" r="4.5" stroke="currentColor" strokeWidth="1.3" fill="none" />
    : k === "line" ? <path d="M3 11L13 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    : <rect x="3" y="4" width="10" height="8" rx="2" stroke="currentColor" strokeWidth="1.3" fill="none" />;

  return (
    <div className={s.dock}>
      {/* 선택/손 그룹 */}
      <div className={s.group} data-dockgroup>
        <ToolBtn active={tool === "select" || tool === "hand"} onClick={() => setUI({ tool: "select" })} title="Select (V)">
          {tool === "hand" ? (
            <svg width="16" height="16" viewBox="0 0 16 16"><path d="M5 7V4a1 1 0 012 0v3M7 6.5V3.5a1 1 0 012 0V7M9 6.5V4.5a1 1 0 012 0V9c0 2.2-1.3 4-3.5 4S4 11 4 9V7.5a1 1 0 012 0" stroke="currentColor" strokeWidth="1.1" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16"><path d="M4 3l8 4.5-3.5 1 2 3.5-1.5.8-2-3.5L4 12V3z" fill="currentColor" /></svg>
          )}
        </ToolBtn>
        <Chevron onClick={() => setOpen(open === "select" ? null : "select")} />
        {open === "select" && (
          <div className={s.menu}>
            <MenuItem label="Select" hint="V" active={tool === "select"} onClick={() => { setUI({ tool: "select" }); setOpen(null); }} />
            <MenuItem label="Hand (Pan)" hint="H" active={tool === "hand"} onClick={() => { setUI({ tool: "hand" }); setOpen(null); }} />
          </div>
        )}
      </div>

      <span className={s.sep} />

      {/* Frame 툴 (Figma F) — 누르면 십자 커서, 캔버스 드래그로 frame 생성 */}
      <ToolBtn active={tool === "frame"} onClick={() => setUI({ tool: tool === "frame" ? "select" : "frame" })} title="Frame (F)">
        <svg width="16" height="16" viewBox="0 0 16 16">
          <path d="M5 2v12M11 2v12M2 5h12M2 11h12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </ToolBtn>

      <ToolBtn
        onClick={() => {
          const p = addTextElement(activeScene);
          // 생성 즉시 인라인 편집 (T 단축키와 동일)
          if (p) window.dispatchEvent(new CustomEvent("scene24:edit-text", { detail: { path: p } }));
        }}
        title="Add text (T)"
      >
        <svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 4h10M8 4v9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </ToolBtn>

      {/* 도형 그룹 */}
      <div className={s.group} data-dockgroup>
        <ToolBtn onClick={() => addShapeElement(activeScene, shapeKind)} title="Add shape (R)">
          <svg width="16" height="16" viewBox="0 0 16 16">{shapeIcon(shapeKind)}</svg>
        </ToolBtn>
        <Chevron onClick={() => setOpen(open === "shape" ? null : "shape")} />
        {open === "shape" && (
          <div className={s.menu}>
            <MenuItem label="Rectangle" hint="R" icon={<svg width="14" height="14" viewBox="0 0 16 16"><rect x="3" y="4" width="10" height="8" rx="2" stroke="currentColor" strokeWidth="1.3" fill="none" /></svg>} active={shapeKind === "rectangle"} onClick={() => { setShapeKind("rectangle"); addShapeElement(activeScene, "rectangle"); setOpen(null); }} />
            <MenuItem label="Ellipse / Circle" hint="O" icon={<svg width="14" height="14" viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.5" stroke="currentColor" strokeWidth="1.3" fill="none" /></svg>} active={shapeKind === "ellipse"} onClick={() => { setShapeKind("ellipse"); addShapeElement(activeScene, "ellipse"); setOpen(null); }} />
            <MenuItem label="Line" hint="L" icon={<svg width="14" height="14" viewBox="0 0 16 16"><path d="M3 11L13 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>} active={shapeKind === "line"} onClick={() => { setShapeKind("line"); addShapeElement(activeScene, "line"); setOpen(null); }} />
          </div>
        )}
      </div>

      {/* Insert — 외부 에셋 삽입 통합 (미디어/목업/배경/로고). 한 단계 섹션 그리드. */}
      <ToolBtn onClick={() => setMockupOpen(true)} title="Insert asset (media / mockup / background / logo)">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="2" y="2" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
          <rect x="9" y="2" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
          <rect x="2" y="9" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
          <path d="M11.5 9.5v4M9.5 11.5h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </ToolBtn>
      {mockupOpen && <MockupPicker activeScene={activeScene} onClose={() => setMockupOpen(false)} />}

      {/* 컷 편집 그룹 — 세로 구분선 뒤. 선택 클립을 재생헤드 기준 트림/자르기/복제. */}
      <span className={s.sep} />
      <ToolBtn onClick={() => sel0 && trimElementTo(sel0, "start", cutFrame(sel0))} disabled={!canCut} title="Trim in to playhead ([)">
        <svg width="16" height="16" viewBox="0 0 16 16"><path d="M4.5 3v10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><path d="M14 8H7M9.5 5.5 7 8l2.5 2.5" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </ToolBtn>
      <ToolBtn onClick={() => sel0 && splitElementAtPlayhead(sel0, cutFrame(sel0))} disabled={!canCut} title="Split at playhead (S)">
        <svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 2.5v11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><path d="M3.5 5 8 8M3.5 11 8 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
      </ToolBtn>
      <ToolBtn onClick={() => sel0 && trimElementTo(sel0, "end", cutFrame(sel0))} disabled={!canCut} title="Trim out to playhead (])">
        <svg width="16" height="16" viewBox="0 0 16 16"><path d="M11.5 3v10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><path d="M2 8h7M6.5 5.5 9 8l-2.5 2.5" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </ToolBtn>
      <ToolBtn onClick={() => canCut && duplicateElements(selection)} disabled={!canCut} title="Duplicate (⌘D)">
        <svg width="16" height="16" viewBox="0 0 16 16"><rect x="3" y="5.5" width="6.5" height="6.5" rx="1.2" stroke="currentColor" strokeWidth="1.2" fill="none" /><path d="M6.5 5.5V4.2A1.2 1.2 0 0 1 7.7 3h5A1.2 1.2 0 0 1 13.9 4.2v5A1.2 1.2 0 0 1 12.7 10.4h-1.2" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" /></svg>
      </ToolBtn>

      {/* 씬 편집 그룹 — 재생헤드 씬 분할 / 스트립 shift-선택 씬 병합 */}
      <span className={s.sep} />
      <ToolBtn
        onClick={() => {
          const st = useEditor.getState();
          if (!st.doc) return;
          const gf = Math.round(getPlayer()?.getCurrentFrame() ?? 0);
          const cur = frameToScene(st.doc, FPS, gf);
          splitSceneAt(cur.sceneIdx, cur.localFrame);
        }}
        title="Split scene at playhead (⇧S)"
      >
        <svg width="16" height="16" viewBox="0 0 16 16"><rect x="1.5" y="4" width="13" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill="none" /><path d="M8 2v12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeDasharray="2 1.6" /></svg>
      </ToolBtn>
      <ToolBtn
        onClick={() => mergeScenes(useEditor.getState().ui.sceneMultiSel)}
        disabled={sceneMultiSel.length < 2}
        title={sceneMultiSel.length >= 2 ? `Merge ${sceneMultiSel.length} scenes` : "Merge scenes — shift-click scenes in the strip first"}
      >
        <svg width="16" height="16" viewBox="0 0 16 16"><rect x="1.5" y="4" width="5.5" height="8" rx="1.2" stroke="currentColor" strokeWidth="1.2" fill="none" /><rect x="9" y="4" width="5.5" height="8" rx="1.2" stroke="currentColor" strokeWidth="1.2" fill="none" /><path d="M6 8h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </ToolBtn>
    </div>
  );
}

function ToolBtn({ active, disabled, onClick, title, children }: { active?: boolean; disabled?: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button className={s.tool} data-active={active} disabled={disabled} onClick={onClick} title={title}>
      {children}
    </button>
  );
}

function Chevron({ onClick }: { onClick: () => void }) {
  return (
    <button className={s.chevron} onClick={onClick} aria-label="Variants">
      <svg width="8" height="8" viewBox="0 0 10 10"><path d="M2.5 4l2.5 2.5L7.5 4" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
  );
}

function MenuItem({ label, hint, icon, active, onClick }: { label: string; hint?: string; icon?: React.ReactNode; active?: boolean; onClick: () => void }) {
  return (
    <button className={s.menuItem} data-active={active} onClick={onClick}>
      <span className={s.menuCheck}>{active ? "✓" : ""}</span>
      {icon && <span className={s.menuIcon}>{icon}</span>}
      <span className={s.menuLabel}>{label}</span>
      {hint && <span className={s.menuHint}>{hint}</span>}
    </button>
  );
}

// Mockup picker - dock-anchored popover with LIVE previews:
// 3D cards render the actual glTF models (slow auto-rotation), 2D cards
// render the real chrome overlays. Extensible list for future mockups.
import { Canvas, useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import { ChromeOverlay } from "@engine/motion/chrome";

const PREVIEWS: Record<string, { glb: string; scale: number; y: number; camZ: number }> = {
  iphone15: { glb: "iphone15.glb", scale: 12.5, y: -0.05, camZ: 6.2 },
  // 회전 대각선이 캔버스 안에 들도록 여유 (실측: 9/6.6 은 코너에서 잘림)
  macbook: { glb: "mbp14.glb", scale: 6.8, y: -0.62, camZ: 7.8 },
};

function SpinModel({ kind }: { kind: "iphone15" | "macbook" }) {
  const cfg = PREVIEWS[kind];
  const gltf = useGLTF(`/models/${cfg.glb}`, "/draco/");
  const ref = React.useRef<{ rotation: { y: number } } | null>(null);
  const cloned = React.useMemo(() => gltf.scene.clone(true), [gltf.scene]);
  useFrame((_, dt) => {
    if (ref.current) ref.current.rotation.y += dt * 0.7;
  });
  return (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <group ref={ref as any}>
      <primitive object={cloned} scale={cfg.scale} position={[0, cfg.y, 0]} />
    </group>
  );
}

// 프리셋 hover 프리뷰 — 타일에 마우스 올리면 실제 프리셋 요소를 미니 플레이어
// 로 루프 재생 (LayerStack 이펙트 hover 프리뷰와 같은 문법: 같은 렌더 경로 =
// 삽입 결과와 동일). rAF 직접 시킹 — 브라우저 autoplay 정책과 무관하게 돈다.
const PresetAd: React.FC<{ spec: VideoSpec }> = ({ spec }) => <Ad spec={spec} />;

function PresetHoverPreview({ build, dur, children }: { build: () => VideoSpec; dur: number; children: React.ReactNode }) {
  const [hover, setHover] = React.useState(false);
  const spec = React.useMemo(() => (hover ? build() : null), [hover, build]);
  const playerRef = React.useRef<PlayerRef>(null);
  React.useEffect(() => {
    if (!spec) return;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      playerRef.current?.seekTo(Math.floor(((now - start) / 1000) * 24) % dur);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [spec, dur]);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ width: "100%", height: "100%", display: "grid", placeItems: "center" }}
    >
      {spec ? (
        <Player
          ref={playerRef}
          component={PresetAd}
          inputProps={{ spec }}
          durationInFrames={dur}
          fps={24}
          compositionWidth={1920}
          compositionHeight={1080}
          style={{ width: 116, height: 65, borderRadius: 8, pointerEvents: "none" }}
        />
      ) : (
        children
      )}
    </div>
  );
}

// 프리셋 미니 스펙 — 삽입 mutation 과 같은 빌더 사용 (결과와 동일 보장)
const titlePreviewSpec = (): VideoSpec => ({
  fps: 24,
  scenes: [{ id: "pv", duration: 2.4, background: { fill: "#0B0D12" }, elements: [titleRevealElementSpec(0)] } as VideoSpec["scenes"][number]],
});
const statPreviewSpec = (): VideoSpec => ({
  fps: 24,
  scenes: [{ id: "pv", duration: 2.9, background: { fill: "#0B0D12" }, elements: [statCounterElementSpec("#FFFFFF", "#9AA3B2", 0)] } as VideoSpec["scenes"][number]],
});
// UI 프리셋 프리뷰 — 삽입 빌더 재사용하되 116px 썸네일에서 읽히게 크기만 키움.
// 지오메트리는 base 에 산다 (에디터 표준) — base 는 얕은 병합.
const uiPreview = (el: SceneElementSpec, over: Record<string, unknown>, dur: number): VideoSpec => {
  const rec = el as unknown as Record<string, unknown>;
  const base = { ...(rec.base as Record<string, unknown> | undefined), ...(over.base as Record<string, unknown> | undefined) };
  return {
    fps: 24,
    scenes: [
      {
        id: "pv",
        duration: dur,
        background: { fill: "#08060D" },
        elements: [{ ...rec, ...over, base } as unknown as SceneElementSpec],
      } as VideoSpec["scenes"][number],
    ],
  };
};
const glowInputPreviewSpec = (): VideoSpec =>
  uiPreview(glowInputElementSpec(0), { base: { width: 72, height: 10 }, radius: 5, fontSize: 3.1, paddingLeft: 5, borderWidth: 5, charsPerSecond: 11, text: "Create a landing page" }, 4.6);
// 분해형 glow card (frame 구조) — 썸네일에서 읽히게 균일 스케일만 키움
const glowCardPreviewSpec = (): VideoSpec =>
  uiPreview(glowCardElementSpec(0, 120), { base: { scale: 1.85, position: { x: 0.5, y: 0.5 } } }, 5);
const glowMenuPreviewSpec = (): VideoSpec =>
  uiPreview(glowMenuElementSpec(0), { height: 7.5, fontSize: 2.4, radius: 2.6, gap: 0.9 }, 6.7);

function DevicePreview({ kind }: { kind: "iphone15" | "macbook" }) {
  return (
    <Canvas camera={{ position: [0, 0.5, PREVIEWS[kind].camZ], fov: 26 }} gl={{ alpha: true, antialias: true }} style={{ width: "100%", height: "100%" }}>
      <ambientLight intensity={1.2} />
      <directionalLight position={[3, 5, 6]} intensity={2.4} />
      <directionalLight position={[-4, 2, 3]} intensity={0.8} />
      <React.Suspense fallback={null}>
        <SpinModel kind={kind} />
      </React.Suspense>
    </Canvas>
  );
}

function ChromePreview({ kind }: { kind: "browser" | "phone" }) {
  // 실물 비율로 크게 렌더한 뒤 축소 — 작은 캔버스에 직접 그리면 크롬 최소치
  // (바 26px 등) 가 거대해져 비율이 무너진다 (실측: 신호등/URL 이 화면 절반).
  const vw = kind === "browser" ? 420 : 150;
  const vh = kind === "browser" ? 280 : 310;
  const s = kind === "browser" ? 0.25 : 0.26;
  return (
    <div style={{ width: vw * s, height: vh * s, overflow: "hidden", borderRadius: 6 }}>
      <div style={{ position: "relative", width: vw, height: vh, background: "var(--bg-elevated)", borderRadius: kind === "phone" ? 34 : 10, transform: `scale(${s})`, transformOrigin: "0 0", overflow: "hidden" }}>
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(160deg, rgba(255,255,255,0.05) 0%, transparent 70%)" }} />
        <ChromeOverlay chrome={{ kind, theme: "dark" }} wPx={vw} hPx={vh} />
      </div>
    </div>
  );
}

function MockupPicker({ activeScene, onClose }: { activeScene: number; onClose: () => void }) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // 바깥 클릭: 캡처 단계 전역 리스너 — 독/캔버스가 이벤트를 삼켜도 닫힌다
    const onDown = (e: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [onClose]);
  const pick = (fn: () => void) => {
    fn();
    onClose();
  };
  // 에디터 디자인 토큰만 사용 (globals.css 무채색 시스템) — 틴트/외곽선 카드 금지.
  // 타일은 호버 fill 로만 구분 (Linear/Figma 에셋 패널 문법), 프리뷰는 inset 썸네일.
  const card: React.CSSProperties = {
    width: 126,
    borderRadius: 10,
    padding: "8px 8px 10px",
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 8,
    color: "var(--text-2)",
    fontSize: 12,
  };
  const prev: React.CSSProperties = { width: 110, height: 82, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-inset)", borderRadius: 8, overflow: "hidden" };
  const label: React.CSSProperties = { color: "var(--text-4)", fontSize: 11, fontWeight: 550, letterSpacing: "0.03em", textTransform: "uppercase", margin: "2px 0 6px" };
  // 독 조상에 transform 이 있어 fixed 가 뷰포트 기준이 아니게 된다(containing
  // block 규칙, 실측: 중앙 지정에도 하단 표시) — body 포털로 탈출.
  return createPortal(
    <>
      <style>{`
        @keyframes mockupPop { from { opacity: 0; transform: translate(-50%, -48%) scale(0.98); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
        @keyframes mockupFade { from { opacity: 0; } to { opacity: 1; } }
        .insert-tile { background: transparent; transition: background 90ms ease; }
        .insert-tile:hover { background: var(--bg-hover); }
      `}</style>
      <div style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(0,0,0,0.45)", animation: "mockupFade 140ms ease-out" }} onPointerDown={onClose} />
      <div
        ref={panelRef}
        style={{
          position: "fixed",
          left: "50%",
          top: "50%",
          zIndex: 301,
          transform: "translate(-50%, -50%)",
          animation: "mockupPop 160ms cubic-bezier(0.2, 0.9, 0.3, 1)",
          background: "var(--bg-panel)",
          border: "1px solid rgba(255,255,255,0.07)",
          borderRadius: 12,
          padding: "16px 18px 18px",
          boxShadow: "0 24px 80px rgba(0,0,0,0.55)",
          maxHeight: "calc(100vh - 120px)",
          overflowY: "auto",
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{ color: "var(--text-1)", fontSize: 13, fontWeight: 600 }}>Insert</div>
          <button onClick={onClose} aria-label="Close" style={{ background: "none", border: "none", color: "var(--text-4)", cursor: "pointer", fontSize: 14, padding: 2 }}>
            <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
        </div>
        <div style={label}>Media</div>
        <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
          <div className="insert-tile" style={{ ...card, width: "100%", boxSizing: "border-box", flexDirection: "row", justifyContent: "flex-start", gap: 12, padding: "10px 10px" }} onClick={() => pick(() => void pickAndInsertMedia(activeScene))}>
            <div style={{ width: 40, height: 40, borderRadius: 8, background: "var(--bg-inset)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-3)", flex: "none" }}>
              <svg width="18" height="18" viewBox="0 0 26 26" fill="none">
                <rect x="2" y="4" width="22" height="18" rx="3" stroke="currentColor" strokeWidth="1.6" />
                <circle cx="9" cy="10.5" r="2.1" fill="currentColor" opacity="0.85" />
                <path d="M4 19l6-5.5 4.5 4 3.5-3 4 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "flex-start" }}>
              <span style={{ color: "var(--text-1)", fontWeight: 600 }}>Image / Video</span>
              <span style={{ color: "var(--text-4)", fontSize: 11 }}>Upload a file - or paste with Cmd V</span>
            </div>
          </div>
        </div>
        <div style={label}>Mockups - 3D glTF devices / 2D chrome frames</div>
        <div style={{ display: "flex", gap: 10 }}>
          <div className="insert-tile" style={card} onClick={() => pick(() => addDeviceElement(activeScene, "iphone15"))}>
            <div style={prev}><DevicePreview kind="iphone15" /></div>
            iPhone 15 Pro
          </div>
          <div className="insert-tile" style={card} onClick={() => pick(() => addDeviceElement(activeScene, "macbook"))}>
            <div style={prev}><DevicePreview kind="macbook" /></div>
            MacBook Pro 14
          </div>
          <div className="insert-tile" style={card} onClick={() => pick(() => addChromeFrame(activeScene, "browser"))}>
            <div style={prev}><ChromePreview kind="browser" /></div>
            Browser window
          </div>
          <div className="insert-tile" style={card} onClick={() => pick(() => addChromeFrame(activeScene, "phone"))}>
            <div style={prev}><ChromePreview kind="phone" /></div>
            Phone bezel
          </div>
        </div>
        <div style={{ ...label, marginTop: 14 }}>Background and brand</div>
        <div style={{ display: "flex", gap: 10 }}>
          <div className="insert-tile" style={card} onClick={() => pick(() => addShaderElement(activeScene))}>
            <div style={prev}>
              <style>{`@keyframes insertGrad { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }`}</style>
              <div style={{ width: 116, height: 78, borderRadius: 8, background: "linear-gradient(120deg, #0B0E1A, #31226E, #7C4DFF, #52C5FF)", backgroundSize: "300% 300%", animation: "insertGrad 5s ease-in-out infinite" }} />
            </div>
            Living gradient
          </div>
          <div className="insert-tile" style={card} onClick={() => pick(() => addLogoElement(activeScene))}>
            <div style={prev}>
              <svg width="46" height="46" viewBox="0 0 46 46" fill="none">
                <path d="M23 6v34M8.3 14.5l29.4 17M8.3 31.5l29.4-17" stroke="var(--text-2)" strokeWidth="3.4" strokeLinecap="round" />
              </svg>
            </div>
            Logo
          </div>
        </div>

        {/* 프리셋 — 범용 레이어 효과가 아닌 조립형/튜닝형 프리셋. 카테고리별
            서브그룹 (지금은 Text — UI/데이터 등 카테고리 추가 여지). */}
        <div style={{ ...label, marginTop: 14 }}>Presets · Text</div>
        <div style={{ display: "flex", gap: 10 }}>
          <div className="insert-tile" style={card} onClick={() => pick(() => addTitleReveal(activeScene))}>
            <div style={prev}>
              <PresetHoverPreview build={titlePreviewSpec} dur={58}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
                  <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text-1)" }}>Build</span>
                  <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text-2)", filter: "blur(1.5px)" }}>SaaS</span>
                  <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text-3)", filter: "blur(3px)" }}>Promo</span>
                </div>
              </PresetHoverPreview>
            </div>
            Title reveal
          </div>
          <div className="insert-tile" style={card} onClick={() => pick(() => addStatCounter(activeScene))}>
            <div style={prev}>
              <PresetHoverPreview build={statPreviewSpec} dur={70}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                  <span style={{ fontSize: 30, fontWeight: 650, color: "var(--text-1)", letterSpacing: "-0.02em" }}>+55</span>
                  <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-3)" }}>ATMs</span>
                </div>
              </PresetHoverPreview>
            </div>
            Stat counter
          </div>
        </div>

        {/* UI 프리셋 — 웹 UI 트렌드의 프레임 기반 포팅 (엔진 uiPresets/neon_pill).
            정지 목업은 CSS 로만, 호버 시 실제 엔진 렌더가 재생된다. */}
        <div style={{ ...label, marginTop: 14 }}>Presets · UI</div>
        <div style={{ display: "flex", gap: 10 }}>
          <div className="insert-tile" style={card} onClick={() => pick(() => addGlowInput(activeScene))}>
            <div style={prev}>
              <PresetHoverPreview build={glowInputPreviewSpec} dur={110}>
                <div style={{ width: 86, height: 24, borderRadius: 12, boxShadow: "inset 0 0 0 1px rgba(148,112,232,0.35)", position: "relative" }}>
                  <div style={{ position: "absolute", top: -1, left: 34, width: 46, height: 2, borderRadius: 2, background: "linear-gradient(90deg, transparent, #D9BAFF 60%, transparent)", filter: "blur(0.4px)" }} />
                  <span style={{ position: "absolute", left: 10, top: 5, fontSize: 9, color: "var(--text-3)" }}>Ask AI</span>
                  <div style={{ position: "absolute", left: 46, top: 7, width: 1.5, height: 10, background: "#C9A0FF" }} />
                </div>
              </PresetHoverPreview>
            </div>
            Glow input
          </div>
          <div className="insert-tile" style={card} onClick={() => pick(() => addGlowCard(activeScene))}>
            <div style={prev}>
              <PresetHoverPreview build={glowCardPreviewSpec} dur={130}>
                <div style={{ width: 58, height: 46, borderRadius: 8, boxShadow: "inset 0 0 0 1px rgba(148,112,232,0.3)", position: "relative", background: "rgba(255,255,255,0.02)", padding: 7, display: "flex", flexDirection: "column", justifyContent: "space-between", boxSizing: "border-box" }}>
                  <div style={{ position: "absolute", top: -1, left: 10, width: 30, height: 2, borderRadius: 2, background: "linear-gradient(90deg, transparent, #D9BAFF 55%, transparent)" }} />
                  <div style={{ width: 11, height: 11, borderRadius: 3, boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.18)" }} />
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <div style={{ width: 26, height: 3, borderRadius: 2, background: "var(--text-3)" }} />
                    <div style={{ width: 40, height: 3, borderRadius: 2, background: "var(--bg-hover)" }} />
                  </div>
                </div>
              </PresetHoverPreview>
            </div>
            Glow card
          </div>
          <div className="insert-tile" style={card} onClick={() => pick(() => addGlowMenu(activeScene))}>
            <div style={prev}>
              <PresetHoverPreview build={glowMenuPreviewSpec} dur={160}>
                <div style={{ display: "flex", gap: 5, padding: "6px 8px", borderRadius: 10, boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.1)", alignItems: "center" }}>
                  {[0, 1, 2].map((i) => (
                    <div key={i} style={{ width: 17, height: 9, borderRadius: 5, background: i === 1 ? "radial-gradient(circle, rgba(168,85,247,0.6), rgba(168,85,247,0.14))" : "var(--bg-hover)" }} />
                  ))}
                </div>
              </PresetHoverPreview>
            </div>
            Glow menu
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
