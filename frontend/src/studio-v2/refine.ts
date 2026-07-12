"use client";

/**
 * refine.ts — studio-v2 에서 편집 컨텍스트를 spec 으로 저장하고 /motion 딥링크로.
 *
 * 원본 studio/resultSpec.ts + editor/agent/buildResultSpec.ts 파이프라인을 재활용.
 *
 * 흐름:
 *   1. planRefine() : 어떤 영상 소스로 spec 열지 결정
 *      - final 이 있고 transcript 도 있으면 → 원본 영상 + 자막 요소 (다듬기 목적)
 *      - final 만 있으면 → 결과물 그대로
 *      - 아직 결과 없고 업로드만 → 업로드 blob or 서버 파일
 *   2. buildResultSpec(): timeline spec 생성 (video + text elements)
 *   3. PUT /api/specs/file?path=agent/studio-v2-result.json
 *   4. return "/motion?spec=..." — 라우터로 이동
 */

import { buildResultSpec, probeVideoDuration } from "@/editor/agent/buildResultSpec";
import type { AgentState, StreamItem, TranscriptSeg } from "./state";

export const REFINE_SPEC_PATH = "agent/studio-v2-result.json";

type FinalItem = Extract<StreamItem, { kind: "final" }>;

interface RefinePlan {
  src: string;
  fallbackDuration: number;
  transcript: TranscriptSeg[];
  label: string; // 툴팁용 ("원본 + 자막" or "결과물")
}

/**
 * 현재 스튜디오 상태에서 다듬기 가능한 소스를 결정.
 */
export function planRefine(state: {
  lastFinal: AgentState["lastFinal"];
  uploadedUrl: AgentState["uploadedUrl"];
  serverVideoPath: AgentState["serverVideoPath"];
  videoContext: AgentState["videoContext"];
  apiBase: string;
}): RefinePlan | null {
  const final = state.lastFinal as FinalItem | null;
  const originalUrl = state.uploadedUrl ?? null;
  const originalTranscript =
    state.videoContext?.transcript ?? final?.transcript ?? [];

  // 원본 + 자막 요소 조합 (다듬기 목적)
  if (final && originalUrl && originalTranscript.length > 0) {
    return {
      src: originalUrl,
      fallbackDuration: final.duration || state.videoContext?.duration || 10,
      transcript: originalTranscript,
      label: "원본 영상 + 자막 요소",
    };
  }

  // 결과물 그대로
  if (final) {
    const src =
      final.outputUrl ||
      (final.outputPath.startsWith("/")
        ? `${state.apiBase}${final.outputPath}`
        : final.outputPath);
    if (src) {
      return {
        src,
        fallbackDuration: final.duration || 10,
        transcript: final.transcript ?? [],
        label: "결과 영상",
      };
    }
  }

  // 결과는 없지만 업로드는 있음 (사전 편집)
  if (originalUrl) {
    return {
      src: originalUrl,
      fallbackDuration: state.videoContext?.duration || 0,
      transcript: originalTranscript,
      label: "업로드 영상",
    };
  }

  return null;
}

/**
 * spec 저장 후 딥링크 URL 반환.
 * 실패 시 Error throw.
 */
export async function saveRefineSpec(plan: RefinePlan): Promise<string> {
  const probed = await probeVideoDuration(plan.src);
  const duration = probed ?? plan.fallbackDuration ?? 10;

  const spec = buildResultSpec({
    videoSrc: plan.src,
    videoDuration: duration,
    transcript: plan.transcript,
  });

  const res = await fetch(
    `/api/specs/file?path=${encodeURIComponent(REFINE_SPEC_PATH)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(spec),
    }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`spec 저장 실패 (${res.status}) ${detail}`);
  }
  return `/motion?spec=${encodeURIComponent(REFINE_SPEC_PATH)}`;
}
