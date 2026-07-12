// detachPresets — 프리셋 monolith 를 일반 요소 조립로 바꾸는 "순수" 변환.
// store 를 건드리지 않아 loadDoc(자동 분해)과 mutations(수동 detach) 양쪽에서
// 쓴다. 문서를 열면 프리셋이 이미 frame/edge_light/shape/text 로 분해되어
// 모든 부분이 개별 선택·표준 패널 편집·트랙 키프레임이 된다 (Figma detach).

import { sceneFrames, type VideoSpec, type SceneElementSpec } from "@engine/motion/SceneRenderer";

const COMP_W = 1920;
const COMP_H = 1080;
const FPS_DEFAULT = 24;

/** edge_light 의 progress 랩 키 생성 — 한 바퀴 = +1, 바퀴 내 이징은 키 이징.
 *  씬 길이를 덮을 만큼 랩을 깐다 (트랙에서 그대로 보이고 수정 가능). */
export function edgeLightLapKeys(periodFrames: number, coverFrames: number, easing = "easeInOut", phase = 0) {
  void coverFrames; // loop:"cycle" 이 무한 반복이라 커버 길이 불필요 (시그니처 유지)
  return [
    { frame: 0, progress: Number(phase.toFixed(4)), easing },
    // 마지막 키의 loop:"cycle" — 이후 프레임이 키 구간 안으로 되접혀 무한 랩.
    // 바퀴 내 이징은 이 세그먼트의 easing 그대로.
    { frame: Math.max(2, Math.round(periodFrames)), progress: Number((phase + 1).toFixed(4)), easing, loop: "cycle" },
  ];
}

// glow_menu 분해 조립 — frame(바) + 아이템별 text(color 키) + 활성 blob shape
// (opacity 키). 레이아웃은 글자수 기반 근사 (분해 후 자유 조정이 목적).
function menuAssembly(vals: {
  id: string;
  position: { x: number; y: number };
  items: { label: string; color?: string }[];
  active: { frame: number; index: number }[];
  switchDuration: number;
  heightVw: number;
  fontVw: number;
  gapVw: number;
  radiusVw: number;
  fillColor: string;
  glass: number;
  cover: number;
}): Record<string, unknown> {
  const PALETTE = ["#5B8CFF", "#A855F7", "#22C55E", "#EF4444", "#F97316"];
  const DIM = "#8A85A0";
  const { items, cover } = vals;
  const fs = vals.fontVw;
  const hVw = vals.heightVw;
  const pad = hVw * 0.25;
  const itemW = (label: string) => label.length * fs * 0.56 + hVw * 0.7;
  const widths = items.map((it) => itemW(it.label));
  const barW = pad * 2 + widths.reduce((a, b) => a + b, 0) + vals.gapVw * (items.length - 1);
  const steps = [...vals.active].sort((a, b) => a.frame - b.frame);
  const dur = Math.max(1, vals.switchDuration);
  // 아이템별 활성 구간 [s, e)
  const segsOf = (i: number) => {
    const out: { s: number; e: number }[] = [];
    for (let k = 0; k < steps.length; k++) {
      if (steps[k].index !== i) continue;
      out.push({ s: steps[k].frame, e: steps[k + 1]?.frame ?? cover });
    }
    return out;
  };
  const children: unknown[] = [];
  let cursor = pad;
  items.forEach((it, i) => {
    const cx = (cursor + widths[i] / 2) / barW;
    cursor += widths[i] + vals.gapVw;
    const color = it.color ?? PALETTE[i % PALETTE.length];
    const segs = segsOf(i);
    const colorKeys: unknown[] = [];
    const blobKeys: unknown[] = [];
    for (const { s: s0, e } of segs) {
      if (s0 <= 0) {
        colorKeys.push({ frame: 0, color: "#FFFFFF" });
        blobKeys.push({ frame: 0, opacity: 0.32 });
      } else {
        colorKeys.push({ frame: s0, color: DIM }, { frame: s0 + dur, color: "#FFFFFF", easing: "easeOut" });
        blobKeys.push({ frame: s0, opacity: 0 }, { frame: s0 + dur, opacity: 0.32, easing: "easeOut" });
      }
      if (e < cover) {
        colorKeys.push({ frame: e, color: "#FFFFFF" }, { frame: e + dur, color: DIM, easing: "easeOut" });
        blobKeys.push({ frame: e, opacity: 0.32 }, { frame: e + dur, opacity: 0, easing: "easeOut" });
      }
    }
    // 활성 blob — 텍스트 뒤 radial 느낌은 blur 로 근사
    children.push({
      element: "shape",
      id: `blob-${i + 1}`,
      base: {
        kind: "ellipse",
        width: Number((widths[i] * 1.15).toFixed(3)),
        height: Number(((hVw * 1.7 * COMP_W) / COMP_H).toFixed(3)),
        position: { x: cx, y: 0.55 },
        fill: color,
        blur: 16,
        opacity: segs.some(({ s: s0 }) => s0 <= 0) ? 0.32 : 0,
      },
      layers: [],
      ...(blobKeys.length ? { keyframes: blobKeys } : {}),
    });
    children.push({
      element: "text",
      id: `item-${i + 1}`,
      base: { text: it.label, fontSize: fs, fontWeight: 500, color: segs.some(({ s: s0 }) => s0 <= 0) ? "#FFFFFF" : DIM, position: { x: cx, y: 0.5 } },
      layers: [],
      ...(colorKeys.length ? { keyframes: colorKeys } : {}),
    });
  });
  return {
    element: "frame",
    id: vals.id,
    base: {
      position: vals.position,
      width: Number(barW.toFixed(3)),
      height: Number(((hVw * COMP_W) / COMP_H).toFixed(3)),
      radius: Math.round((vals.radiusVw / 100) * COMP_W),
      fill: { type: "solid", color: vals.fillColor },
      ...(vals.glass > 0 ? { backdropBlur: vals.glass } : {}),
      stroke: "rgba(255,255,255,0.08)",
      strokeWidth: 1,
      clipsContent: false,
    },
    children,
  };
}

/** 프리셋 monolith 하나를 분해 스펙으로. 대상 아니면 null. */
export function decomposePreset(el: Record<string, unknown>, cover: number): Record<string, unknown> | null {

  const kind = el.element as string;
  if (kind !== "glow_card" && kind !== "neon_pill" && kind !== "glow_menu") return null;
  if (kind === "glow_menu") {
    const mb = (el.base ?? {}) as { position?: { x: number; y: number } };
    return menuAssembly({
      id: (el.id as string) ?? "glow-menu",
      position: mb.position ?? (el.position as { x: number; y: number }) ?? { x: 0.5, y: 0.5 },
      items: (el.items as { label: string; color?: string }[]) ?? [],
      active: (el.active as { frame: number; index: number }[]) ?? [{ frame: 0, index: 0 }],
      switchDuration: (el.switchDuration as number) ?? 10,
      heightVw: (el.height as number) ?? 3.4,
      fontVw: (el.fontSize as number) ?? 1.05,
      gapVw: (el.gap as number) ?? 0.4,
      radiusVw: (el.radius as number) ?? 1.2,
      fillColor: (el.fillColor as string) ?? "rgba(14,12,20,0.72)",
      glass: (el.glass as number) ?? 12,
      cover,
    });
  }

  const base = (el.base ?? {}) as Record<string, unknown> & { position?: { x: number; y: number } };
  const orbit = el.orbit as { period?: number; span?: number; colors?: [string, string]; dim?: string; bloom?: number; easing?: string; reverse?: boolean; phase?: number } | undefined;
  const wVw = (base.width as number) ?? (el.width as number) ?? (kind === "neon_pill" ? 46 : 22);
  const hVw = (base.height as number) ?? (el.height as number) ?? (kind === "neon_pill" ? 6.2 : 15);
  const rVw = (el.radius as number) ?? (kind === "neon_pill" ? hVw * 0.28 : 1.3);
  const bw = (el.borderWidth as number) ?? 3;
  const borderColors = (el.borderColors as [string, string]) ?? ["#B47CFF", "#7C3AED"];
  const framePxW = (wVw / 100) * COMP_W;
  const framePxH = (hVw / 100) * COMP_W;

  const edgeLight = orbit
    ? [{
        element: "edge_light",
        id: "edge-light",
        base: {
          position: { x: 0.5, y: 0.5 },
          // width/height 생략 = 부모 frame 을 채움(auto) — frame 리사이즈에 추종
          radius: rVw,
          span: orbit.span ?? 0.38,
          thickness: bw,
          colors: orbit.colors ?? borderColors,
          ...(orbit.dim ? { dim: orbit.dim } : {}),
          bloom: orbit.bloom ?? 1,
          glow: (el.glow as number) ?? 1,
        },
        keyframes: edgeLightLapKeys(orbit.period ?? 96, cover, orbit.easing ?? "linear", orbit.phase ?? 0).map((k) =>
          orbit.reverse ? { ...k, progress: (orbit.phase ?? 0) * 2 - k.progress } : k,
        ),
      }]
    : [];

  // 등장 램프 -> 표준 레이어 (fade/move in)
  const fadeIn = el.fadeIn as { start?: number; duration?: number } | undefined;
  const rise = (el.rise as number) ?? 0;
  const layers: unknown[] = [];
  if (fadeIn) layers.push({ type: "fade", role: "in", props: { duration: fadeIn.duration ?? 14, delay: fadeIn.start ?? 0 } });
  if (rise > 0) layers.push({ type: "move", role: "in", props: { fromY: ((rise / 100) * COMP_W) / COMP_H, toY: 0, duration: fadeIn?.duration ?? 14, delay: fadeIn?.start ?? 0, easing: "easeOut" } });

  let next: Record<string, unknown>;
  if (kind === "glow_card") {
    const padPx = (((el.padding as number) ?? 1.6) / 100) * COMP_W;
    const iconPx = (2.6 / 100) * COMP_W;
    const iconCx = (padPx + iconPx / 2) / framePxW;
    const iconCy = (padPx + iconPx / 2) / framePxH;
    const leftX = padPx / framePxW;
    const children: unknown[] = [...edgeLight];
    const sheenAmt = (el.sheen as number) ?? 0.5;
    if (sheenAmt > 0) {
      children.push({
        element: "shape",
        id: "sheen",
        base: {
          kind: "rectangle",
          width: wVw,
          height: Number(((framePxH / COMP_H) * 100).toFixed(3)),
          radius: Math.round((rVw / 100) * COMP_W),
          position: { x: 0.5, y: 0.5 },
          fill: { type: "gradient", css: `linear-gradient(175deg, rgba(255,255,255,${(0.07 * sheenAmt).toFixed(3)}) 0%, transparent 38%)` },
        },
        layers: [],
      });
    }
    if (el.icon) {
      children.push(
        { element: "shape", id: "icon-box", base: { kind: "rectangle", width: 2.6, height: Number(((iconPx / COMP_H) * 100).toFixed(3)), radius: 11, position: { x: iconCx, y: iconCy }, fill: "rgba(255,255,255,0.04)", stroke: "rgba(255,255,255,0.12)", strokeWidth: 1 }, layers: [] },
        { element: "text", id: "icon-glyph", base: { text: String(el.icon), fontSize: 1.3, fontWeight: 500, color: "#E7E2F2", position: { x: iconCx, y: iconCy } }, layers: [] },
      );
    }
    if (el.title) children.push({ element: "text", id: "title", base: { text: String(el.title), fontSize: (el.titleSize as number) ?? 1.5, fontWeight: 600, color: (el.titleColor as string) ?? "#F4F1FA", anchor: "left", position: { x: leftX, y: 0.74 } }, layers: [] });
    if (el.description) children.push({ element: "text", id: "description", base: { text: String(el.description), fontSize: (el.descSize as number) ?? 1.0, fontWeight: 400, color: (el.descColor as string) ?? "rgba(228,222,244,0.55)", anchor: "left", position: { x: leftX, y: 0.86 } }, layers: [] });
    next = {
      element: "frame",
      id: (el.id as string) ?? "glow-card",
      base: {
        position: base.position ?? { x: 0.5, y: 0.5 },
        width: wVw,
        height: Number(((framePxH / COMP_H) * 100).toFixed(3)),
        radius: Math.round((rVw / 100) * COMP_W),
        fill: { type: "solid", color: (el.fillColor as string) ?? "rgba(16,13,24,0.62)" },
        ...(((el.glass as number) ?? 14) > 0 ? { backdropBlur: (el.glass as number) ?? 14 } : {}),
        // orbit 없는 카드(정적 네온 링)는 링을 frame stroke 로 승계, 아니면 hairline
        ...(!orbit && ((el.glow as number) ?? 0.8) > 0 && bw > 0
          ? { stroke: borderColors[0], strokeWidth: bw }
          : el.hairline && el.hairline !== "rgba(0,0,0,0)"
            ? { stroke: el.hairline as string, strokeWidth: 1 }
            : {}),
        clipsContent: false,
        ...(base.rotate != null ? { rotate: base.rotate } : {}),
        ...(base.opacity != null ? { opacity: base.opacity } : {}),
        ...(base.scale != null ? { scale: base.scale } : {}),
        ...(base.blur != null ? { blur: base.blur } : {}),
      },
      ...(layers.length ? { layers } : {}),
      ...(el.keyframes ? { keyframes: el.keyframes } : {}),
      ...(el.timing ? { timing: el.timing } : {}),
      children,
    };
  } else {
    // neon_pill — frame(알약) + edge_light + 모드별 콘텐츠 (type/swap/dots)
    const padVw = (el.paddingLeft as number) ?? wVw * 0.07;
    const fsVw = (el.fontSize as number) ?? hVw * 0.42;
    const mode = (el.mode as string) ?? "type";
    const children: unknown[] = [...edgeLight];
    if (mode === "type") {
      children.push({
        element: "text",
        id: "typed-text",
        base: {
          text: String(el.text ?? ""),
          fontSize: fsVw,
          fontWeight: (el.fontWeight as number) ?? 600,
          color: (el.color as string) ?? "#FFFFFF",
          anchor: "left",
          position: { x: padVw / wVw, y: 0.5 },
        },
        layers: [
          { type: "typewriter", role: "in", props: { unit: "char", mode: "type", charsPerSecond: (el.charsPerSecond as number) ?? 15, cursor: "light", delay: (el.typeStart as number) ?? 0, ...(el.freshTint ? { freshTint: el.freshTint } : {}) } },
        ],
      });
    } else if (mode === "swap") {
      // 단어 룰렛 — 단어별 텍스트에 y/opacity/blur 롤 키 (근사 분해)
      const prefix = (el.fixedPrefix as string) ?? "";
      const words = ((el.swapWords as { text: string; frame: number }[]) ?? []).slice().sort((a, b) => a.frame - b.frame);
      const dur = (el.swapDuration as number) ?? 7;
      const anchorLeft = (el.align ?? "center") === "left";
      const xBase = anchorLeft ? padVw / wVw : 0.5;
      if (prefix) {
        children.push({
          element: "text",
          id: "prefix",
          base: { text: prefix, fontSize: fsVw, fontWeight: (el.fontWeight as number) ?? 600, color: (el.color as string) ?? "#FFFFFF", anchor: "left", position: { x: xBase, y: 0.5 } },
          layers: [],
        });
      }
      const wordX = anchorLeft ? xBase + (prefix.length * fsVw * 0.62) / wVw : 0.5;
      words.forEach((w, k) => {
        const s0 = w.frame;
        const e = words[k + 1]?.frame ?? cover;
        const kfs: unknown[] = [];
        if (s0 > 0) {
          kfs.push(
            { frame: s0, y: 0.95, easing: "easeOut" },
            { frame: s0 + dur, y: 0.5, easing: "easeOut" },
            { frame: s0, opacity: 0 },
            { frame: s0 + dur, opacity: 1, easing: "easeOut" },
            { frame: s0, blur: 8 },
            { frame: s0 + dur, blur: 0, easing: "easeOut" },
          );
        }
        if (e < cover) {
          kfs.push(
            { frame: e, y: 0.5 }, { frame: e + dur, y: 0.05, easing: "easeIn" },
            { frame: e, opacity: 1 }, { frame: e + dur, opacity: 0, easing: "easeIn" },
            { frame: e, blur: 0 }, { frame: e + dur, blur: 8, easing: "easeIn" },
          );
        }
        children.push({
          element: "text",
          id: `word-${k + 1}`,
          base: { text: w.text, fontSize: fsVw, fontWeight: (el.fontWeight as number) ?? 600, color: (el.color as string) ?? "#FFFFFF", anchor: anchorLeft ? "left" : undefined, position: { x: wordX, y: 0.5 }, opacity: s0 > 0 ? 0 : 1 },
          layers: [],
          ...(kfs.length ? { keyframes: kfs } : {}),
          timing: { start: Math.max(0, s0), ...(e < cover ? { end: Math.min(cover, e + dur + 1) } : {}) },
        });
      });
    } else {
      // dots — 점 3개 펄스 (opacity pingpong 루프 = 무한, 키 2개씩)
      const period = (el.dotPeriod as number) ?? 22;
      const n = (el.dotCount as number) ?? 3;
      const dotVw = fsVw * 0.28;
      for (let i = 0; i < n; i++) {
        const cx = 0.5 + ((i - (n - 1) / 2) * fsVw * 0.73) / wVw;
        children.push({
          element: "shape",
          id: `dot-${i + 1}`,
          base: { kind: "ellipse", width: dotVw, height: Number(((dotVw / 100) * COMP_W / COMP_H * 100).toFixed(3)), position: { x: cx, y: 0.5 }, fill: (el.color as string) ?? "#FFFFFF" },
          layers: [],
          keyframes: [
            { frame: i * Math.round(period * 0.15), opacity: 1 },
            { frame: i * Math.round(period * 0.15) + Math.round(period / 2), opacity: 0.25, easing: "easeInOut", loop: "pingpong" },
          ],
        });
      }
    }
    next = {
      element: "frame",
      id: (el.id as string) ?? "glow-input",
      base: {
        position: base.position ?? { x: 0.5, y: 0.5 },
        width: wVw,
        height: Number(((framePxH / COMP_H) * 100).toFixed(3)),
        radius: Math.round((rVw / 100) * COMP_W),
        fill: { type: "solid", color: (el.fillColor as string) ?? "#0A0714" },
        clipsContent: false,
        ...(base.rotate != null ? { rotate: base.rotate } : {}),
        ...(base.opacity != null ? { opacity: base.opacity } : {}),
        ...(base.scale != null ? { scale: base.scale } : {}),
        ...(base.blur != null ? { blur: base.blur } : {}),
      },
      ...(layers.length ? { layers } : {}),
      ...(el.keyframes ? { keyframes: el.keyframes } : {}),
      ...(el.timing ? { timing: el.timing } : {}),
      children,
    };
  }

  return next;
}



/** 문서 전체 자동 분해 — 씬/컨테이너를 재귀로 걸어 프리셋을 교체. 로드 시 1회. */
export function migrateDetachPresets(doc: VideoSpec, fps = FPS_DEFAULT): VideoSpec {
  const visit = (els: SceneElementSpec[] | undefined, cover: number, parentIsFrame = false) => {
    if (!els) return;
    for (let i = 0; i < els.length; i++) {
      const el = els[i] as unknown as Record<string, unknown>;
      const next = decomposePreset(el, cover);
      if (next) els[i] = next as unknown as SceneElementSpec;
      const cur = els[i] as unknown as Record<string, unknown>;
      // 레거시 정규화: 초기 분해가 edge_light 에 vw 크기를 박아 frame 리사이즈를
      // 안 따라갔다 — frame 직속 edge_light 는 auto(부모 채움)로 승격.
      if (parentIsFrame && cur.element === "edge_light") {
        const b = cur.base as { width?: number; height?: number } | undefined;
        if (b) {
          delete b.width;
          delete b.height;
        }
      }
      const kids = (els[i] as { children?: SceneElementSpec[] }).children;
      if (Array.isArray(kids)) visit(kids, cover, (els[i] as { element?: string }).element === "frame");
    }
  };
  for (const scene of doc.scenes ?? []) {
    visit(scene.elements, sceneFrames(scene, fps));
  }
  return doc;
}
