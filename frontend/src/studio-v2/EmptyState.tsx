"use client";

import { motion } from "motion/react";
import { Sparkles, Upload } from "lucide-react";
import { useHotkeys } from "react-hotkeys-hook";
import { toast } from "sonner";
import { useAgentStore } from "./state";
import { uploadVideos } from "./backend";
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

export function EmptyState() {
  const uploadedNames = useAgentStore((s) => s.uploadedNames);

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

  return (
    <div className={styles.wrap}>
      <motion.div
        className={styles.hero}
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

        <label className={styles.uploadBtn}>
          <Upload size={13} />
          <span>영상 업로드</span>
          <input
            type="file"
            accept="video/*"
            multiple
            hidden
            onChange={async (e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length === 0) return;
              try {
                const ok = await uploadVideos(files);
                if (ok.length > 0) {
                  toast.success(`영상 ${ok.length}개 업로드 완료`);
                } else {
                  throw new Error("no upload");
                }
              } catch {
                toast("업로드는 로컬만 성공 (백엔드 응답 없음)", {
                  description:
                    "지금은 로컬 프리뷰만 가능. 아래 예시 지시로 스트리밍 UX 는 확인 가능.",
                });
              }
            }}
          />
        </label>

        {uploadedNames.length > 0 && (
          <div className={styles.uploadedList}>
            {uploadedNames.map((n, i) => (
              <span key={`${n}-${i}`} className={styles.uploadedChip}>
                {n}
              </span>
            ))}
          </div>
        )}

        <div className={styles.uploadHint}>또는 여기로 드래그 (여러 개 가능)</div>
      </motion.div>

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
    </div>
  );
}
