// CapturedAdSpec — 캡쳐-UI 광고의 계약(contract).
//
// 두 겹으로 나뉜다:
//   capture : capture-lab(Playwright)가 자동으로 뽑는 값. element.json + 에셋 경로.
//   choreo  : 안무(무엇을 타이핑할지, 줌 배율, 비트 타임라인, 룩). 사람/LLM이 작성.
//
// CapturedScene 은 이 스펙을 받아 "그리기만" 한다(순수 렌더러). 사이트마다
// 달라지는 값이 전부 여기로 빠져, 나중에 LLM 이 choreo 만 JSON 으로 뱉으면
// 새 영상이 나온다. LOVABLE_SPEC 은 현재 하드코딩돼 있던 값을 그대로 옮긴 것
// — 동작이 1프레임도 바뀌지 않는 게 리팩터 성공 기준.
import rawCapture from "../capturedLovable.json";
import { type Shot, defaultShots, shotsTotal } from "./shots";

// capture-lab 산출물(element.json)의 형태. capture 가 자동으로 채운다.
export type CaptureData = {
  viewport: { w: number; h: number };
  bbox: { x: number; y: number; w: number; h: number };
  textSlot: {
    relX: number; relY: number; w: number; h: number;
    fontSize: string; fontFamily: string; fontWeight: string;
    color: string; lineHeight: string; letterSpacing: string;
  } | null;
  sendBtn: {
    relX: number; relY: number; w: number; h: number;
    background: string; color: string;
  } | null;
  elW: number; elH: number;
};

// 안무 + 룩. 사이트/브랜드마다 달라지는 부분. LLM 이 채울 표적.
// shots = 모션 시퀀스(이게 비어 있지 않으면 사이트마다 다른 모션이 된다).
export type Choreography = {
  typedText: string; // 입력창에 타이핑될 문구
  zoom: number;      // follow 줌 배율(빌더가 shots 생성에 쓰는 기본값)
  entrance: { damping: number; stiffness: number; mass: number; scaleXFrom: number; scaleYFactor: number };
  text: {
    padX: number; padY: number;      // 박스 안 텍스트 위치(추출 보정값)
    fontSizePx: number;              // 타이핑 텍스트 크기(추출값 위 override)
    color: string;                   // 타이핑 텍스트 색
    caretColor: string;              // 깜빡이는 caret 색
    placeholder: string;             // 입력 전 placeholder
  };
  sendBtnFill: string; // 전송버튼 오버레이 색
  outroFill: string;   // 화면 채움 색(다음 씬 배경과 맞춤)
  shots: Shot[];       // 모션 시퀀스
};

export type CapturedAssets = {
  cleanplate: string;  // 요소 숨긴 배경 PNG (staticFile 이름)
  elementHtml: string; // self-contained HTML
  elementPng: string;  // 요소만 PNG (image 모드용)
};

export type CapturedAdSpec = {
  capture: CaptureData;
  choreo: Choreography;
  assets: CapturedAssets;
};

// 씬 길이 = shot 길이 합. LovableAd / Root 가 합성 길이 계산에 쓴다.
export const capturedFrames = (s: CapturedAdSpec): number => shotsTotal(s.choreo.shots);

// ---- 스마트 디폴트 빌더 -----------------------------------------------------
// 새 캡쳐(element.json + 에셋)를 받아 choreo 를 데이터에서 *자동으로* 채운다.
// 손으로 튜닝한 LOVABLE_SPEC 과 달리, 이건 임의의 사이트에 합리적 기본값을 준다.
// LLM 은 나중에 여기서 나온 spec 위에 일부 값만 덮어쓰면 된다.

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const px = (v: string | undefined, fallback: number): number => {
  const n = parseFloat(v ?? "");
  return Number.isFinite(n) ? n : fallback;
};

type BuildOpts = {
  typedText: string;
  zoom?: number;
  entrance?: Choreography["entrance"];
  text?: Partial<Choreography["text"]>;
  sendBtnFill?: string;
  outroFill?: string;
  shots?: Shot[];
};

export function buildCapturedSpec(
  capture: CaptureData,
  assets: CapturedAssets,
  opts: BuildOpts,
): CapturedAdSpec {
  const ts = capture.textSlot;
  const bb = capture.bbox;
  const vw = capture.viewport.w;

  // 줌: 박스가 프레임 가로의 ~60%를 채우도록(읽기 좋은 정도), 1.6~2.6 로 제한
  const zoom = opts.zoom ?? clamp((vw * 0.6) / Math.max(bb.w, 1), 1.6, 2.6);

  // 텍스트 위치/크기: textSlot(자동 추출) 우선, 없으면 박스 비율로 추정
  const padX = opts.text?.padX ?? (ts ? ts.relX : Math.round(bb.w * 0.04));
  const padY = opts.text?.padY ?? (ts ? ts.relY : Math.round(bb.h * 0.18));
  const fontSizePx = opts.text?.fontSizePx ?? px(ts?.fontSize, 18);

  return {
    capture,
    assets,
    choreo: {
      typedText: opts.typedText,
      zoom,
      entrance: opts.entrance ?? { damping: 10, stiffness: 150, mass: 0.8, scaleXFrom: 0.18, scaleYFactor: 0.18 },
      text: {
        padX, padY, fontSizePx,
        color: opts.text?.color ?? ts?.color ?? "#1a1a1a",
        caretColor: opts.text?.caretColor ?? "#ff5c7a",
        placeholder: opts.text?.placeholder ?? "",
      },
      sendBtnFill: opts.sendBtnFill ?? "#4a4846",
      outroFill: opts.outroFill ?? "#0B0A0E",
      shots: opts.shots ?? defaultShots(opts.typedText, zoom),
    },
  };
}

// 현재 Lovable 캡쳐의 기본 안무. (이전 CapturedScene 상수를 1:1로 옮김.)
export const LOVABLE_SPEC: CapturedAdSpec = {
  capture: rawCapture as CaptureData,
  assets: {
    cleanplate: "cap-lovable-cleanplate.png",
    elementHtml: "cap-lovable-element.html",
    elementPng: "cap-lovable-element.png",
  },
  choreo: {
    typedText: "a landing page for my startup",
    zoom: 2.4,
    entrance: { damping: 10, stiffness: 150, mass: 0.8, scaleXFrom: 0.18, scaleYFactor: 0.18 },
    text: {
      padX: 38, padY: 36,
      fontSizePx: 19,
      color: "#1a1a1a",
      caretColor: "#ff5c7a",
      placeholder: "Ask Lovable to create...",
    },
    sendBtnFill: "#4a4846",
    outroFill: "#0B0A0E",
    // 현재 type-and-send 모션을 5-shot 으로 분해(이전 beats 와 동일 타임라인).
    shots: [
      { kind: "hold", durationInFrames: 20, zoom: 1 },
      { kind: "focusInput", durationInFrames: 24, zoom: 2.4 },
      { kind: "typeInto", durationInFrames: 48, zoom: 2.4 },
      { kind: "panToSend", durationInFrames: 16, zoom: 2.4 },
      { kind: "clickFill", durationInFrames: 40, zoom: 2.4 },
    ],
  },
};
