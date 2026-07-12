"use client";

// EasingEditorModal — 우측 앵커 플로팅 패널(전체 모달 아님 — 캔버스 계속 보임).
// named 이징 갤러리(엔진 EASING 그대로) + 커스텀 cubic-bezier 편집 + 라이브 프리뷰.

import { uiPrompt } from "@/editor/ui/dialogs";
import React from "react";
import { useEditor } from "@/editor/store";
import {
  EASING_NAMES,
  resolveEasing,
  sampleEasing,
  yRange,
  pointsToPath,
  parseCubicValue,
  fitBezier,
} from "@/editor/curveSample";
import { bezierEasing } from "@engine/motion/core/easing";
import {
  useCustomEasings,
  addCustomEasing,
  deleteCustomEasing,
  matchCustomName,
  type CustomEasing,
} from "@/editor/customEasings";
import { getElement } from "@/editor/specPath";
import { setByPath, getByPath } from "@/editor/setByPath";
import { atomFallbackKnobs, displayNameForLayer } from "@/editor/schema";
import { Select } from "@/editor/controls";
import type { EasingEditorTarget } from "@/editor/store";
import type { VideoSpec } from "@engine/motion/SceneRenderer";
import type { MotionLayer } from "@engine/motion/core/timing";
import s from "./easing.module.css";

// 현재 이징 값 → 편집 핸들의 초기 cubic. cubic(...) 이면 그대로 파싱, named 이징
// ("easeOut" 등)이면 fitBezier 로 그 곡선에 근사 → 모달 열 때 현재 이징에서 시작.
// (bounce/elastic 처럼 단일 cubic 으로 표현 안 되는 건 최선 근사; 실제 곡선은
//  BezierEditor 의 점선 레퍼런스로 별도 표시됨.)
function cubicForValue(value: string | undefined): [number, number, number, number] {
  const parsed = parseCubicValue(value);
  if (parsed) return parsed;
  if (value) {
    try {
      return fitBezier(resolveEasing(value));
    } catch {
      /* 근사 불가 → 아래 기본값 */
    }
  }
  return [0.33, 0.33, 0.67, 0.67];
}

// 선택된 요소 하나에서 편집 가능한 이징들을 모은다(레이어 이징 + 로고 램프 이징).
type EasingTargetOpt = { label: string; target: EasingEditorTarget };
const LOGO_RAMPS: [string, string][] = [
  ["fadeIn", "Fade in"], ["scaleIn", "Scale in"], ["fadeOut", "Fade out"], ["scaleOut", "Scale out"], ["slideOut", "Slide out"],
];
function collectEasingTargets(doc: VideoSpec | null, path: string | undefined): EasingTargetOpt[] {
  if (!doc || !path) return [];
  const el = getElement(doc, path);
  if (!el) return [];
  const out: EasingTargetOpt[] = [];
  if (el.element === "text" || el.element === "shape" || el.element === "group") {
    const layers: MotionLayer[] = (el as { layers?: MotionLayer[] }).layers ?? [];
    layers.forEach((layer, i) => {
      for (const k of atomFallbackKnobs(layer.type)) {
        if (k.kind !== "easing") continue;
        const v = getByPath(layer, k.path);
        out.push({
          label: `${displayNameForLayer(layer.type, layer.role ?? "in")} · ${k.label}`,
          target: { path, layerIdx: i, propPath: k.path, value: typeof v === "string" ? v : undefined },
        });
      }
    });
  }
  if (el.element === "logo") {
    for (const [key, label] of LOGO_RAMPS) {
      const ramp = (el as Record<string, unknown>)[key] as Record<string, unknown> | undefined;
      if (ramp) out.push({ label: `${label} · Easing`, target: { path, propPath: `${key}.easing`, value: typeof ramp.easing === "string" ? (ramp.easing as string) : undefined } });
    }
  }
  return out;
}

export default function EasingEditorModal() {
  const explicit = useEditor((st) => st.ui.easingEditor);
  const doc = useEditor((st) => st.doc);
  const selection = useEditor((st) => st.selection);
  const setUI = useEditor((st) => st.setUI);
  const close = React.useCallback(() => setUI({ easingEditor: null }), [setUI]);

  // 명시적 타겟(칩에서 열림) 여부
  const hasExplicit = (!!explicit?.path && !!explicit?.propPath) || !!explicit?.cameraKf || !!explicit?.elementKf;

  // 탐색 모드: 선택된 단일 요소의 이징 목록에서 적용 대상을 고를 수 있게
  const opts = React.useMemo(
    () => (selection.length === 1 ? collectEasingTargets(doc, selection[0]) : []),
    [doc, selection],
  );
  const [pickIdx, setPickIdx] = React.useState(0);
  React.useEffect(() => { setPickIdx(0); }, [selection[0]]);

  // 실제 편집 대상: 명시적 타겟 우선, 아니면 선택된 요소의 pickIdx 이징
  const target: EasingEditorTarget | null = hasExplicit
    ? explicit
    : opts.length > 0
      ? opts[Math.min(pickIdx, opts.length - 1)].target
      : null;
  const hasTarget = !!target;
  const value = target?.value ?? explicit?.value;

  // 현재 값 → 편집 핸들 초기 위치. cubic(...) 이면 그대로, named 이징이면 그 곡선에
  // fitBezier 로 맞춘다(직선 폴백 금지) → 모달 열자마자 현재 이징에서 시작.
  const [bez, setBez] = React.useState<[number, number, number, number]>(() => cubicForValue(value));

  React.useEffect(() => {
    setBez(cubicForValue(value));
  }, [value]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const applyValue = React.useCallback(
    (v: string) => {
      if (!target) return;
      // 카메라 키프레임 세그먼트 이징
      if (target.cameraKf) {
        const { sceneIdx, kfIndex } = target.cameraKf;
        useEditor.getState().updateDoc("Camera easing", (draft) => {
          const cam = draft.scenes[sceneIdx]?.camera;
          if (cam?.type === "keyframes" && cam.keyframes[kfIndex]) cam.keyframes[kfIndex].easing = v;
        });
        if (hasExplicit) setUI({ easingEditor: { ...target, value: v } });
        return;
      }
      // 요소 속성 키프레임 세그먼트 이징 (들어오는 구간 = 이 키의 easing)
      if (target.elementKf) {
        const { path, kfIndex } = target.elementKf;
        useEditor.getState().updateDoc("Keyframe easing", (draft) => {
          const el = getElement(draft, path);
          const kfs = (el as { keyframes?: { easing?: string }[] } | null)?.keyframes;
          if (kfs && kfs[kfIndex]) kfs[kfIndex].easing = v;
        });
        if (hasExplicit) setUI({ easingEditor: { ...target, value: v } });
        return;
      }
      if (!target.path || !target.propPath) return;
      useEditor.getState().updateDoc("Easing", (draft) => {
        const el = getElement(draft, target.path!);
        if (!el) return;
        if (target.layerIdx != null) {
          // 레이어 props 내부 easing
          if (el.element === "logo") return;
          const layer = (el as { layers?: unknown[] }).layers?.[target.layerIdx];
          if (layer) setByPath(layer as Record<string, unknown>, target.propPath!, v);
        } else {
          // 요소 직속 prop 경로(예: 로고 램프 "fadeIn.easing")
          setByPath(el as unknown as Record<string, unknown>, target.propPath!, v);
        }
      });
      if (hasExplicit) setUI({ easingEditor: { ...target, value: v } });
    },
    [target, hasExplicit, setUI],
  );

  const customs = useCustomEasings();
  // 현재 값이 named 이면 그 이름, cubic 이면 등록된 커스텀 이름(있으면)
  const curName = parseCubicValue(value) ? matchCustomName(bez) : value ?? null;

  // 프리셋 카드 클릭: 커스텀 에디터에 그 곡선을 로드(fit) + 적용
  const pickPreset = (name: string) => {
    setBez(fitBezier(resolveEasing(name)));
    if (hasTarget) applyValue(name);
  };
  // 커스텀 카드 클릭: 정확한 베지어 로드 + 적용
  const pickCustom = (ce: CustomEasing) => {
    setBez(ce.bezier);
    if (hasTarget) applyValue(`cubic(${ce.bezier.join(",")})`);
  };

  const applyCubic = async (save: boolean) => {
    const [a, b, c, d] = bez;
    const cubic = `cubic(${a.toFixed(3)},${b.toFixed(3)},${c.toFixed(3)},${d.toFixed(3)})`;
    if (save) {
      const name = await uiPrompt("Save custom easing", curName && !EASING_NAMES.includes(curName as never) ? curName : "myEase", { message: "Saved permanently to the easing library." });
      if (name) void addCustomEasing(name, [a, b, c, d]);
    }
    if (hasTarget) applyValue(cubic);
  };

  return (
    <div className={s.wrap}>
      <div className={s.backdrop} onClick={close} />
      <div className={s.panel} role="dialog" aria-label="Edit easing">
        <div className={s.header}>
          <div className={s.headerTitle}>
            Easing
            <span className={s.headerSub}>
              {hasExplicit
                ? (target?.cameraKf ? "Camera" : target?.elementKf ? `${target.elementKf.channel} keyframe` : (target?.propPath ?? "").split(".").pop())
                : hasTarget
                  ? "Apply to selection"
                  : "Browse mode"}
            </span>
          </div>
          <button className="icon-btn" onClick={close} aria-label="Close">
            <svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
          </button>
        </div>

        <div className={s.scroll}>
          {/* 탐색 모드: 어디에 적용할지 선택. 명시적 타겟(칩)으로 열었으면 안 보임. */}
          {!hasExplicit && (
            <div className={s.targetPick}>
              <div className={s.sectionLabel}>Apply to</div>
              {opts.length > 0 ? (
                <Select
                  value={String(Math.min(pickIdx, opts.length - 1))}
                  options={opts.map((o, i) => ({ value: String(i), label: o.label }))}
                  onChange={(v) => setPickIdx(Number(v))}
                />
              ) : (
                <div className={s.targetHint}>
                  Select a single element and its easings appear here to apply directly.<br />
                  Or expand a layer in the inspector and click the <b>easing curve chip</b>.
                </div>
              )}
            </div>
          )}

          <div className={s.customSection}>
            <div className={s.sectionLabel}>Custom curve</div>
            <BezierEditor bez={bez} onChange={setBez} value={value} />
            <div className={s.bezFields}>
              {(["x1", "y1", "x2", "y2"] as const).map((name, i) => (
                <div key={name} className={s.bezField}>
                  <span className={s.bezFieldLabel}>{name}</span>
                  <input
                    className={`${s.bezInput} tnum`}
                    type="number"
                    step={0.01}
                    value={bez[i]}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (!Number.isFinite(v)) return;
                      const next = [...bez] as [number, number, number, number];
                      next[i] = i % 2 === 0 ? Math.max(0, Math.min(1, v)) : v;
                      setBez(next);
                    }}
                  />
                </div>
              ))}
            </div>
            <PreviewStrip bez={bez} />
            <div className={s.customBtns}>
              {hasTarget && (
                <button className={s.applyBtn} onClick={() => applyCubic(false)}>
                  Apply
                </button>
              )}
              <button className={s.saveBtn} onClick={() => applyCubic(true)} title="Save to library with a name">
                Save as…
              </button>
            </div>
          </div>

          {/* 내 커스텀 이징 (영구 저장) */}
          {customs.length > 0 && (
            <>
              <div className={s.sectionLabel}>My custom easings</div>
              <div className={s.gallery}>
                {customs.map((ce) => (
                  <CustomCard
                    key={ce.name}
                    ce={ce}
                    current={curName === ce.name}
                    onPick={() => pickCustom(ce)}
                    onDelete={() => void deleteCustomEasing(ce.name)}
                  />
                ))}
              </div>
            </>
          )}

          <div className={s.sectionLabel}>Presets (engine-sampled)</div>
          <div className={s.gallery}>
            {EASING_NAMES.map((name) => (
              <EasingCard
                key={name}
                name={name}
                current={value === name}
                onPick={() => pickPreset(name)}
              />
            ))}
          </div>

          <div className={s.footnote}>
            Click a card to load it into the custom curve for editing. {hasTarget ? "Applying updates the target above. " : "Select an element to apply. "}
            <b>Save as…</b> registers it permanently under "My custom easings".
          </div>
        </div>
      </div>
    </div>
  );
}

function CustomCard({ ce, current, onPick, onDelete }: { ce: CustomEasing; current: boolean; onPick: () => void; onDelete: () => void }) {
  const pts = React.useMemo(() => sampleEasing(`cubic(${ce.bezier.join(",")})`, 48), [ce.bezier]);
  const { min, max } = yRange(pts);
  const path = pointsToPath(pts, 72, 52, 6, min, max);
  return (
    <div className={s.card} data-current={current} style={{ position: "relative" }}>
      <button style={{ display: "contents" }} onClick={onPick} title="Apply + load into custom">
        <svg width="72" height="52" viewBox="0 0 72 52" className={s.cardCurve}>
          <line x1="6" y1="46" x2="66" y2="46" stroke="var(--hairline)" strokeWidth="1" />
          <line x1="6" y1="6" x2="6" y2="46" stroke="var(--hairline)" strokeWidth="1" />
          <path d={path} stroke={current ? "var(--accent-strong)" : "var(--warn)"} strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className={`${s.cardName} mono`}>{ce.name}</span>
      </button>
      <button className={s.cardDelete} onClick={(e) => { e.stopPropagation(); onDelete(); }} title="Delete">
        <svg width="9" height="9" viewBox="0 0 10 10"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
      </button>
    </div>
  );
}

function EasingCard({
  name,
  current,
  onPick,
}: {
  name: string;
  current: boolean;
  onPick?: () => void;
}) {
  const [hover, setHover] = React.useState(false);
  const pts = React.useMemo(() => sampleEasing(name, 48), [name]);
  const { min, max } = yRange(pts);
  const path = pointsToPath(pts, 72, 52, 6, min, max);
  const fn = React.useMemo(() => resolveEasing(name), [name]);

  const [t, setT] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (!hover) {
      setT(null);
      return;
    }
    let raf = 0;
    let start = 0;
    const DUR = 700;
    const loop = (ts: number) => {
      if (!start) start = ts;
      setT(((ts - start) % DUR) / DUR);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [hover]);

  const span = max - min || 1;
  const dotY = t == null ? null : 52 - 6 - ((fn(t) - min) / span) * (52 - 12);
  const dotX = t == null ? null : 6 + t * (72 - 12);

  return (
    <button
      className={s.card}
      data-current={current}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onPick}
      disabled={!onPick}
      title={onPick ? "Apply" : name}
    >
      <svg width="72" height="52" viewBox="0 0 72 52" className={s.cardCurve}>
        <line x1="6" y1="46" x2="66" y2="46" stroke="var(--hairline)" strokeWidth="1" />
        <line x1="6" y1="6" x2="6" y2="46" stroke="var(--hairline)" strokeWidth="1" />
        <path d={path} stroke={current ? "var(--accent-strong)" : "var(--text-1)"} strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        {dotX != null && dotY != null && <circle cx={dotX} cy={dotY} r="3" fill="var(--accent-strong)" />}
      </svg>
      <span className={`${s.cardName} mono`}>{name}</span>
    </button>
  );
}

function BezierEditor({
  bez,
  onChange,
  value,
}: {
  bez: [number, number, number, number];
  onChange: (b: [number, number, number, number]) => void;
  value: string | undefined;
}) {
  const W = 264;
  const H = 200;
  const PAD = 24;
  const yMin = -0.4;
  const yMax = 1.4;
  const toPx = (x: number, y: number) => ({
    px: PAD + x * (W - 2 * PAD),
    py: H - PAD - ((y - yMin) / (yMax - yMin)) * (H - 2 * PAD),
  });
  const fromPx = (px: number, py: number) => ({
    x: (px - PAD) / (W - 2 * PAD),
    y: yMin + ((H - PAD - py) / (H - 2 * PAD)) * (yMax - yMin),
  });

  const svgRef = React.useRef<SVGSVGElement>(null);
  const dragging = React.useRef<0 | 1 | null>(null);

  const onDown = (idx: 0 | 1) => (e: React.PointerEvent) => {
    dragging.current = idx;
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (dragging.current == null || !svgRef.current) return;
    const r = svgRef.current.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const py = ((e.clientY - r.top) / r.height) * H;
    const { x, y } = fromPx(px, py);
    const next = [...bez] as [number, number, number, number];
    if (dragging.current === 0) {
      next[0] = Math.max(0, Math.min(1, x));
      next[1] = y;
    } else {
      next[2] = Math.max(0, Math.min(1, x));
      next[3] = y;
    }
    onChange(next);
  };
  const onUp = (e: React.PointerEvent) => {
    dragging.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  };

  const p0 = toPx(0, 0);
  const p1 = toPx(bez[0], bez[1]);
  const p2 = toPx(bez[2], bez[3]);
  const p3 = toPx(1, 1);
  const curvePath = `M${p0.px},${p0.py} C${p1.px},${p1.py} ${p2.px},${p2.py} ${p3.px},${p3.py}`;

  const namedPts = value && !value.startsWith("cubic(") ? sampleEasing(value, 48) : null;
  const namedPath = namedPts
    ? namedPts.map((p, i) => {
        const { px, py } = toPx(p.x, p.y);
        return `${i === 0 ? "M" : "L"}${px},${py}`;
      }).join(" ")
    : null;

  const y0 = toPx(0, 0).py;
  const y1line = toPx(0, 1).py;

  return (
    <svg ref={svgRef} className={s.bezSvg} viewBox={`0 0 ${W} ${H}`} onPointerMove={onMove} onPointerUp={onUp}>
      <line x1={PAD} y1={y0} x2={W - PAD} y2={y0} stroke="var(--hairline)" strokeWidth="1" strokeDasharray="3 3" />
      <line x1={PAD} y1={y1line} x2={W - PAD} y2={y1line} stroke="var(--hairline)" strokeWidth="1" strokeDasharray="3 3" />
      <rect x={PAD} y={y1line} width={W - 2 * PAD} height={y0 - y1line} fill="none" stroke="var(--hairline)" strokeWidth="1" />
      {namedPath && <path d={namedPath} stroke="var(--text-4)" strokeWidth="1" fill="none" strokeDasharray="2 2" />}
      <line x1={p0.px} y1={p0.py} x2={p1.px} y2={p1.py} stroke="var(--accent)" strokeWidth="1" opacity="0.5" />
      <line x1={p3.px} y1={p3.py} x2={p2.px} y2={p2.py} stroke="var(--accent)" strokeWidth="1" opacity="0.5" />
      <path d={curvePath} stroke="var(--accent-strong)" strokeWidth="1.8" fill="none" />
      <circle cx={p0.px} cy={p0.py} r="3" fill="var(--text-3)" />
      <circle cx={p3.px} cy={p3.py} r="3" fill="var(--text-3)" />
      <circle className={s.handle} cx={p1.px} cy={p1.py} r="6" onPointerDown={onDown(0)} />
      <circle className={s.handle} cx={p2.px} cy={p2.py} r="6" onPointerDown={onDown(1)} />
    </svg>
  );
}

function PreviewStrip({ bez }: { bez: [number, number, number, number] }) {
  const [dur, setDur] = React.useState(700);
  const [pos, setPos] = React.useState(0);
  const fn = React.useMemo(() => bezierEasing(bez[0], bez[1], bez[2], bez[3]), [bez]);

  React.useEffect(() => {
    let raf = 0;
    let start = 0;
    const loop = (ts: number) => {
      if (!start) start = ts;
      const t = ((ts - start) % dur) / dur;
      setPos(fn(t));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [fn, dur]);

  return (
    <div className={s.preview}>
      <div className={s.previewTrack}>
        <div className={s.previewDot} style={{ left: `${Math.max(0, Math.min(1, pos)) * 100}%`, transform: "translateX(-50%)" }} />
      </div>
      <div className={s.previewControls}>
        {[400, 700, 1200].map((d) => (
          <button key={d} className={s.durBtn} data-active={dur === d} onClick={() => setDur(d)}>
            {(d / 1000).toFixed(1)}s
          </button>
        ))}
      </div>
    </div>
  );
}
