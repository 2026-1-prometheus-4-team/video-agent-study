"use client";

// resultToSpec — 에이전트 편집 결과(mp4 + video_context)를 에디터 문서로.
// (/motion 의 Agent 탭 전용 — 스튜디오는 studio/resultSpec.ts 로 파일 저장 + 딥링크)
// 1) openResultInCanvas: 결과 영상을 VideoSpec 으로 열기 (30s 씬 분할 포함)
// 2) addSubtitleElements: transcript 를 타이밍 창 가진 텍스트 요소로 —
//    자막은 결국 텍스트박스다. 씬 분할 문서에도 씬-로컬 프레임으로 배치.

import { useEditor } from "@/editor/store";
import { FPS } from "@/engine/normalize";
import { AGENT_API, type FinalResult, type TranscriptSeg } from "./agentStore";
import { buildResultSpec, probeVideoDuration } from "./buildResultSpec";

const RESULT_DOC_PATH = "agent/result.json";
const SUBTITLE_ID_PREFIX = "sub-";

function absoluteUrl(url: string): string {
  return url.startsWith("http") ? url : `${AGENT_API}${url}`;
}

/** 결과 mp4 를 VideoSpec 으로 캔버스에 연다 (길면 30s 씬 분할). */
export async function openResultInCanvas(result: FinalResult): Promise<boolean> {
  if (!result.outputUrl) return false;
  const src = absoluteUrl(result.outputUrl);
  const probed = await probeVideoDuration(src);
  const duration = probed ?? result.videoContext?.duration ?? 10;

  const spec = buildResultSpec({ videoSrc: src, videoDuration: duration });
  useEditor.getState().loadDoc(RESULT_DOC_PATH, spec);
  return true;
}

/** transcript → 자막 텍스트 요소. 현재 문서의 씬 경계에 맞춰 분배.
 *  기존 자막(sub-*) 은 교체. 추가된 개수 반환. */
export function addSubtitleElements(transcript: TranscriptSeg[]): number {
  const state = useEditor.getState();
  const doc = state.doc;
  if (!doc?.scenes?.length || !transcript.length) return 0;

  const segs = transcript
    .filter((t) => (t.text ?? "").trim())
    .map((t) => ({
      startF: Math.max(0, Math.round(t.start * FPS)),
      endF: Math.max(Math.round(t.start * FPS) + 1, Math.round(t.end * FPS)),
      text: t.text.trim(),
    }));
  if (!segs.length) return 0;

  // 씬 시작 프레임 (누적) — 씬 분할 문서에서도 올바른 로컬 타이밍 계산
  const sceneStarts: number[] = [];
  let cursor = 0;
  for (const scene of doc.scenes) {
    sceneStarts.push(cursor);
    cursor += Math.max(1, Math.round((scene.duration ?? 2) * FPS));
  }
  const totalF = cursor;

  let added = 0;
  state.updateDoc("add subtitles", (draft) => {
    draft.scenes.forEach((scene: { elements?: { id?: string }[] }, i: number) => {
      if (!scene.elements) scene.elements = [];
      scene.elements = scene.elements.filter(
        (el) => !el.id?.startsWith(SUBTITLE_ID_PREFIX),
      );
      const sceneStartF = sceneStarts[i];
      const sceneEndF = i + 1 < sceneStarts.length ? sceneStarts[i + 1] : totalF;

      segs.forEach((seg, n) => {
        const s = Math.max(seg.startF, sceneStartF);
        const e = Math.min(seg.endF, sceneEndF);
        if (e <= s) return;
        added += 1;
        (scene.elements as Record<string, unknown>[]).push({
          element: "text",
          id: `${SUBTITLE_ID_PREFIX}${i + 1}-${n + 1}`,
          base: {
            text: seg.text,
            fontSize: 3.2,
            color: "#FFFFFF",
            position: { x: 0.5, y: 0.88 },
          },
          timing: { start: s - sceneStartF, end: e - sceneStartF },
          layers: [],
        });
      });
    });
  });
  return added;
}
