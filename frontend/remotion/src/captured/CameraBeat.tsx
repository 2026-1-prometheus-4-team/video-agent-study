// CameraBeat — 우리 shot 카메라 엔진(shots.ts)을 임의의 JSX "표면" 위에서 돌린다.
// 캡쳐 이미지가 아니라 직접 만든 UI(예: Scene24 입력창)에도 동일한 카메라 무빙
// (focusInput/typeInto/panToSend/clickFill/spotlight/heroPan) + 타이핑/커서/채움을
// 그대로 입힐 수 있게 CapturedScene 의 카메라 로직을 표면-무관하게 일반화한 것.
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring, Easing } from "remotion";
import { planShots, resolveCamera, resolveTransform, windowOf, type Shot, type ShotCtx } from "./shots";

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
let _mctx: CanvasRenderingContext2D | null = null;
function measure(text: string, font: string): number {
  if (!_mctx) _mctx = document.createElement("canvas").getContext("2d");
  if (!_mctx) return text.length * 9;
  _mctx.font = font;
  return _mctx.measureText(text).width;
}

export type CameraBeatProps = {
  width: number; height: number; background: string;
  shots: Shot[];
  input?: { x: number; y: number };     // 타이핑 시작점(page 좌표) — typeInto 카메라가 따라감
  send?: { x: number; y: number };       // 전송버튼 중심(page 좌표) — pan/click 타겟
  surface: React.ReactNode;              // page 좌표(0..w,0..h)로 그린 UI 표면
  typedText?: string;
  typedFont?: string;                    // 타이핑 오버레이 + caret 측정용 CSS font
  typedColor?: string;
  caretColor?: string;
  placeholder?: string;
  cursor?: boolean;
  fillColor?: string;                    // clickFill 채움색(다음 씬 배경과 맞춤)
};

export const CameraBeat: React.FC<CameraBeatProps> = (p) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const font = p.typedFont ?? "400 24px sans-serif";
  const input = p.input ?? { x: p.width / 2, y: p.height / 2 };
  const send = p.send ?? { x: p.width / 2, y: p.height / 2 };
  const txt = p.typedText ?? "";

  const ctx: ShotCtx = {
    capW: p.width, capH: p.height,
    inputLeft: input.x, inputCY: input.y,
    sendCenter: send,
    caretAt: (t) => input.x + measure(txt.slice(0, Math.floor(t * txt.length)), font),
    caretFullX: input.x + measure(txt, font),
  };
  const plan = planShots(p.shots, ctx);
  const cam = resolveCamera(frame, plan, ctx).cam;
  const transform = resolveTransform(cam, p.width, p.height);

  const tw = windowOf(plan, "typeInto");
  const typeFrac = tw ? clamp01((frame - tw.start) / Math.max(1, tw.end - tw.start)) : 0;
  const typed = txt.slice(0, Math.floor(typeFrac * txt.length));
  const typing = tw ? frame >= tw.start && frame <= tw.end + 4 : false;
  const caretOn = typing || Math.floor(frame / 8) % 2 === 0;

  const cw = windowOf(plan, "clickFill");
  const cdur = cw ? cw.end - cw.start : 0;
  const clickF = cw ? cw.start + Math.min(10, Math.round(cdur * 0.45)) : -1;
  const cursorInF = cw ? cw.start : -1;
  const cursorOutF = cw ? Math.min(cw.end, clickF + 6) : -1;
  const fillStartF = cw ? clickF + 2 : Infinity;
  const fillEndF = cw ? cw.end : Infinity;
  const showCursor = !!p.cursor && !!cw && cursorOutF - cursorInF >= 10;

  const sendScreenX = p.width / 2 + (send.x - cam.tx) * cam.zoom;
  const sendScreenY = p.height / 2 + (send.y - cam.ty) * cam.zoom;
  const fill = p.fillColor && cw && frame >= fillStartF ? interpolate(frame, [fillStartF, fillEndF], [0, 1], { extrapolateRight: "clamp", easing: Easing.in(Easing.cubic) }) : 0;
  const fillBase = 40 * cam.zoom;

  return (
    <AbsoluteFill style={{ background: p.background }}>
      <div style={{ width: p.width, height: p.height, transformOrigin: "0 0", transform }}>
        {p.surface}
        {p.typedText !== undefined && (
          <div style={{ position: "absolute", left: input.x, top: input.y, font, color: p.typedColor ?? "#111", whiteSpace: "nowrap" }}>
            {typed.length === 0 ? <span style={{ opacity: 0.4 }}>{p.placeholder}</span> : <span>{typed}</span>}
            <span style={{ opacity: caretOn ? 1 : 0, color: p.caretColor ?? p.typedColor ?? "#111", fontWeight: 600 }}>|</span>
          </div>
        )}
      </div>

      {showCursor && (() => {
        const x = interpolate(frame, [cursorInF, clickF], [sendScreenX + 120, sendScreenX], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
        const y = interpolate(frame, [cursorInF, clickF], [sendScreenY + 110, sendScreenY], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
        const op = interpolate(frame, [cursorInF, cursorInF + 4, cursorOutF - 3, cursorOutF], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        const press = frame < clickF ? 1 : interpolate(spring({ frame: frame - clickF, fps, config: { damping: 9, stiffness: 240 } }), [0, 1], [0.7, 1]);
        return (
          <div style={{ position: "absolute", left: x, top: y, opacity: op, transform: `scale(${press})`, transformOrigin: "0 0", filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.3))" }}>
            <svg width="28" height="28" viewBox="0 0 24 24"><path d="M4 2 L4 19 L8.5 14.8 L11.2 21 L14.2 19.6 L11.6 13.5 L17.5 13.5 Z" fill="#fff" stroke="#111" strokeWidth="1.3" strokeLinejoin="round" /></svg>
          </div>
        );
      })()}

      {fill > 0 && (
        <div style={{ position: "absolute", left: sendScreenX, top: sendScreenY, width: fillBase, height: fillBase, marginLeft: -fillBase / 2, marginTop: -fillBase / 2, borderRadius: "50%", background: p.fillColor, transform: `scale(${1 + fill * 60})` }} />
      )}
    </AbsoluteFill>
  );
};
