"use client";

// resultSpec — 에이전트 결과를 모션 에디터로 넘기는 스튜디오측 어댑터.
// 스튜디오는 에디터 스토어를 직접 만지지 않는다: spec 파일로 저장한 뒤
// /motion?spec=... 딥링크로 넘긴다 (에디터가 부팅 시 열음).
//
// 자막이 있으면 "원본 영상 + 자막 텍스트 요소" 조합으로 연다 — 결과물엔 자막이
// 이미 burn-in 돼 있어 겹치기 때문. 자막을 스타일링해 에디터에서 다시 뽑는 것이
// "다듬기" 흐름의 본래 목적이다. 자막이 없으면 결과물 영상 그대로.

import { AGENT_API, type FinalResult } from "@/editor/agent/agentStore";
import { buildResultSpec, probeVideoDuration } from "@/editor/agent/buildResultSpec";

export const RESULT_SPEC_PATH = "agent/result.json";

function absolute(url: string): string {
  return url.startsWith("http") ? url : `${AGENT_API}${url}`;
}

export type RefinePlan = {
  src: string;
  usesOriginal: boolean; // true = 원본 + 자막 요소 조합
  transcript: NonNullable<FinalResult["videoContext"]>["transcript"];
};

/** 어떤 소스로 다듬기를 여는지 결정 (버튼 툴팁/라벨용으로도 사용) */
export function planRefine(result: FinalResult, originalUrl: string | null): RefinePlan | null {
  const transcript = result.videoContext?.transcript ?? [];
  if (transcript.length > 0 && originalUrl) {
    return { src: originalUrl, usesOriginal: true, transcript };
  }
  if (result.outputUrl) {
    return { src: absolute(result.outputUrl), usesOriginal: false, transcript };
  }
  return null;
}

/** spec 저장 후 모션 에디터 딥링크 반환. 실패 시 Error throw. */
export async function saveResultSpec(
  result: FinalResult,
  originalUrl: string | null,
): Promise<string> {
  const plan = planRefine(result, originalUrl);
  if (!plan) throw new Error("열 수 있는 결과 영상이 없어요");

  const probed = await probeVideoDuration(plan.src);
  const duration = probed ?? result.videoContext?.duration ?? 10;

  const spec = buildResultSpec({
    videoSrc: plan.src,
    videoDuration: duration,
    transcript: plan.usesOriginal ? plan.transcript : [],
  });

  const res = await fetch(`/api/specs/file?path=${encodeURIComponent(RESULT_SPEC_PATH)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(spec),
  });
  if (!res.ok) throw new Error(`spec 저장 실패 (${res.status})`);
  return `/motion?spec=${encodeURIComponent(RESULT_SPEC_PATH)}`;
}
