"use client";

// KeyframeControls — 인스펙터의 요소 속성 키프레임 UI.
//  - KeyframeToggle: 채널별 스톱워치(◇/◆) 토글. 켜면 arm, 끄면 confirm 후 disarm.
//  - XYRow / RotationKfRow / ScaleKfRow / OpacityKfRow: 스톱워치 + 값 편집 Row.
//    armed 면 플레이헤드 보간값을 보여주고 편집이 upsertChannelKey 로,
//    armed 아니면 기존 base 필드 편집(writeElementField)으로 라우팅.
//  - ElementKeyframeEditor: 선택된 키프레임(selectedElKeyframe) 한 개 편집 패널
//    (SceneInspector 의 KeyframeCameraEditor 를 요소용으로 미러링).

import { uiConfirm } from "@/editor/ui/dialogs";
import React from "react";
import { useEditor } from "@/editor/store";
import { Select, Section, Row, NumberInput, EasingChip } from "@/editor/controls";
import { sampleElementKeyframes } from "@engine/motion/keyframes";
import {
  setChannelLoop,
  CHANNEL_META,
  type KfChannel,
  isChannelArmed,
  armChannel,
  disarmChannel,
  upsertChannelKey,
  getElementKeyframes,
  channelKeys,
  channelsForElement,
  deleteElementKeyframe,
  addElementKeyframeAt,
  selectElementKeyframe,
  setElementKeyframeValue,
} from "@/editor/elementKeyframes";
import type { ElementPath } from "@/editor/specPath";
import { usePlayerFrame, seekTo } from "@/editor/playerBridge";
import { sceneStarts } from "@/editor/timing";
import { FPS } from "@/engine/normalize";
import { writeElementField } from "./writes";
import { ensureGroupAnchor } from "@/editor/mutations";
import s from "@/editor/controls/controls.module.css";

// 플레이헤드의 씬-로컬 프레임. usePlayerFrame 구독을 여기(리프 Row)에 가둬서
// 인스펙터 전체가 매 프레임 재렌더되지 않도록 한다(playerBridge 설계 원칙).
export function useLocalFrame(): number {
  const doc = useEditor((st) => st.doc);
  const activeScene = useEditor((st) => st.activeScene);
  const gf = usePlayerFrame();
  if (!doc) return 0;
  return Math.max(0, Math.round(gf - (sceneStarts(doc, FPS)[activeScene] ?? 0)));
}

// --- 스톱워치 토글 ---
export function KeyframeToggle({
  el,
  path,
  channel,
}: {
  el: unknown;
  path: ElementPath;
  channel: KfChannel;
}) {
  const localFrame = useLocalFrame();
  const armed = isChannelArmed(el, channel);
  const meta = CHANNEL_META[channel];
  const onClick = async () => {
    if (!armed) armChannel(path, channel, localFrame);
    // 켜져 있으면 모든 키를 지우므로 파괴적 — confirm 한 번.
    else if (await uiConfirm(`Remove all ${meta.label} keyframes?`, { danger: true, okLabel: "Remove" })) disarmChannel(path, channel, localFrame); // 현재 값 base 로 bake
  };
  return (
    <button
      type="button"
      className={s.kfStopwatch}
      data-armed={armed}
      onClick={onClick}
      title={armed ? `Stop animating ${meta.label}` : `Animate ${meta.label}`}
      style={armed ? { color: meta.color } : undefined}
    >
      {/* AE 스톱워치: 크라운 버튼 + 몸통 + 12시 바늘. armed 면 채널색. */}
      <svg width="12" height="13" viewBox="0 0 12 13">
        <path d="M4.5 1h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        <path d="M6 1v1.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        <path d="M9.7 3.1l0.9 0.9" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
        <circle
          cx="6"
          cy="7.6"
          r="4.1"
          fill={armed ? "currentColor" : "none"}
          fillOpacity={armed ? 0.25 : undefined}
          stroke="currentColor"
          strokeWidth="1.2"
        />
        <path d="M6 7.6V5.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <circle cx="6" cy="7.6" r="0.8" fill="currentColor" />
      </svg>
    </button>
  );
}

// AE 식 키프레임 내비게이터 — armed 채널 행 오른쪽 ◀ ◆ ▶.
// ◀/▶: 이전/다음 키로 플레이헤드 점프 + 그 키 선택(아래 Keyframe 이징 패널 표시).
// ◆: 플레이헤드 위치에 키 토글 — 있으면 삭제, 없으면 현재 보간값으로 추가.
function KfNavigator({
  el,
  path,
  channel,
}: {
  el: unknown;
  path: ElementPath;
  channel: KfChannel;
}) {
  const localFrame = useLocalFrame();
  const doc = useEditor((st) => st.doc);
  const activeScene = useEditor((st) => st.activeScene);
  const keys = channelKeys(el, channel);
  const atIdx = keys.findIndex((k) => Math.round(k.kf.frame) === localFrame);
  const at = atIdx >= 0;
  const prev = [...keys].reverse().find((k) => k.kf.frame < localFrame);
  const next = keys.find((k) => k.kf.frame > localFrame);
  const start = doc ? sceneStarts(doc, FPS)[activeScene] ?? 0 : 0;
  const go = (k: { kf: { frame: number }; index: number }) => {
    seekTo(start + k.kf.frame);
    selectElementKeyframe(path, channel, k.index);
  };
  const toggle = () => {
    if (at) deleteElementKeyframe(path, keys[atIdx].index);
    else {
      const idx = addElementKeyframeAt(path, channel, localFrame);
      if (idx >= 0) selectElementKeyframe(path, channel, idx);
    }
  };
  const meta = CHANNEL_META[channel];
  return (
    <span className={s.kfNavGroup}>
      <button type="button" className={s.kfNav} disabled={!prev} onClick={() => prev && go(prev)} title="Previous keyframe">
        <svg width="9" height="9" viewBox="0 0 10 10"><path d="M6.8 2 3.2 5l3.6 3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <button
        type="button"
        className={s.kfNav}
        data-at={at}
        onClick={toggle}
        title={at ? "Remove keyframe at playhead" : "Add keyframe at playhead"}
        style={at ? { color: meta.color } : undefined}
      >
        <svg width="9" height="9" viewBox="0 0 12 12"><path d="M6 1.5 10.5 6 6 10.5 1.5 6Z" fill={at ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
      </button>
      <button type="button" className={s.kfNav} disabled={!next} onClick={() => next && go(next)} title="Next keyframe">
        <svg width="9" height="9" viewBox="0 0 10 10"><path d="M3.2 2 6.8 5 3.2 8" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
    </span>
  );
}

// 스톱워치 + 라벨 + 컨트롤 그리드 (비-애니 Row 와 라벨 열 정렬 유지: 14+6+56 ≈ 76)
// armed 면 오른쪽에 키프레임 내비게이터(◀ ◆ ▶)가 붙는다 — 요소를 클릭하는 즉시
// 패널에서 키 탐색/추가/삭제 가능 (트랙에서 키를 집을 필요 없음).
export function KfRow({
  el,
  path,
  channel,
  label,
  children,
}: {
  el: unknown;
  path: ElementPath;
  channel: KfChannel;
  label: string;
  children: React.ReactNode;
}) {
  const armed = isChannelArmed(el, channel);
  return (
    <div className={s.kfRow}>
      <KeyframeToggle el={el} path={path} channel={channel} />
      <span className={s.kfRowLabel}>{label}</span>
      {children}
      {armed && <KfNavigator el={el} path={path} channel={channel} />}
    </div>
  );
}

// --- X / Y 위치 (base.position 오버라이드) ---
export function XYRow({
  el,
  path,
  axis,
  pos,
}: {
  el: unknown;
  path: ElementPath;
  axis: "x" | "y";
  pos: { x: number; y: number };
}) {
  const localFrame = useLocalFrame();
  const armed = isChannelArmed(el, axis);
  const label = axis === "x" ? "X position" : "Y position";
  // armed 면 보간값(없으면 base 폴백), 아니면 base.position 값.
  const sampled = sampleElementKeyframes(getElementKeyframes(el), localFrame)[axis];
  const value = armed ? (sampled == null ? pos[axis] : sampled) : pos[axis];
  const onChange = (v: number, live: boolean) => {
    if (armed) upsertChannelKey(path, axis, localFrame, v, live);
    else writeElementField(path, `base.position.${axis}`, v, live, label);
  };
  return (
    <KfRow el={el} path={path} channel={axis} label={label}>
      {/* 캔버스 밖 배치 허용 — 큰 스케일/오프캔버스 연출용 (Figma 동일) */}
      <NumberInput value={value} min={-10} max={11} step={0.001} displayScale={100} unit="%" onChange={(v, o) => onChange(v, o.live)} />
    </KfRow>
  );
}

// --- 회전 (base.rotate 정적값 + 키프레임 delta 가산) ---
export function RotationKfRow({
  el,
  path,
  baseRotate,
}: {
  el: unknown;
  path: ElementPath;
  baseRotate: number;
}) {
  const localFrame = useLocalFrame();
  const armed = isChannelArmed(el, "rotate");
  // 엔진: 최종 회전 = base.rotate(정적) + sampled.rotate(가산 delta).
  // 필드는 TOTAL 을 보여주고, 저장 시엔 delta = total - base.rotate 로 환산한다.
  const delta = sampleElementKeyframes(getElementKeyframes(el), localFrame).rotate;
  const shown = armed ? baseRotate + delta : baseRotate;
  const onChange = (v: number, live: boolean) => {
    if ((el as { element?: string }).element === "group") ensureGroupAnchor(path);
    if (armed) upsertChannelKey(path, "rotate", localFrame, v - baseRotate, live); // delta 로 환산
    else writeElementField(path, "base.rotate", v, live, "Rotation");
  };
  return (
    <KfRow el={el} path={path} channel="rotate" label="Rotation">
      <NumberInput value={shown} min={-180} max={180} step={1} unit="°" onChange={(v, o) => onChange(v, o.live)} />
    </KfRow>
  );
}

// --- 스케일 (transform 배수. base 필드 없음 → 편집이 곧 arm) ---
export function ScaleKfRow({ el, path }: { el: unknown; path: ElementPath }) {
  const localFrame = useLocalFrame();
  const armed = isChannelArmed(el, "scale");
  // AE 시멘틱: 스톱워치 OFF = 정적 base.scale 편집(키 안 찍힘), ON = 키프레임.
  // 엔진은 base.scale * kf.scale 곱 합성 — 표시는 유효값(절대), 키는 배율로 환산.
  const baseScale = ((el as { base?: { scale?: number } }).base?.scale as number | undefined) ?? 1;
  const kfScale = sampleElementKeyframes(getElementKeyframes(el), localFrame).scale;
  const value = armed ? baseScale * kfScale : baseScale;
  const onChange = (v: number, live: boolean) => {
    // 그룹은 피벗을 자식 콘텐츠 중심으로 유지 — comp 중앙 기준 수축 드리프트 방지
    if ((el as { element?: string }).element === "group") ensureGroupAnchor(path);
    if (armed) upsertChannelKey(path, "scale", localFrame, v / Math.max(0.0001, baseScale), live);
    else writeElementField(path, "base.scale", v, live, "Scale");
  };
  return (
    <KfRow el={el} path={path} channel="scale" label="Scale">
      {/* 상한 800% — 캔버스 리사이즈 핸들(sizeParamsOf max 8)과 동일 */}
      <NumberInput value={value} min={0} max={8} step={0.01} displayScale={100} unit="%" onChange={(v, o) => onChange(v, o.live)} />
    </KfRow>
  );
}

// --- 블러 (base.blur 정적 px + 키프레임 가산 — AE 스톱워치 시멘틱) ---
export function BlurKfRow({ el, path }: { el: unknown; path: ElementPath }) {
  const localFrame = useLocalFrame();
  const armed = isChannelArmed(el, "blur");
  const baseBlur = ((el as { base?: { blur?: number } }).base?.blur as number | undefined) ?? 0;
  const kfBlur = sampleElementKeyframes(getElementKeyframes(el), localFrame).blur;
  const value = armed ? baseBlur + kfBlur : baseBlur;
  const onChange = (v: number, live: boolean) => {
    if (armed) upsertChannelKey(path, "blur", localFrame, v - baseBlur, live);
    else writeElementField(path, "base.blur", v, live, "Blur");
  };
  return (
    <KfRow el={el} path={path} channel="blur" label="Blur">
      <NumberInput value={value} min={0} max={80} step={0.5} unit="px" onChange={(v, o) => onChange(v, o.live)} />
    </KfRow>
  );
}

// --- 3D 자세 (rotateX=위아래 기울기 / rotateY=좌우 팬 — 절대 deg, base 폴백) ---
export function Rot3DKfRow({
  el,
  path,
  axis,
}: {
  el: unknown;
  path: ElementPath;
  axis: "rotateX" | "rotateY";
}) {
  const localFrame = useLocalFrame();
  const armed = isChannelArmed(el, axis);
  const baseVal = ((el as { base?: Record<string, unknown> }).base?.[axis] as number | undefined) ?? 0;
  const sampled = sampleElementKeyframes(getElementKeyframes(el), localFrame)[axis];
  const value = armed ? (sampled == null ? baseVal : sampled) : baseVal;
  const label = CHANNEL_META[axis].label;
  const onChange = (v: number, live: boolean) => {
    if (armed) upsertChannelKey(path, axis, localFrame, v, live);
    else writeElementField(path, `base.${axis}`, v, live, label);
  };
  return (
    <KfRow el={el} path={path} channel={axis} label={label}>
      {/* 3D 회전 전 범위 — 다회전 스핀(0->360xN, loop) 직접 키잉 지원. 과거 +-80
          제한은 CSS 원근 기울기 시절 가드였고 회전 채널엔 근거 없음. */}
      <NumberInput value={value} min={-1080} max={1080} step={1} unit="deg" onChange={(v, o) => onChange(v, o.live)} />
    </KfRow>
  );
}

// --- 경로 진행도 (group path layout 전용) ---
// base 필드가 없는 키프레임 전용 채널(opacity 의 base 없음 케이스와 동일) —
// 값 편집이 곧 arm. AE Path Progress 키프레임 등가: 타임라인 다이아 + 세그먼트
// 이징(키 선택 -> Keyframe 패널의 EasingChip)으로 속도/가감속을 조절한다.
export function PathProgressKfRow({ el, path }: { el: unknown; path: ElementPath }) {
  const localFrame = useLocalFrame();
  const sampled = sampleElementKeyframes(getElementKeyframes(el), localFrame).progress;
  const value = sampled ?? 0;
  return (
    <KfRow el={el} path={path} channel="progress" label="Progress">
      <NumberInput
        value={value}
        min={0}
        max={1}
        step={0.01}
        displayScale={100}
        unit="%"
        onChange={(v, o) => upsertChannelKey(path, "progress", localFrame, v, o.live)}
      />
    </KfRow>
  );
}

// --- 깊이 Z (3D 씬 전용 의미 — comp-width %, +z = 화면 안쪽) ---
export function DepthZKfRow({ el, path }: { el: unknown; path: ElementPath }) {
  const localFrame = useLocalFrame();
  const armed = isChannelArmed(el, "z");
  const baseVal = ((el as { base?: { z?: number } }).base?.z) ?? 0;
  const sampled = sampleElementKeyframes(getElementKeyframes(el), localFrame).z;
  const value = armed ? (sampled == null ? baseVal : sampled) : baseVal;
  const onChange = (v: number, live: boolean) => {
    if (armed) upsertChannelKey(path, "z", localFrame, v, live);
    else writeElementField(path, "base.z", v || undefined, live, "Depth Z");
  };
  return (
    <KfRow el={el} path={path} channel="z" label="Depth Z">
      <NumberInput value={value} min={-400} max={240} step={1} unit="%" onChange={(v, o) => onChange(v, o.live)} />
    </KfRow>
  );
}

// --- 불투명도 ---
// shape 는 base.opacity 가 있어 armed 아니면 거기 씀. text/logo 는 base 필드가
// 없어 키프레임 배수 전용(편집이 곧 arm). basePath 유무로 분기.
export function OpacityKfRow({
  el,
  path,
  baseOpacity,
  basePath,
}: {
  el: unknown;
  path: ElementPath;
  baseOpacity: number;
  basePath?: string; // 예: "base.opacity" (shape). 없으면 키프레임 전용.
}) {
  const localFrame = useLocalFrame();
  const armed = isChannelArmed(el, "opacity");
  const value = armed ? sampleElementKeyframes(getElementKeyframes(el), localFrame).opacity : baseOpacity;
  const onChange = (v: number, live: boolean) => {
    if (armed) upsertChannelKey(path, "opacity", localFrame, v, live);
    else if (basePath) writeElementField(path, basePath, v, live, "Opacity");
    else upsertChannelKey(path, "opacity", localFrame, v, live); // base 없음 → arm
  };
  return (
    <KfRow el={el} path={path} channel="opacity" label="Opacity">
      <NumberInput value={value} min={0} max={1} step={0.01} displayScale={100} unit="%" onChange={(v, o) => onChange(v, o.live)} />
    </KfRow>
  );
}

// --- 선택된 키프레임 편집 패널 (KeyframeCameraEditor 요소판) ---
// 채널당 단일 채널 엔트리라 kf[channel] 이 그 키의 값이다.
function formatChannelValue(channel: KfChannel, v: number): string {
  if (channel === "rotate") return `${v.toFixed(1)}° delta`;
  if (channel === "rotateX" || channel === "rotateY") return `${v.toFixed(1)}°`;
  if (channel === "scale") return `${Math.round(v * 100)}%`;
  if (channel === "blur") return `${v.toFixed(1)}px`;
  return `${(v * 100).toFixed(channel === "x" || channel === "y" ? 1 : 0)}%`;
}

// 채널별 NumberInput 표시 설정(%/° 스케일·스텝). formatChannelValue 와 일관.
function channelInputProps(channel: KfChannel): {
  min?: number; max?: number; step: number; displayScale: number; unit?: string;
} {
  switch (channel) {
    case "opacity":
    case "progress":
      return { min: 0, max: 1, step: 0.01, displayScale: 100, unit: "%" };
    case "scale":
      return { min: 0, max: 8, step: 0.01, displayScale: 100, unit: "%" };
    case "x":
    case "y":
    case "w":
    case "h":
      return { step: 0.005, displayScale: 100, unit: "%" };
    case "rotate":
    case "rotateX":
    case "rotateY":
      return { step: 1, displayScale: 1, unit: "°" };
    case "blur":
      return { min: 0, step: 0.5, displayScale: 1, unit: "px" };
    default:
      return { step: 1, displayScale: 1 };
  }
}

// 요소의 모든 키프레임을 채널별로 나열하는 토글 박스 — 다이아몬드를 눌러야만
// 보이던 단일 편집기를 대체(사용자 요청). 각 키: 프레임 · 값 · 이징 칩 · 삭제.
// 행 클릭 = 그 키 선택 + 플레이헤드 이동(타임라인과 동기). 채널마다 루프 옵션.
export function ElementKeyframeEditor({ el, path }: { el: unknown; path: ElementPath }) {
  const sel = useEditor((st) => st.ui.selectedElKeyframe);
  const doc = useEditor((st) => st.doc);
  const activeScene = useEditor((st) => st.activeScene);

  const armed = channelsForElement(el as Parameters<typeof channelsForElement>[0]).filter(
    (c) => channelKeys(el, c).length > 0,
  );
  if (armed.length === 0) return null; // 키프레임 없으면 섹션 자체를 숨김
  const start = doc ? sceneStarts(doc, FPS)[activeScene] ?? 0 : 0;

  return (
    <Section title="Keyframes">
      <div className={s.kfList}>
        {armed.map((c) => {
          const keys = channelKeys(el, c); // 프레임순 정렬됨
          const meta = CHANNEL_META[c];
          const loop = (keys[keys.length - 1]?.kf.loop as string) ?? "";
          return (
            <div key={c} className={s.kfChanGroup}>
              <div className={s.kfChanHead}>
                <span className={s.kfChanDot} style={{ background: meta.color }} />
                <span className={s.kfChanName}>{meta.label}</span>
                <span className={s.kfChanCount}>{keys.length}</span>
              </div>
              {keys.map(({ kf, index }, ord) => {
                const selected = sel?.path === path && sel.channel === c && sel.kfIndex === index;
                const val = kf[c];
                return (
                  <div
                    key={index}
                    className={s.kfListRow}
                    data-selected={selected}
                    onClick={() => {
                      selectElementKeyframe(path, c, index);
                      seekTo(start + kf.frame);
                    }}
                  >
                    {/* 윗줄: 프레임 · 값(인라인 편집) · 삭제 */}
                    <div className={s.kfListTop}>
                      <span className={s.kfListFrame}>f{kf.frame}</span>
                      {typeof val === "number" ? (
                        <div
                          className={s.kfListValEdit}
                          onClick={(e) => e.stopPropagation()}
                          onPointerDown={(e) => e.stopPropagation()}
                        >
                          <NumberInput
                            value={val}
                            {...channelInputProps(c)}
                            onChange={(v, o) => setElementKeyframeValue(path, index, c, v, o.live)}
                          />
                        </div>
                      ) : (
                        <span className={s.kfListVal}>—</span>
                      )}
                      {ord === 0 && <span className={s.kfListStart}>start</span>}
                      <button
                        className={s.kfListDel}
                        title="Delete keyframe"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteElementKeyframe(path, index);
                        }}
                      >
                        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
                      </button>
                    </div>
                    {/* 아랫줄: 이징(전폭). 첫 키는 진입 세그먼트가 없어 생략. */}
                    {ord > 0 && (
                      <div className={s.kfListEase} onClick={(e) => e.stopPropagation()}>
                        <EasingChip
                          value={typeof kf.easing === "string" ? kf.easing : "easeInOut"}
                          target={{ elementKf: { path, channel: c, kfIndex: index }, value: typeof kf.easing === "string" ? kf.easing : undefined }}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
              {/* 채널 루프 (AE loopOut) — 마지막 키 이후 무한 반복 */}
              <div className={s.kfChanLoop}>
                <Select
                  value={loop}
                  options={[
                    { value: "", label: "Loop: none" },
                    { value: "cycle", label: "Loop: cycle" },
                    { value: "pingpong", label: "Loop: pingpong" },
                    { value: "continue", label: "Loop: continue" },
                  ]}
                  onChange={(v) => setChannelLoop(path, c, v || undefined)}
                />
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}
