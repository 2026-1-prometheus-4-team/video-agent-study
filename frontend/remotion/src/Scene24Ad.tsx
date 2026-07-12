// Scene24 self-ad — 4:5 인스타(1080x1350). Scene24 2026 디자인 반영.
//   텍스트 비트 = 우리 프리셋 엔진(statement/hero_zoom, GRADE 색 sweep) — 폴리시 + 자글거림 없음(GPU promote).
//   UI 비트 = 우리 shot 카메라(CameraBeat: zoom/type/pan/click) — 실제 카메라 무빙.
// 모노크롬 chrome + 유일한 색 = GRADE 그라데이션. Fraunces serif, Syne 워드마크, grain.
import React from "react";
import { Series, useCurrentFrame, interpolate, staticFile } from "remotion";
import { loadFont as loadFraunces } from "@remotion/google-fonts/Fraunces";
import { loadFont as loadGeist } from "@remotion/google-fonts/Geist";
import { loadFont as loadSyne } from "@remotion/google-fonts/Syne";
import { Ad, totalFrames, type VideoSpec } from "./motion/SceneRenderer";
import { expandPresetScene, type Brand } from "./presets";
import { CameraBeat } from "./captured/CameraBeat";
import { CameraScene } from "./motion/camera/CameraScene";
import { shotsTotal, type Shot } from "./captured/shots";

const FRAUNCES = loadFraunces("normal", { weights: ["400", "600", "900"] }).fontFamily;
const GEIST = loadGeist("normal", { weights: ["400", "500", "600"] }).fontFamily;
const SYNE = loadSyne("normal", { weights: ["700", "800"] }).fontFamily;

// tokens
const PAPER = "#fdfdfc", PAPER_SURF = "#f2f1ef", INK = "#0c0a09", INK_MUTED = "#4a4d54", HAIR = "rgba(12,10,9,0.10)";
const STUDIO = "#0a0b0d", STUDIO_S1 = "#14161a", STUDIO_S2 = "#1d2027", STUDIO_INK = "#f4f1ec", STUDIO_MUTED = "#a59c8c", STUDIO_HAIR = "rgba(244,241,236,0.08)";
const MINT = "#7df0c0";
const GRADE_COLORS = ["#34d6c2", "#e85c9b", "#f4b94c"];
const GRADE_HERO = "radial-gradient(90% 120% at 18% 20%, #34d6c2, transparent 52%), radial-gradient(90% 120% at 82% 24%, #e85c9b, transparent 50%), radial-gradient(120% 120% at 60% 95%, #f4b94c, transparent 55%), linear-gradient(135deg, #1a2436, #2a1830)";
const grainBg ={ backgroundImage: `url(${staticFile("textures/grain-noise.avif")})`, backgroundRepeat: "repeat" as const, backgroundSize: "200px" };
const Grain: React.FC<{ o?: number }> = ({ o = 0.06 }) => <div style={{ position: "absolute", inset: 0, pointerEvents: "none", mixBlendMode: "overlay", opacity: o, ...grainBg }} />;

const W = 1080, H = 1350;

// 6-스포크 asterisk 마크 + Syne 워드마크
const Wordmark: React.FC<{ size: number; color: string }> = ({ size, color }) => {
  const c = size / 2, r = size * 0.38, sw = size * 0.0625;
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: size * 0.5 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ overflow: "visible" }}>
        {[0, 1, 2, 3, 4, 5].map((i) => { const a = ((i * 60 - 90) * Math.PI) / 180; return <line key={i} x1={c} y1={c} x2={c + r * Math.cos(a)} y2={c + r * Math.sin(a)} stroke={color} strokeWidth={sw} strokeLinecap="round" />; })}
      </svg>
      <span style={{ fontFamily: SYNE, fontWeight: 800, fontSize: size, letterSpacing: "-0.02em", color, lineHeight: 1 }}>Scene24</span>
    </div>
  );
};

const Plate: React.FC<{ x: number; y: number; w: number; h: number; r?: number; label?: string; play?: boolean }> = ({ x, y, w, h, r = 22, label, play }) => (
  <div style={{ position: "absolute", left: x, top: y, width: w, height: h, borderRadius: r, overflow: "hidden", background: GRADE_HERO, boxShadow: "0 24px 80px rgba(0,0,0,0.5)" }}>
    <div style={{ position: "absolute", inset: 0, mixBlendMode: "overlay", opacity: 0.12, ...grainBg }} />
    <div style={{ position: "absolute", inset: 0, boxShadow: "inset 0 0 120px rgba(0,0,0,0.35)" }} />
    {play && <div style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%)", width: w * 0.12, height: w * 0.12, borderRadius: "50%", background: "rgba(255,255,255,0.22)", display: "flex", alignItems: "center", justifyContent: "center" }}><svg width={w * 0.045} height={w * 0.045} viewBox="0 0 24 24"><path d="M8 5 L19 12 L8 19 Z" fill="#fff" /></svg></div>}
    {label && <div style={{ position: "absolute", left: 0, right: 0, bottom: h * 0.1, textAlign: "center", fontFamily: FRAUNCES, fontStyle: "italic", fontSize: w * 0.05, color: "rgba(255,255,255,0.92)" }}>{label}</div>}
  </div>
);

// ---- 프리셋 텍스트 비트 (우리 엔진) ----
const brandPaper: Brand = { background: PAPER, colors: GRADE_COLORS, fontFamily: FRAUNCES };
const spec1 = (scene: ReturnType<typeof expandPresetScene>): VideoSpec => ({ fps: 24, brandDefaults: brandPaper, scenes: [scene] });

const HEADLINE = spec1(expandPresetScene("statement", {
  text: "Your product, made cinematic.", highlightWord: 3, highlightCycle: GRADE_COLORS,
  exitSpeed: "med", baseColor: INK, duration: 3.6, fontSize: 3.8, fontWeight: 900,
}, { brand: brandPaper }));

const CLOSE = spec1(expandPresetScene("hero_zoom", {
  text: "Scene24", gradientStops: GRADE_COLORS, flowSpeed: 2,
  baseColor: INK, duration: 3.0, fontSize: 6.5, fontWeight: 800,
}, { brand: { ...brandPaper, fontFamily: SYNE } }));

// ---- UI 표면들 (CameraBeat 위에서 카메라가 훑음) ----
const InputSurface: React.FC = () => {
  const frame = useCurrentFrame();
  const urlIn = interpolate(frame, [10, 26], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const urlValid = urlIn > 0.6;
  return (
    <div style={{ position: "absolute", inset: 0, background: PAPER }}>
      <Grain o={0.05} />
      <div style={{ position: "absolute", top: 150, left: 0, right: 0, textAlign: "center", fontFamily: GEIST, fontSize: 30, color: INK_MUTED, letterSpacing: "-0.01em" }}>1 — paste your URL</div>
      <div style={{ position: "absolute", top: 230, left: 0, right: 0, display: "flex", justifyContent: "center" }}><Wordmark size={36} color={INK} /></div>
      {/* chat-input hero card */}
      <div style={{ position: "absolute", left: 150, top: 520, width: 780, height: 300, background: "#fff", border: `1px solid ${HAIR}`, borderRadius: 28, boxShadow: "0 12px 32px rgba(10,11,13,0.14), 0 2px 6px rgba(10,11,13,0.08)" }} />
      {/* url chip (animates to filled) */}
      <div style={{ position: "absolute", left: 186, top: 736, display: "inline-flex", alignItems: "center", gap: 9, background: urlValid ? "rgba(125,240,192,0.18)" : PAPER_SURF, borderRadius: 12, padding: "11px 15px", fontFamily: GEIST, fontSize: 23 }}>
        {urlValid
          ? <svg width="17" height="17" viewBox="0 0 24 24"><path d="M5 13 l4 4 L19 7" stroke="#1fae73" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
          : <svg width="17" height="17" viewBox="0 0 24 24"><path d="M9 15 l6-6 M8 9 a3 3 0 0 0 0 6 M16 15 a3 3 0 0 0 0 -6" stroke={INK_MUTED} strokeWidth="2" fill="none" strokeLinecap="round" /></svg>}
        <span style={{ color: urlIn > 0 ? INK : "rgba(12,10,9,0.4)" }}>{urlIn > 0 ? "stripe.com".slice(0, Math.floor(urlIn * 10)) : "Product URL"}</span>
      </div>
      {/* send button (ink) */}
      <div style={{ position: "absolute", left: 852, top: 728, width: 52, height: 52, borderRadius: 16, background: INK, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg width="22" height="22" viewBox="0 0 24 24"><path d="M12 19 V6 M6 12 L12 6 L18 12" stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </div>
    </div>
  );
};
const inputShots: Shot[] = [
  { kind: "hold", durationInFrames: 16, zoom: 1 },
  { kind: "focusInput", durationInFrames: 22, zoom: 1.7 },
  { kind: "typeInto", durationInFrames: 52, zoom: 1.7 },
  { kind: "panToSend", durationInFrames: 18, zoom: 1.7 },
  { kind: "clickFill", durationInFrames: 16, zoom: 1.7 },
];

const ComposeSurface: React.FC = () => (
  <div style={{ position: "absolute", inset: 0, background: STUDIO }}>
    <Grain o={0.09} />
    <div style={{ position: "absolute", inset: 0, boxShadow: "inset 0 0 240px rgba(0,0,0,0.5)" }} />
    <div style={{ position: "absolute", top: 150, left: 0, right: 0, textAlign: "center", fontFamily: GEIST, fontSize: 30, color: STUDIO_MUTED }}>2 — watch the agent compose</div>
    <Plate x={110} y={430} w={860} h={490} r={26} label="your generated ad" play />
  </div>
);
const composeShots: Shot[] = [
  { kind: "hold", durationInFrames: 12, zoom: 1 },
  { kind: "spotlight", durationInFrames: 66, target: { x: 110, y: 430, w: 860, h: 490 }, zoom: 1.16 },
];

const EditorSurface: React.FC = () => {
  const frame = useCurrentFrame();
  const change = interpolate(frame, [86, 100], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ position: "absolute", inset: 0, background: STUDIO }}>
      <Grain o={0.09} />
      <div style={{ position: "absolute", inset: 0, boxShadow: "inset 0 0 240px rgba(0,0,0,0.5)" }} />
      <div style={{ position: "absolute", top: 150, left: 0, right: 0, textAlign: "center", fontFamily: GEIST, fontSize: 30, color: STUDIO_MUTED }}>3 — direct it, by chat or by hand</div>
      <Plate x={90} y={300} w={900} h={506} r={18} play />
      {/* chat panel */}
      <div style={{ position: "absolute", left: 90, top: 838, width: 900, height: 322, background: STUDIO_S1, border: `1px solid ${STUDIO_HAIR}`, borderRadius: 20 }} />
      {/* change-summary card (mint bar) */}
      <div style={{ position: "absolute", left: 116, top: 866, width: 848, background: STUDIO_S2, borderRadius: 12, padding: "16px 18px 16px 24px", opacity: change, transform: `translateY(${interpolate(change, [0, 1], [10, 0])}px)` }}>
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, background: MINT, borderRadius: "12px 0 0 12px" }} />
        <div style={{ fontFamily: GEIST, fontSize: 21, color: STUDIO_INK }}>Changed: headline scale 1.0 → 1.4, moved up 80px</div>
      </div>
      {/* chat input row */}
      <div style={{ position: "absolute", left: 116, top: 1010, width: 848, height: 96, background: STUDIO_S2, borderRadius: 14 }} />
      <div style={{ position: "absolute", left: 916, top: 1032, width: 52, height: 52, borderRadius: 14, background: STUDIO_INK, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg width="22" height="22" viewBox="0 0 24 24"><path d="M12 19 V6 M6 12 L12 6 L18 12" stroke={STUDIO} strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </div>
    </div>
  );
};
const editorShots: Shot[] = [
  { kind: "hold", durationInFrames: 14, zoom: 1 },
  { kind: "focusInput", durationInFrames: 22, zoom: 1.45 },
  { kind: "typeInto", durationInFrames: 56, zoom: 1.45 },
  { kind: "clickFill", durationInFrames: 22, zoom: 1.45 },
];

// ---- beat 길이 ----
const F = {
  headline: totalFrames(HEADLINE, 24),
  input: shotsTotal(inputShots),
  compose: shotsTotal(composeShots),
  editor: shotsTotal(editorShots),
  close: totalFrames(CLOSE, 24),
};
export const SCENE24_AD_FRAMES = F.headline + F.input + F.compose + F.editor + F.close;

export const Scene24Ad: React.FC = () => (
  <Series>
    <Series.Sequence durationInFrames={F.headline}>
      <CameraScene background={PAPER} shots={[{ kind: "pushIn", durationInFrames: F.headline, zoom: 1.12 }]}>
        <Ad spec={HEADLINE} />
      </CameraScene>
    </Series.Sequence>
    <Series.Sequence durationInFrames={F.input}>
      <CameraBeat width={W} height={H} background={PAPER} shots={inputShots}
        input={{ x: 188, y: 600 }} send={{ x: 878, y: 754 }} surface={<InputSurface />}
        typedText="a cinematic launch video" typedFont={`500 27px ${GEIST}`} typedColor={INK} caretColor="#1fae73"
        cursor fillColor={STUDIO} />
    </Series.Sequence>
    <Series.Sequence durationInFrames={F.compose}>
      <CameraBeat width={W} height={H} background={STUDIO} shots={composeShots} surface={<ComposeSurface />} />
    </Series.Sequence>
    <Series.Sequence durationInFrames={F.editor}>
      <CameraBeat width={W} height={H} background={STUDIO} shots={editorShots}
        input={{ x: 150, y: 1058 }} send={{ x: 942, y: 1058 }} surface={<EditorSurface />}
        typedText="make the headline bigger, push it up" typedFont={`500 23px ${GEIST}`} typedColor={STUDIO_INK} caretColor={MINT} />
    </Series.Sequence>
    <Series.Sequence durationInFrames={F.close}>
      <CameraScene background={PAPER} shots={[{ kind: "pushIn", durationInFrames: F.close, zoom: 1.08 }]}>
        <Ad spec={CLOSE} />
      </CameraScene>
    </Series.Sequence>
  </Series>
);
