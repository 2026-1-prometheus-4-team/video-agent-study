"use client";

import Link from "next/link";
import { ArrowLeft, Download, Save, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useAgentStore } from "@/studio-v2/state";
import { useEditorStore } from "./editorState";
import styles from "./editor-topbar.module.css";

export function EditorTopBar() {
  const uploadedName = useAgentStore((s) => s.uploadedName);
  const lastFinal = useAgentStore((s) => s.lastFinal);
  const dirty = useEditorStore((s) => s.dirty);
  const markSaved = useEditorStore((s) => s.markSaved);

  const label =
    lastFinal?.outputPath ||
    uploadedName ||
    "새 프로젝트";

  const onSave = () => {
    // MVP: 로컬 오버라이드만 저장으로 표시. 실 저장 파이프라인 TODO.
    markSaved();
    toast.success("편집 저장", { description: "로컬 편집 버퍼 저장됨" });
  };

  const onExport = () => {
    toast("내보내기 준비 중", {
      description: "백엔드 렌더 파이프라인 연결 예정",
    });
  };

  return (
    <div className={styles.bar}>
      <div className={styles.left}>
        <Link href="/" className={styles.back} aria-label="스튜디오로">
          <ArrowLeft size={14} strokeWidth={2.2} />
          <span>스튜디오</span>
        </Link>
        <div className={styles.divider} />
        <div className={styles.brand}>
          <div className={styles.brandMark}>
            <Sparkles size={11} strokeWidth={2.2} />
          </div>
          <div className={styles.brandText}>
            <span className={styles.brandTitle}>모션 에디터</span>
            <span className={styles.brandCaption}>Refine</span>
          </div>
        </div>
      </div>

      <div className={styles.center}>
        <div className={styles.project}>
          <span className={styles.projectMono}>{label}</span>
          {dirty && (
            <span className={styles.dirtyDot} title="저장되지 않은 변경" />
          )}
        </div>
      </div>

      <div className={styles.right}>
        <button
          type="button"
          className={styles.btnGhost}
          onClick={onSave}
          disabled={!dirty}
          title="저장 (⌘S)"
        >
          <Save size={12} />
          <span>{dirty ? "저장" : "저장됨"}</span>
        </button>
        <button
          type="button"
          className={styles.btnPrimary}
          onClick={onExport}
          title="내보내기 (⌘E)"
        >
          <Download size={12} />
          <span>내보내기</span>
        </button>
      </div>
    </div>
  );
}
