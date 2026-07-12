// Captured-UI reconstruction demo. capture-lab 산출물(clean plate + self-contained
// HTML + 스펙)을 합성하고, 안무는 shot 리스트(choreo.shots)로 구동한다.
//   기본 type-and-send: hold(등장) -> focusInput -> typeInto -> panToSend -> clickFill.
//   shot 리스트만 바꾸면(spotlight/heroPan 추가 등) 사이트마다 다른 모션이 나온다.
// mode='image': element.png 정적. mode='code': HTML 재구성 + shot 안무.
import React, { useEffect, useRef, useState } from "react";
import {
  AbsoluteFill,
  Img,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
  staticFile,
  delayRender,
  continueRender,
  Easing,
} from "remotion";
import { LOVABLE_SPEC, capturedFrames, type CapturedAdSpec } from "./captured/spec";
import { planShots, resolveCamera, resolveTransform, windowOf, type ShotCtx } from "./captured/shots";

const easeIO = Easing.inOut(Easing.cubic);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// 스펙에서 화면 좌표/폰트 등 파생값을 한 번에 계산. (예전 모듈 상수의 대체)
function deriveLayout(spec: CapturedAdSpec) {
  const cap = spec.capture;
  const ch = spec.choreo;
  const CAP_W = cap.viewport.w;
  const CAP_H = cap.viewport.h;
  const bb = cap.bbox;
  const BOX_CX = bb.x + bb.w / 2;
  const BOX_CY = bb.y + bb.h / 2;
  const SB = cap.sendBtn;
  // 전송 버튼 중심(page 좌표)
  const SBX = bb.x + (SB ? SB.relX + SB.w / 2 : bb.w - 40);
  const SBY = bb.y + (SB ? SB.relY + SB.h / 2 : bb.h - 40);
  const SB_MIN = Math.min(SB?.w ?? 32, SB?.h ?? 32); // 채움 시작 크기(알약은 짧은 변 기준)
  // 합성 버튼 오버레이는 원형(가로≈세로)일 때만. 알약/직사각 버튼은 재구성 HTML 의
  // 실제 버튼을 그대로 쓰고 카메라+커서 클릭으로만 표현(합성 원이 덧그려져 깨지지 않게).
  const drawSyntheticBtn = !!SB && Math.abs(SB.w - SB.h) < 10;
  const TEXT_LEFT = bb.x + ch.text.padX;
  // 캡쳐 폰트에 generic fallback 보장. "Inter" 처럼 fallback 없는 family 는 폰트
  // 미로드 시 브라우저 기본 serif(Times)로 떨어지므로 sans-serif 를 붙인다.
  const rawFam = cap.textSlot?.fontFamily?.trim();
  const fontFamily = !rawFam
    ? "ui-sans-serif, system-ui, sans-serif"
    : /(sans-serif|serif|monospace)\s*$/.test(rawFam)
      ? rawFam
      : `${rawFam}, ui-sans-serif, system-ui, sans-serif`;
  const fontWeight = cap.textSlot?.fontWeight ?? "400";
  const TEXT_FONT = `${fontWeight} ${ch.text.fontSizePx}px ${fontFamily}`;
  const lineHeight = cap.textSlot?.lineHeight ?? "22px";
  return { CAP_W, CAP_H, bb, BOX_CX, BOX_CY, SB, SBX, SBY, SB_MIN, drawSyntheticBtn, TEXT_LEFT, TEXT_FONT, lineHeight };
}
type Layout = ReturnType<typeof deriveLayout>;

let _measureCtx: CanvasRenderingContext2D | null = null;
function measureWidth(text: string, font: string): number {
  if (!_measureCtx) _measureCtx = document.createElement("canvas").getContext("2d");
  if (!_measureCtx) return text.length * 9;
  _measureCtx.font = font;
  return _measureCtx.measureText(text).width;
}

function resolve2DCamera(targetX: number, targetY: number, z: number, capW: number, capH: number) {
  return `translate(${capW / 2 - targetX * z}px, ${capH / 2 - targetY * z}px) scale(${z})`;
}

// image 모드(CapturedV1) 전용 — 정적 element.png 를 천천히 줌. shot 과 무관.
function imageCamera(frame: number, D: Layout) {
  const z = interpolate(frame, [12, 48, 72, 108], [1, 2.1, 2.1, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeIO });
  const ty = interpolate(frame, [12, 48, 72, 108], [D.CAP_H / 2, D.BOX_CY, D.BOX_CY, D.CAP_H / 2], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeIO });
  return resolve2DCamera(D.BOX_CX, ty, z, D.CAP_W, D.CAP_H);
}

const _htmlCache: Record<string, string> = {};
function useElementHtml(url: string): string | null {
  const [html, setHtml] = useState<string | null>(_htmlCache[url] ?? null);
  const [handle] = useState(() => (_htmlCache[url] ? -1 : delayRender("element-html")));
  const done = useRef(_htmlCache[url] != null);
  useEffect(() => {
    if (_htmlCache[url]) return;
    fetch(url).then((r) => r.text()).then((t) => { _htmlCache[url] = t; setHtml(t); });
  }, [url]);
  useEffect(() => {
    if (html && !done.current && handle >= 0) { done.current = true; continueRender(handle); }
  }, [html, handle]);
  return html;
}

// 마우스 커서 (스크린 공간 SVG 포인터). 타이밍은 clickFill shot 윈도우에서 파생.
// targetX/Y = 전송 버튼의 화면 좌표(카메라 클램프 반영).
const Cursor: React.FC<{ frame: number; fps: number; cursorIn: number; click: number; cursorOut: number; targetX: number; targetY: number }> = ({ frame, fps, cursorIn, click, cursorOut, targetX, targetY }) => {
  if (frame < cursorIn || frame > cursorOut) return null;
  // 전송버튼 위치로 들어옴
  const x = interpolate(frame, [cursorIn, click], [targetX + 120, targetX], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const y = interpolate(frame, [cursorIn, click], [targetY + 110, targetY], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const op = interpolate(frame, [cursorIn, cursorIn + 4, cursorOut - 3, cursorOut], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  // 클릭 시 눌림: 작아졌다 고무처럼
  const press = frame < click ? 1 : interpolate(spring({ frame: frame - click, fps, config: { damping: 9, stiffness: 240 } }), [0, 1], [0.7, 1]);
  return (
    <div style={{ position: "absolute", left: x, top: y, opacity: op, transform: `scale(${press})`, transformOrigin: "0 0", filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.3))" }}>
      <svg width="26" height="26" viewBox="0 0 24 24">
        <path d="M4 2 L4 19 L8.5 14.8 L11.2 21 L14.2 19.6 L11.6 13.5 L17.5 13.5 Z" fill="#fff" stroke="#111" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
    </div>
  );
};

export const CapturedScene: React.FC<{ mode?: "image" | "code"; spec?: CapturedAdSpec }> = ({ mode = "image", spec = LOVABLE_SPEC }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const isCode = mode === "code";
  const D = deriveLayout(spec);
  const ch = spec.choreo;
  const SB = D.SB;
  const bb = D.bb;
  const html = useElementHtml(staticFile(spec.assets.elementHtml));

  // shot 엔진: 무대 좌표(ctx) -> 플랜 -> 카메라.
  const ctx: ShotCtx = {
    capW: D.CAP_W, capH: D.CAP_H,
    inputLeft: D.TEXT_LEFT, inputCY: D.BOX_CY,
    sendCenter: { x: D.SBX, y: D.SBY },
    caretAt: (t) => D.TEXT_LEFT + measureWidth(ch.typedText.slice(0, Math.floor(t * ch.typedText.length)), D.TEXT_FONT),
    caretFullX: D.TEXT_LEFT + measureWidth(ch.typedText, D.TEXT_FONT),
  };
  const plan = planShots(ch.shots, ctx);
  const cam = resolveCamera(frame, plan, ctx).cam;
  const camera = isCode ? resolveTransform(cam, D.CAP_W, D.CAP_H) : imageCamera(frame, D);
  // 전송 버튼의 현재 화면 좌표(카메라 클램프 반영). 커서 클릭/검정 채움이 실제
  // 버튼 위치에 맞도록 — 화면 중앙 가정 대신 카메라로부터 역산.
  const sendScreenX = D.CAP_W / 2 + (D.SBX - cam.tx) * cam.zoom;
  const sendScreenY = D.CAP_H / 2 + (D.SBY - cam.ty) * cam.zoom;

  // 타이핑 = typeInto shot 윈도우 기준 진행률.
  const tw = windowOf(plan, "typeInto");
  const typeFrac = tw ? clamp01((frame - tw.start) / Math.max(1, tw.end - tw.start)) : 0;
  const typed = ch.typedText.slice(0, Math.floor(typeFrac * ch.typedText.length));
  const typing = tw ? frame >= tw.start && frame <= tw.end + 4 : false;
  const caretOn = typing || Math.floor(frame / 8) % 2 === 0;

  // 커서/클릭/채움 = clickFill shot 윈도우 기준. LLM 이 짧은 길이를 줘도 안 깨지게
  // 오프셋을 윈도우 길이에 비례시킨다(역전 방지).
  const cw = windowOf(plan, "clickFill");
  const cdur = cw ? cw.end - cw.start : 0;
  const clickF = cw ? cw.start + Math.min(10, Math.round(cdur * 0.45)) : -1;
  const cursorInF = cw ? cw.start : -1;
  const cursorOutF = cw ? Math.min(cw.end, clickF + 6) : -1;
  const fillStartF = cw ? clickF + 2 : Infinity;
  const fillEndF = cw ? cw.end : Infinity;
  const showCursor = !!cw && cursorOutF - cursorInF >= 10;

  // 박스 젤리 등장(가로 작다가 또잉 -> 풀 가로). scaleX 라 콘텐츠도 같이 늘어남.
  const enter = spring({ frame, fps, config: { damping: ch.entrance.damping, stiffness: ch.entrance.stiffness, mass: ch.entrance.mass } });
  const sx = isCode ? interpolate(enter, [0, 1], [ch.entrance.scaleXFrom, 1]) : 1;
  const sy = isCode ? 1 + (1 - sx) * ch.entrance.scaleYFactor : 1;

  // 전송 버튼 눌림(작아졌다 커짐)
  const btnPress = cw && frame >= clickF ? interpolate(spring({ frame: frame - clickF, fps, config: { damping: 9, stiffness: 240 } }), [0, 1], [0.8, 1]) : 1;
  // 검정 채움(버튼 화면 채우기) — 스크린 공간
  const fill = cw && frame >= fillStartF ? interpolate(frame, [fillStartF, fillEndF], [0, 1], { extrapolateRight: "clamp", easing: Easing.in(Easing.cubic) }) : 0;
  const fillBase = D.SB_MIN * ch.zoom; // 화면상 버튼 크기에서 시작

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <div style={{ width: D.CAP_W, height: D.CAP_H, transformOrigin: "0 0", transform: camera }}>
        <Img src={staticFile(spec.assets.cleanplate)} style={{ position: "absolute", left: 0, top: 0, width: D.CAP_W, height: D.CAP_H }} />
        <div style={{ position: "absolute", left: bb.x, top: bb.y, width: bb.w, height: bb.h, transformOrigin: "center center", transform: `scale(${sx}, ${sy})` }}>
          {isCode ? (
            html && (
              <div style={{ position: "relative", width: "100%", height: "100%" }}>
                <div style={{ position: "absolute", inset: 0 }} dangerouslySetInnerHTML={{ __html: html }} />
                {/* 타이핑 텍스트 (재구성 HTML 안의 z-index 요소 위로 강제) */}
                <div style={{ position: "absolute", left: ch.text.padX, top: ch.text.padY, font: D.TEXT_FONT, lineHeight: D.lineHeight, color: ch.text.color, whiteSpace: "nowrap", zIndex: 1000 }}>
                  {typed.length === 0 ? <span style={{ color: "rgba(0,0,0,0.4)" }}>{ch.text.placeholder}</span> : <span>{typed}</span>}
                  <span style={{ opacity: caretOn ? 1 : 0, color: ch.text.caretColor, fontWeight: 600 }}>|</span>
                </div>
                {/* 전송 버튼 오버레이(눌림 애니메이션) — 원형 버튼일 때만 합성 */}
                {SB && D.drawSyntheticBtn && (
                  <div style={{ position: "absolute", left: SB.relX, top: SB.relY, width: SB.w, height: SB.h, borderRadius: "50%", background: ch.sendBtnFill, display: "flex", alignItems: "center", justifyContent: "center", transform: `scale(${btnPress})`, zIndex: 1001 }}>
                    <svg width={SB.w * 0.55} height={SB.w * 0.55} viewBox="0 0 24 24">
                      <path d="M12 19 L12 6 M6 12 L12 6 L18 12" stroke="#fff" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                )}
              </div>
            )
          ) : (
            <Img src={staticFile(spec.assets.elementPng)} style={{ width: "100%", height: "100%" }} />
          )}
        </div>
      </div>

      {/* 마우스 커서(스크린 공간) */}
      {isCode && showCursor && <Cursor frame={frame} fps={fps} cursorIn={cursorInF} click={clickF} cursorOut={cursorOutF} targetX={sendScreenX} targetY={sendScreenY} />}

      {/* 검정 버튼이 화면을 채움 -> 아웃트로(검정)로 자연스럽게 (실제 버튼 위치에서) */}
      {isCode && fill > 0 && (
        <div style={{ position: "absolute", left: sendScreenX, top: sendScreenY, width: fillBase, height: fillBase, marginLeft: -fillBase / 2, marginTop: -fillBase / 2, borderRadius: "50%", background: ch.outroFill, transform: `scale(${1 + fill * 48})` }} />
      )}
    </AbsoluteFill>
  );
};

// 합성 길이 계산에 쓰는 기본 씬 길이(LovableAd / Root). 스펙별이면 capturedFrames(spec).
export const CAPTURED_FRAMES = capturedFrames(LOVABLE_SPEC);
