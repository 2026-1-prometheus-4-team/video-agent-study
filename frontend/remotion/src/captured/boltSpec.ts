// bolt.new 광고 스펙. Gemini 비전 픽(pick.json) + 페이지 타겟(pageTargets)으로 구동.
//
// 파이프라인: capture.py(번호+타겟 매김) -> pick-elements.mjs(Gemini grounding)
//   -> 이 파일이 픽/타겟으로 spec 조립 -> CapturedScene 렌더.
//
// 두 스펙을 export 해서 *같은 사이트가 다르게 움직이는 것*을 보여준다:
//   BOLT_SPEC         = 기본 type-and-send (입력 직행)
//   BOLT_VARIETY_SPEC = 헤드라인 spotlight 로 시작 -> 입력 -> 타이핑 -> 클릭
import rawBolt from "../capturedBolt.json";
import pick from "../capturedBolt-pick.json";
import { buildCapturedSpec, type CaptureData } from "./spec";
import type { Shot } from "./shots";

// 비전이 고른 전송버튼 좌표를 capture.sendBtn 으로 주입(휴리스틱은 null 이었음).
const capture: CaptureData = {
  ...(rawBolt as CaptureData),
  sendBtn: pick.sendBox
    ? { relX: pick.sendBox.x, relY: pick.sendBox.y, w: pick.sendBox.w, h: pick.sendBox.h, background: "rgba(0,0,0,0)", color: "#fff" }
    : null,
};

const assets = {
  cleanplate: "cap-bolt-cleanplate.png",
  elementHtml: "cap-bolt-element.html",
  elementPng: "cap-bolt-element.png",
};

const textOpts = {
  padX: pick.inputBox.x,
  padY: pick.inputBox.y,
  fontSizePx: 18,
  color: "#ededf0",
  caretColor: "#4d7dff",
};

// --- 기본 모션 (입력 직행 type-and-send) ---
export const BOLT_SPEC = buildCapturedSpec(capture, assets, {
  typedText: pick.typedText,
  text: textOpts,
});

// --- variety 모션 (헤드라인 spotlight 로 시작) ---
type PageTarget = { id: string; tag: string; text: string; box: { x: number; y: number; w: number; h: number } };
const pageTargets = ((rawBolt as unknown as { pageTargets?: PageTarget[] }).pageTargets) ?? [];
const headline = pageTargets.find((t) => t.tag === "h1") ?? pageTargets.find((t) => t.id === "F");

const Z = 1.6; // bolt 기본 줌(입력 follow)
const varietyShots: Shot[] = [
  { kind: "hold", durationInFrames: 14, zoom: 1 },
  ...(headline ? [{ kind: "spotlight", durationInFrames: 30, target: headline.box, zoom: 1.9 } as Shot] : []),
  { kind: "focusInput", durationInFrames: 22, zoom: Z },
  { kind: "typeInto", durationInFrames: 54, zoom: Z },
  { kind: "panToSend", durationInFrames: 16, zoom: Z },
  { kind: "clickFill", durationInFrames: 36, zoom: Z },
];

export const BOLT_VARIETY_SPEC = buildCapturedSpec(capture, assets, {
  typedText: pick.typedText,
  text: textOpts,
  zoom: Z,
  shots: varietyShots,
});
