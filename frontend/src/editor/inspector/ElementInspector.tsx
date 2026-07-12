"use client";

// ElementInspector — 선택 요소 하나 편집 (text/logo/group).

import React from "react";
import { useEditor } from "@/editor/store";
import { Section, Row, NumberInput, ColorInput, Select, TextInput, Toggle, Segmented } from "@/editor/controls";
import { FillStack } from "@/editor/controls/FillStack";
import type { FillSpec } from "@engine/motion/fill";
import { FONT_OPTIONS, WEIGHT_OPTIONS, GLOW_KNOBS, MOTIONBLUR_KNOBS } from "@/editor/schema";
import { getByPath } from "@/editor/setByPath";
import { getElement, elementLabel, isGroup, parentPath, type ElementPath } from "@/editor/specPath";
import type { TextElementSpec } from "@engine/motion/ComposedText";
import type { LogoElementSpec } from "@engine/motion/ComposedLogo";
import type { ShapeElementSpec } from "@engine/motion/ComposedShape";
import type { GooeyElementSpec } from "@engine/motion/ComposedGooey";
import type { ImageElementSpec } from "@engine/motion/ComposedImage";
import type { VideoElementSpec } from "@engine/motion/ComposedVideo";
import type { ShaderElementSpec } from "@engine/motion/ComposedShader";
import type { FrameElementSpec, SceneElementSpec } from "@engine/motion/SceneRenderer";
import type { Curve3DSpec } from "@engine/motion/curve3d";
import { Curve3DSection } from "./Curve3DSection";
import { uploadAsset } from "@/editor/imageInsert";
import { EasingChip } from "@/editor/controls";
import { LayerStack } from "./LayerStack";
import { ColorEditor } from "./ColorEditor";
import { KnobField } from "./KnobField";
import { writeElementField, deleteElementField } from "./writes";
import { upsertChannelKey } from "@/editor/elementKeyframes";
import { getPlayer } from "@/editor/playerBridge";
import { sceneStarts } from "@/editor/timing";
import { FPS } from "@/engine/normalize";
import { presetToPoints } from "@engine/motion/pathLayout";
import { XYRow, RotationKfRow, ScaleKfRow, OpacityKfRow, BlurKfRow, Rot3DKfRow, PathProgressKfRow, DepthZKfRow, ElementKeyframeEditor } from "./KeyframeControls";
import { NeonPillBody, GlowCardBody, GlowMenuBody, EdgeLightBody } from "./PresetInspector";
import s from "./inspector.module.css";

// 요소 3D 자세 — 모든 요소 공통 (rotateX=위아래 기울기, rotateY=좌우 팬).
// 스톱워치 채널: armed 면 플레이헤드에 키, 아니면 base 정적값 편집.
function Rot3DRows({ path, el }: { path: ElementPath; el: unknown }) {
  return (
    <>
      <Rot3DKfRow el={el} path={path} axis="rotateX" />
      <Rot3DKfRow el={el} path={path} axis="rotateY" />
    </>
  );
}

// Transform — Figma 식 공통 섹션: Position / Rotation / 3D / Scale (전부 스톱워치 채널).
function TransformSection({ elementPath, el }: { elementPath: ElementPath; el: SceneElementSpec }) {
  const pos = ((el as { base?: { position?: { x: number; y: number } } }).base?.position) ?? { x: 0.5, y: 0.5 };
  const baseRotate = ((el as { base?: { rotate?: number } }).base?.rotate) ?? 0;
  return (
    <Section title="Transform">
      <XYRow el={el} path={elementPath} axis="x" pos={pos} />
      <XYRow el={el} path={elementPath} axis="y" pos={pos} />
      <RotationKfRow el={el} path={elementPath} baseRotate={baseRotate} />
      <Rot3DRows path={elementPath} el={el} />
      {/* 깊이 Z — 씬 space:"3d" 에서만 렌더에 반영 (AE 3D 레이어의 Position Z) */}
      <DepthZKfRow el={el} path={elementPath} />
      <ScaleKfRow el={el} path={elementPath} />
      {/* 압출(두께) — AE Geometry Options Extrusion Depth 등가. 3D 회전과 함께
          쓰면 옆면이 벽처럼 보인다. glow/모션블러와 동시 사용 시 브라우저 평탄화로
          무효 (구조적 한계). */}
      {/* 곡면(3D canvas) 컨테이너 안에서 평평하게 유지 — AE 의 굽힘 프리컴프 밖
          레이어 등가. 디바이스/영상/압출 텍스트는 기본 ON (슬라이스 복제 유해). */}
      <Row label="Flat in curve">
        <Toggle
          on={(el as { curveFlat?: boolean }).curveFlat ?? (el.element === "device" || el.element === "video" || (el.element === "text" && (((el as { base?: { extrude?: number } }).base?.extrude) ?? 0) > 0))}
          onChange={(v) => writeElementField(elementPath, "curveFlat", v, false, "Flat in curve")}
          aria-label="Flat in curve"
        />
      </Row>
      {(el.element === "text" || el.element === "shape" || el.element === "image" || el.element === "frame") && (
        <Row label="Extrude">
          <NumberInput
            value={((el as { base?: { extrude?: number } }).base?.extrude) ?? 0}
            min={0}
            max={80}
            step={1}
            unit="px"
            onChange={(v, o) => writeElementField(elementPath, "base.extrude", v > 0 ? Math.round(v) : undefined, o.live, "Extrude")}
          />
        </Row>
      )}
    </Section>
  );
}

// Stroke — Figma 식 (inside ring). shape/image/video/frame.
function StrokeSection({ elementPath, el }: { elementPath: ElementPath; el: SceneElementSpec }) {
  if (el.element !== "shape" && el.element !== "image" && el.element !== "video" && el.element !== "frame") return null;
  const b = el.base as { stroke?: string; strokeWidth?: number } | undefined;
  const on = typeof b?.stroke === "string";
  return (
    <Section title="Stroke" defaultOpen={on}>
      <Row label="Color">
        <ColorInput value={b?.stroke} clearable onChange={(v) => v ? writeElementField(elementPath, "base.stroke", v, false, "Stroke") : deleteElementField(elementPath, "base.stroke", "Stroke")} />
      </Row>
      {on && (
        <Row label="Weight">
          <NumberInput value={b?.strokeWidth ?? 2} min={0.5} max={40} step={0.5} unit="px" onChange={(v, o) => writeElementField(elementPath, "base.strokeWidth", v, o.live, "Stroke weight")} />
        </Row>
      )}
    </Section>
  );
}

export function ElementInspector({ elementPath }: { elementPath: ElementPath }) {
  const doc = useEditor((st) => st.doc);
  const el = doc ? getElement(doc, elementPath) : null;
  if (!el) return <div className={s.hint}>Selected element not found</div>;

  const kindGlyph =
    el.element === "group" ? "Group" : el.element === "logo" ? "Logo" : el.element === "shape" ? "Shape" : el.element === "gooey" ? "Gooey" : el.element === "image" ? "Image" : el.element === "video" ? "Video" : el.element === "frame" ? "Frame" : el.element === "shader" ? "Shader" : el.element === "device" ? "3D Device" : el.element === "neon_pill" ? "Glow input" : el.element === "glow_card" ? "Glow card" : el.element === "glow_menu" ? "Glow menu" : el.element === "edge_light" ? "Edge light" : "Text";

  return (
    <div className={s.body}>
      <div className={s.elHeader}>
        <span className={s.elKind}>{kindGlyph}</span>
        <TextInput
          value={el.id ?? ""}
          placeholder={elementLabel(el)}
          onChange={() => {}}
          onCommit={(v) => writeElementField(elementPath, "id", v || undefined, false, "Rename")}
        />
      </div>

      {el.element === "text" && <TextBody elementPath={elementPath} el={el} />}
      {el.element === "logo" && <LogoBody elementPath={elementPath} el={el} />}
      {el.element === "shape" && <ShapeBody elementPath={elementPath} el={el} />}
      {el.element === "gooey" && <GooeyBody elementPath={elementPath} el={el} />}
      {el.element === "image" && <ImageBody elementPath={elementPath} el={el} />}
      {el.element === "shader" && <ShaderBody elementPath={elementPath} el={el} />}
      {el.element === "device" && <DeviceBody elementPath={elementPath} el={el} />}
      {el.element === "video" && <VideoBody elementPath={elementPath} el={el} />}
      {el.element === "frame" && <FrameBody elementPath={elementPath} el={el} />}
      {el.element === "group" && <GroupBody elementPath={elementPath} el={el} />}
      {el.element === "neon_pill" && <NeonPillBody elementPath={elementPath} el={el} />}
      {el.element === "glow_card" && <GlowCardBody elementPath={elementPath} el={el} />}
      {el.element === "glow_menu" && <GlowMenuBody elementPath={elementPath} el={el} />}
      {el.element === "edge_light" && <EdgeLightBody elementPath={elementPath} el={el} />}

      {/* 부모가 배치(경로/궤도) 그룹인 자식: 배치 제외 고정(Pin) — 궤도 중앙 텍스트 등 */}
      <LayoutPinSection elementPath={elementPath} el={el} />

      {/* Motion path — 모든 요소 공통 (AE paste path to position 등가). */}
      <MotionPathSection elementPath={elementPath} el={el} />

      {/* Material — AE Material Options 등가. 씬 Light 가 켜져 있어야 반응. */}
      <MaterialSection elementPath={elementPath} el={el} />

      {/* 3D 커브드 캔버스 — 모든 요소 공통(그룹이면 자식 전체가 곡면 위). */}
      <Curve3DSection
        curve={(el as { curve3d?: Curve3DSpec }).curve3d}
        write={(f, v, live) => writeElementField(elementPath, `curve3d.${f}`, v, live, "3D canvas")}
        remove={() => deleteElementField(elementPath, "curve3d", "3D canvas")}
      />

      {/* 선택된 요소 키프레임 편집 패널 (그룹은 progress 채널) */}
      <ElementKeyframeEditor el={el} path={elementPath} />
    </div>
  );
}

function TextBody({ elementPath, el }: { elementPath: ElementPath; el: TextElementSpec }) {
  const glow = el.effects?.glow;
  const mb = el.effects?.motionBlur;

  return (
    <>
      <Section title="Content">
        <Row label="Text" wide>
          <TextInput
            value={el.base?.text ?? ""}
            onChange={(v) => writeElementField(elementPath, "base.text", v, true, "Text")}
            onCommit={(v) => writeElementField(elementPath, "base.text", v, false, "Text")}
          />
        </Row>
      </Section>

      <TransformSection elementPath={elementPath} el={el} />

      <Section title="Typography">
        <Row label="Size">
          <NumberInput value={el.base?.fontSize ?? 4} min={0.5} max={50} step={0.1} unit="vw" onChange={(v, o) => writeElementField(elementPath, "base.fontSize", v, o.live, "Font size")} />
        </Row>
        <Row label="Weight">
          <Select value={String(el.base?.fontWeight ?? 500)} options={WEIGHT_OPTIONS} onChange={(v) => writeElementField(elementPath, "base.fontWeight", Number(v), false, "Font weight")} />
        </Row>
        <Row label="Font">
          <Select value={el.base?.fontFamily ?? ""} options={[{ value: "", label: "Brand default" }, ...FONT_OPTIONS]} onChange={(v) => writeElementField(elementPath, "base.fontFamily", v || undefined, false, "Font")} />
        </Row>
        <Row label="Letter spacing">
          <NumberInput value={el.base?.letterSpacing ?? 0} min={-0.2} max={0.5} step={0.005} unit="em" onChange={(v, o) => writeElementField(elementPath, "base.letterSpacing", v, o.live, "Letter spacing")} />
        </Row>
      </Section>

      <AppearanceSection elementPath={elementPath} el={el} />

      <Section title="Fill">
        {/* Figma 식 통합 fill 스택 — 글리프 색. base.fill(없으면 base.color 시드). */}
        <FillStack
          fill={(el.base?.fill ?? el.base?.color) as FillSpec | undefined}
          label=""
          allowNone
          onChange={(f) => f == null ? deleteElementField(elementPath, "base.fill", "Fill") : writeElementField(elementPath, "base.fill", f, false, "Fill")}
        />
      </Section>

      <Section title="Color timeline" defaultOpen={false}>
        {/* 팔레트/흐르는 그라디언트(엔진 color.timeline) — fill 보다 우선 적용됨. */}
        <ColorEditor elementPath={elementPath} el={el} />
      </Section>

      <Section title="Layers" >
        <LayerStack elementPath={elementPath} />
      </Section>

      <Section title="Effects" defaultOpen={false}>
        <Row label="Glow">
          <Toggle on={glow?.enabled === true} onChange={(v) => writeElementField(elementPath, "effects.glow.enabled", v, false, "Glow")} aria-label="Glow" />
        </Row>
        {glow?.enabled && (
          <div className={s.effectKnobs}>
            {GLOW_KNOBS.map((k) => (
              <KnobField key={k.path} knob={k} value={getByPath(glow, k.path)} onChange={(v, o) => writeElementField(elementPath, `effects.glow.${k.path}`, v, o.live, k.label)} />
            ))}
          </div>
        )}
        <Row label="Motion blur">
          <Toggle on={mb?.enabled === true} onChange={(v) => writeElementField(elementPath, "effects.motionBlur.enabled", v, false, "Motion blur")} aria-label="Motion blur" />
        </Row>
        {mb?.enabled && (
          <div className={s.effectKnobs}>
            {MOTIONBLUR_KNOBS.map((k) => (
              <KnobField key={k.path} knob={k} value={getByPath(mb, k.path)} onChange={(v, o) => writeElementField(elementPath, `effects.motionBlur.${k.path}`, v, o.live, k.label)} />
            ))}
          </div>
        )}
      </Section>
    </>
  );
}

function LogoBody({ elementPath, el }: { elementPath: ElementPath; el: LogoElementSpec }) {
  const LOGO_KINDS = [
    { value: "scene24", label: "scene24 mark" },
    { value: "scene24-wordmark", label: "scene24 wordmark" },
    { value: "base44-sun", label: "base44 mark" },
    { value: "base44-wordmark", label: "base44 wordmark" },
  ];
  return (
    <>
      <Section title="Logo">
        <Row label="Type">
          <Select value={el.base?.kind ?? "scene24"} options={LOGO_KINDS} onChange={(v) => writeElementField(elementPath, "base.kind", v, false, "Logo type")} />
        </Row>
        <Row label="Size">
          <NumberInput value={el.base?.size ?? 8} min={1} max={40} step={0.5} unit="vw" onChange={(v, o) => writeElementField(elementPath, "base.size", v, o.live, "Logo size")} />
        </Row>
        <Row label="Blade color">
          <ColorInput value={el.base?.bladeColor} clearable onChange={(v) => v ? writeElementField(elementPath, "base.bladeColor", v, false, "Blade color") : deleteElementField(elementPath, "base.bladeColor", "Blade color")} />
        </Row>
        <Row label="Accent color">
          <ColorInput value={el.base?.accentColor} clearable onChange={(v) => v ? writeElementField(elementPath, "base.accentColor", v, false, "Accent color") : deleteElementField(elementPath, "base.accentColor", "Accent color")} />
        </Row>
      </Section>

      <TransformSection elementPath={elementPath} el={el} />

      <AppearanceSection elementPath={elementPath} el={el} />

      <Section title="In animation">
        <LogoRamp elementPath={elementPath} rampKey="fadeIn" label="Fade in" ramp={el.fadeIn} fields={["duration", "delay"]} defaults={{ duration: 12, delay: 0 }} defaultEasing="easeOut" />
        <LogoRamp elementPath={elementPath} rampKey="scaleIn" label="Scale in" ramp={el.scaleIn} fields={["from", "to", "duration", "delay"]} defaults={{ from: 0.8, to: 1, duration: 14, delay: 0 }} defaultEasing="easeOut" />
      </Section>

      <Section title="Out animation" defaultOpen={false}>
        <LogoRamp elementPath={elementPath} rampKey="fadeOut" label="Fade out" ramp={el.fadeOut} fields={["duration"]} defaults={{ duration: 10 }} defaultEasing="easeIn" />
        <LogoRamp elementPath={elementPath} rampKey="scaleOut" label="Scale out" ramp={el.scaleOut} fields={["from", "to", "duration"]} defaults={{ from: 1, to: 0.2, duration: 16 }} defaultEasing="easeIn" />
        <LogoRamp elementPath={elementPath} rampKey="slideOut" label="Slide out" ramp={el.slideOut} fields={["fromX", "toX", "duration"]} defaults={{ fromX: 0, toX: -0.4, duration: 12 }} defaultEasing="easeIn" />
      </Section>
    </>
  );
}

// 로고 램프(fadeIn/scaleIn/fadeOut/scaleOut/slideOut) 편집. 토글로 켜고 끄며,
// 켜면 default 객체 생성 / 끄면 삭제. from/to 는 스케일(x), fromX/toX 는 fraction.
function LogoRamp({
  elementPath,
  rampKey,
  label,
  ramp,
  fields,
  defaults,
  defaultEasing,
}: {
  elementPath: ElementPath;
  rampKey: string;
  label: string;
  ramp: Record<string, unknown> | undefined;
  fields: string[];
  defaults: Record<string, number>;
  defaultEasing: string;
}) {
  const on = ramp != null;
  const w = (field: string, v: number, live: boolean) =>
    writeElementField(elementPath, `${rampKey}.${field}`, v, live, label);

  const meta: Record<string, { lbl: string; min: number; max: number; step: number; unit?: "x" | "fraction" | "frames" }> = {
    from: { lbl: "From", min: 0, max: 3, step: 0.05, unit: "x" },
    to: { lbl: "To", min: 0, max: 3, step: 0.05, unit: "x" },
    fromX: { lbl: "X from", min: -1, max: 1, step: 0.01, unit: "fraction" },
    toX: { lbl: "X to", min: -1, max: 1, step: 0.01, unit: "fraction" },
    duration: { lbl: "Duration", min: 2, max: 60, step: 1, unit: "frames" },
    delay: { lbl: "Delay", min: 0, max: 60, step: 1, unit: "frames" },
  };

  return (
    <div className={s.rampBlock}>
      <div className={s.rampHead}>
        <span className={s.rampLabel}>{label}</span>
        <Toggle
          on={on}
          aria-label={label}
          onChange={(v) => (v ? writeElementField(elementPath, rampKey, { ...defaults, easing: defaultEasing }, false, label) : deleteElementField(elementPath, rampKey, label))}
        />
      </div>
      {on && (
        <div className={s.rampBody}>
          {fields.map((f) => (
            <Row key={f} label={meta[f].lbl}>
              <NumberInput
                value={typeof ramp?.[f] === "number" ? (ramp[f] as number) : defaults[f]}
                min={meta[f].min}
                max={meta[f].max}
                step={meta[f].step}
                unit={meta[f].unit === "frames" ? "f" : meta[f].unit === "x" ? "×" : undefined}
                onChange={(v, o) => w(f, v, o.live)}
              />
            </Row>
          ))}
          <Row label="Easing">
            <EasingChip
              value={typeof ramp?.easing === "string" ? (ramp.easing as string) : defaultEasing}
              target={{ path: elementPath, propPath: `${rampKey}.easing`, value: typeof ramp?.easing === "string" ? (ramp.easing as string) : undefined }}
            />
          </Row>
        </div>
      )}
    </div>
  );
}

function ShapeBody({ elementPath, el }: { elementPath: ElementPath; el: ShapeElementSpec }) {
  const b = el.base ?? {};
  return (
    <>
      <TransformSection elementPath={elementPath} el={el} />

      <Section title="Layout">
        <Row label="Type">
          <Select
            value={b.kind ?? "rectangle"}
            options={[{ value: "rectangle", label: "Rectangle" }, { value: "ellipse", label: "Ellipse" }, { value: "line", label: "Line" }]}
            onChange={(v) => writeElementField(elementPath, "base.kind", v, false, "Shape type")}
          />
        </Row>
        <Row label="Width">
          <NumberInput value={b.width ?? 24} min={0.5} max={400} step={0.5} unit="%" onChange={(v, o) => writeElementField(elementPath, "base.width", v, o.live, "Width")} />
        </Row>
        <Row label="Height">
          <NumberInput value={b.height ?? 14} min={0.5} max={400} step={0.5} unit="%" onChange={(v, o) => writeElementField(elementPath, "base.height", v, o.live, "Height")} />
        </Row>
      </Section>

      <AppearanceSection elementPath={elementPath} el={el} />

      <Section title="Fill">
        <FillStack
          fill={b.fill as FillSpec | undefined}
          label=""
          onChange={(f) => f == null ? deleteElementField(elementPath, "base.fill", "Fill") : writeElementField(elementPath, "base.fill", f, false, "Fill")}
        />
      </Section>

      <StrokeSection elementPath={elementPath} el={el} />

      <Section title="Layers">
        <LayerStack elementPath={elementPath} />
      </Section>
    </>
  );
}

function ImageBody({ elementPath, el }: { elementPath: ElementPath; el: ImageElementSpec }) {
  const b = el.base ?? ({} as ImageElementSpec["base"]);
  const replaceImage = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/avif";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      const url = await uploadAsset(f);
      writeElementField(elementPath, "base.src", url, false, "Replace image");
    };
    input.click();
  };
  return (
    <>
      <Section title="Image">
        <Row label="Source" wide>
          <button className={s.imgReplaceBtn} onClick={replaceImage} title={b.src}>
            {b.src ? b.src.split("/").pop() : "Choose image..."}
          </button>
        </Row>
        <Row label="Fit">
          <Select
            value={b.fit ?? "contain"}
            options={[{ value: "contain", label: "Contain (전체)" }, { value: "cover", label: "Cover (채움)" }, { value: "fill", label: "Fill (늘림)" }]}
            onChange={(v) => writeElementField(elementPath, "base.fit", v, false, "Image fit")}
          />
        </Row>
      </Section>

      <TransformSection elementPath={elementPath} el={el} />

      <Section title="Layout">
        <Row label="Width">
          <NumberInput value={b.width ?? 34} min={0.5} max={400} step={0.5} unit="%" onChange={(v, o) => writeElementField(elementPath, "base.width", v, o.live, "Width")} />
        </Row>
        <Row label="Height">
          <NumberInput value={b.height ?? 20} min={0.5} max={400} step={0.5} unit="%" onChange={(v, o) => writeElementField(elementPath, "base.height", v, o.live, "Height")} />
        </Row>
      </Section>

      <DecomposeSection elementPath={elementPath} el={el} />

      <AppearanceSection elementPath={elementPath} el={el} />

      <StrokeSection elementPath={elementPath} el={el} />

      <Section title="Layers">
        <LayerStack elementPath={elementPath} />
      </Section>
    </>
  );
}

// Decompose (A2) — 정적 UI 이미지를 조각으로 잘라 순차 bounce 조립 (v06 재현).
// 타이밍/탄성(stagger 5f, bounce Amp .04/Freq 1.8/Decay 3)은 실측 cemented —
// 에디터에선 분할/방향만 조작. 고급 조정은 JSON 패널에서 가능.
function DecomposeSection({ elementPath, el }: { elementPath: ElementPath; el: ImageElementSpec }) {
  const d = el.decompose;
  const on = !!d;
  return (
    <Section title="Decompose" defaultOpen={on}>
      <Row label="Enable">
        <Toggle
          on={on}
          onChange={(v) => {
            if (v) writeElementField(elementPath, "decompose", { mode: "grid", cols: 3, rows: 4 }, false, "Decompose on");
            else writeElementField(elementPath, "decompose", undefined, false, "Decompose off");
          }}
          aria-label="Decompose"
        />
      </Row>
      {on && d && (
        <>
          <Row label="Columns">
            <NumberInput value={d.cols ?? 3} min={1} max={12} step={1} onChange={(v, o) => writeElementField(elementPath, "decompose.cols", Math.round(v), o.live, "Decompose cols")} />
          </Row>
          <Row label="Rows">
            <NumberInput value={d.rows ?? 4} min={1} max={12} step={1} onChange={(v, o) => writeElementField(elementPath, "decompose.rows", Math.round(v), o.live, "Decompose rows")} />
          </Row>
          <Row label="Entry">
            <Select
              value={d.entry ?? "bottom"}
              options={[
                { value: "bottom", label: "아래에서 (v06 기본)" },
                { value: "top", label: "위에서" },
                { value: "left", label: "왼쪽에서" },
                { value: "right", label: "오른쪽에서" },
              ]}
              onChange={(v) => writeElementField(elementPath, "decompose.entry", v, false, "Decompose entry")}
            />
          </Row>
          <Row label="Stagger">
            <NumberInput value={d.stagger ?? 5} min={0} max={24} step={1} unit="f" onChange={(v, o) => writeElementField(elementPath, "decompose.stagger", Math.round(v), o.live, "Decompose stagger")} />
          </Row>
          <Row label="Delay">
            <NumberInput value={d.delay ?? 0} min={0} max={120} step={1} unit="f" onChange={(v, o) => writeElementField(elementPath, "decompose.delay", Math.round(v), o.live, "Decompose delay")} />
          </Row>
        </>
      )}
    </Section>
  );
}

// Shader (C4) — WebGL 유체/리빙 프리셋. 프로토타입: living_gradient.
// noise scale/warp/시간 계수는 cemented(관찰+node 검증) — 에디터는 팔레트/속도만.
// horizon_glow 색 스탑 편집 — 색별 X 위치/높이/강도 (좌=Color2, 중=Color3, 우=Color4)
function ShaderStopRows({ elementPath, el }: { elementPath: ElementPath; el: ShaderElementSpec }) {
  const stops = el.stops ?? [];
  const dflt = [{ x: 0.08 }, { x: 0.52 }, { x: 0.97 }];
  const write = (i: number, field: "x" | "reach" | "intensity", v: number, live: boolean) => {
    const next = [0, 1, 2].map((k) => ({
      x: stops[k]?.x ?? dflt[k].x,
      reach: stops[k]?.reach ?? 1,
      intensity: stops[k]?.intensity ?? 1,
      ...(k === i ? { [field]: v } : {}),
    }));
    writeElementField(elementPath, "stops", next, live, "Shader stop");
  };
  return (
    <>
      {[0, 1, 2].map((i) => (
        <React.Fragment key={i}>
          <Row label={`Stop ${i + 1} X`}>
            <NumberInput value={stops[i]?.x ?? dflt[i].x} min={-0.2} max={1.2} step={0.01} displayScale={100} unit="%" onChange={(v, o) => write(i, "x", v, o.live)} />
          </Row>
          <Row label={`· reach`}>
            <NumberInput value={stops[i]?.reach ?? 1} min={0.3} max={2.5} step={0.05} onChange={(v, o) => write(i, "reach", v, o.live)} />
          </Row>
          <Row label={`· strength`}>
            <NumberInput value={stops[i]?.intensity ?? 1} min={0} max={2.5} step={0.05} onChange={(v, o) => write(i, "intensity", v, o.live)} />
          </Row>
        </React.Fragment>
      ))}
    </>
  );
}

function ShaderBody({ elementPath, el }: { elementPath: ElementPath; el: ShaderElementSpec }) {
  const palette = el.palette ?? ["#0B0E1A", "#31226E", "#7C4DFF", "#52C5FF"];
  const b = el.base ?? {};
  return (
    <>
      {/* 엔진 ComposedShader 는 position/x/y/scale/rotate/opacity 채널을 소비 (감사 #23) */}
      <TransformSection elementPath={elementPath} el={el} />

      <Section title="Shader">
        <Row label="Preset">
          <Select
            value={el.preset ?? "living_gradient"}
            options={[{ value: "living_gradient", label: "Living gradient" }, { value: "horizon_flow", label: "Horizon flow (bottom glow)" }, { value: "horizon_glow", label: "Horizon glow (vivid)" }]}
            onChange={(v) => writeElementField(elementPath, "preset", v, false, "Shader preset")}
          />
        </Row>
        {palette.map((c, i) => (
          <Row key={i} label={`Color ${i + 1}`}>
            <ColorInput
              value={c}
              onChange={(v) => {
                if (!v) return;
                const next = [...palette];
                next[i] = v;
                writeElementField(elementPath, "palette", next, false, "Shader palette");
              }}
            />
          </Row>
        ))}
        <Row label="Speed">
          <NumberInput value={el.speed ?? 1} min={0} max={8} step={0.1} onChange={(v, o) => writeElementField(elementPath, "speed", v, o.live, "Shader speed")} />
        </Row>
        {el.preset === "horizon_glow" && <ShaderStopRows elementPath={elementPath} el={el} />}
      </Section>

      <Section title="Layout">
        <Row label="Width">
          <NumberInput value={b.width ?? 100} min={1} max={400} step={1} unit="%" onChange={(v, o) => writeElementField(elementPath, "base.width", v, o.live, "Width")} />
        </Row>
        <Row label="Height">
          <NumberInput value={b.height ?? 100} min={1} max={400} step={1} unit="%" onChange={(v, o) => writeElementField(elementPath, "base.height", v, o.live, "Height")} />
        </Row>
        <Row label="Radius">
          <NumberInput value={b.radius ?? 0} min={0} max={200} step={1} unit="px" onChange={(v, o) => writeElementField(elementPath, "base.radius", v, o.live, "Radius")} />
        </Row>
      </Section>

      <Section title="Layers">
        <LayerStack elementPath={elementPath} />
      </Section>
    <Section title="Appearance">
        <OpacityKfRow el={el} path={elementPath} baseOpacity={b.opacity ?? 1} basePath="base.opacity" />
      </Section>

    </>
  );
}

function VideoBody({ elementPath, el }: { elementPath: ElementPath; el: VideoElementSpec }) {
  const b = el.base ?? ({} as VideoElementSpec["base"]);
  const replaceVideo = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "video/mp4,video/webm,video/quicktime";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      const url = await uploadAsset(f);
      writeElementField(elementPath, "base.src", url, false, "Replace video");
    };
    input.click();
  };
  return (
    <>
      <Section title="Video">
        <Row label="Source" wide>
          <button className={s.imgReplaceBtn} onClick={replaceVideo} title={b.src}>
            {b.src ? b.src.split("/").pop() : "Choose video..."}
          </button>
        </Row>
        <Row label="Fit">
          <Select
            value={b.fit ?? "cover"}
            options={[{ value: "cover", label: "Cover (채움)" }, { value: "contain", label: "Contain (전체)" }, { value: "fill", label: "Fill (늘림)" }]}
            onChange={(v) => writeElementField(elementPath, "base.fit", v, false, "Video fit")}
          />
        </Row>
        <Row label="Loop"><Toggle on={b.loop ?? true} onChange={(v) => writeElementField(elementPath, "base.loop", v, false, "Loop")} aria-label="Loop" /></Row>
        <Row label="Muted"><Toggle on={b.muted ?? true} onChange={(v) => writeElementField(elementPath, "base.muted", v, false, "Muted")} aria-label="Muted" /></Row>
        <Row label="Speed">
          <NumberInput value={b.playbackRate ?? 1} min={0.25} max={4} step={0.05} unit="×" onChange={(v, o) => writeElementField(elementPath, "base.playbackRate", v, o.live, "Speed")} />
        </Row>
      </Section>

      <TransformSection elementPath={elementPath} el={el} />

      <Section title="Layout">
        <Row label="Width">
          <NumberInput value={b.width ?? 55} min={0.5} max={400} step={0.5} unit="%" onChange={(v, o) => writeElementField(elementPath, "base.width", v, o.live, "Width")} />
        </Row>
        <Row label="Height">
          <NumberInput value={b.height ?? 31} min={0.5} max={400} step={0.5} unit="%" onChange={(v, o) => writeElementField(elementPath, "base.height", v, o.live, "Height")} />
        </Row>
      </Section>

      <AppearanceSection elementPath={elementPath} el={el} />

      <StrokeSection elementPath={elementPath} el={el} />

      <Section title="Layers">
        <LayerStack elementPath={elementPath} />
      </Section>
    </>
  );
}

// Appearance — Figma 식 공통 섹션: Opacity + Corner radius (+ shape 는 Backdrop blur).
// 라운드 불가 타입(텍스트 등)은 비활성 + 힌트.
function AppearanceSection({ elementPath, el }: { elementPath: ElementPath; el: SceneElementSpec }) {
  if (el.element === "gooey") return null;
  // group 은 자체 박스가 없어 라운드가 없다 — Opacity 만 노출(엔진이 그룹 opacity
  // 를 자식 전체에 곱해 소비). 키프레임도 가능(opacity 채널).
  if (el.element === "group") {
    const gb = (el as { base?: { opacity?: number } }).base;
    return (
      <Section title="Appearance">
        <OpacityKfRow el={el} path={elementPath} baseOpacity={gb?.opacity ?? 1} basePath="base.opacity" />
        <BlurKfRow el={el} path={elementPath} />
      </Section>
    );
  }
  const radiusCapable =
    el.element === "shape" || el.element === "image" || el.element === "video" || el.element === "frame";
  const b = (el as { base?: { radius?: number; opacity?: number; backdropBlur?: number } }).base;
  return (
    <Section title="Appearance">
      <OpacityKfRow
        el={el}
        path={elementPath}
        baseOpacity={radiusCapable ? (b?.opacity ?? 1) : 1}
        basePath={radiusCapable ? "base.opacity" : undefined}
      />
      {el.element !== "logo" && <BlurKfRow el={el} path={elementPath} />}
      {el.element === "shape" && (
        <Row label="Backdrop blur">
          <NumberInput value={b?.backdropBlur ?? 0} min={0} max={40} step={1} unit="px" onChange={(v, o) => v > 0 ? writeElementField(elementPath, "base.backdropBlur", v, o.live, "Backdrop blur") : deleteElementField(elementPath, "base.backdropBlur", "Backdrop blur")} />
        </Row>
      )}
      <Row label="Corner radius">
        {radiusCapable ? (
          <NumberInput
            value={b?.radius ?? 0}
            min={0}
            max={200}
            step={1}
            unit="px"
            onChange={(v, o) => writeElementField(elementPath, "base.radius", v, o.live, "Corner radius")}
          />
        ) : (
          <div
            className={s.disabledHint}
            title="텍스트는 배경이 없어 라운드를 줄 수 없어요 — Frame selection(⌥⌘G)으로 감싸고 frame 에 라운드를 주세요"
          >
            0 px
          </div>
        )}
      </Row>
    </Section>
  );
}

// FRAME — 자체 박스 + fill + 클립 컨테이너 (그룹과 별개).
function FrameBody({ elementPath, el }: { elementPath: ElementPath; el: FrameElementSpec }) {
  const b = el.base ?? {};
  const flow = (el as { flow?: { direction?: string; gap?: number; padding?: { x?: number; y?: number }; align?: string; justify?: string; hugW?: boolean; hugH?: boolean } }).flow;
  return (
    <>
      <TransformSection elementPath={elementPath} el={el} />

      <Section title="Layout">
        <Row label="Width">
          <NumberInput value={b.width ?? 40} min={0.5} max={400} step={0.5} unit="%" onChange={(v, o) => writeElementField(elementPath, "base.width", v, o.live, "Width")} />
        </Row>
        <Row label="Height">
          <NumberInput value={b.height ?? 30} min={0.5} max={400} step={0.5} unit="%" onChange={(v, o) => writeElementField(elementPath, "base.height", v, o.live, "Height")} />
        </Row>
      </Section>

      {/* Auto layout (Figma 등가) — Free 는 절대좌표(기존), Vertical/Horizontal 은
          frame 이 위치의 주인: 자식이 흐름 배치되고 Padding/Gap/Hug 가 생긴다. */}
      <Section title="Auto layout" defaultOpen={!!flow}>
        <Row label="Flow">
          <Segmented
            value={flow?.direction ?? "free"}
            options={[
              { value: "free", label: "Free" },
              { value: "vertical", label: "Vert" },
              { value: "horizontal", label: "Horiz" },
            ]}
            onChange={(v) => {
              if (v === "free") deleteElementField(elementPath, "flow", "Auto layout");
              // Figma 와 동일: Auto layout 을 켜면 기본 Hug — padding/gap 이 frame
              // 크기를 키운다 (Fixed 프레임에선 padding 이 내용만 밀어 반응이 없어 보임)
              else writeElementField(elementPath, "flow", { ...(flow ?? { gap: 16, padding: { x: 32, y: 24 }, hugW: true, hugH: true }), direction: v }, false, "Auto layout");
            }}
          />
        </Row>
        {/* Figma Resizing — W/H 는 Auto layout 소속 (Hug 시 비활성 의미) */}
        <Row label="W">
          <NumberInput value={b.width ?? 40} min={0.5} max={400} step={0.5} unit="%" onChange={(v, o) => writeElementField(elementPath, "base.width", v, o.live, "Width")} />
        </Row>
        <Row label="H">
          <NumberInput value={b.height ?? 30} min={0.5} max={400} step={0.5} unit="%" onChange={(v, o) => writeElementField(elementPath, "base.height", v, o.live, "Height")} />
        </Row>
        {flow && (
          <>
            <Row label="Gap">
              <NumberInput value={flow.gap ?? 0} min={0} max={400} step={2} unit="px" onChange={(v, o) => writeElementField(elementPath, "flow.gap", v, o.live, "Gap")} />
            </Row>
            <Row label="Padding X">
              <NumberInput value={flow.padding?.x ?? 0} min={0} max={400} step={2} unit="px" onChange={(v, o) => writeElementField(elementPath, "flow.padding.x", v, o.live, "Padding")} />
            </Row>
            <Row label="Padding Y">
              <NumberInput value={flow.padding?.y ?? 0} min={0} max={400} step={2} unit="px" onChange={(v, o) => writeElementField(elementPath, "flow.padding.y", v, o.live, "Padding")} />
            </Row>
            <Row label="Align">
              <Select
                value={flow.align ?? "center"}
                options={[
                  { value: "start", label: "Start" },
                  { value: "center", label: "Center" },
                  { value: "end", label: "End" },
                ]}
                onChange={(v) => writeElementField(elementPath, "flow.align", v, false, "Align")}
              />
            </Row>
            <Row label="Justify">
              <Select
                value={flow.justify ?? "center"}
                options={[
                  { value: "start", label: "Start" },
                  { value: "center", label: "Center" },
                  { value: "end", label: "End" },
                  { value: "between", label: "Space between" },
                ]}
                onChange={(v) => writeElementField(elementPath, "flow.justify", v, false, "Justify")}
              />
            </Row>
            <Row label="Hug width">
              <Toggle on={!!flow.hugW} onChange={(v) => writeElementField(elementPath, "flow.hugW", v || undefined, false, "Hug")} aria-label="Hug width" />
            </Row>
            <Row label="Hug height">
              <Toggle on={!!flow.hugH} onChange={(v) => writeElementField(elementPath, "flow.hugH", v || undefined, false, "Hug")} aria-label="Hug height" />
            </Row>
            <div className={s.hint}>
              Figma Auto layout 과 동일 — 자식의 X/Y 대신 frame 의 흐름이 배치를
              소유한다. Hug 는 콘텐츠 크기에 맞춤 (chrome 과 병용 불가).
            </div>
          </>
        )}
        <Row label="Clip content">
          <Toggle on={b.clipsContent !== false} onChange={(v) => writeElementField(elementPath, "base.clipsContent", v, false, "Clip content")} aria-label="Clip content" />
        </Row>
      </Section>

      <AppearanceSection elementPath={elementPath} el={el} />

      <Section title="Fill">
        <FillStack
          fill={b.fill as FillSpec | undefined}
          label=""
          allowNone
          onChange={(f) => f == null ? deleteElementField(elementPath, "base.fill", "Frame fill") : writeElementField(elementPath, "base.fill", f, false, "Frame fill")}
        />
      </Section>

      <StrokeSection elementPath={elementPath} el={el} />

      <Section title="Layers">
        <LayerStack elementPath={elementPath} />
      </Section>

      {/* 디바이스 크롬 (A3 mockup) — frame 표면 스타일. 콘텐츠는 스크린 영역으로 인셋. */}
      <Section title="Device chrome" defaultOpen={!!(el as { chrome?: { kind?: string } }).chrome}>
        <Row label="Kind">
          <Select
            value={(el as { chrome?: { kind?: string } }).chrome?.kind ?? ""}
            options={[
              { value: "", label: "None" },
              { value: "browser", label: "Browser 창" },
              { value: "phone", label: "Phone (다이나믹 아일랜드)" },
            ]}
            onChange={(v) => {
              if (!v) deleteElementField(elementPath, "chrome", "Device chrome");
              else writeElementField(elementPath, "chrome", { kind: v, theme: (el as { chrome?: { theme?: string } }).chrome?.theme ?? "dark" }, false, "Device chrome");
            }}
          />
        </Row>
        {(el as { chrome?: { kind?: string; theme?: string; url?: string } }).chrome && (
          <>
            <Row label="Theme">
              <Select
                value={(el as { chrome?: { theme?: string } }).chrome?.theme ?? "dark"}
                options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }]}
                onChange={(v) => writeElementField(elementPath, "chrome.theme", v, false, "Chrome theme")}
              />
            </Row>
            {(el as { chrome?: { kind?: string } }).chrome?.kind === "browser" && (
              <Row label="URL" wide>
                <TextInput
                  value={(el as { chrome?: { url?: string } }).chrome?.url ?? ""}
                  placeholder="app.example.com"
                  onChange={() => {}}
                  onCommit={(v) => writeElementField(elementPath, "chrome.url", v || undefined, false, "Chrome URL")}
                />
              </Row>
            )}
          </>
        )}
      </Section>
    </>
  );
}

function GooeyBody({ elementPath, el }: { elementPath: ElementPath; el: GooeyElementSpec }) {
  const b = el.base ?? ({} as GooeyElementSpec["base"]);
  const from = b.fromShape ?? { x: 0.5, y: 0.62 };
  const travel = b.travel ?? { dx: 0, dy: -0.28 };
  // detach 타이밍은 gooey_travel 레이어의 duration. 기본 추가 시 layers[0].
  const travelIdx = (el.layers ?? []).findIndex((l) => l.type === "gooey_travel");
  const travelDur = travelIdx >= 0 ? ((el.layers![travelIdx].props as { duration?: number })?.duration ?? 46) : 46;
  return (
    <>
      <Section title="Blob · Source">
        <Row label="From X">
          <NumberInput value={from.x} min={0} max={1} step={0.001} displayScale={100} unit="%" onChange={(v, o) => writeElementField(elementPath, "base.fromShape.x", v, o.live, "From X")} />
        </Row>
        <Row label="From Y">
          <NumberInput value={from.y} min={0} max={1} step={0.001} displayScale={100} unit="%" onChange={(v, o) => writeElementField(elementPath, "base.fromShape.y", v, o.live, "From Y")} />
        </Row>
        <Row label="Blob size">
          <NumberInput value={b.radius ?? 7} min={1} max={40} step={0.5} unit="%" onChange={(v, o) => writeElementField(elementPath, "base.radius", v, o.live, "Blob size")} />
        </Row>
      </Section>

      <Section title="Detach">
        <Row label="Travel X">
          <NumberInput value={travel.dx} min={-1} max={1} step={0.01} displayScale={100} unit="%" onChange={(v, o) => writeElementField(elementPath, "base.travel.dx", v, o.live, "Travel X")} />
        </Row>
        <Row label="Travel Y">
          <NumberInput value={travel.dy} min={-1} max={1} step={0.01} displayScale={100} unit="%" onChange={(v, o) => writeElementField(elementPath, "base.travel.dy", v, o.live, "Travel Y")} />
        </Row>
        <Row label="Duration">
          <NumberInput value={travelDur} min={6} max={120} step={1} unit="frames" onChange={(v, o) => writeElementField(elementPath, `layers.${travelIdx >= 0 ? travelIdx : 0}.props.duration`, v, o.live, "Detach duration")} />
        </Row>
        <Row label="Stickiness">
          <Select value={b.stickiness ?? "medium"} options={[{ value: "loose", label: "Loose (snappy)" }, { value: "medium", label: "Medium" }, { value: "sticky", label: "Sticky" }, { value: "glue", label: "Glue (long neck)" }]} onChange={(v) => writeElementField(elementPath, "base.stickiness", v, false, "Stickiness")} />
        </Row>
        <Row label="Swell">
          <NumberInput value={b.swell ?? 1} min={0.3} max={2.5} step={0.05} unit="×" onChange={(v, o) => writeElementField(elementPath, "base.swell", v, o.live, "Swell")} />
        </Row>
      </Section>

      <Section title="Style">
        <Row label="Fill">
          <ColorInput value={typeof b.fill === "string" ? b.fill : "#7C4DFF"} onChange={(v) => writeElementField(elementPath, "base.fill", v ?? "#7C4DFF", false, "Fill")} />
        </Row>
        <Row label="Goo blur">
          <NumberInput value={b.blur ?? 14} min={0} max={40} step={0.5} unit="px" onChange={(v, o) => writeElementField(elementPath, "base.blur", v, o.live, "Goo blur")} />
        </Row>
        <Row label="Rotation">
          <NumberInput value={b.rotate ?? 0} min={-180} max={180} step={1} unit="°" onChange={(v, o) => writeElementField(elementPath, "base.rotate", v, o.live, "Rotation")} />
        </Row>
        <Row label="Opacity">
          <NumberInput value={b.opacity ?? 1} min={0} max={1} step={0.01} displayScale={100} unit="%" onChange={(v, o) => writeElementField(elementPath, "base.opacity", v, o.live, "Opacity")} />
        </Row>
      </Section>
    </>
  );
}

// 3D 디바이스 목업 (glTF) — 다른 요소와 동일한 공통 계층(Transform 채널/투명도/
// 모션패스/키프레임) 전부 + 고유 Device 섹션만 추가 (텍스트 요소에 Typography 가
// 추가되는 것과 같은 구조). 3D tilt/pan 채널은 진짜 3D 모델 회전으로 들어간다.
function DeviceBody({ elementPath, el }: { elementPath: ElementPath; el: SceneElementSpec }) {
  const d = el as {
    device?: string;
    screen?: { src?: string };
    statusBar?: boolean;
    time?: string;
    lidAngle?: number;
    children?: unknown[];
    base?: { width?: number; height?: number; opacity?: number };
  };
  const hasScreenFrame = (d.children?.length ?? 0) > 0;
  const addScreenFrame = () => {
    writeElementField(
      elementPath,
      "children",
      [
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
      false,
      "Add screen frame",
    );
  };
  return (
    <>
      <Section title="Device">
        <Row label="Model">
          <Select
            value={d.device ?? "macbook"}
            options={[
              { value: "macbook", label: "MacBook (glTF)" },
              { value: "iphone15", label: "iPhone 15 Pro (glTF)" },
            ]}
            onChange={(v) => writeElementField(elementPath, "device", v, false, "Device model")}
          />
        </Row>
        {/* 스크린 콘텐츠는 자식 "screen" frame 의 Fill 로 — 이미지/영상/솔리드/
            그라디언트 전부 frame 속성 하나로 통일 (구 파일 피커 제거). */}
        {!hasScreenFrame && (
          <Row label="Screen" wide>
            <button className={s.imgReplaceBtn} onClick={addScreenFrame}>
              Add screen frame
            </button>
          </Row>
        )}
        {(d.device ?? "macbook") === "iphone15" && (
          <>
            <Row label="Status bar">
              <Select
                value={d.statusBar === false ? "off" : "on"}
                options={[{ value: "on", label: "On" }, { value: "off", label: "Off" }]}
                onChange={(v) => {
                  if (v === "off") writeElementField(elementPath, "statusBar", false, false, "Status bar");
                  else deleteElementField(elementPath, "statusBar", "Status bar");
                }}
              />
            </Row>
            {d.statusBar !== false && (
              <Row label="Time">
                <TextInput
                  value={d.time ?? ""}
                  placeholder="9:41"
                  onChange={() => {}}
                  onCommit={(v) => writeElementField(elementPath, "time", v || undefined, false, "Status bar time")}
                />
              </Row>
            )}
          </>
        )}
        {(d.device ?? "macbook") === "macbook" && (
          <Row label="Lid angle">
            <NumberInput value={d.lidAngle ?? -15} min={-90} max={10} step={1} unit="deg" onChange={(v, o) => writeElementField(elementPath, "lidAngle", Math.round(v), o.live, "Lid angle")} />
          </Row>
        )}
        <div className={s.hint}>
          Screen content lives in the child screen frame -- set its Fill to an
          image, video, or color. It stays glued to the display through 3D
          rotation. iPhone model: polyman (CC-BY 4.0).
        </div>
      </Section>

      <TransformSection elementPath={elementPath} el={el} />

      <Section title="Layout">
        <Row label="W">
          <NumberInput value={d.base?.width ?? 56} min={10} max={400} step={1} unit="%" onChange={(v, o) => writeElementField(elementPath, "base.width", v, o.live, "Device width")} />
        </Row>
        <Row label="H">
          <NumberInput value={d.base?.height ?? 64} min={10} max={400} step={1} unit="%" onChange={(v, o) => writeElementField(elementPath, "base.height", v, o.live, "Device height")} />
        </Row>
      </Section>

      <Section title="Appearance">
        <OpacityKfRow el={el} path={elementPath} baseOpacity={d.base?.opacity ?? 1} basePath="base.opacity" />
      </Section>

      {/* 엔진 ComposedDevice 는 spec.layers(fade/scale/move 래퍼)를 소비 (감사 #24) */}
      <Section title="Layers">
        <LayerStack elementPath={elementPath} />
      </Section>
    </>
  );
}

// 배치 그룹 자식의 Pin — 궤도/경로 분포에서 제외하고 제자리 고정.
// zIndex 0 으로 깊이 정렬엔 참여 (앞 카드가 가리고, 뒤 카드는 뒤로).
function LayoutPinSection({ elementPath, el }: { elementPath: ElementPath; el: SceneElementSpec }) {
  const doc = useEditor((st) => st.doc);
  const pp = parentPath(elementPath);
  const parent = doc && pp ? getElement(doc, pp) : null;
  const gl = (parent as { layout?: { type?: string } } | null)?.layout;
  if (!parent || parent.element !== "group" || !gl || (gl.type !== "path" && gl.type !== "orbit")) return null;
  const pinned = !!(el as { layoutPin?: boolean }).layoutPin;
  return (
    <Section title="Group layout" defaultOpen={pinned}>
      <Row label="Pin (배치 제외)">
        <Toggle on={pinned} onChange={(v) => writeElementField(elementPath, "layoutPin", v || undefined, false, "Layout pin")} aria-label="Layout pin" />
      </Row>
      <div className={s.hint}>
        궤도/경로 배치에서 빼고 제자리에 고정 — 궤도 중앙의 텍스트/로고 등.
        깊이 정렬에는 참여해서 앞으로 도는 카드는 이 요소를 가리고, 뒤로 도는
        카드는 이 요소 뒤로 지나간다.
      </div>
    </Section>
  );
}

// Material — AE Material Options 등가. 씬 Light + lit 요소만 셰이딩.
// 요소의 3D 자세(rotateX/rotateY)와 빛 방향으로 밝기/글린트가 계산된다.
function MaterialSection({ elementPath, el }: { elementPath: ElementPath; el: SceneElementSpec }) {
  const mat = (el as { material?: { lit?: boolean; specular?: number; shininess?: number } }).material;
  // AE Material Options: Accepts Lights 기본 ON — 끄는 것만 명시(lit:false)
  const accepts = mat?.lit !== false;
  return (
    <Section title="Material" defaultOpen={false}>
      <Row label="Accepts light">
        <Toggle
          on={accepts}
          onChange={(v) =>
            v
              ? writeElementField(elementPath, "material.lit", undefined, false, "Material")
              : writeElementField(elementPath, "material", { ...(mat ?? {}), lit: false }, false, "Material")
          }
          aria-label="Accepts light"
        />
      </Row>
      {accepts && (
        <>
          <div className={s.hint}>AE 와 동일 — 씬 Light 가 켜지면 기본으로 모든 요소가 반응한다.</div>
          <Row label="Specular">
            <NumberInput value={mat?.specular ?? 0.5} min={0} max={1.5} step={0.05} displayScale={100} unit="%" onChange={(v, o) => writeElementField(elementPath, "material.specular", v, o.live, "Specular")} />
          </Row>
          <Row label="Shininess">
            <NumberInput value={mat?.shininess ?? 24} min={1} max={120} step={1} onChange={(v, o) => writeElementField(elementPath, "material.shininess", Math.round(v), o.live, "Shininess")} />
          </Row>
        </>
      )}
    </Section>
  );
}

// Motion path — AE "paste path to position" 등가. 모든 요소 공통: 경로를 붙이면
// progress 키프레임 채널이 위치를 구동한다. Enable 시 AE 기본처럼 2초(48f)
// 키프레임 쌍을 플레이헤드 위치에 자동 시드(easeInOut) — 바로 재생 확인 가능.
function MotionPathSection({ elementPath, el }: { elementPath: ElementPath; el: SceneElementSpec }) {
  const mp = (el as { motionPath?: { d?: string; points?: Array<{ x: number; y: number }>; closed?: boolean; preset?: string; radius?: number; orient?: string; offset?: number; loop?: boolean | { durationF?: number } } }).motionPath;
  const on = !!mp;
  const loopOn = !!mp?.loop;
  const cycle = typeof mp?.loop === "object" ? (mp.loop.durationF ?? 240) : 240;
  const groupLayoutOn = (el as { element?: string; layout?: { type?: string } }).element === "group" && ((el as { layout?: { type?: string } }).layout?.type === "path" || (el as { layout?: { type?: string } }).layout?.type === "orbit");
  return (
    <Section title="Motion path" defaultOpen={on}>
      {groupLayoutOn && (
        <div className={s.hint}>
          이 그룹은 Layout 경로로 자식들을 배치 중 — 배치 경로(자식들이 놓이는 선)
          편집은 위 Layout 섹션에서. Motion path 는 그룹 전체가 통째로 이동하는
          별도 기능이다.
        </div>
      )}
      <Row label="Enable">
        <Toggle
          on={on}
          onChange={(v) => {
            if (v) {
              writeElementField(elementPath, "motionPath", { preset: "arc", orient: "tangent" }, false, "Motion path on");
              // AE paste-path 기본: 2초 진행 키프레임 시드 (플레이헤드부터)
              const f = Math.max(0, Math.round((getPlayer()?.getCurrentFrame() ?? 0)));
              const doc0 = useEditor.getState().doc;
              const sceneIdx = Number(String(elementPath).split(":")[0]);
              const starts = doc0 ? sceneStarts(doc0, FPS) : [0];
              // 씬 길이 안에 2초 여정이 들어가게 클램프 (씬 밖 키는 재생 안 됨)
              const doc1 = useEditor.getState().doc;
              const sceneF = Math.max(49, Math.round((doc1?.scenes?.[sceneIdx]?.duration ?? 4) * FPS));
              const local = Math.min(Math.max(0, f - (starts[sceneIdx] ?? 0)), sceneF - 49);
              upsertChannelKey(elementPath, "progress", local, 0, false);
              upsertChannelKey(elementPath, "progress", local + 48, 1, false);
            } else {
              writeElementField(elementPath, "motionPath", undefined, false, "Motion path off");
            }
          }}
          aria-label="Motion path"
        />
      </Row>
      {on && mp && (
        <>
          <Row label="Path">
            <Select
              value={mp.points ? "points" : mp.d ? "custom" : (mp.preset ?? "arc")}
              options={[
                { value: "arc", label: "호 (완만한 곡선)" },
                { value: "wave", label: "물결" },
                { value: "circle", label: "원" },
                { value: "points", label: "포인트 (캔버스에서 편집)" },
                { value: "custom", label: "커스텀 d" },
              ]}
              onChange={(v) => {
                if (v === "points") {
                  // 현재 프리셋을 편집 가능한 점+핸들로 변환 — 캔버스에서 바로 편집
                  const conv = presetToPoints((mp.preset as "circle" | "arc" | "wave") ?? "arc", mp.radius ?? 30);
                  writeElementField(elementPath, "motionPath.points", conv.points, false, "Motion path points");
                  writeElementField(elementPath, "motionPath.closed", conv.closed || undefined, false, "Motion path points");
                  deleteElementField(elementPath, "motionPath.d", "Motion path d");
                } else if (v === "custom") {
                  deleteElementField(elementPath, "motionPath.points", "Motion path points");
                  writeElementField(elementPath, "motionPath.d", "M 10 50 C 35 20, 65 80, 90 50", false, "Motion path d");
                } else {
                  deleteElementField(elementPath, "motionPath.d", "Motion path d");
                  deleteElementField(elementPath, "motionPath.points", "Motion path points");
                  writeElementField(elementPath, "motionPath.preset", v, false, "Motion path preset");
                }
              }}
            />
          </Row>
          {mp.points && (
            <div className={s.hint}>
              캔버스에서 점 드래그 = 이동, 점 클릭 = 핸들 표시, 핸들 드래그 = 곡률
              (Alt = 한쪽만), 선분 더블클릭 = 점 추가, 점 더블클릭 = 삭제.
            </div>
          )}
          {typeof mp.d === "string" && !mp.points && (
            <Row label="d" wide>
              <TextInput value={mp.d} onChange={() => {}} onCommit={(v) => writeElementField(elementPath, "motionPath.d", v, false, "Motion path d")} />
            </Row>
          )}
          {!mp.d && !mp.points && mp.preset === "circle" && (
            <Row label="Radius">
              <NumberInput value={mp.radius ?? 30} min={5} max={48} step={1} unit="%" onChange={(v, o) => writeElementField(elementPath, "motionPath.radius", v, o.live, "Motion path radius")} />
            </Row>
          )}
          <Row label="Orient">
            <Select
              value={mp.orient ?? "none"}
              options={[
                { value: "none", label: "수평 유지" },
                { value: "tangent", label: "경로 방향 (Auto-Orient)" },
              ]}
              onChange={(v) => writeElementField(elementPath, "motionPath.orient", v, false, "Motion path orient")}
            />
          </Row>
          <Row label="Offset">
            <NumberInput value={mp.offset ?? 0} min={0} max={1} step={0.01} displayScale={100} unit="%" onChange={(v, o) => writeElementField(elementPath, "motionPath.offset", v || undefined, o.live, "Motion path offset")} />
          </Row>
          <Row label="Loop">
            <Toggle
              on={loopOn}
              onChange={(v) => writeElementField(elementPath, "motionPath.loop", v ? { durationF: cycle } : undefined, false, "Motion path loop")}
              aria-label="Motion path loop"
            />
          </Row>
          {loopOn && (
            <Row label="Cycle">
              <NumberInput value={cycle} min={12} max={960} step={12} unit="f" onChange={(v, o) => writeElementField(elementPath, "motionPath.loop", { durationF: Math.round(v) }, o.live, "Motion path cycle")} />
            </Row>
          )}
          <PathProgressKfRow el={el} path={elementPath} />
        </>
      )}
    </Section>
  );
}

// B2 경로 배치 — 그룹 자식들을 SVG 경로 위에 분포/이동 (AE Path Carousel).
// progress 타이밍(48f easeInOut)은 v05 실측 cemented — 에디터는 형태/방향/속도만.
function PathLayoutSection({ elementPath }: { elementPath: ElementPath }) {
  const doc = useEditor((st) => st.doc);
  const el = doc ? getElement(doc, elementPath) : null;
  const layout = (el as { layout?: { type: string; preset?: string; points?: Array<{ x: number; y: number }>; closed?: boolean; radius?: number; tilt?: number; orient?: string; swing?: boolean; progress?: { loop?: boolean; durationF?: number } } } | null)?.layout;
  const on = layout?.type === "path" || layout?.type === "orbit";
  return (
    <Section title="Layout" defaultOpen={on}>
      <Row label="Enable">
        <Toggle
          on={on}
          onChange={(v) => {
            if (v)
              writeElementField(elementPath, "layout", { type: "path", preset: "circle", radius: 30, orient: "upright", progress: { loop: true, durationF: 240 } }, false, "Group layout on");
            else writeElementField(elementPath, "layout", undefined, false, "Group layout off");
          }}
          aria-label="Group layout"
        />
      </Row>
      {on && layout && (
        <>
          <Row label="Type">
            <Select
              value={layout.type}
              options={[
                { value: "path", label: "Path (2D 경로)" },
                { value: "orbit", label: "Orbit (3D 궤도)" },
              ]}
              onChange={(v) => {
                if (v === "orbit")
                  writeElementField(elementPath, "layout", { type: "orbit", radius: 28, tilt: layout.tilt ?? 0, progress: layout.progress?.loop ? layout.progress : { loop: true, durationF: 240 } }, false, "Layout type");
                else
                  writeElementField(elementPath, "layout", { type: "path", preset: "circle", radius: 30, orient: "upright", progress: layout.progress?.loop ? layout.progress : { loop: true, durationF: 240 } }, false, "Layout type");
              }}
            />
          </Row>
          {layout.type === "orbit" && (
            <>
              <Row label="Radius">
                <NumberInput value={layout.radius ?? 28} min={5} max={45} step={1} unit="%" onChange={(v, o) => writeElementField(elementPath, "layout.radius", v, o.live, "Orbit radius")} />
              </Row>
              <Row label="Tilt">
                <NumberInput value={layout.tilt ?? 0} min={0} max={40} step={1} unit="%" onChange={(v, o) => writeElementField(elementPath, "layout.tilt", v, o.live, "Orbit tilt")} />
              </Row>
            </>
          )}
          {layout.type === "path" && (
          <Row label="Path">
            <Select
              value={layout.points ? "points" : (layout.preset ?? "wave")}
              options={[
                { value: "circle", label: "원 (대관람차/캐러셀)" },
                { value: "arc", label: "호 (완만한 곡선)" },
                { value: "wave", label: "물결" },
                { value: "points", label: "포인트 (캔버스에서 편집)" },
              ]}
              onChange={(v) => {
                if (v === "points") {
                  // 현재 프리셋 -> 편집 가능한 점+핸들. 자식 배치가 이 경로 그대로 유지.
                  const conv = presetToPoints((layout.preset as "circle" | "arc" | "wave") ?? "wave", layout.radius ?? 30);
                  writeElementField(elementPath, "layout.points", conv.points, false, "Layout path points");
                  writeElementField(elementPath, "layout.closed", conv.closed || undefined, false, "Layout path points");
                } else {
                  deleteElementField(elementPath, "layout.points", "Layout path points");
                  deleteElementField(elementPath, "layout.closed", "Layout path points");
                  writeElementField(elementPath, "layout.preset", v, false, "Path preset");
                }
              }}
            />
          </Row>
          )}
          {layout.type === "path" && layout.points && (
            <div className={s.hint}>
              캔버스에서 이 경로를 직접 편집 — 자식들이 편집된 경로 위에 그대로
              배치된다. 점 드래그/클릭+핸들/선분 더블클릭(추가)/점 더블클릭(삭제).
            </div>
          )}
          {layout.type === "path" && layout.preset === "circle" && (
            <Row label="Radius">
              <NumberInput value={layout.radius ?? 30} min={5} max={48} step={1} unit="%" onChange={(v, o) => writeElementField(elementPath, "layout.radius", v, o.live, "Path radius")} />
            </Row>
          )}
          {layout.type === "path" && (
          <Row label="Orient">
            <Select
              value={layout.orient ?? "upright"}
              options={[
                { value: "upright", label: "수평 유지 (곤돌라)" },
                { value: "tangent", label: "경로 방향 (접선)" },
              ]}
              onChange={(v) => writeElementField(elementPath, "layout.orient", v, false, "Path orient")}
            />
          </Row>
          )}
          {layout.type === "path" && (
          <Row label="Swing">
            <Toggle on={!!layout.swing} onChange={(v) => writeElementField(elementPath, "layout.swing", v || undefined, false, "Path swing")} aria-label="Swing" />
          </Row>
          )}
          <Row label="Loop">
            <Toggle
              on={!!layout.progress?.loop}
              onChange={(v) => writeElementField(elementPath, "layout.progress", v ? { loop: true, durationF: layout.progress?.durationF ?? 240 } : undefined, false, "Path loop")}
              aria-label="Loop"
            />
          </Row>
          {layout.progress?.loop && (
            <Row label="Cycle">
              <NumberInput value={layout.progress?.durationF ?? 240} min={12} max={960} step={12} unit="f" onChange={(v, o) => writeElementField(elementPath, "layout.progress.durationF", Math.round(v), o.live, "Path cycle")} />
            </Row>
          )}
          {/* 안무된 이동 — AE Path Progress 와 동일: 스톱워치로 키 찍고, 타임라인
              다이아 선택 -> Keyframe 패널에서 세그먼트 이징(가감속) 편집. 키프레임이
              있으면 loop 등속보다 우선한다. */}
          <PathProgressKfRow el={el} path={elementPath} />
        </>
      )}
    </Section>
  );
}

function GroupBody({ elementPath, el }: { elementPath: ElementPath; el: SceneElementSpec }) {
  return (
    <>
      <div className={s.hint}>Group — group motion applies to all children.</div>
      {/* 그룹 공통 Transform — 회전/3D/깊이/스케일이 그룹 컨테이너에 적용 (자식 전체) */}
      <TransformSection elementPath={elementPath} el={el} />
      {/* 그룹 Opacity(+키프레임) — 엔진이 자식 전체에 곱한다 */}
      <AppearanceSection elementPath={elementPath} el={el} />
      <PathLayoutSection elementPath={elementPath} />
      <Section title="Group motion">
        <LayerStack elementPath={elementPath} />
      </Section>
    </>
  );
}
