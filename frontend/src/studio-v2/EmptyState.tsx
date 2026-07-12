"use client";

import { motion } from "motion/react";
import { Sparkles, Upload } from "lucide-react";
import { useHotkeys } from "react-hotkeys-hook";
import { useAgentStore } from "./state";
import { playScenario } from "./mock/mockStream";
import styles from "./emptystate.module.css";

const PROMPTS = [
  {
    title: "하이라이트만 골라서 30초 숏츠로 만들어줘",
    caption: "장면 분석 → 상위 3개 컷 → 9:16 리프레임",
    scenario: "shorts" as const,
  },
  {
    title: "말하는 내용을 자막으로 넣어줘",
    caption: "Whisper 전사 → 스타일 자막 → burn-in",
    scenario: "shorts" as const,
  },
  {
    title: "여행 쇼츠 컨셉 3개 추천해줘",
    caption: "트렌드 리서치 → 컨셉 → 후킹 · CTA · BGM",
    scenario: "concept" as const,
  },
];

export function EmptyState() {
  const setUpload = useAgentStore((s) => s.setUpload);

  const trigger = (scenario: "shorts" | "concept") => {
    if (scenario === "shorts") {
      setUpload(100, "cooking-2m.mp4");
    }
    void playScenario(scenario);
  };

  useHotkeys("meta+1, ctrl+1", (e) => {
    e.preventDefault();
    trigger(PROMPTS[0].scenario);
  });
  useHotkeys("meta+2, ctrl+2", (e) => {
    e.preventDefault();
    trigger(PROMPTS[1].scenario);
  });
  useHotkeys("meta+3, ctrl+3", (e) => {
    e.preventDefault();
    trigger(PROMPTS[2].scenario);
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
        <div className={styles.heroTitle}>영상 하나로 시작해</div>
        <div className={styles.heroCaption}>
          업로드한 영상을 분석하고, 자연어 한 줄로 컷 · 자막 · BGM 까지
          에이전트가 처리해. 실행 전 계획을 먼저 보여줄게.
        </div>

        <label className={styles.uploadBtn}>
          <Upload size={13} />
          <span>영상 업로드</span>
          <input
            type="file"
            accept="video/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setUpload(100, f.name);
            }}
          />
        </label>

        <div className={styles.uploadHint}>또는 여기로 드래그</div>
      </motion.div>

      <div className={styles.promptsHeader}>이렇게 시작해봐</div>

      <div className={styles.prompts}>
        {PROMPTS.map((p, i) => (
          <motion.button
            key={i}
            type="button"
            className={styles.promptCard}
            onClick={() => trigger(p.scenario)}
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
