"use client";

// resultToSpec — 에이전트 편집 결과(mp4 + video_context)를 에디터 문서로.
// 1) openResultInCanvas: 결과 영상을 video 요소 하나짜리 VideoSpec 으로 열기
// 2) addSubtitleElements: Whisper transcript 를 타이밍 창(timing) 가진
//    텍스트 요소로 변환 — 자막은 결국 텍스트박스다. SRT 번인과 달리
//    스타일/애니메이션 편집이 자유롭다.

import { useEditor } from "@/editor/store";
import { FPS } from "@/engine/normalize";
import { AGENT_API, type FinalResult, type TranscriptSeg } from "./agentStore";

const RESULT_DOC_PATH = "agent/result.json";
const SUBTITLE_ID_PREFIX = "sub-";

function absoluteUrl(url: string): string {
  return url.startsWith("http") ? url : `${AGENT_API}${url}`;
}

/** 결과 mp4 를 단일 씬 VideoSpec 으로 캔버스에 연다. */
export function openResultInCanvas(result: FinalResult): boolean {
  if (!result.outputUrl) return false;
  const duration = result.videoContext?.duration ?? 10;

  const spec = {
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
        elements: [
          {
            element: "video",
            id: "result-video",
            base: {
              src: absoluteUrl(result.outputUrl),
              width: 100,
              height: 100,
              position: { x: 0.5, y: 0.5 },
              fit: "contain",
              loop: false,
              muted: false,
            },
          },
        ],
      },
    ],
  };

  useEditor.getState().loadDoc(RESULT_DOC_PATH, spec);
  return true;
}

/** transcript → 자막 텍스트 요소 (scene 0 기준, timing 창으로 표시 구간 제어).
 *  기존 자막(sub-*) 은 교체. 추가된 개수 반환. */
export function addSubtitleElements(transcript: TranscriptSeg[]): number {
  const state = useEditor.getState();
  const doc = state.doc;
  if (!doc?.scenes?.length || !transcript.length) return 0;

  const segs = transcript
    .filter((t) => (t.text ?? "").trim())
    .map((t) => ({
      start: Math.max(0, Math.round(t.start * FPS)),
      end: Math.max(Math.round(t.start * FPS) + 1, Math.round(t.end * FPS)),
      text: t.text.trim(),
    }));
  if (!segs.length) return 0;

  state.updateDoc("add subtitles", (draft) => {
    const scene = draft.scenes[0];
    if (!scene.elements) scene.elements = [];
    // 기존 자막 요소 제거 후 재생성 (중복 방지)
    scene.elements = scene.elements.filter(
      (el: { id?: string }) => !el.id?.startsWith(SUBTITLE_ID_PREFIX),
    );
    segs.forEach((seg, i) => {
      scene.elements.push({
        element: "text",
        id: `${SUBTITLE_ID_PREFIX}${i + 1}`,
        base: {
          text: seg.text,
          fontSize: 3.2,
          color: "#FFFFFF",
          position: { x: 0.5, y: 0.88 },
        },
        timing: { start: seg.start, end: seg.end },
        // 즉시 표시 (에디터 생성 요소 관례) — 애니메이션은 Layers 에서 추가
        layers: [],
      });
    });
  });
  return segs.length;
}
