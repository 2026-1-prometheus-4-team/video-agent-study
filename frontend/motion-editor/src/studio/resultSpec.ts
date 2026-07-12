"use client";

// resultSpec — 에이전트 결과를 모션 에디터용 VideoSpec 으로 변환.
// 스튜디오는 에디터 스토어를 직접 만지지 않는다: spec 파일로 저장한 뒤
// /motion?spec=... 딥링크로 넘긴다 (에디터가 부팅 시 열음).

import { AGENT_API, type FinalResult } from "@/editor/agent/agentStore";

const FPS = 24;

export const RESULT_SPEC_PATH = "agent/result.json";

/** 결과 영상 + (있으면) 자막 텍스트 요소를 가진 단일 씬 VideoSpec */
export function buildResultSpec(result: FinalResult): Record<string, unknown> | null {
  if (!result.outputUrl) return null;
  const src = result.outputUrl.startsWith("http")
    ? result.outputUrl
    : `${AGENT_API}${result.outputUrl}`;
  const duration = result.videoContext?.duration ?? 10;

  const elements: Record<string, unknown>[] = [
    {
      element: "video",
      id: "result-video",
      base: {
        src,
        width: 100,
        height: 100,
        position: { x: 0.5, y: 0.5 },
        fit: "contain",
        loop: false,
        muted: false,
      },
    },
  ];

  // 자막 = 타이밍 창을 가진 텍스트박스
  const transcript = result.videoContext?.transcript ?? [];
  transcript
    .filter((t) => (t.text ?? "").trim())
    .forEach((t, i) => {
      const start = Math.max(0, Math.round(t.start * FPS));
      const end = Math.max(start + 1, Math.round(t.end * FPS));
      elements.push({
        element: "text",
        id: `sub-${i + 1}`,
        base: {
          text: t.text.trim(),
          fontSize: 3.2,
          color: "#FFFFFF",
          position: { x: 0.5, y: 0.88 },
        },
        timing: { start, end },
        layers: [],
      });
    });

  return {
    fps: FPS,
    brandDefaults: {
      background: "#000000",
      fontFamily: "General Sans",
      colors: ["#FFFFFF"],
    },
    scenes: [
      {
        id: "agent-result",
        duration,
        fit: "fixed",
        background: "#000000",
        elements,
      },
    ],
  };
}

/** spec 저장 후 모션 에디터 딥링크 반환. 실패 시 null. */
export async function saveResultSpec(result: FinalResult): Promise<string | null> {
  const spec = buildResultSpec(result);
  if (!spec) return null;
  const res = await fetch(`/api/specs/file?path=${encodeURIComponent(RESULT_SPEC_PATH)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(spec),
  });
  if (!res.ok) return null;
  return `/motion?spec=${encodeURIComponent(RESULT_SPEC_PATH)}`;
}
