const API_BASE = (
  process.env.NEXT_PUBLIC_AGENT_API || "http://localhost:8000"
).replace(/\/+$/, "");

/** 경로 → 확장자 뺀 파일명. 자막 큐 문서(cues.json)의 키. */
export function pathStem(p: string | undefined | null): string {
  if (!p) return "";
  const base = p.split(/[/\\]/).pop() ?? "";
  return base.replace(/\.[^.]+$/, "");
}

/** 백엔드 상대 산출물 경로 → 정적 파일 URL (없으면 null). */
export function outputFileUrl(p: string | undefined | null): string | null {
  if (!p) return null;
  const m = p.match(
    /^(?:.*[/\\])?(videos|output|outputs|audio_files|bgm_files)\/(.+)$/
  );
  if (!m) return null;
  const sub =
    m[1] === "audio_files" ? "audio" : m[1] === "bgm_files" ? "bgm" : m[1];
  return `${API_BASE}/files/${sub}/${m[2]}`;
}

export interface SubtitleStyle {
  font: string;
  size: number;
  margin_v: number;
  color: string;
  stroke_color: string;
  stroke_width: number;
  bold: boolean;
  fade: boolean;
}

export const DEFAULT_STYLE: SubtitleStyle = {
  font: "Noto Sans KR",
  size: 18,
  margin_v: 23,
  color: "#FFFFFF",
  stroke_color: "#000000",
  stroke_width: 2,
  bold: true,
  fade: true,
};

// 폴백 목록 — 백엔드 /fonts 응답(폰트 내부 family 명)이 있으면 그걸 우선 사용.
// value 는 백엔드 스타일 응답과 같은 내부 family 명이어야 select 값이 맞는다.
export const FONT_OPTIONS = [
  { label: "Noto Sans KR", value: "Noto Sans KR" },
  { label: "Gothic A1", value: "Gothic A1" },
  { label: "IBM Plex Sans KR", value: "IBM Plex Sans KR" },
  { label: "Gowun Dodum", value: "Gowun Dodum" },
  { label: "Black Han Sans", value: "Black Han Sans" },
  { label: "Nanum Gothic", value: "NanumGothic" },
];

export async function getSubtitleStyle(stem: string): Promise<SubtitleStyle> {
  const res = await fetch(
    `${API_BASE}/api/subtitles/${encodeURIComponent(stem)}/style`
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function patchSubtitleStyle(
  stem: string,
  style: Partial<SubtitleStyle>
): Promise<SubtitleStyle> {
  const res = await fetch(
    `${API_BASE}/api/subtitles/${encodeURIComponent(stem)}/style`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(style),
    }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export interface RenderResult {
  status: string;
  output_path: string;
  duration_sec: number;
}

export async function renderSubtitles(
  stem: string,
  style?: Partial<SubtitleStyle>
): Promise<RenderResult> {
  const res = await fetch(
    `${API_BASE}/api/subtitles/${encodeURIComponent(stem)}/render`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(style ? { style } : {}),
    }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 큐 배치 수정 명세 — 매칭 키(id|index) + 변경 필드. */
export interface CueUpdate {
  id?: string;
  index?: number;
  text?: string;
  start?: number;
  end?: number;
  style?: Record<string, unknown>;
  delete?: boolean;
}

export interface CueUpdateResult {
  status: string;
  updated?: string[];
  deleted?: string[];
  failed?: Array<{ id?: string; error?: string }>;
}

/** 자막 큐 텍스트/타이밍/개별 스타일 수정 (모션 에디터 저장). */
export async function updateSubtitleCues(
  stem: string,
  updates: CueUpdate[]
): Promise<CueUpdateResult> {
  const res = await fetch(
    `${API_BASE}/api/subtitles/${encodeURIComponent(stem)}/cues`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates }),
    }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
