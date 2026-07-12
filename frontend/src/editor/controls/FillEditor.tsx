"use client";

// FillEditor — Figma 팝오버 Custom 탭 본문 (fill 팝오버 해부와 1:1).
// 위 -> 아래: 페인트 타입 아이콘 행(Solid/Gradient/Image/Video/Noise + 블렌드
// 드롭릿) -> 타입별 본문. Solid 는 인라인 ColorPanel, Gradient 는 stop 핀 바 +
// Stops 리스트 + 선택 stop 의 ColorPanel. 페인트 opacity 는 알파 슬라이더/% 로 편집.

import React from "react";
import type { FillPaint, FillFit, FillBlend } from "@engine/motion/fill";
import { ColorPanel } from "./ColorPicker";
import { Segmented } from "./Segmented";
import { NumberInput } from "./NumberInput";
import { Select } from "./Select";
import { Row } from "./Section";
import { genGradient, parseGradient, isGradient, evenStops, type GradKind, type GradStop, type RadialGeom } from "@/editor/gradient";
import { useEditor } from "@/editor/store";
import s from "./fill.module.css";

type FillType = "solid" | "gradient" | "image" | "video" | "noise" | "aurora";

function fillType(fill: FillPaint | undefined): FillType {
  if (fill == null || fill === "") return "solid";
  if (typeof fill === "string") return isGradient(fill) ? "gradient" : "solid";
  return fill.type as FillType;
}

const FIT_OPTS: { value: FillFit; label: string }[] = [
  { value: "cover", label: "Fill" },
  { value: "contain", label: "Fit" },
  { value: "fill", label: "Stretch" },
];

const BLENDS: FillBlend[] = [
  "normal", "darken", "multiply", "color-burn", "lighten", "screen", "color-dodge",
  "overlay", "soft-light", "hard-light", "difference", "exclusion",
  "hue", "saturation", "color", "luminosity",
];

type Asset = { name: string; url: string; kind: "image" | "video" };
type RefVid = { name: string; url: string; rel: string };

// 문자열 페인트 -> 객체 (opacity/blend 를 실을 때만)
function toObject(p: FillPaint): Exclude<FillPaint, string> {
  if (typeof p !== "string") return p;
  return isGradient(p) ? { type: "gradient", css: p } : { type: "solid", color: p };
}

// ---- 페인트 타입 아이콘 (Figma 아이콘 행 재현) ----
function TypeIcon({ t }: { t: FillType }) {
  if (t === "solid")
    return (
      <svg width="15" height="15" viewBox="0 0 16 16">
        <rect x="2.5" y="2.5" width="11" height="11" rx="3" stroke="currentColor" strokeWidth="1.2" fill="none" />
        <rect x="5.5" y="5.5" width="5" height="5" rx="1" fill="currentColor" />
      </svg>
    );
  if (t === "gradient")
    return (
      <svg width="15" height="15" viewBox="0 0 16 16">
        <rect x="2.5" y="2.5" width="11" height="11" rx="3" stroke="currentColor" strokeWidth="1.2" fill="none" />
        {[
          [5.5, 5.5, 1], [8, 5.5, 0.75], [10.5, 5.5, 0.4],
          [5.5, 8, 0.75], [8, 8, 0.5], [10.5, 8, 0.28],
          [5.5, 10.5, 0.4], [8, 10.5, 0.28], [10.5, 10.5, 0.16],
        ].map(([cx, cy, o], i) => (
          <circle key={i} cx={cx} cy={cy} r="0.9" fill="currentColor" opacity={o} />
        ))}
      </svg>
    );
  if (t === "image")
    return (
      <svg width="15" height="15" viewBox="0 0 16 16">
        <rect x="2.5" y="2.5" width="11" height="11" rx="3" stroke="currentColor" strokeWidth="1.2" fill="none" />
        <circle cx="6" cy="6.2" r="1.2" fill="currentColor" />
        <path d="M4.5 12.5l3.2-3.6 2 2.1 1.6-1.7 2.2 3.2" stroke="currentColor" strokeWidth="1.1" fill="none" strokeLinejoin="round" />
      </svg>
    );
  if (t === "video")
    return (
      <svg width="15" height="15" viewBox="0 0 16 16">
        <rect x="2.5" y="2.5" width="11" height="11" rx="3" stroke="currentColor" strokeWidth="1.2" fill="none" />
        <path d="M6.5 5.6v4.8L10.8 8z" fill="currentColor" />
      </svg>
    );
  if (t === "noise")
    return (
      <svg width="15" height="15" viewBox="0 0 16 16">
        <rect x="2.5" y="2.5" width="11" height="11" rx="3" stroke="currentColor" strokeWidth="1.2" fill="none" />
        {[[5.2, 6.1], [7.4, 4.9], [9.8, 6.4], [6.2, 8.8], [8.6, 9.6], [10.6, 8.4], [5.4, 11], [9, 11.4]].map(([cx, cy], i) => (
          <circle key={i} cx={cx} cy={cy} r="0.7" fill="currentColor" />
        ))}
      </svg>
    );
  return (
    <svg width="15" height="15" viewBox="0 0 16 16">
      <rect x="2.5" y="2.5" width="11" height="11" rx="3" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <circle cx="6" cy="9.5" r="2.6" fill="currentColor" opacity="0.55" />
      <circle cx="9.5" cy="6.5" r="2.6" fill="currentColor" opacity="0.35" />
      <circle cx="8.6" cy="10" r="2.2" fill="currentColor" opacity="0.25" />
    </svg>
  );
}

export function FillEditor({
  fill,
  onChange,
}: {
  fill: FillPaint | undefined;
  onChange: (f: FillPaint | undefined) => void;
  /** @deprecated 팝오버 헤더/스택 행이 제거를 담당 — None 탭 없음 (Figma 구조) */
  allowNone?: boolean;
}) {
  const type = fillType(fill);
  const [blendOpen, setBlendOpen] = React.useState(false);
  // 오로라 페인트 시드용 브랜드 팔레트 — 셀렉터는 원본 참조만 반환
  // (셀렉터 안에서 새 배열을 만들면 zustand getSnapshot 무한 루프)
  const brandColorsRaw = useEditor((st) => (st.doc as { brandDefaults?: { colors?: string[] } } | null)?.brandDefaults?.colors);
  const brandColors = React.useMemo(() => (brandColorsRaw ?? []).filter((c) => /^#[0-9a-fA-F]{6}$/.test(c)), [brandColorsRaw]);

  const setType = (t: FillType) => {
    if (t === type) return;
    if (t === "solid") onChange(typeof fill === "string" && !isGradient(fill) ? fill : "#7C4DFF");
    else if (t === "gradient") onChange(isGradient(fill) ? (fill as string) : genGradient("linear", 90, evenStops(["#7C4DFF", "#FF4D9D"])));
    else if (t === "image") onChange({ type: "image", src: typeof fill === "object" && fill != null && "src" in fill ? fill.src : "", fit: "cover" });
    else if (t === "noise") onChange({ type: "noise", scale: 0.65, color: "#FFFFFF" });
    else if (t === "aurora") onChange({ type: "aurora", colors: brandColors.length > 0 ? brandColors.slice(0, 3) : ["#7C4DFF", "#52C5FF", "#FF4D9D"] });
    else onChange({ type: "video", src: typeof fill === "object" && fill != null && "src" in fill ? fill.src : "", fit: "cover", loop: true });
  };

  const blend: FillBlend = (typeof fill === "object" && fill != null ? fill.blend : undefined) ?? "normal";
  const setBlend = (b: FillBlend) => {
    const obj = toObject(fill ?? "#7C4DFF");
    if (b === "normal") {
      const { blend: _drop, ...rest } = obj;
      onChange(rest as FillPaint);
    } else onChange({ ...obj, blend: b });
    setBlendOpen(false);
  };

  const opacity = typeof fill === "object" && fill != null ? fill.opacity ?? 1 : 1;
  const setOpacity = (o: number) => onChange({ ...toObject(fill ?? "#7C4DFF"), opacity: o });

  const types: FillType[] = ["solid", "gradient", "image", "video", "noise", "aurora"];
  const titles: Record<FillType, string> = { solid: "Solid", gradient: "Gradient", image: "Image", video: "Video", noise: "Noise", aurora: "Aurora (drifting glow)" };

  return (
    <div className={s.fill}>
      {/* 페인트 타입 아이콘 행 + 블렌드 드롭릿 (Figma) */}
      <div className={s.typeRow}>
        <div className={s.typeIcons}>
          {types.map((t) => (
            <button key={t} className={s.typeBtn} data-active={type === t} title={titles[t]} onClick={() => setType(t)}>
              <TypeIcon t={t} />
            </button>
          ))}
        </div>
        <div className={s.typeRowRight}>
          <button
            className={s.typeBtn}
            data-active={blend !== "normal"}
            title={`Blend mode: ${blend}`}
            onClick={() => setBlendOpen(!blendOpen)}
          >
            <svg width="14" height="14" viewBox="0 0 16 16">
              <path d="M8 2.2S3.8 7 3.8 9.8a4.2 4.2 0 108.4 0C12.2 7 8 2.2 8 2.2z" stroke="currentColor" strokeWidth="1.2" fill={blend !== "normal" ? "currentColor" : "none"} strokeLinejoin="round" />
            </svg>
          </button>
          {blendOpen && (
            <div className={s.blendMenu}>
              {BLENDS.map((b) => (
                <button key={b} className={s.blendItem} data-active={blend === b} onClick={() => setBlend(b)}>
                  {b}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className={s.divider} />

      {type === "solid" && (
        <ColorPanel
          value={typeof fill === "string" ? fill : (fill as { color?: string })?.color ?? "#7C4DFF"}
          onChange={(v) => {
            if (typeof fill === "object" && fill != null && fill.type === "solid") onChange({ ...fill, color: v });
            else onChange(v);
          }}
          opacity={opacity}
          onOpacity={setOpacity}
        />
      )}

      {type === "gradient" && (
        <GradientFill
          css={typeof fill === "string" ? fill : (fill as { css?: string })?.css ?? ""}
          onChange={(css) => {
            if (typeof fill === "object" && fill != null && fill.type === "gradient") onChange({ ...fill, css });
            else onChange(css);
          }}
        />
      )}

      {type === "image" && <ImageFill fill={fill as Extract<FillPaint, { type: "image" }>} onChange={onChange} />}
      {type === "video" && <VideoFill fill={fill as Extract<FillPaint, { type: "video" }>} onChange={onChange} />}
      {type === "noise" && <NoiseFill fill={fill as Extract<FillPaint, { type: "noise" }>} onChange={onChange} />}
      {type === "aurora" && <AuroraFill fill={fill as Extract<FillPaint, { type: "aurora" }>} onChange={onChange} />}
    </div>
  );
}

// ---- Gradient (Figma: 컨트롤 행 / stop 핀 프리뷰 바 / Stops 리스트 / 선택 stop 컬러 패널) ----
function GradientFill({ css, onChange }: { css: string; onChange: (css: string) => void }) {
  const parsed = parseGradient(css);
  const kind: GradKind = parsed?.kind ?? "linear";
  const angle = parsed?.angle ?? 90;
  const stops: GradStop[] = parsed?.stops ?? evenStops(["#7C4DFF", "#FF4D9D"]);
  const radial = parsed?.radial; // 부분 방사형 기하 (없으면 중앙 꽉 참)
  const [selIdx, setSelIdx] = React.useState(0);
  const barRef = React.useRef<HTMLDivElement>(null);
  const sel = Math.min(selIdx, stops.length - 1);

  const write = (k: GradKind, a: number, st: GradStop[], geom?: RadialGeom) => onChange(genGradient(k, a, st, geom ?? radial));
  const patchGeom = (g: Partial<RadialGeom>) => write(kind, angle, stops, { x: 50, y: 50, r: 75, ...radial, ...g });
  const patchStop = (i: number, p: Partial<GradStop>) => write(kind, angle, stops.map((x, j) => (j === i ? { ...x, ...p } : x)));

  // 핀 드래그 — 위치(0..100) 이동. 클릭은 선택.
  const dragPin = (i: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    setSelIdx(i);
    const bar = barRef.current!;
    const move = (ev: { clientX: number }) => {
      const r = bar.getBoundingClientRect();
      const pos = Math.max(0, Math.min(100, ((ev.clientX - r.left) / r.width) * 100));
      patchStop(i, { pos: Math.round(pos * 10) / 10 });
    };
    const mv = (ev: PointerEvent) => move(ev);
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  // 바 클릭 = 그 위치에 stop 추가 (Figma)
  const addAt = (e: React.PointerEvent) => {
    const r = barRef.current!.getBoundingClientRect();
    const pos = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
    // 가장 가까운 stop 색으로 시작 (밋밋한 중간색 대신 이어 그리기 좋은 선택)
    const nearest = [...stops].sort((a, b) => Math.abs(a.pos - pos) - Math.abs(b.pos - pos))[0];
    const next = [...stops, { color: nearest?.color ?? "#FFFFFF", pos: Math.round(pos * 10) / 10 }];
    write(kind, angle, next);
    setSelIdx(next.length - 1);
  };

  const removeStop = (i: number) => {
    if (stops.length <= 2) return;
    write(kind, angle, stops.filter((_, j) => j !== i));
    setSelIdx(Math.max(0, sel - (i <= sel ? 1 : 0)));
  };

  return (
    <>
      {/* 컨트롤 행: 타입 + (linear) 각도 · 플립 / 90도 회전 */}
      <div className={s.gradCtl}>
        <div style={{ width: 92, flex: "none" }}>
          <Select
            value={kind}
            options={[{ value: "linear", label: "Linear" }, { value: "radial", label: "Radial" }]}
            onChange={(v) => write(v as GradKind, angle, stops)}
          />
        </div>
        {kind === "linear" && (
          <div style={{ width: 70, flex: "none" }}>
            <NumberInput value={angle} min={0} max={360} step={5} unit="°" onChange={(v) => write(kind, v, stops)} />
          </div>
        )}
        <span style={{ flex: 1 }} />
        <button
          className={s.gradBtn}
          title="Flip gradient"
          onClick={() => write(kind, angle, stops.map((st) => ({ ...st, pos: 100 - st.pos })))}
        >
          <svg width="14" height="14" viewBox="0 0 16 16"><path d="M5.5 4.5L2.5 7l3 2.5M10.5 6.5l3 2.5-3 2.5M2.5 7h8M5.5 9h8" stroke="currentColor" strokeWidth="1.1" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        {kind === "linear" && (
          <button className={s.gradBtn} title="Rotate 90°" onClick={() => write(kind, (angle + 90) % 360, stops)}>
            <svg width="14" height="14" viewBox="0 0 16 16"><path d="M13 8a5 5 0 11-1.8-3.8M13 2.8v2.4h-2.4" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        )}
      </div>
      {kind === "radial" && (
        <>
          {/* 부분 방사형 — 중심/크기. 기본(중앙 꽉 참)에서 조절하는 순간 기하가 명시된다 */}
          <Row label="Center X">
            <NumberInput value={radial?.x ?? 50} min={-20} max={120} step={1} unit="%" onChange={(v) => patchGeom({ x: v })} />
          </Row>
          <Row label="Center Y">
            <NumberInput value={radial?.y ?? 50} min={-20} max={120} step={1} unit="%" onChange={(v) => patchGeom({ y: v })} />
          </Row>
          <Row label="Size">
            <NumberInput value={radial?.r ?? 75} min={5} max={150} step={1} unit="%" onChange={(v) => patchGeom({ r: v })} />
          </Row>
        </>
      )}

      {/* stop 핀 + 프리뷰 바 — 핀은 바 위에 얹힌 사각 스와치 (Figma) */}
      <div className={s.gradPinArea}>
        <div className={s.gradPins}>
          {stops.map((st, i) => (
            <button
              key={i}
              className={s.gradPin}
              data-active={i === sel}
              style={{ left: `${st.pos}%` }}
              onPointerDown={dragPin(i)}
              title={`${st.color} · ${Math.round(st.pos)}%`}
            >
              <span className={s.gradPinSwatch} style={{ background: st.color }} />
            </button>
          ))}
        </div>
        <div
          ref={barRef}
          className={s.previewBar}
          style={{ background: genGradient("linear", 90, stops), cursor: "copy" }}
          onPointerDown={addAt}
        />
      </div>

      {/* Stops 리스트 */}
      <div className={s.stopsHead}>
        <span>Stops</span>
        <button
          className={s.fillStackAddSmall}
          title="Add stop"
          onClick={() => {
            const next = [...stops, { color: stops[stops.length - 1]?.color ?? "#FFFFFF", pos: 50 }];
            write(kind, angle, next);
            setSelIdx(next.length - 1);
          }}
        >
          +
        </button>
      </div>
      <div className={s.stops}>
        {stops.map((st, i) => (
          <div key={i} className={s.stopRow} data-active={i === sel} onPointerDown={() => setSelIdx(i)}>
            <input
              className={s.stopPos}
              value={Math.round(st.pos)}
              inputMode="numeric"
              onChange={(e) => {
                const n = Math.max(0, Math.min(100, parseInt(e.target.value.replace(/\D/g, "") || "0", 10)));
                patchStop(i, { pos: n });
              }}
              aria-label="Stop position %"
            />
            <span className={s.stopPct}>%</span>
            <span className={s.stopSwatch} style={{ background: st.color }} />
            <span className={s.stopHex}>{st.color.replace("#", "")}</span>
            <button className={s.stopRemove} disabled={stops.length <= 2} onClick={() => removeStop(i)} title="Remove stop">
              −
            </button>
          </div>
        ))}
      </div>
      <div className={s.divider} />

      {/* 선택 stop 색 편집 — solid 와 동일한 인라인 패널 */}
      <ColorPanel key={sel} value={stops[sel]?.color ?? "#FFFFFF"} onChange={(v) => patchStop(sel, { color: v })} />
    </>
  );
}

// ---- Image ----
function ImageFill({ fill, onChange }: { fill: Extract<FillPaint, { type: "image" }>; onChange: (f: FillPaint) => void }) {
  const patch = (p: Partial<Extract<FillPaint, { type: "image" }>>) => onChange({ ...fill, ...p });
  return (
    <>
      <Row label="Mode">
        <Segmented<FillFit> value={fill.fit ?? "cover"} options={FIT_OPTS} onChange={(v) => patch({ fit: v })} />
      </Row>
      {fill.src ? (
        <div className={s.imgPreview} style={{ backgroundImage: `url(${fill.src})`, backgroundSize: fill.fit === "fill" ? "100% 100%" : fill.fit ?? "cover", backgroundPosition: `${(fill.posX ?? 0.5) * 100}% ${(fill.posY ?? 0.5) * 100}%` }} />
      ) : (
        <div className={s.emptyPreview}>No image</div>
      )}
      <AssetSource kind="image" onPick={(url) => patch({ src: url })} />
      <Row label="Reframe X"><NumberInput value={fill.posX ?? 0.5} min={0} max={1} step={0.01} displayScale={100} unit="%" onChange={(v) => patch({ posX: v })} /></Row>
      <Row label="Reframe Y"><NumberInput value={fill.posY ?? 0.5} min={0} max={1} step={0.01} displayScale={100} unit="%" onChange={(v) => patch({ posY: v })} /></Row>
    </>
  );
}

// ---- Video ----
function VideoFill({ fill, onChange }: { fill: Extract<FillPaint, { type: "video" }>; onChange: (f: FillPaint) => void }) {
  const patch = (p: Partial<Extract<FillPaint, { type: "video" }>>) => onChange({ ...fill, ...p });
  return (
    <>
      <Row label="Mode">
        <Segmented<FillFit> value={fill.fit ?? "cover"} options={FIT_OPTS} onChange={(v) => patch({ fit: v })} />
      </Row>
      {fill.src ? (
        <video className={s.vidPreview} src={fill.src} muted loop autoPlay playsInline style={{ objectFit: fill.fit === "fill" ? "fill" : fill.fit ?? "cover" }} />
      ) : (
        <div className={s.emptyPreview}>No video</div>
      )}
      <AssetSource kind="video" onPick={(url) => patch({ src: url })} showReference />
      <Row label="Trim start"><NumberInput value={fill.trimStart ?? 0} min={0} max={600} step={0.1} unit="s" onChange={(v) => patch({ trimStart: v })} /></Row>
      <Row label="Trim end"><NumberInput value={fill.trimEnd ?? 0} min={0} max={600} step={0.1} unit="s" onChange={(v) => patch({ trimEnd: v > 0 ? v : undefined })} /></Row>
    </>
  );
}

// ---- Noise ----
function NoiseFill({ fill, onChange }: { fill: Extract<FillPaint, { type: "noise" }>; onChange: (f: FillPaint) => void }) {
  const patch = (p: Partial<Extract<FillPaint, { type: "noise" }>>) => onChange({ ...fill, ...p });
  return (
    <>
      <Row label="Density"><NumberInput value={fill.scale ?? 0.65} min={0.1} max={1.5} step={0.05} onChange={(v) => patch({ scale: v })} /></Row>
      <div className={s.divider} />
      <ColorPanel value={fill.color ?? "#FFFFFF"} onChange={(v) => patch({ color: v })} docColors={false} />
    </>
  );
}

// ---- Aurora (드리프트 블롭 글로우) ----
function AuroraFill({ fill, onChange }: { fill: Extract<FillPaint, { type: "aurora" }>; onChange: (f: FillPaint) => void }) {
  const patch = (p: Partial<Extract<FillPaint, { type: "aurora" }>>) => onChange({ ...fill, ...p });
  const colors = fill.colors && fill.colors.length > 0 ? fill.colors : ["#7C4DFF", "#52C5FF", "#FF4D9D"];
  const [pick, setPick] = React.useState<number | null>(null);
  const setColor = (i: number, c: string) => patch({ colors: colors.map((x, j) => (j === i ? c : x)) });
  return (
    <>
      {/* 라이브 프리뷰 느낌의 정적 미리보기 */}
      <div
        className={s.previewBar}
        style={{
          height: 44,
          background: `radial-gradient(circle at 30% 75%, ${colors[0]}55, transparent 60%), radial-gradient(circle at 72% 30%, ${colors[1] ?? colors[0]}44, transparent 60%), radial-gradient(circle at 52% 60%, ${colors[2] ?? colors[0]}33, transparent 65%), #0b0d10`,
        }}
      />
      <Row label="Speed">
        <NumberInput value={fill.speed ?? 1} min={0} max={3} step={0.1} onChange={(v) => patch({ speed: v })} />
      </Row>
      <Row label="Spots">
        <NumberInput value={fill.spots ?? 3} min={1} max={6} step={1} onChange={(v) => patch({ spots: Math.round(v) })} />
      </Row>
      <Row label="Layout">
        <button
          className={s.uploadBtn}
          style={{ width: "100%" }}
          title="Shuffle spot placement (deterministic seed)"
          onClick={() => patch({ seed: Math.floor(Math.random() * 1e9) })}
        >
          Shuffle
        </button>
      </Row>
      <div className={s.stopsHead}>
        <span>Colors</span>
        {colors.length < 3 && (
          <button className={s.fillStackAddSmall} title="Add color" onClick={() => patch({ colors: [...colors, "#FF4D9D"] })}>
            +
          </button>
        )}
      </div>
      <div className={s.stops}>
        {colors.map((c, i) => (
          <div key={i} className={s.stopRow} data-active={i === pick} onPointerDown={() => setPick(i)}>
            <span className={s.stopSwatch} style={{ background: c }} />
            <span className={s.stopHex}>{c.replace("#", "").toUpperCase()}</span>
            <button
              className={s.stopRemove}
              disabled={colors.length <= 1}
              onClick={() => {
                patch({ colors: colors.filter((_, j) => j !== i) });
                setPick(null);
              }}
              title="Remove color"
            >
              −
            </button>
          </div>
        ))}
      </div>
      {pick != null && colors[pick] != null && (
        <>
          <div className={s.divider} />
          <ColorPanel key={pick} value={colors[pick]} onChange={(v) => setColor(pick, v)} docColors={false} />
        </>
      )}
      <div className={s.hint} style={{ fontSize: 11, color: "var(--text-4)", lineHeight: 1.5 }}>
        Drifting background glow. Speed 0 = static glow spots. Shuffle rolls a
        new deterministic placement (stored as a seed -- render-safe). Never on
        by default.
      </div>
    </>
  );
}

// ---- Asset source: URL + upload + browse (assets, and reference for video) ----
function AssetSource({ kind, onPick, showReference }: { kind: "image" | "video"; onPick: (url: string) => void; showReference?: boolean }) {
  const [url, setUrl] = React.useState("");
  const [assets, setAssets] = React.useState<Asset[]>([]);
  const [refs, setRefs] = React.useState<RefVid[]>([]);
  const [uploading, setUploading] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const loadAssets = React.useCallback(() => {
    fetch("/api/assets").then((r) => r.json()).then((d) => setAssets((d.assets ?? []).filter((a: Asset) => a.kind === kind))).catch(() => {});
  }, [kind]);
  React.useEffect(() => {
    loadAssets();
    if (showReference) fetch("/api/reference").then((r) => r.json()).then((d) => setRefs(d.videos ?? [])).catch(() => {});
  }, [loadAssets, showReference]);

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/assets", { method: "POST", body: fd });
      const d = await res.json();
      if (d.url) { onPick(d.url); loadAssets(); }
    } finally {
      setUploading(false);
    }
  };

  const thumbs = [
    ...assets.map((a) => ({ url: a.url, name: a.name, kind })),
    ...refs.map((r) => ({ url: r.url, name: r.name, kind: "video" as const })),
  ];

  return (
    <div className={s.source}>
      <div className={s.sourceRow}>
        <input className={s.urlInput} placeholder="Paste URL…" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && url.trim()) { onPick(url.trim()); setUrl(""); } }} />
        <button className={s.uploadBtn} disabled={uploading} onClick={() => fileRef.current?.click()}>{uploading ? "…" : "Upload"}</button>
        <input ref={fileRef} type="file" accept={kind === "image" ? "image/*" : "video/*"} style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
      </div>
      {thumbs.length > 0 && (
        <div className={s.thumbs}>
          {thumbs.slice(0, 24).map((t) => (
            <button key={t.url} className={s.thumb} title={t.name} onClick={() => onPick(t.url)}>
              {t.kind === "image" ? (
                <div style={{ backgroundImage: `url(${t.url})`, backgroundSize: "cover", backgroundPosition: "center", width: "100%", height: "100%" }} />
              ) : (
                <video src={t.url} muted preload="metadata" onLoadedMetadata={(e) => { e.currentTarget.currentTime = 0.5; }} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
