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

// 백엔드 ALLOWED_VIDEO_EXTS 와 동일. 드롭 시점에 걸러야 415 왕복을 줄인다.
const VIDEO_EXTS = [".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"];

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
        <div className={styles.readyHint}>
          쓸 영상을 고르고 아래에 하고 싶은 편집을 적어줘.
        </div>
      )}
    </div>
  );
}
