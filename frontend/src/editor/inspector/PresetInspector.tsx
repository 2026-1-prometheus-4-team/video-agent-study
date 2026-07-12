"use client";

// PresetInspector — preset element(neon_pill / glow_card / glow_menu) 바디.
// Transform/Appearance 는 다른 요소와 같은 스톱워치 채널 행(KeyframeControls)
// 을 쓰고, 이펙트 knob(orbit/타이핑/표면/아이템)은 전부 필드로 노출한다.
// 여기 없는 심화 필드(designverse swap 롤 등)는 {} JSON 편집기로.

import React from "react";
import { Section, Row, NumberInput, ColorInput, AlphaColorInput, Select, TextInput, Toggle } from "@/editor/controls";
import { writeElementField, deleteElementField } from "./writes";
import type { ElementPath } from "@/editor/specPath";
import type { SceneElementSpec } from "@engine/motion/SceneRenderer";
import type { NeonPillSpec } from "@engine/motion/effects/designverse";
import type { GlowCardSpec, GlowMenuSpec, GlowMenuItem } from "@engine/motion/effects/uiPresets";
import type { OrbitSpec } from "@engine/motion/effects/orbitGlow";
import { XYRow, RotationKfRow, ScaleKfRow, OpacityKfRow, BlurKfRow, Rot3DKfRow } from "./KeyframeControls";
import s from "./inspector.module.css";

// 프리셋 요소가 소비하는 채널만 (3D/depth 행은 엔진이 안 읽어 제외)
function PresetTransformSection({ elementPath, el }: { elementPath: ElementPath; el: SceneElementSpec }) {
  const p = el as { base?: { position?: { x: number; y: number }; rotate?: number; opacity?: number } ; position?: { x: number; y: number } };
  const pos = p.base?.position ?? p.position ?? { x: 0.5, y: 0.5 };
  return (
    <Section title="Transform">
      <XYRow el={el} path={elementPath} axis="x" pos={pos} />
      <XYRow el={el} path={elementPath} axis="y" pos={pos} />
      <RotationKfRow el={el} path={elementPath} baseRotate={p.base?.rotate ?? 0} />
      <Rot3DKfRow el={el} path={elementPath} axis="rotateX" />
      <Rot3DKfRow el={el} path={elementPath} axis="rotateY" />
      <ScaleKfRow el={el} path={elementPath} />
    </Section>
  );
}

function PresetAppearanceSection({ elementPath, el }: { elementPath: ElementPath; el: SceneElementSpec }) {
  const b = (el as { base?: { opacity?: number } }).base;
  return (
    <Section title="Appearance">
      <OpacityKfRow el={el} path={elementPath} baseOpacity={b?.opacity ?? 1} basePath="base.opacity" />
      <BlurKfRow el={el} path={elementPath} />
    </Section>
  );
}

const ORBIT_EASE_OPTIONS = [
  { value: "", label: "Uniform (등속)" },
  { value: "easeInOut", label: "Ease in-out" },
  { value: "easeIn", label: "Ease in" },
  { value: "easeOut", label: "Ease out" },
  { value: "easeInQuart", label: "Ease in quart" },
  { value: "easeOutCirc", label: "Ease out circ" },
];

const DEFAULT_ORBIT: OrbitSpec = {
  period: 110,
  span: 0.42,
  colors: ["#C9A0FF", "#7C3AED"],
  dim: "rgba(124,92,246,0.14)",
  bloom: 1.15,
};

// 궤도 스침광 knob 전부 — pill/card 공용
function OrbitSection({ elementPath, el }: { elementPath: ElementPath; el: SceneElementSpec }) {
  const orbit = (el as { orbit?: OrbitSpec }).orbit;
  const colors = orbit?.colors ?? ["#C9A0FF", "#7C3AED"];
  return (
    <Section title="Orbit glow">
      <Row label="Enable">
        <Toggle
          on={!!orbit}
          onChange={(on) =>
            on
              ? writeElementField(elementPath, "orbit", { ...DEFAULT_ORBIT }, false, "Orbit glow")
              : deleteElementField(elementPath, "orbit", "Orbit glow")
          }
        />
      </Row>
      {orbit && (
        <>
          <Row label="Period">
            <NumberInput value={orbit.period ?? 96} min={8} max={600} step={1} unit="f" onChange={(v, o) => writeElementField(elementPath, "orbit.period", v, o.live, "Orbit period")} />
          </Row>
          <Row label="Span">
            <NumberInput value={orbit.span ?? 0.38} min={0.04} max={0.92} step={0.01} displayScale={100} unit="%" onChange={(v, o) => writeElementField(elementPath, "orbit.span", v, o.live, "Orbit span")} />
          </Row>
          <Row label="Head color">
            <ColorInput value={colors[0]} onChange={(v) => v && writeElementField(elementPath, "orbit.colors", [v, colors[1]], false, "Orbit color")} />
          </Row>
          <Row label="Tail color">
            <ColorInput value={colors[1]} onChange={(v) => v && writeElementField(elementPath, "orbit.colors", [colors[0], v], false, "Orbit color")} />
          </Row>
          <Row label="Dim rim">
            <AlphaColorInput value={orbit.dim ?? "rgba(124,92,246,0.14)"} onChange={(v, live) => writeElementField(elementPath, "orbit.dim", v, live, "Orbit dim")} />
          </Row>
          <Row label="Bloom">
            <NumberInput value={orbit.bloom ?? 1} min={0} max={3} step={0.05} onChange={(v, o) => writeElementField(elementPath, "orbit.bloom", v, o.live, "Orbit bloom")} />
          </Row>
          <Row label="Easing">
            <Select
              value={orbit.easing ?? ""}
              options={ORBIT_EASE_OPTIONS}
              onChange={(v) => (v ? writeElementField(elementPath, "orbit.easing", v, false, "Orbit easing") : deleteElementField(elementPath, "orbit.easing", "Orbit easing"))}
            />
          </Row>
          <Row label="Reverse">
            <Toggle on={!!orbit.reverse} onChange={(on) => (on ? writeElementField(elementPath, "orbit.reverse", true, false, "Orbit reverse") : deleteElementField(elementPath, "orbit.reverse", "Orbit reverse"))} />
          </Row>
          <Row label="Phase">
            <NumberInput value={orbit.phase ?? 0} min={0} max={1} step={0.01} displayScale={100} unit="%" onChange={(v, o) => writeElementField(elementPath, "orbit.phase", v, o.live, "Orbit phase")} />
          </Row>
        </>
      )}
    </Section>
  );
}

// 등장 램프 (fadeIn/drawIn 계열 {start, duration}) 공용 행
function RampRows({ elementPath, el, field, label }: { elementPath: ElementPath; el: SceneElementSpec; field: string; label: string }) {
  const ramp = (el as unknown as Record<string, { start?: number; duration?: number } | undefined>)[field];
  return (
    <>
      <Row label={`${label}`}>
        <Toggle
          on={!!ramp}
          onChange={(on) => (on ? writeElementField(elementPath, field, { duration: 14 }, false, label) : deleteElementField(elementPath, field, label))}
        />
      </Row>
      {ramp && (
        <>
          <Row label="Start">
            <NumberInput value={ramp.start ?? 0} min={0} max={600} step={1} unit="f" onChange={(v, o) => writeElementField(elementPath, `${field}.start`, v, o.live, label)} />
          </Row>
          <Row label="Duration">
            <NumberInput value={ramp.duration ?? 14} min={1} max={300} step={1} unit="f" onChange={(v, o) => writeElementField(elementPath, `${field}.duration`, v, o.live, label)} />
          </Row>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- neon_pill

export function NeonPillBody({ elementPath, el }: { elementPath: ElementPath; el: SceneElementSpec }) {
  const p = el as unknown as NeonPillSpec & { base?: { width?: number; height?: number } };
  const w = p.base?.width ?? p.width ?? 46;
  const h = p.base?.height ?? p.height ?? 6.2;
  const [bc1, bc2] = p.borderColors ?? ["#8A5CF6", "#A855F7"];
  return (
    <>
      <PresetTransformSection elementPath={elementPath} el={el} />
      <Section title="Layout">
        <Row label="Width">
          <NumberInput value={w} min={2} max={100} step={0.5} unit="vw" onChange={(v, o) => writeElementField(elementPath, "base.width", v, o.live, "Width")} />
        </Row>
        <Row label="Height">
          <NumberInput value={h} min={1} max={60} step={0.1} unit="vw" onChange={(v, o) => writeElementField(elementPath, "base.height", v, o.live, "Height")} />
        </Row>
        <Row label="Radius">
          <NumberInput value={p.radius ?? h * 0.28} min={0} max={30} step={0.1} unit="vw" onChange={(v, o) => writeElementField(elementPath, "radius", v, o.live, "Radius")} />
        </Row>
      </Section>
      <PresetAppearanceSection elementPath={elementPath} el={el} />
      <Section title="Pill">
        <Row label="Fill" wide>
          <AlphaColorInput value={p.fillColor ?? "#0A0714"} onChange={(v, live) => writeElementField(elementPath, "fillColor", v, live, "Fill")} />
        </Row>
        <Row label="Border width">
          <NumberInput value={p.borderWidth ?? 4} min={0} max={30} step={0.5} unit="px" onChange={(v, o) => writeElementField(elementPath, "borderWidth", v, o.live, "Border width")} />
        </Row>
        <Row label="Border 1">
          <ColorInput value={bc1} onChange={(v) => v && writeElementField(elementPath, "borderColors", [v, bc2], false, "Border color")} />
        </Row>
        <Row label="Border 2">
          <ColorInput value={bc2} onChange={(v) => v && writeElementField(elementPath, "borderColors", [bc1, v], false, "Border color")} />
        </Row>
        <Row label="Glow">
          <NumberInput value={p.glow ?? 0.8} min={0} max={2} step={0.05} onChange={(v, o) => writeElementField(elementPath, "glow", v, o.live, "Glow")} />
        </Row>
        <RampRows elementPath={elementPath} el={el} field="drawIn" label="Draw in" />
      </Section>
      <OrbitSection elementPath={elementPath} el={el} />
      <Section title="Content">
        <Row label="Mode">
          <Select
            value={p.mode ?? "type"}
            options={[{ value: "type", label: "Typing" }, { value: "swap", label: "Word swap" }, { value: "dots", label: "Dots" }]}
            onChange={(v) => writeElementField(elementPath, "mode", v, false, "Mode")}
          />
        </Row>
        {(p.mode ?? "type") === "type" && (
          <>
            <Row label="Text" wide>
              <TextInput value={p.text ?? ""} onChange={(v) => writeElementField(elementPath, "text", v, true, "Text")} onCommit={(v) => writeElementField(elementPath, "text", v, false, "Text")} />
            </Row>
            <Row label="Chars/sec">
              <NumberInput value={p.charsPerSecond ?? 15} min={1} max={60} step={1} onChange={(v, o) => writeElementField(elementPath, "charsPerSecond", v, o.live, "Type speed")} />
            </Row>
            <Row label="Type start">
              <NumberInput value={p.typeStart ?? 0} min={0} max={600} step={1} unit="f" onChange={(v, o) => writeElementField(elementPath, "typeStart", v, o.live, "Type start")} />
            </Row>
            <Row label="Cursor">
              <Toggle on={p.cursor ?? true} onChange={(on) => writeElementField(elementPath, "cursor", on, false, "Cursor")} />
            </Row>
            <Row label="Caret color">
              <ColorInput value={p.caretColor ?? "#FFFFFF"} onChange={(v) => v && writeElementField(elementPath, "caretColor", v, false, "Caret color")} />
            </Row>
            <Row label="Fresh tint">
              <Toggle
                on={!!p.freshTint}
                onChange={(on) => (on ? writeElementField(elementPath, "freshTint", { color: "#A78BFA", fade: 16 }, false, "Fresh tint") : deleteElementField(elementPath, "freshTint", "Fresh tint"))}
              />
            </Row>
            {p.freshTint && (
              <>
                <Row label="Tint color">
                  <ColorInput value={p.freshTint.color ?? "#A78BFA"} onChange={(v) => v && writeElementField(elementPath, "freshTint.color", v, false, "Tint color")} />
                </Row>
                <Row label="Tint fade">
                  <NumberInput value={p.freshTint.fade ?? 14} min={1} max={90} step={1} unit="f" onChange={(v, o) => writeElementField(elementPath, "freshTint.fade", v, o.live, "Tint fade")} />
                </Row>
              </>
            )}
          </>
        )}
        <Row label="Font size">
          <NumberInput value={p.fontSize ?? h * 0.42} min={0.4} max={12} step={0.1} unit="vw" onChange={(v, o) => writeElementField(elementPath, "fontSize", v, o.live, "Font size")} />
        </Row>
        <Row label="Weight">
          <NumberInput value={p.fontWeight ?? 600} min={100} max={900} step={100} onChange={(v, o) => writeElementField(elementPath, "fontWeight", v, o.live, "Weight")} />
        </Row>
        <Row label="Text color">
          <ColorInput value={p.color ?? "#FFFFFF"} onChange={(v) => v && writeElementField(elementPath, "color", v, false, "Text color")} />
        </Row>
        <Row label="Align">
          <Select
            value={p.align ?? ((p.mode ?? "type") === "type" ? "left" : "center")}
            options={[{ value: "left", label: "Left" }, { value: "center", label: "Center" }]}
            onChange={(v) => writeElementField(elementPath, "align", v, false, "Align")}
          />
        </Row>
        <Row label="Pad left">
          <NumberInput value={p.paddingLeft ?? w * 0.07} min={0} max={30} step={0.1} unit="vw" onChange={(v, o) => writeElementField(elementPath, "paddingLeft", v, o.live, "Padding")} />
        </Row>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- glow_card

export function GlowCardBody({ elementPath, el }: { elementPath: ElementPath; el: SceneElementSpec }) {
  const p = el as unknown as GlowCardSpec;
  const w = p.base?.width ?? p.width ?? 22;
  const h = p.base?.height ?? p.height ?? 15;
  const [bc1, bc2] = p.borderColors ?? ["#B47CFF", "#7C3AED"];
  return (
    <>
      <PresetTransformSection elementPath={elementPath} el={el} />
      <Section title="Layout">
        <Row label="Width">
          <NumberInput value={w} min={2} max={100} step={0.5} unit="vw" onChange={(v, o) => writeElementField(elementPath, "base.width", v, o.live, "Width")} />
        </Row>
        <Row label="Height">
          <NumberInput value={h} min={2} max={100} step={0.5} unit="vw" onChange={(v, o) => writeElementField(elementPath, "base.height", v, o.live, "Height")} />
        </Row>
        <Row label="Radius">
          <NumberInput value={p.radius ?? 1.3} min={0} max={20} step={0.1} unit="vw" onChange={(v, o) => writeElementField(elementPath, "radius", v, o.live, "Radius")} />
        </Row>
        <Row label="Padding">
          <NumberInput value={p.padding ?? 1.6} min={0} max={10} step={0.1} unit="vw" onChange={(v, o) => writeElementField(elementPath, "padding", v, o.live, "Padding")} />
        </Row>
      </Section>
      <PresetAppearanceSection elementPath={elementPath} el={el} />
      <Section title="Surface">
        <Row label="Fill" wide>
          <AlphaColorInput value={p.fillColor ?? "rgba(16,13,24,0.62)"} onChange={(v, live) => writeElementField(elementPath, "fillColor", v, live, "Fill")} />
        </Row>
        <Row label="Glass blur">
          <NumberInput value={p.glass ?? 14} min={0} max={40} step={1} unit="px" onChange={(v, o) => writeElementField(elementPath, "glass", v, o.live, "Glass")} />
        </Row>
        <Row label="Sheen">
          <NumberInput value={p.sheen ?? 0.5} min={0} max={1} step={0.05} displayScale={100} unit="%" onChange={(v, o) => writeElementField(elementPath, "sheen", v, o.live, "Sheen")} />
        </Row>
        <Row label="Hairline" wide>
          <AlphaColorInput value={p.hairline ?? "rgba(255,255,255,0.09)"} onChange={(v, live) => writeElementField(elementPath, "hairline", v, live, "Hairline")} />
        </Row>
      </Section>
      <Section title="Border">
        <Row label="Width">
          <NumberInput value={p.borderWidth ?? 3} min={0} max={30} step={0.5} unit="px" onChange={(v, o) => writeElementField(elementPath, "borderWidth", v, o.live, "Border width")} />
        </Row>
        <Row label="Color 1">
          <ColorInput value={bc1} onChange={(v) => v && writeElementField(elementPath, "borderColors", [v, bc2], false, "Border color")} />
        </Row>
        <Row label="Color 2">
          <ColorInput value={bc2} onChange={(v) => v && writeElementField(elementPath, "borderColors", [bc1, v], false, "Border color")} />
        </Row>
        <Row label="Glow">
          <NumberInput value={p.glow ?? 0.8} min={0} max={2} step={0.05} onChange={(v, o) => writeElementField(elementPath, "glow", v, o.live, "Glow")} />
        </Row>
      </Section>
      <OrbitSection elementPath={elementPath} el={el} />
      <Section title="Content">
        <Row label="Icon">
          <TextInput value={p.icon ?? ""} placeholder="glyph" onChange={(v) => writeElementField(elementPath, "icon", v, true, "Icon")} onCommit={(v) => (v ? writeElementField(elementPath, "icon", v, false, "Icon") : deleteElementField(elementPath, "icon", "Icon"))} />
        </Row>
        <Row label="Title" wide>
          <TextInput value={p.title ?? ""} onChange={(v) => writeElementField(elementPath, "title", v, true, "Title")} onCommit={(v) => (v ? writeElementField(elementPath, "title", v, false, "Title") : deleteElementField(elementPath, "title", "Title"))} />
        </Row>
        <Row label="Description" wide>
          <TextInput value={p.description ?? ""} onChange={(v) => writeElementField(elementPath, "description", v, true, "Description")} onCommit={(v) => (v ? writeElementField(elementPath, "description", v, false, "Description") : deleteElementField(elementPath, "description", "Description"))} />
        </Row>
        <Row label="Title size">
          <NumberInput value={p.titleSize ?? 1.5} min={0.4} max={8} step={0.1} unit="vw" onChange={(v, o) => writeElementField(elementPath, "titleSize", v, o.live, "Title size")} />
        </Row>
        <Row label="Desc size">
          <NumberInput value={p.descSize ?? 1.0} min={0.3} max={6} step={0.1} unit="vw" onChange={(v, o) => writeElementField(elementPath, "descSize", v, o.live, "Desc size")} />
        </Row>
        <Row label="Title color">
          <ColorInput value={p.titleColor ?? "#F4F1FA"} onChange={(v) => v && writeElementField(elementPath, "titleColor", v, false, "Title color")} />
        </Row>
        <Row label="Desc color" wide>
          <AlphaColorInput value={p.descColor ?? "rgba(228,222,244,0.55)"} onChange={(v, live) => writeElementField(elementPath, "descColor", v, live, "Desc color")} />
        </Row>
      </Section>
      <Section title="Entrance">
        <RampRows elementPath={elementPath} el={el} field="fadeIn" label="Fade in" />
        <Row label="Rise">
          <NumberInput value={p.rise ?? 0} min={0} max={20} step={0.1} unit="vw" onChange={(v, o) => writeElementField(elementPath, "rise", v, o.live, "Rise")} />
        </Row>
        <RampRows elementPath={elementPath} el={el} field="fadeOut" label="Fade out" />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- glow_menu

export function GlowMenuBody({ elementPath, el }: { elementPath: ElementPath; el: SceneElementSpec }) {
  const p = el as unknown as GlowMenuSpec;
  const items = p.items ?? [];
  const active = p.active ?? [{ frame: 0, index: 0 }];
  const writeItems = (next: GlowMenuItem[], label: string) => writeElementField(elementPath, "items", next, false, label);
  const writeActive = (next: { frame: number; index: number }[], label: string) =>
    writeElementField(elementPath, "active", [...next].sort((a, b) => a.frame - b.frame), false, label);
  return (
    <>
      <PresetTransformSection elementPath={elementPath} el={el} />
      <PresetAppearanceSection elementPath={elementPath} el={el} />
      <Section title="Bar">
        <Row label="Height">
          <NumberInput value={p.height ?? 3.4} min={1} max={20} step={0.1} unit="vw" onChange={(v, o) => writeElementField(elementPath, "height", v, o.live, "Bar height")} />
        </Row>
        <Row label="Font size">
          <NumberInput value={p.fontSize ?? 1.05} min={0.3} max={6} step={0.05} unit="vw" onChange={(v, o) => writeElementField(elementPath, "fontSize", v, o.live, "Font size")} />
        </Row>
        <Row label="Gap">
          <NumberInput value={p.gap ?? 0.4} min={0} max={5} step={0.05} unit="vw" onChange={(v, o) => writeElementField(elementPath, "gap", v, o.live, "Gap")} />
        </Row>
        <Row label="Radius">
          <NumberInput value={p.radius ?? 1.2} min={0} max={10} step={0.1} unit="vw" onChange={(v, o) => writeElementField(elementPath, "radius", v, o.live, "Radius")} />
        </Row>
        <Row label="Fill" wide>
          <AlphaColorInput value={p.fillColor ?? "rgba(14,12,20,0.72)"} onChange={(v, live) => writeElementField(elementPath, "fillColor", v, live, "Fill")} />
        </Row>
        <Row label="Glass blur">
          <NumberInput value={p.glass ?? 12} min={0} max={40} step={1} unit="px" onChange={(v, o) => writeElementField(elementPath, "glass", v, o.live, "Glass")} />
        </Row>
        <Row label="Label" wide>
          <AlphaColorInput value={p.labelColor ?? "rgba(235,230,248,0.5)"} onChange={(v, live) => writeElementField(elementPath, "labelColor", v, live, "Label color")} />
        </Row>
        <Row label="Active label">
          <ColorInput value={p.activeLabelColor ?? "#FFFFFF"} onChange={(v) => v && writeElementField(elementPath, "activeLabelColor", v, false, "Active label")} />
        </Row>
        <Row label="Switch dur">
          <NumberInput value={p.switchDuration ?? 10} min={1} max={60} step={1} unit="f" onChange={(v, o) => writeElementField(elementPath, "switchDuration", v, o.live, "Switch duration")} />
        </Row>
      </Section>
      <Section title="Items">
        {items.map((it, i) => (
          <Row key={i} label={`#${i + 1}`} wide>
            <div className={s.presetItemRow}>
              <TextInput value={it.label} onChange={(v) => writeElementField(elementPath, `items.${i}.label`, v, true, "Item label")} onCommit={(v) => writeElementField(elementPath, `items.${i}.label`, v, false, "Item label")} />
              <ColorInput value={it.color ?? "#A855F7"} onChange={(v) => v && writeItems(items.map((x, j) => (j === i ? { ...x, color: v } : x)), "Item color")} />
              <button className={s.multiBtn} data-danger title="Remove item" onClick={() => writeItems(items.filter((_, j) => j !== i), "Remove item")}>
                ×
              </button>
            </div>
          </Row>
        ))}
        <Row label="" wide>
          <button className={s.multiBtn} onClick={() => writeItems([...items, { label: `Item ${items.length + 1}` }], "Add item")}>
            + Add item
          </button>
        </Row>
      </Section>
      <Section title="Active steps">
        {active.map((st, i) => (
          <Row key={i} label={`Step ${i + 1}`} wide>
            <div className={s.presetItemRow}>
              <NumberInput value={st.frame} min={0} max={3000} step={1} unit="f" onChange={(v, o) => { if (!o.live) writeActive(active.map((x, j) => (j === i ? { ...x, frame: Math.round(v) } : x)), "Active step"); }} />
              <NumberInput value={st.index} min={0} max={Math.max(0, items.length - 1)} step={1} onChange={(v, o) => { if (!o.live) writeActive(active.map((x, j) => (j === i ? { ...x, index: Math.round(v) } : x)), "Active step"); }} />
              <button className={s.multiBtn} data-danger title="Remove step" onClick={() => writeActive(active.filter((_, j) => j !== i), "Remove step")}>
                ×
              </button>
            </div>
          </Row>
        ))}
        <Row label="" wide>
          <button
            className={s.multiBtn}
            onClick={() => writeActive([...active, { frame: (active[active.length - 1]?.frame ?? 0) + 40, index: (active[active.length - 1]?.index ?? 0) + 1 <= items.length - 1 ? (active[active.length - 1]?.index ?? 0) + 1 : 0 }], "Add step")}
          >
            + Add step
          </button>
        </Row>
      </Section>
      <Section title="Entrance">
        <RampRows elementPath={elementPath} el={el} field="fadeIn" label="Fade in" />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- edge_light

import type { EdgeLightSpec } from "@engine/motion/effects/edgeLight";
import { upsertChannelKey } from "@/editor/elementKeyframes";
import { sampleElementKeyframes } from "@engine/motion/keyframes";
import { useLocalFrame, KfRow } from "./KeyframeControls";

// progress 행 — PathProgressKfRow 는 0..1 클램프라 랩(1 이상)이 안 된다.
// edge_light 는 progress 정수부 = 랩 수라서 자유 범위로 열어둔다.
function EdgeLightProgressRow({ el, path }: { el: unknown; path: ElementPath }) {
  const localFrame = useLocalFrame();
  const b = (el as { base?: { progress?: number } }).base;
  const sampled = sampleElementKeyframes((el as { keyframes?: never[] }).keyframes, localFrame).progress;
  const value = sampled ?? b?.progress ?? 0;
  return (
    <KfRow el={el} path={path} channel="progress" label="Progress">
      <NumberInput
        value={value}
        min={-50}
        max={50}
        step={0.01}
        onChange={(v, o) => {
          const armed = (el as { keyframes?: { progress?: number }[] }).keyframes?.some((k) => typeof k.progress === "number");
          if (armed) upsertChannelKey(path, "progress", localFrame, v, o.live);
          else writeElementField(path, "base.progress", v, o.live, "Progress");
        }}
      />
    </KfRow>
  );
}

export function EdgeLightBody({ elementPath, el }: { elementPath: ElementPath; el: SceneElementSpec }) {
  const p = el as unknown as EdgeLightSpec;
  const b = p.base ?? {};
  const colors = b.colors ?? ["#C9A0FF", "#7C3AED"];
  return (
    <>
      <PresetTransformSection elementPath={elementPath} el={el} />
      <Section title="Layout">
        <Row label="Width">
          <NumberInput value={b.width ?? 22} min={2} max={400} step={0.5} unit="vw" onChange={(v, o) => writeElementField(elementPath, "base.width", v, o.live, "Width")} />
        </Row>
        <Row label="Height">
          <NumberInput value={b.height ?? 15} min={1} max={400} step={0.5} unit="vw" onChange={(v, o) => writeElementField(elementPath, "base.height", v, o.live, "Height")} />
        </Row>
        <Row label="Radius">
          <NumberInput value={b.radius ?? 1.3} min={0} max={30} step={0.1} unit="vw" onChange={(v, o) => writeElementField(elementPath, "base.radius", v, o.live, "Radius")} />
        </Row>
        <Row label="Thickness">
          <NumberInput value={b.thickness ?? 3} min={0.5} max={30} step={0.5} unit="px" onChange={(v, o) => writeElementField(elementPath, "base.thickness", v, o.live, "Thickness")} />
        </Row>
      </Section>
      <PresetAppearanceSection elementPath={elementPath} el={el} />
      <Section title="Light">
        <EdgeLightProgressRow el={el} path={elementPath} />
        <Row label="Span">
          <NumberInput value={b.span ?? 0.38} min={0.04} max={0.92} step={0.01} displayScale={100} unit="%" onChange={(v, o) => writeElementField(elementPath, "base.span", v, o.live, "Span")} />
        </Row>
        <Row label="Head color">
          <ColorInput value={colors[0]} onChange={(v) => v && writeElementField(elementPath, "base.colors", [v, colors[1]], false, "Light color")} />
        </Row>
        <Row label="Tail color">
          <ColorInput value={colors[1]} onChange={(v) => v && writeElementField(elementPath, "base.colors", [colors[0], v], false, "Light color")} />
        </Row>
        <Row label="Dim rim" wide>
          <AlphaColorInput value={b.dim ?? "rgba(124,92,246,0)"} onChange={(v, live) => writeElementField(elementPath, "base.dim", v, live, "Dim rim")} />
        </Row>
        <Row label="Bloom">
          <NumberInput value={b.bloom ?? 1} min={0} max={3} step={0.05} onChange={(v, o) => writeElementField(elementPath, "base.bloom", v, o.live, "Bloom")} />
        </Row>
        <Row label="Glow">
          <NumberInput value={b.glow ?? 1} min={0} max={2} step={0.05} onChange={(v, o) => writeElementField(elementPath, "base.glow", v, o.live, "Glow")} />
        </Row>
      </Section>
    </>
  );
}
