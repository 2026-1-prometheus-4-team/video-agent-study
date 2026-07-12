// Director plan -> CapturedAdSpec. Gemini 가 작성한 "기획서"(plan.json)를 받아
// 검증/보정하고, 타겟 참조(번호/알파벳)를 실제 좌표로 해석해 렌더 가능한 spec 으로.
//
// plan 의 모양(디렉터 출력):
//   { input: <candidate id>, send: <candidate id|null>, typedText,
//     shots: [ {kind, durationInFrames, target?, from?, to?, zoom?} ], note }
// - input/send 는 candidates.json 의 번호(박스 내부 클릭 후보)
// - spotlight.target / heroPan.from,to 는 pageTargets.json 의 알파벳(카메라 타겟)
// 잘못된 shot/타겟은 버리고 경고를 남긴다(LLM 출력 신뢰경계).
import { buildCapturedSpec, type CaptureData, type CapturedAdSpec, type CapturedAssets } from "./spec";
import type { Shot } from "./shots";

export type RBox = { x: number; y: number; w: number; h: number };
export type Candidate = { id: number; tag: string; role?: string; input?: boolean; clickable?: boolean; isBox?: boolean; text?: string; relBox: RBox };
export type PageTarget = { id: string; tag: string; text: string; box: RBox };
export type RawShot = { kind: string; durationInFrames?: number; target?: string; from?: string; to?: string; zoom?: number };
export type Plan = { input: number | null; send: number | null; typedText: string; shots?: RawShot[]; note?: string };

export type PlanBrand = {
  textColor?: string; caretColor?: string; outroFill?: string; sendBtnFill?: string;
  placeholder?: string; fontSizePx?: number;
};

const VALID = new Set(["hold", "focusInput", "typeInto", "panToSend", "clickFill", "spotlight", "heroPan"]);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function buildSpecFromPlan(
  capture0: CaptureData,
  assets: CapturedAssets,
  candidates: Candidate[],
  pageTargets: PageTarget[],
  plan: Plan,
  brand: PlanBrand = {},
): { spec: CapturedAdSpec; warnings: string[] } {
  const warnings: string[] = [];
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const tById = new Map(pageTargets.map((t) => [t.id, t]));

  const inputC = plan.input != null ? byId.get(plan.input) : undefined;
  const sendC = plan.send != null ? byId.get(plan.send) : undefined;
  if (plan.input != null && !inputC) warnings.push(`input id ${plan.input} not in candidates`);
  if (plan.send != null && !sendC) warnings.push(`send id ${plan.send} not in candidates`);

  // 비전이 고른 전송버튼 좌표 주입(없으면 원래 capture 값 유지).
  const capture: CaptureData = {
    ...capture0,
    sendBtn: sendC
      ? { relX: sendC.relBox.x, relY: sendC.relBox.y, w: sendC.relBox.w, h: sendC.relBox.h, background: "rgba(0,0,0,0)", color: "#fff" }
      : capture0.sendBtn,
  };

  const bb = capture.bbox;
  const vw = capture.viewport.w;
  const baseZoom = clamp((vw * 0.6) / Math.max(bb.w, 1), 1.6, 2.6);

  // RawShot -> Shot: kind/duration 검증·클램프, 타겟 참조 해석.
  const shots: Shot[] = [];
  for (const rs of plan.shots ?? []) {
    if (!VALID.has(rs.kind)) { warnings.push(`drop unknown shot "${rs.kind}"`); continue; }
    const dur = clamp(Math.round(rs.durationInFrames ?? 24), 6, 120);
    if (rs.kind === "spotlight") {
      const t = rs.target ? tById.get(rs.target) : undefined;
      if (!t) { warnings.push(`drop spotlight: target "${rs.target}" not found`); continue; }
      shots.push({ kind: "spotlight", durationInFrames: dur, target: t.box, zoom: rs.zoom ?? clamp((vw * 0.6) / Math.max(t.box.w, 1), 1.4, 2.4) });
    } else if (rs.kind === "heroPan") {
      const a = rs.from ? tById.get(rs.from) : undefined;
      const b = rs.to ? tById.get(rs.to) : undefined;
      if (!a || !b) { warnings.push(`drop heroPan: from "${rs.from}"/to "${rs.to}" not found`); continue; }
      shots.push({ kind: "heroPan", durationInFrames: dur, from: a.box, to: b.box, zoom: rs.zoom ?? 1.3 });
    } else if (rs.kind === "hold") {
      shots.push({ kind: "hold", durationInFrames: dur, zoom: rs.zoom ?? 1 });
    } else {
      shots.push({ kind: rs.kind as "focusInput" | "typeInto" | "panToSend" | "clickFill", durationInFrames: dur, zoom: rs.zoom ?? baseZoom });
    }
  }

  // typeInto 가 있는데 input 못 찾았으면 경고(타이핑 위치가 추정값이 됨).
  if (shots.some((s) => s.kind === "typeInto") && !inputC) warnings.push("typeInto present but input not grounded; text position estimated");

  // 텍스트 시작 위치. 비전이 *바깥 컨테이너*를 input 으로 고르면 relBox 가 박스
  // 모서리(≈0,0)라 텍스트가 너무 붙는다 -> 최소 인셋(16) floor 로 보정.
  const ts = capture.textSlot;
  const padX = inputC ? Math.max(inputC.relBox.x, 16) : ts ? ts.relX : Math.round(bb.w * 0.04);
  const padY = inputC ? Math.max(inputC.relBox.y, 16) : ts ? ts.relY : Math.round(bb.h * 0.18);

  // shot 이 너무 적으면(LLM 실패) 빌더 기본 5-shot 으로 폴백.
  const useShots = shots.length >= 2 ? shots : undefined;
  if (!useShots) warnings.push("plan shots too few; fell back to default type-and-send");

  const spec = buildCapturedSpec(capture, assets, {
    typedText: plan.typedText || "",
    zoom: baseZoom,
    text: {
      padX, padY,
      fontSizePx: brand.fontSizePx,
      color: brand.textColor,
      caretColor: brand.caretColor,
      placeholder: brand.placeholder,
    },
    sendBtnFill: brand.sendBtnFill,
    outroFill: brand.outroFill,
    shots: useShots,
  });

  return { spec, warnings };
}
