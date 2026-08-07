"use client";

import { useEffect } from "react";
import { motion } from "motion/react";
import { EditorTopBar } from "./EditorTopBar";
import { SubtitleList } from "./SubtitleList";
import { EditorPreview } from "./EditorPreview";
import { EditorInspector } from "./EditorInspector";
import { EditorTimeline } from "./EditorTimeline";
import { useAgentStore } from "@/studio-v2/state";
import { useEditorStore } from "./editorState";
import { getSubtitleDocument, pathStem } from "@/studio-v2/subtitle/subtitleApi";
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
  const setGlobalSubtitleStyle = useEditorStore((s) => s.setGlobalSubtitleStyle);

  const hasContext = !!videoContext || !!uploadedName || !!lastFinal;
  const finalPath = lastFinal?.outputPath;

  // 자막 스타일을 서버 큐 문서에서 직접 가져온다.
  // 이전에는 globalSubtitleStyle 을 채우는 곳이 스튜디오의 자막 스타일 카드
  // 하나뿐이었다. 그 카드는 자막 큐가 있을 때만 뜨고 메모리에만 남아서,
  // /motion 을 직접 열거나 카드를 안 거치면 값이 null 이었다. 그러면
  // EditorPreview 가 하드코딩 기본값(26px · 검정 외곽선 없음)으로 그려서
  // 같은 영상인데 미리보기와 폰트가 달라 보였다.
  useEffect(() => {
    const stem = pathStem(finalPath);
    if (!stem) return;
    let alive = true;
    getSubtitleDocument(stem)
      .then((doc) => {
        if (!alive) return;
        setGlobalSubtitleStyle({
          size: doc.style.size,
          color: doc.style.color,
          bold: doc.style.bold,
          strokeColor: doc.style.stroke_color,
          strokeWidth: doc.style.stroke_width,
          position:
            doc.style.position === "top"
              ? "top"
              : doc.style.position === "middle"
                ? "middle"
                : "bottom",
        });
      })
      .catch(() => {
        // 백엔드가 없으면 기존 기본값으로 둔다 — 편집 자체는 계속 가능해야 한다.
      });
    return () => {
      alive = false;
    };
  }, [finalPath, setGlobalSubtitleStyle]);

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
