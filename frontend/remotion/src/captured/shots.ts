// 캡쳐-UI 모션의 단위 = shot. 각 shot 은 길이(프레임)+종류별 파라미터를 갖고,
// 리스트로 이어 붙여 하나의 안무를 만든다. 카메라는 shot 사이를 부드럽게 이어
// (직전 shot 의 끝 상태 -> 이번 shot 의 목표로 ease) 연속 무빙이 된다.
// LLM 은 이 리스트만 작성하면 사이트마다 다른 모션을 만들 수 있다.
import { Easing } from "remotion";

export type Box = { x: number; y: number; w: number; h: number };
export type CamState = { tx: number; ty: number; zoom: number }; // 카메라가 바라보는 page 좌표 + 줌

export type Shot =
  | { kind: "hold"; durationInFrames: number; zoom?: number }                  // 페이지 전체에서 정지(등장 연출)
  | { kind: "focusInput"; durationInFrames: number; zoom: number }             // 입력칸으로 줌인
  | { kind: "typeInto"; durationInFrames: number; zoom: number }               // 입력칸 타이핑 + caret follow
  | { kind: "panToSend"; durationInFrames: number; zoom: number }              // 입력 -> 전송버튼 팬
  | { kind: "clickFill"; durationInFrames: number; zoom: number }              // 전송버튼 클릭 + 검정 채움
  | { kind: "spotlight"; durationInFrames: number; target: Box; zoom: number } // 임의 요소에 줌-펀치 후 홀드
  | { kind: "heroPan"; durationInFrames: number; from: Box; to: Box; zoom: number } // 두 영역 사이 드리프트
  // --- 범용 무브 (입력/전송 타겟 불필요 — 아무 씬에나 적용) ---
  | { kind: "still"; durationInFrames: number; zoom?: number }                                       // 직전 위치에서 정지
  | { kind: "pushIn"; durationInFrames: number; zoom: number; focus?: { x: number; y: number } }     // 초점으로 줌인(기본 중앙)
  | { kind: "pullBack"; durationInFrames: number; zoom?: number; focus?: { x: number; y: number } }  // 줌아웃(기본 1.0)
  | { kind: "pan"; durationInFrames: number; to: { x: number; y: number }; from?: { x: number; y: number }; zoom?: number } // 두 점 사이 팬
  | { kind: "drift"; durationInFrames: number; dx?: number; dy?: number; zoom?: number };            // 느린 ambient 드리프트

const easeIO = Easing.inOut(Easing.cubic);
const easeOut = Easing.out(Easing.cubic);
const centerOf = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// 렌더러가 채워주는 무대 좌표(입력칸/전송버튼/caret 등).
export type ShotCtx = {
  capW: number; capH: number;
  inputLeft: number; inputCY: number;     // 타이핑 시작 x, 입력칸 중앙 y
  sendCenter: { x: number; y: number };
  caretAt: (frac: number) => number;      // 타이핑 진행률(0..1) -> caret x
  caretFullX: number;                     // 타이핑 끝 caret x
};

type Planned = { shot: Shot; start: number; end: number; entry: CamState; exit: CamState };

function destOf(shot: Shot, ctx: ShotCtx, prev: CamState): CamState {
  const cx = ctx.capW / 2, cy = ctx.capH / 2;
  switch (shot.kind) {
    case "hold": return { tx: cx, ty: cy, zoom: shot.zoom ?? 1 };
    case "still": return { tx: prev.tx, ty: prev.ty, zoom: shot.zoom ?? prev.zoom };
    case "focusInput": return { tx: ctx.inputLeft, ty: ctx.inputCY, zoom: shot.zoom };
    case "typeInto": return { tx: ctx.caretFullX, ty: ctx.inputCY, zoom: shot.zoom };
    case "panToSend":
    case "clickFill": return { tx: ctx.sendCenter.x, ty: ctx.sendCenter.y, zoom: shot.zoom };
    case "spotlight": { const c = centerOf(shot.target); return { tx: c.x, ty: c.y, zoom: shot.zoom }; }
    case "heroPan": { const c = centerOf(shot.to); return { tx: c.x, ty: c.y, zoom: shot.zoom }; }
    case "pushIn": { const f = shot.focus ?? { x: cx, y: cy }; return { tx: f.x, ty: f.y, zoom: shot.zoom }; }
    case "pullBack": { const f = shot.focus ?? { x: cx, y: cy }; return { tx: f.x, ty: f.y, zoom: shot.zoom ?? 1 }; }
    case "pan": return { tx: shot.to.x, ty: shot.to.y, zoom: shot.zoom ?? prev.zoom };
    case "drift": return { tx: prev.tx + (shot.dx ?? 0), ty: prev.ty + (shot.dy ?? 0), zoom: shot.zoom ?? prev.zoom };
  }
}

function entryOf(shot: Shot, ctx: ShotCtx, prev: CamState): CamState {
  if (shot.kind === "heroPan") { const c = centerOf(shot.from); return { tx: c.x, ty: c.y, zoom: shot.zoom }; }
  if (shot.kind === "pan" && shot.from) return { tx: shot.from.x, ty: shot.from.y, zoom: shot.zoom ?? prev.zoom };
  if (shot.kind === "hold") return destOf(shot, ctx, prev); // 정지
  return prev; // 직전 shot 의 끝에서 이어감
}

// shot 리스트 -> 각 shot 의 [start,end) + 진입/이탈 카메라 상태.
export function planShots(shots: Shot[], ctx: ShotCtx): Planned[] {
  const out: Planned[] = [];
  let t = 0;
  let prev: CamState = { tx: ctx.capW / 2, ty: ctx.capH / 2, zoom: 1 };
  for (const shot of shots) {
    const entry = entryOf(shot, ctx, prev);
    const exit = destOf(shot, ctx, prev);
    out.push({ shot, start: t, end: t + shot.durationInFrames, entry, exit });
    t += shot.durationInFrames;
    prev = exit;
  }
  return out;
}

export const shotsTotal = (shots: Shot[]) => shots.reduce((s, sh) => s + sh.durationInFrames, 0);

// 글로벌 프레임 -> 카메라 상태 + 활성 shot.
export function resolveCamera(frame: number, plan: Planned[], ctx: ShotCtx): { cam: CamState; active: Planned | null } {
  const p = plan.find((pp) => frame < pp.end) ?? plan[plan.length - 1];
  if (!p) return { cam: { tx: ctx.capW / 2, ty: ctx.capH / 2, zoom: 1 }, active: null };
  const dur = p.shot.durationInFrames;
  const t = dur > 0 ? clamp01((frame - p.start) / dur) : 1;
  let cam: CamState;
  if (p.shot.kind === "typeInto") {
    cam = { tx: ctx.caretAt(t), ty: ctx.inputCY, zoom: p.exit.zoom }; // caret 따라가기
  } else if (p.shot.kind === "hold" || p.shot.kind === "clickFill" || p.shot.kind === "still") {
    cam = p.exit; // 정지/홀드
  } else if (p.shot.kind === "spotlight") {
    // 줌-펀치: 앞 60% 동안 easeOut 으로 빠르게 들어가고 나머지는 홀드.
    const e = easeOut(clamp01(t / 0.6));
    cam = { tx: lerp(p.entry.tx, p.exit.tx, e), ty: lerp(p.entry.ty, p.exit.ty, e), zoom: lerp(p.entry.zoom, p.exit.zoom, e) };
  } else if (p.shot.kind === "drift") {
    const e = t; // 선형 ambient 드리프트
    cam = { tx: lerp(p.entry.tx, p.exit.tx, e), ty: lerp(p.entry.ty, p.exit.ty, e), zoom: lerp(p.entry.zoom, p.exit.zoom, e) };
  } else {
    const e = easeIO(t); // 진입 -> 이탈 ease (focusInput / panToSend / heroPan / pushIn / pullBack / pan)
    cam = { tx: lerp(p.entry.tx, p.exit.tx, e), ty: lerp(p.entry.ty, p.exit.ty, e), zoom: lerp(p.entry.zoom, p.exit.zoom, e) };
  }
  // 플레이트(캡쳐 이미지)는 정확히 프레임 크기 -> 가장자리를 보려 하면 그 너머 검정이
  // 노출된다. 보이는 영역이 항상 플레이트 안에 있도록 타겟을 경계로 클램프.
  const hw = ctx.capW / (2 * cam.zoom);
  const hh = ctx.capH / (2 * cam.zoom);
  cam.tx = hw <= ctx.capW / 2 ? Math.max(hw, Math.min(ctx.capW - hw, cam.tx)) : ctx.capW / 2;
  cam.ty = hh <= ctx.capH / 2 ? Math.max(hh, Math.min(ctx.capH - hh, cam.ty)) : ctx.capH / 2;
  return { cam, active: p };
}

export function resolveTransform(cam: CamState, capW: number, capH: number): string {
  return `translate(${capW / 2 - cam.tx * cam.zoom}px, ${capH / 2 - cam.ty * cam.zoom}px) scale(${cam.zoom})`;
}

// 특정 종류 shot 의 [start,end) (오버레이 게이팅용 — 타이핑/커서/채움 타이밍).
export function windowOf(plan: Planned[], kind: Shot["kind"]): { start: number; end: number } | null {
  const p = plan.find((pp) => pp.shot.kind === kind);
  return p ? { start: p.start, end: p.end } : null;
}

// 타이핑 길이에 맞춰 기본 5-shot 안무를 생성(현재 type-and-send 템플릿).
export function defaultShots(typedText: string, zoom: number): Shot[] {
  const chars = Math.max(typedText.length, 1);
  const typeDur = Math.max(24, Math.min(96, Math.round(chars * 1.5)));
  return [
    { kind: "hold", durationInFrames: 18, zoom: 1 },
    { kind: "focusInput", durationInFrames: 24, zoom },
    { kind: "typeInto", durationInFrames: typeDur, zoom },
    { kind: "panToSend", durationInFrames: 16, zoom },
    { kind: "clickFill", durationInFrames: 40, zoom },
  ];
}
