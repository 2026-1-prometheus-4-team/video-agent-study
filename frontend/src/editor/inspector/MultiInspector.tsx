"use client";

// MultiInspector — Figma 식 다중 선택 패널.
//  - 선택 요소 전부가 가진 속성만 노출. 값이 서로 다르면 "Mixed" 표시,
//    편집하면 전체에 그 값 적용.
//  - Selection colors: 선택(+자손)에 쓰인 고유 색을 모아 나열 — 한 색을
//    바꾸면 그 색을 쓰는 모든 곳이 한 번에 바뀐다 (Figma Selection colors).
//  - 채널 armed(스톱워치 ON) 요소는 플레이헤드에 키로, 아니면 base 정적 쓰기
//    (단일 선택 인스펙터와 동일한 AE 시멘틱).

import React from "react";
import { useEditor } from "@/editor/store";
import { getElement, type ElementPath } from "@/editor/specPath";
import { setByPath } from "@/editor/setByPath";
import { Section, Row, NumberInput, ColorInput, TextInput } from "@/editor/controls";
import { sampleElementKeyframes, type ElementKeyframe } from "@engine/motion/keyframes";
import { isChannelArmed, type KfChannel } from "@/editor/elementKeyframes";
import { groupElements, duplicateElements, deleteElements, ensureGroupAnchor } from "@/editor/mutations";
import { useLocalFrame } from "./KeyframeControls";
import s from "./inspector.module.css";

type AnyEl = {
  element: string;
  base?: Record<string, unknown> & {
    position?: { x: number; y: number };
    fromShape?: { x: number; y: number };
  };
  keyframes?: ElementKeyframe[];
  children?: unknown[];
};

const EPS = 1e-4;
const HEX = /^#[0-9a-fA-F]{3,8}$/;

function allEqual(vals: number[]): boolean {
  return vals.every((v) => Math.abs(v - vals[0]) < EPS);
}

// ---- Selection colors 수집 ----
// 선택 루트 + 자손 전부에서 hex 색 사용처를 모은다. loc 은 요소 내부의
// setByPath 경로 — 같은 색끼리 묶어 한 번에 치환.
type ColorRef = { path: ElementPath; loc: string };

function collectColors(
  doc: Parameters<typeof getElement>[0],
  roots: ElementPath[],
): { color: string; refs: ColorRef[] }[] {
  const map = new Map<string, ColorRef[]>();
  const add = (color: unknown, path: ElementPath, loc: string) => {
    if (typeof color !== "string" || !HEX.test(color)) return;
    const key = color.toUpperCase();
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push({ path, loc });
  };
  const paint = (pt: unknown, path: ElementPath, loc: string) => {
    if (typeof pt === "string") add(pt, path, loc);
    else if (pt && typeof pt === "object") {
      const o = pt as { color?: unknown; colors?: unknown[] };
      if (typeof o.color === "string") add(o.color, path, `${loc}.color`);
      if (Array.isArray(o.colors)) o.colors.forEach((c, j) => add(c, path, `${loc}.colors.${j}`));
    }
  };
  const visit = (path: ElementPath) => {
    const el = getElement(doc, path) as AnyEl | null;
    if (!el) return;
    const b = (el.base ?? {}) as Record<string, unknown>;
    add(b.color, path, "base.color");
    add(b.stroke, path, "base.stroke");
    const fill = b.fill;
    if (Array.isArray(fill)) fill.forEach((pt, i) => paint(pt, path, `base.fill.${i}`));
    else if (fill != null) paint(fill, path, "base.fill");
    (el.children ?? []).forEach((_, i) => visit(`${path}.${i}`));
  };
  roots.forEach(visit);
  return [...map.entries()].map(([color, refs]) => ({ color, refs }));
}

export function MultiInspector({ paths }: { paths: ElementPath[] }) {
  const doc = useEditor((st) => st.doc);
  const localFrame = useLocalFrame();
  if (!doc) return null;
  const items = paths
    .map((path) => ({ path, el: getElement(doc, path) as AnyEl | null }))
    .filter((x): x is { path: ElementPath; el: AnyEl } => !!x.el);
  if (items.length < 2) return null;

  const frame = Math.max(0, Math.round(localFrame));

  // ---- 공통 쓰기: 채널 armed 면 플레이헤드 키 upsert, 아니면 base 경로 ----
  const applyAll = (
    label: string,
    chan: KfChannel | null,
    v: number,
    live: boolean,
    baseLocOf: (el: AnyEl) => string | null,
    kfValOf?: (el: AnyEl) => number, // armed 시 채널에 쓸 값(delta/배율 환산)
  ) => {
    useEditor.getState().updateDoc(
      label,
      (draft) => {
        for (const { path } of items) {
          const el = getElement(draft, path) as AnyEl | null;
          if (!el) continue;
          if (chan && isChannelArmed(el, chan)) {
            const kv = Number((kfValOf ? kfValOf(el) : v).toFixed(4));
            if (!Array.isArray(el.keyframes)) el.keyframes = [];
            const kfs = el.keyframes;
            const dup = kfs.findIndex((k) => k.frame === frame && typeof k[chan] === "number");
            if (dup >= 0) (kfs[dup] as Record<string, unknown>)[chan] = kv;
            else kfs.push({ frame, [chan]: kv, easing: "easeInOut" } as ElementKeyframe);
          } else {
            const loc = baseLocOf(el);
            if (loc) setByPath(el as unknown as Record<string, unknown>, loc, v);
          }
        }
      },
      { coalesceKey: live ? `multi-${label}` : undefined },
    );
    if (!live) useEditor.getState().endCoalescing();
  };

  // ---- 값 수집 ----
  const els = items.map((x) => x.el);
  const sampled = els.map((el) => sampleElementKeyframes(el.keyframes, frame));
  const posOf = (el: AnyEl, i: number, axis: "x" | "y") => {
    const kf = sampled[i][axis];
    if (kf != null) return kf;
    const p = (el.element === "gooey" ? el.base?.fromShape : el.base?.position) ?? { x: 0.5, y: 0.5 };
    return p[axis];
  };
  const xs = els.map((el, i) => posOf(el, i, "x"));
  const ys = els.map((el, i) => posOf(el, i, "y"));
  const rots = els.map((el, i) => ((el.base?.rotate as number | undefined) ?? 0) + sampled[i].rotate);
  const scales = els.map((el, i) => ((el.base?.scale as number | undefined) ?? 1) * sampled[i].scale);

  const allText = els.every((el) => el.element === "text");
  const sizes = allText ? els.map((el) => (el.base?.fontSize as number | undefined) ?? 6) : [];
  const weights = allText ? els.map((el) => (el.base?.fontWeight as number | undefined) ?? 600) : [];

  const OPACITY_OK = new Set(["shape", "image", "video", "frame", "group", "neon_pill", "glow_card", "glow_menu"]);
  const allOpacity = els.every((el) => OPACITY_OK.has(el.element));
  const opacities = allOpacity ? els.map((el) => (el.base?.opacity as number | undefined) ?? 1) : [];
  const RADIUS_OK = new Set(["shape", "image", "video", "frame"]);
  const allRadius = els.every((el) => RADIUS_OK.has(el.element));
  const radii = allRadius ? els.map((el) => (el.base?.radius as number | undefined) ?? 0) : [];
  const allBlur = els.every((el) => el.element !== "logo");
  const blurs = allBlur ? els.map((el, i) => ((el.base?.blur as number | undefined) ?? 0) + sampled[i].blur) : [];

  const posLoc = (axis: "x" | "y") => (el: AnyEl) =>
    el.element === "gooey" ? `base.fromShape.${axis}` : `base.position.${axis}`;

  // 그룹 scale/rotate 는 피벗(anchor) 유지
  const ensureAnchors = () => {
    for (const { path, el } of items) if (el.element === "group") ensureGroupAnchor(path);
  };

  // 텍스트 내용 일괄 쓰기 (Figma: 다중 선택 텍스트 편집 = 전체 적용)
  const writeTextAll = (v: string, live: boolean) => {
    useEditor.getState().updateDoc(
      "Text (multi)",
      (draft) => {
        for (const { path } of items) {
          const el = getElement(draft, path) as AnyEl | null;
          if (el?.element === "text") {
            if (!el.base) (el as { base?: Record<string, unknown> }).base = {};
            (el.base as { text?: string }).text = v;
          }
        }
      },
      { coalesceKey: live ? "multi-text" : undefined },
    );
    if (!live) useEditor.getState().endCoalescing();
  };

  const colors = collectColors(doc, paths);
  const applyColor = (refs: ColorRef[], v: string) => {
    useEditor.getState().updateDoc("Selection color", (draft) => {
      for (const r of refs) {
        const el = getElement(draft, r.path) as AnyEl | null;
        if (el) setByPath(el as unknown as Record<string, unknown>, r.loc, v);
      }
    });
  };

  return (
    <div className={s.body}>
      <div className={s.multiHead}>{items.length} elements selected</div>
      <div className={s.multiActions}>
        <button className={s.multiBtn} onClick={() => groupElements(paths)}>Group</button>
        <button className={s.multiBtn} onClick={() => duplicateElements(paths)}>Duplicate</button>
        <button className={s.multiBtn} data-danger onClick={() => deleteElements(paths)}>Delete</button>
      </div>

      <Section title="Transform">
        <Row label="X position">
          <NumberInput
            value={xs[0]} mixed={!allEqual(xs)} min={-10} max={11} step={0.001} displayScale={100} unit="%"
            onChange={(v, o) => applyAll("X position", "x", v, o.live, posLoc("x"))}
          />
        </Row>
        <Row label="Y position">
          <NumberInput
            value={ys[0]} mixed={!allEqual(ys)} min={-10} max={11} step={0.001} displayScale={100} unit="%"
            onChange={(v, o) => applyAll("Y position", "y", v, o.live, posLoc("y"))}
          />
        </Row>
        <Row label="Rotation">
          <NumberInput
            value={rots[0]} mixed={!allEqual(rots)} min={-360} max={360} step={1} unit="°"
            onChange={(v, o) => {
              ensureAnchors();
              applyAll("Rotation", "rotate", v, o.live, () => "base.rotate",
                (el) => v - ((el.base?.rotate as number | undefined) ?? 0));
            }}
          />
        </Row>
        <Row label="Scale">
          <NumberInput
            value={scales[0]} mixed={!allEqual(scales)} min={0} max={8} step={0.01} displayScale={100} unit="%"
            onChange={(v, o) => {
              ensureAnchors();
              applyAll("Scale", "scale", v, o.live, () => "base.scale",
                (el) => v / Math.max(0.0001, (el.base?.scale as number | undefined) ?? 1));
            }}
          />
        </Row>
      </Section>

      {allText && (
        <Section title="Text">
          <Row label="Text" wide>
            <TextInput
              value={String((els[0].base as { text?: string } | undefined)?.text ?? "")}
              onChange={(v) => writeTextAll(v, true)}
              onCommit={(v) => writeTextAll(v, false)}
            />
          </Row>
          <Row label="Size">
            <NumberInput
              value={sizes[0]} mixed={!allEqual(sizes)} min={0.5} max={40} step={0.1}
              onChange={(v, o) => applyAll("Font size", null, v, o.live, () => "base.fontSize")}
            />
          </Row>
          <Row label="Weight">
            <NumberInput
              value={weights[0]} mixed={!allEqual(weights)} min={100} max={900} step={100}
              onChange={(v, o) => applyAll("Font weight", null, v, o.live, () => "base.fontWeight")}
            />
          </Row>
        </Section>
      )}

      <Section title="Appearance">
        {allOpacity && (
          <Row label="Opacity">
            <NumberInput
              value={opacities[0]} mixed={!allEqual(opacities)} min={0} max={1} step={0.01} displayScale={100} unit="%"
              onChange={(v, o) => applyAll("Opacity", null, v, o.live, () => "base.opacity")}
            />
          </Row>
        )}
        {allBlur && (
          <Row label="Blur">
            <NumberInput
              value={blurs[0]} mixed={!allEqual(blurs)} min={0} max={80} step={0.5} unit="px"
              onChange={(v, o) => applyAll("Blur", "blur", v, o.live, () => "base.blur",
                (el) => v - ((el.base?.blur as number | undefined) ?? 0))}
            />
          </Row>
        )}
        {allRadius && (
          <Row label="Corner radius">
            <NumberInput
              value={radii[0]} mixed={!allEqual(radii)} min={0} max={200} step={1} unit="px"
              onChange={(v, o) => applyAll("Corner radius", null, v, o.live, () => "base.radius")}
            />
          </Row>
        )}
      </Section>

      {colors.length > 0 && (
        <Section title="Selection colors">
          {colors.map(({ color, refs }) => (
            <div key={color} className={s.selColorRow}>
              <ColorInput value={color} onChange={(v) => v && applyColor(refs, v)} />
              {refs.length > 1 && <span className={s.selColorCount}>{refs.length}</span>}
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}
