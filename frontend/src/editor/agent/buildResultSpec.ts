"use client";

// buildResultSpec — 에이전트 결과(영상 + transcript)를 모션 에디터 VideoSpec 으로.
// 스튜디오(파일 저장 + 딥링크)와 에디터 Agent 탭(loadDoc 직접) 이 공유한다.
//
// 엔진 제약 반영:
//  - sceneFrames 가 duration 을 30s 로 clamp (SceneRenderer.tsx) → 긴 영상은
//    30s 씬 여러 개로 분할, video 요소의 trimBefore(frame)로 이어 재생
//  - SceneSpec.background 는 객체 타입 — 배경은 brandDefaults.background 로 통일
//  - 자막 = timing 창을 가진 텍스트 요소. 씬 분할 시 겹치는 씬에 로컬 프레임으로 배치

import type { TranscriptSeg } from "./agentStore";

export const FPS = 24;
const MAX_SCENE_SEC = 30; // 엔진 sceneFrames clamp 상한

export type ResultSpecInput = {
  /** 재생할 영상의 절대 URL (원본 또는 편집 결과물) */
  videoSrc: string;
  /** 영상 실측 길이(초) — <video> metadata 로 probe 한 값 */
  videoDuration: number;
  /** 자막 세그먼트 (초 단위). 텍스트 요소로 변환됨 */
  transcript?: TranscriptSeg[];
};

export function buildResultSpec({
  videoSrc,
  videoDuration,
  transcript = [],
}: ResultSpecInput): Record<string, unknown> {
  const duration = Math.max(0.1, videoDuration);
  const sceneCount = Math.max(1, Math.ceil(duration / MAX_SCENE_SEC));

  const segs = transcript
    .filter((t) => (t.text ?? "").trim())
    .map((t) => ({
      startF: Math.max(0, Math.round(t.start * FPS)),
      endF: Math.max(Math.round(t.start * FPS) + 1, Math.round(t.end * FPS)),
      text: t.text.trim(),
    }));

  const scenes: Record<string, unknown>[] = [];
  for (let i = 0; i < sceneCount; i++) {
    const offsetSec = i * MAX_SCENE_SEC;
    const sceneSec = Math.min(MAX_SCENE_SEC, duration - offsetSec);
    const sceneStartF = Math.round(offsetSec * FPS);
    const sceneEndF = sceneStartF + Math.round(sceneSec * FPS);

    const elements: Record<string, unknown>[] = [
      {
        element: "video",
        id: sceneCount === 1 ? "result-video" : `result-video-${i + 1}`,
        base: {
          src: videoSrc,
          width: 100,
          height: 100,
          position: { x: 0.5, y: 0.5 },
          fit: "contain",
          loop: false,
          muted: false,
          // 씬 분할 시 앞 씬에서 재생된 만큼 건너뛰고 이어서 재생
          trimBefore: sceneStartF || undefined,
        },
      },
    ];

    // 이 씬 구간과 겹치는 자막을 씬-로컬 프레임으로 배치
    segs.forEach((seg, n) => {
      const s = Math.max(seg.startF, sceneStartF);
      const e = Math.min(seg.endF, sceneEndF);
      if (e <= s) return;
      elements.push({
        element: "text",
        id: sceneCount === 1 ? `sub-${n + 1}` : `sub-${i + 1}-${n + 1}`,
        base: {
          text: seg.text,
          fontSize: 3.2,
          color: "#FFFFFF",
          position: { x: 0.5, y: 0.88 },
        },
        timing: { start: s - sceneStartF, end: e - sceneStartF },
        // 즉시 표시 (에디터 생성 요소 관례) — 애니메이션은 Layers 에서 추가
        layers: [],
      });
    });

    scenes.push({
      id: sceneCount === 1 ? "agent-result" : `agent-result-${i + 1}`,
      duration: sceneSec,
      fit: "fixed",
      transition_out: "hard_cut",
      elements,
    });
  }

  return {
    fps: FPS,
    brandDefaults: {
      background: "#000000",
      fontFamily: "General Sans",
      colors: ["#FFFFFF"],
    },
    scenes,
  };
}

/** <video> metadata 로 실제 재생 길이(초)를 잰다. 실패 시 null. */
export function probeVideoDuration(src: string, timeoutMs = 10_000): Promise<number | null> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      v.onloadedmetadata = null;
      v.onerror = null;
      v.removeAttribute("src");
      v.load();
    };
    v.onloadedmetadata = () => {
      const d = Number.isFinite(v.duration) ? v.duration : null;
      cleanup();
      resolve(d);
    };
    v.onerror = () => {
      cleanup();
      resolve(null);
    };
    v.src = src;
  });
}
