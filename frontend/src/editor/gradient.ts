// gradient.ts — 시각 그라디언트 빌더 공용 유틸 (배경 + fill 이 공유).
// Figma 식 stop 모델: 각 stop 이 색 + 위치(0..100%). CSS 문자열과 왕복 파싱.

export type GradKind = "linear" | "radial";
export type GradStop = { color: string; pos: number };
/** radial 전용 — 중심 위치(0..100%)와 크기(반경 %, 박스 비례). */
export type RadialGeom = { x: number; y: number; r: number };

/** stop 배열 -> CSS 그라디언트 문자열. pos 는 0..100(%) — 항상 명시해 쓴다.
 *  radial 은 geom(중심/크기) 지정 시 "부분 방사형" — ellipse R% R% at X% Y%. */
export function genGradient(kind: GradKind, angle: number, stops: GradStop[], radial?: RadialGeom): string {
  const sorted = [...stops].sort((a, b) => a.pos - b.pos);
  const list = sorted.map((s) => `${s.color} ${Math.round(s.pos * 10) / 10}%`).join(", ");
  if (kind === "linear") return `linear-gradient(${Math.round(angle)}deg, ${list})`;
  if (radial) {
    const r = Math.round(radial.r * 10) / 10;
    return `radial-gradient(ellipse ${r}% ${r}% at ${Math.round(radial.x * 10) / 10}% ${Math.round(radial.y * 10) / 10}%, ${list})`;
  }
  return `radial-gradient(circle at 50% 50%, ${list})`;
}

/** 균등 분포 stop 생성 (색 목록만 있을 때). */
export function evenStops(colors: string[]): GradStop[] {
  const n = Math.max(1, colors.length - 1);
  return colors.map((color, i) => ({ color, pos: (i / n) * 100 }));
}

// hex 그라디언트 문자열 역파싱(라운드트립). 위치 없는 stop 은 균등 분포로 보간.
// 실패 시 null.
export function parseGradient(
  css: string | undefined,
): { kind: GradKind; angle: number; stops: GradStop[]; radial?: RadialGeom } | null {
  if (!css) return null;
  const m = css.trim().match(/^(linear|radial)-gradient\((.*)\)$/i);
  if (!m) return null;
  const kind = m[1].toLowerCase() as GradKind;
  const parts = m[2].split(",").map((p) => p.trim());
  let angle = 90;
  let radial: RadialGeom | undefined;
  const raw: { color: string; pos: number | null }[] = [];
  for (const p of parts) {
    const deg = p.match(/^(-?\d+(?:\.\d+)?)deg$/);
    if (deg) {
      angle = Number(deg[1]);
      continue;
    }
    if (/^(circle|ellipse|at\s|to\s)/i.test(p)) {
      // 부분 방사형 기하 라운드트립: "ellipse R% R% at X% Y%"
      const g = p.match(/ellipse\s+(-?\d+(?:\.\d+)?)%\s+(-?\d+(?:\.\d+)?)%\s+at\s+(-?\d+(?:\.\d+)?)%\s+(-?\d+(?:\.\d+)?)%/i);
      if (g) radial = { r: Number(g[1]), x: Number(g[3]), y: Number(g[4]) };
      continue;
    }
    const hex = p.match(/#[0-9a-fA-F]{3,8}/);
    if (!hex) continue;
    const pct = p.match(/(-?\d+(?:\.\d+)?)%/);
    raw.push({ color: hex[0].toUpperCase(), pos: pct ? Number(pct[1]) : null });
  }
  if (raw.length < 2) return null;
  // 위치 없는 stop 은 균등 분포 (전부 없으면 0..100 등분)
  const n = Math.max(1, raw.length - 1);
  const stops = raw.map((r, i) => ({ color: r.color, pos: r.pos ?? (i / n) * 100 }));
  return { kind, angle, stops, radial };
}

export function isGradient(v: unknown): v is string {
  return typeof v === "string" && /-gradient\(/.test(v);
}
