"use client";

import { motion } from "motion/react";
import { AlertCircle, Sparkles, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { toast } from "sonner";
import { useAgentStore } from "./state";
import { fetchMedia, uploadVideos } from "./backend";
import { MediaLibrary } from "./MediaLibrary";
import styles from "./emptystate.module.css";

const PROMPTS = [
  {
    title: "하이라이트만 골라서 30초 숏츠로 만들어줘",
    caption: "장면 분석 → 상위 3개 컷 → 9:16 리프레임",
  },
  {
    title: "말하는 내용을 자막으로 넣어줘",
    caption: "Whisper 전사 → 스타일 자막 → burn-in",
  },
  {
    title: "여행 쇼츠 컨셉 3개 추천해줘",
    caption: "트렌드 리서치 → 컨셉 → 후킹 · CTA · BGM",
  },
];

// 쇼츠 프리셋 — 클릭하면 아래 상세 프롬프트가 입력창에 채워진다(길이만 다름).
// 원본이 세로면 pad 없이 9:16, 가로면 위아래 pad + 그 여백에 제목/자막.
function shortsPrompt(seconds: number): string {
  return `업로드한 영상들을 소재로 ${seconds}초짜리 세로 쇼츠(9:16)를 만들어줘.

[화면 구성]
- 원본이 세로 영상이면 여백 없이 9:16 화면을 꽉 채우고, 원본이 가로 영상이면 비율을 그대로 유지한 채 위아래에 검은 여백을 넣는 pad 방식으로 세로로 만들어줘. 원본 화면을 잘라내는 crop은 쓰지 마.
- 제목은 위쪽에, 발화 자막은 아래쪽에 배치해줘. 가로 원본이라 위아래 검은 여백이 생기면 그 여백 안에 제목/자막이 들어가게 해줘.

[편집]
- 각 영상에서 가장 보기 좋은 구간만 골라 자연스럽게 이어붙여 전체 길이를 ${seconds}초 정도로 맞춰줘. 전체를 다 넣지 말고 하이라이트 위주로.
- 등장인물이 말하는 내용은 발화 자막으로 자동으로 넣어줘.

[사운드]
- 잔잔하고 편안한 배경음악을 영상 전체에 은은하게 깔아줘. 원본 현장음은 살리고 BGM은 작게(원본이 잘 들리게).

[제목]
- 영상 내용에 맞는 짧은 제목을 지어서 위쪽에 넣어줘 (예: "oo 브이로그").`;
}

const SHORTS_PRESETS = [
  { label: "30초 쇼츠", caption: "하이라이트 · 9:16 · 자막 · BGM", seconds: 30 },
  { label: "60초 쇼츠", caption: "풀 하이라이트 · 9:16 · 자막 · BGM", seconds: 60 },
];

// 백엔드 ALLOWED_VIDEO_EXTS 와 동일. 드롭 시점에 걸러야 415 왕복을 줄인다.
const VIDEO_EXTS = [".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"];

// backend/agent/graph.py 의 노드 흐름과 같은 순서.
// 패널 아래쪽을 채우는 동시에, 실행을 누르기 전에 무슨 일이 일어날지 알려준다.
const PIPELINE = [
  { name: "분석", detail: "씬 감지 · 음성 전사 · 화면 요약" },
  { name: "기획", detail: "편집 계획 초안" },
  { name: "승인", detail: "계획을 확인한 뒤 실행" },
  { name: "실행", detail: "컷 · 자막 · BGM" },
  { name: "검증", detail: "길이 · 자막 점검" },
];

function isVideoFile(file: File): boolean {
  if (file.type.startsWith("video/")) return true;
  const lower = file.name.toLowerCase();
  return VIDEO_EXTS.some((ext) => lower.endsWith(ext));
}

export function EmptyState() {
  const uploadPct = useAgentStore((s) => s.uploadPct);
  const uploadError = useAgentStore((s) => s.uploadError);
  const mediaCount = useAgentStore((s) => s.media.length);
  const [dragging, setDragging] = useState(false);
  // dragenter/leave 는 자식 위를 지날 때도 발생한다. 깊이를 세어야 드롭존이
  // 껌뻑이지 않는다.
  const dragDepth = useRef(0);
  const uploadingRef = useRef(false);

  // 새로고침해도 라이브러리는 서버에 남아 있다 — 마운트 때 복원.
  useEffect(() => {
    void fetchMedia();
  }, []);

  const runUpload = useCallback(async (files: File[]) => {
    const videos = files.filter(isVideoFile);
    const rejected = files.length - videos.length;
    if (rejected > 0) {
      toast.error(`영상이 아닌 파일 ${rejected}개는 제외했어`, {
        description: VIDEO_EXTS.join(" · "),
      });
    }
    if (videos.length === 0) return;
    if (uploadingRef.current) return;

    uploadingRef.current = true;
    try {
      const before = useAgentStore.getState().media.length;
      const ok = await uploadVideos(videos);
      const after = useAgentStore.getState().media.length;
      const reused = ok.length - (after - before);

      if (ok.length === 0) {
        toast.error("업로드에 실패했어", {
          description:
            useAgentStore.getState().uploadError ?? "백엔드가 떠 있는지 확인해줘",
        });
      } else if (reused > 0) {
        toast.success(`영상 ${ok.length}개 준비 완료`, {
          description: `${reused}개는 이미 올린 영상이라 그대로 재사용했어`,
        });
      } else {
        toast.success(`영상 ${ok.length}개 업로드 완료`);
      }
    } finally {
      uploadingRef.current = false;
    }
  }, []);

  // 드롭존 밖에 떨어뜨렸을 때 브라우저가 영상을 재생해버리는 것 방지.
  useEffect(() => {
    const swallow = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);

  const fillComposer = (title: string) => {
    // 예시 프롬프트 = Composer 에 텍스트만 채워넣기.
    // 사용자가 확인 후 직접 전송 (실제 백엔드가 뜨면 실제 실행, 아니면 유저 메시지만 남음).
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("va:fill-composer", { detail: title })
      );
    }
  };

  useHotkeys("meta+1, ctrl+1", (e) => {
    e.preventDefault();
    fillComposer(PROMPTS[0].title);
  });
  useHotkeys("meta+2, ctrl+2", (e) => {
    e.preventDefault();
    fillComposer(PROMPTS[1].title);
  });
  useHotkeys("meta+3, ctrl+3", (e) => {
    e.preventDefault();
    fillComposer(PROMPTS[2].title);
  });

  const uploading = uploadPct !== null && uploadPct < 100;

  return (
    <div
      className={styles.wrap}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        // preventDefault 가 없으면 drop 이벤트 자체가 오지 않는다.
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        void runUpload(Array.from(e.dataTransfer.files ?? []));
      }}
    >
      <motion.div
        className={styles.hero}
        data-dragging={dragging}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className={styles.heroIcon}>
          <Sparkles size={14} strokeWidth={2.2} />
        </div>
        <div className={styles.heroTitle}>영상으로 시작해</div>
        <div className={styles.heroCaption}>
          여러 영상을 올려도 돼. 각 영상을 분석하고, 자연어 한 줄로 컷 · 자막 ·
          BGM 까지 에이전트가 처리해. 실행 전 계획을 먼저 보여줄게.
        </div>

        <label className={styles.uploadBtn} data-disabled={uploading}>
          <Upload size={13} />
          <span>{uploading ? `업로드 중 ${uploadPct}%` : "영상 업로드"}</span>
          <input
            type="file"
            accept="video/*"
            multiple
            hidden
            disabled={uploading}
            onChange={async (e) => {
              const files = Array.from(e.target.files ?? []);
              // 같은 파일을 연속으로 고를 수 있게 input 을 비운다.
              e.target.value = "";
              await runUpload(files);
            }}
          />
        </label>

        {uploading && (
          <div className={styles.progressTrack} aria-hidden>
            <motion.div
              className={styles.progressFill}
              initial={false}
              animate={{ width: `${uploadPct}%` }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            />
          </div>
        )}

        <div className={styles.uploadHint}>
          {dragging ? "여기에 놓으면 업로드돼" : "또는 여기로 드래그 (여러 개 가능)"}
        </div>

        {dragging && <div className={styles.dropOverlay} aria-hidden />}
      </motion.div>

      {uploadError && (
        <div className={styles.uploadError} role="alert">
          <AlertCircle size={12} strokeWidth={2} />
          <span className={styles.uploadErrorText}>{uploadError}</span>
        </div>
      )}

      <MediaLibrary />

      {mediaCount === 0 && (
        <>
          <div className={styles.promptsHeader}>이렇게 시작해봐</div>

          <div className={styles.prompts}>
            {PROMPTS.map((p, i) => (
              <motion.button
                key={i}
                type="button"
                className={styles.promptCard}
                onClick={() => fillComposer(p.title)}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: 0.24,
                  delay: 0.06 * i,
                  ease: [0.22, 1, 0.36, 1],
                }}
                whileHover={{ y: -1 }}
              >
                <div className={styles.promptTop}>
                  <div className={styles.promptTitle}>{p.title}</div>
                  <div className={styles.promptShortcut}>
                    <kbd>⌘</kbd>
                    <kbd>{i + 1}</kbd>
                  </div>
                </div>
                <div className={styles.promptCaption}>{p.caption}</div>
              </motion.button>
            ))}
          </div>
        </>
      )}

      {mediaCount > 0 && (
        <>
          <div className={styles.promptsHeader}>쇼츠 프리셋 — 클릭하면 지시가 채워져</div>
          <div className={styles.prompts}>
            {SHORTS_PRESETS.map((p, i) => (
              <motion.button
                key={p.seconds}
                type="button"
                className={styles.promptCard}
                onClick={() => fillComposer(shortsPrompt(p.seconds))}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: 0.24,
                  delay: 0.06 * i,
                  ease: [0.22, 1, 0.36, 1],
                }}
                whileHover={{ y: -1 }}
              >
                <div className={styles.promptTop}>
                  <div className={styles.promptTitle}>{p.label}</div>
                </div>
                <div className={styles.promptCaption}>{p.caption}</div>
              </motion.button>
            ))}
          </div>
          <div className={styles.readyHint}>
            쓸 영상을 고르고 프리셋을 누르거나, 아래에 직접 편집을 적어줘.
          </div>
        </>
      )}

      {/* margin-top:auto 로 하단에 붙는다. 남는 세로 공간이 "빈 화면"이 아니라
          액션(위)과 설명(아래) 사이의 여백으로 읽히게 하는 장치. */}
      <div className={styles.pipeline}>
        <div className={styles.pipelineHead}>지시하면 이렇게 진행돼</div>
        <ol className={styles.pipelineList}>
          {PIPELINE.map((step) => (
            <li key={step.name} className={styles.pipelineStep}>
              <span className={styles.pipelineDot} aria-hidden />
              <span className={styles.pipelineName}>{step.name}</span>
              <span className={styles.pipelineDetail}>{step.detail}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
