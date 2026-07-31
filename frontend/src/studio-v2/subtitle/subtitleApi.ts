const API_BASE = (
  process.env.NEXT_PUBLIC_AGENT_API || "http://localhost:8000"
).replace(/\/+$/, "");

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
  font: "NotoSansKR",
  size: 18,
  margin_v: 23,
  color: "#FFFFFF",
  stroke_color: "#000000",
  stroke_width: 2,
  bold: true,
  fade: true,
};

export const FONT_OPTIONS = [
  { label: "Noto Sans KR", value: "NotoSansKR" },
  { label: "Gothic A1", value: "GothicA1" },
  { label: "IBM Plex Sans KR", value: "IBMPlexSansKR" },
  { label: "Gowun Dodum", value: "GowunDodum" },
  { label: "Black Han Sans", value: "BlackHanSans" },
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
