"use client";

import { motion } from "motion/react";
import { EditorTopBar } from "./EditorTopBar";
import { SubtitleList } from "./SubtitleList";
import { EditorPreview } from "./EditorPreview";
import { EditorInspector } from "./EditorInspector";
import { EditorTimeline } from "./EditorTimeline";
import { useAgentStore } from "@/studio-v2/state";
import styles from "./motion-editor-shell.module.css";

/**
 * MotionEditorShell — studio-v2 와 짝을 이루는 심화 편집기.
 *
 * 데이터: studio-v2 store 의 uploadedUrl / lastFinal / videoContext 를 그대로
 * 참조 (딥링크 spec 파일 없음). editorState 는 로컬 편집 상태만.
 *
 * 레이아웃 (반응형):
 *   ≥1280: [Subtitles | Preview + Timeline | Inspector]
 *   768-1279: [Subtitles(collapsible) | Preview + Timeline] · Inspector overlay
 *   <768: 세로 스택
 */
export function MotionEditorShell() {
  const videoContext = useAgentStore((s) => s.videoContext);
  const uploadedName = useAgentStore((s) => s.uploadedName);
  const lastFinal = useAgentStore((s) => s.lastFinal);

  const hasContext = !!videoContext || !!uploadedName || !!lastFinal;

  return (
    <div className={styles.shell}>
      <EditorTopBar />

      {hasContext ? (
        <>
          <aside className={styles.left}>
            <SubtitleList />
          </aside>

          <main className={styles.center}>
            <EditorPreview />
            <EditorTimeline />
          </main>

          <aside className={styles.right}>
            <EditorInspector />
          </aside>
        </>
      ) : (
        <motion.div
          className={styles.emptyStage}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.24 }}
        >
          <div className={styles.emptyMark}>◐</div>
          <div className={styles.emptyTitle}>편집할 소스가 없어</div>
          <div className={styles.emptyCaption}>
            먼저 스튜디오에서 영상을 업로드하거나 편집을 마친 뒤 여기로 넘어와.
          </div>
          <a href="/" className={styles.emptyLink}>
            스튜디오로 돌아가기
          </a>
        </motion.div>
      )}
    </div>
  );
}
