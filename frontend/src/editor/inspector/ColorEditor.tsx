"use client";

// ColorEditor — spec.color(ColorSpec) 의 첫 timeline 엔트리 fill 을 편집.
// 단색(base.color) / 그라디언트 / 팔레트. 복잡한 멀티 엔트리 timeline 은 v1 미지원
// (첫 엔트리만 편집 — 대부분 실제 스펙이 단일 엔트리).

import React from "react";
import { Segmented, ColorInput, NumberInput, Row, Toggle } from "@/editor/controls";
import type { ElementPath } from "@/editor/specPath";
import type { ColorSpec, Fill } from "@engine/motion/color/engine";
import type { TextElementSpec } from "@engine/motion/ComposedText";
import { KfRow, useLocalFrame } from "./KeyframeControls";
import { upsertColorKey, isChannelArmed } from "@/editor/elementKeyframes";
import { sampleElementKeyframes } from "@engine/motion/keyframes";
import { writeElementField, deleteElementField } from "./writes";
import s from "./inspector.module.css";

type Mode = "solid" | "gradient" | "palette";

function currentFill(el: TextElementSpec): Fill | null {
  const first = el.color?.timeline?.[0]?.fill;
  return first ?? null;
}
function modeOf(el: TextElementSpec): Mode {
  const f = currentFill(el);
  if (!f) return "solid";
  if (f.type === "gradient") return "gradient";
  if (f.type === "palette") return "palette";
  return "solid";
}

function setColorSpec(elementPath: ElementPath, spec: ColorSpec | undefined) {
  if (spec === undefined) deleteElementField(elementPath, "color", "Color mode");
  else writeElementField(elementPath, "color", spec, false, "Color");
}

export function ColorEditor({
  elementPath,
  el,
}: {
  elementPath: ElementPath;
  el: TextElementSpec;
}) {
  const mode = modeOf(el);
  const fill = currentFill(el);

  const switchMode = (m: Mode) => {
    if (m === "solid") {
      setColorSpec(elementPath, undefined);
    } else if (m === "gradient") {
      const stops =
        fill?.type === "gradient"
          ? fill.stops
          : [el.base?.color ?? "#FFFFFF", "#7C4DFF"];
      setColorSpec(elementPath, {
        timeline: [{ fill: { type: "gradient", stops, angle: 90 } }],
      });
    } else {
      const values =
        fill?.type === "palette"
          ? (fill.values.map((v) => (typeof v === "string" ? v : "#FFFFFF")) as string[])
          : [el.base?.color ?? "#FFFFFF", "#FF4D9D"];
      setColorSpec(elementPath, {
        timeline: [{ fill: { type: "palette", values, unit: "word" } }],
      });
    }
  };

  const writeFillPath = (path: string, value: unknown) => {
    // spec.color.timeline[0].fill.<path>
    writeElementField(elementPath, `color.timeline.0.fill.${path}`, value, false, "Color");
  };

  return (
    <div className={s.colorEditor}>
      <Segmented<Mode>
        value={mode}
        options={[
          { value: "solid", label: "Solid" },
          { value: "gradient", label: "Gradient" },
          { value: "palette", label: "Palette" },
        ]}
        onChange={switchMode}
      />

      {mode === "solid" && <SolidColorKfRow elementPath={elementPath} el={el} />}

      {mode === "gradient" && fill?.type === "gradient" && (
        <>
          <Row label="Stops" wide>
            <StopList
              stops={fill.stops}
              onChange={(next) => writeFillPath("stops", next)}
            />
          </Row>
          <Row label="Angle">
            <NumberInput
              value={fill.angle ?? 90}
              min={0}
              max={360}
              step={1}
              unit="°"
              onChange={(v) => writeFillPath("angle", v)}
            />
          </Row>
          <Row label="Flow">
            <NumberInput
              value={el.color?.flowSpeed ?? 0}
              min={-10}
              max={10}
              step={0.1}
              onChange={(v) => writeElementField(elementPath, "color.flowSpeed", v, false, "Gradient flow")}
            />
          </Row>
        </>
      )}

      {mode === "palette" && fill?.type === "palette" && (
        <>
          <Row label="Per-word color" wide>
            <StopList
              stops={fill.values.map((v) => (typeof v === "string" ? v : "#FFFFFF"))}
              onChange={(next) => writeFillPath("values", next)}
            />
          </Row>
          <Row label="Unit">
            <Segmented
              value={fill.unit ?? "word"}
              options={[
                { value: "word", label: "Word" },
                { value: "char", label: "Char" },
              ]}
              onChange={(v) => writeFillPath("unit", v)}
            />
          </Row>
        </>
      )}

      {/* 고급 색 동작 — ColorSpec 이 있을 때(단색 아님)만. 근거: editor-prop-audit
          (letterOffsetFrames/revealLinked/sweepPerLetter 미노출 갭). */}
      {mode !== "solid" && el.color && (
        <>
          <div className={s.cementedTitle} style={{ marginTop: 4 }}>Color behavior</div>
          <Row label="Letter shift">
            <NumberInput
              value={el.color.letterOffsetFrames ?? 0}
              min={-8}
              max={8}
              step={0.1}
              unit="f"
              onChange={(v) => writeElementField(elementPath, "color.letterOffsetFrames", v, false, "Letter color shift")}
            />
          </Row>
          <Row label="Word sweep">
            <NumberInput
              value={el.color.sweepPerLetter ?? 0}
              min={-8}
              max={8}
              step={0.1}
              unit="f"
              onChange={(v) => writeElementField(elementPath, "color.sweepPerLetter", v, false, "Word color sweep")}
            />
          </Row>
          <Row label="Link to reveal">
            <Toggle
              on={el.color.revealLinked === true}
              aria-label="Link to reveal"
              onChange={(v) => writeElementField(elementPath, "color.revealLinked", v, false, "Color reveal link")}
            />
          </Row>
        </>
      )}
    </div>
  );
}

function StopList({
  stops,
  onChange,
}: {
  stops: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className={s.colorList}>
      {stops.map((c, i) => (
        <div key={i} className={s.colorListItem}>
          <ColorInput
            value={c}
            onChange={(v) => {
              const next = [...stops];
              next[i] = v ?? "#FFFFFF";
              onChange(next);
            }}
          />
          {stops.length > 1 && (
            <button className={s.colorListRemove} onClick={() => onChange(stops.filter((_, j) => j !== i))} title="Remove">
              <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 5h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
            </button>
          )}
        </div>
      ))}
      <button className={s.colorListAdd} onClick={() => onChange([...stops, "#FFFFFF"])}>+ Add color</button>
    </div>
  );
}


// 솔리드 색 — color 키프레임 채널 행. 스톱워치 ON 이면 플레이헤드에 색 키
// upsert(키 사이 sRGB 보간), OFF 면 base.color 정적 쓰기 (AE 시멘틱).
function SolidColorKfRow({ elementPath, el }: { elementPath: Parameters<typeof writeElementField>[0]; el: { base?: { color?: string }; keyframes?: unknown } }) {
  const localFrame = useLocalFrame();
  const sampled = sampleElementKeyframes(el.keyframes as never, Math.max(0, Math.round(localFrame))).color;
  const value = sampled ?? el.base?.color ?? "#FFFFFF";
  return (
    <KfRow el={el} path={elementPath} channel="color" label="Color">
      <ColorInput
        value={value}
        onChange={(v) => {
          if (!v) return;
          if (isChannelArmed(el, "color")) upsertColorKey(elementPath, localFrame, v, false);
          else writeElementField(elementPath, "base.color", v, false, "Color");
        }}
      />
    </KfRow>
  );
}
