"use client";

import { useCallback, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { motion } from "motion/react";
import { ArrowUp, Paperclip, X } from "lucide-react";
import { useAgentStore } from "./state";
import { playScenario } from "./mock/mockStream";
import styles from "./composer.module.css";

export function Composer() {
  const [text, setText] = useState("");
  const [dragging, setDragging] = useState(false);
  const [attached, setAttached] = useState<File | null>(null);
  const uploadedName = useAgentStore((s) => s.uploadedName);
  const connection = useAgentStore((s) => s.connection);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const t = text.trim();
    if (!t) return;
    // 백엔드 오프라인이면 mock 시나리오 시연.
    const isMockable = detectMockable(t);
    if (isMockable) {
      void playScenario(isMockable);
    } else {
      // 그 외에는 그냥 유저 메세지만 push (백엔드 없이 아무 응답 없음)
      useAgentStore.getState().appendUser(t, attached ? [attached.name] : undefined);
    }
    setText("");
    setAttached(null);
  }, [text, attached]);

  useHotkeys(
    "meta+enter, ctrl+enter",
    (e) => {
      e.preventDefault();
      handleSend();
    },
    { enableOnFormTags: ["TEXTAREA"] },
    [handleSend]
  );

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) {
      setAttached(f);
      useAgentStore.getState().setUpload(100, f.name);
    }
  };

  return (
    <div className={styles.wrap}>
      {uploadedName && !attached && (
        <div className={styles.uploadedRow}>
          <div className={styles.uploadedName}>{uploadedName}</div>
          <button
            type="button"
            onClick={() => useAgentStore.getState().setUpload(null, null)}
            aria-label="첨부 취소"
            className={styles.uploadedRemove}
          >
            <X size={11} />
          </button>
        </div>
      )}

      {attached && (
        <div className={styles.uploadedRow}>
          <div className={styles.uploadedName}>{attached.name}</div>
          <button
            type="button"
            onClick={() => setAttached(null)}
            aria-label="첨부 취소"
            className={styles.uploadedRemove}
          >
            <X size={11} />
          </button>
        </div>
      )}

      <motion.div
        className={styles.field}
        data-dragging={dragging || undefined}
        data-focused={undefined}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <textarea
          ref={inputRef}
          className={styles.input}
          placeholder={
            uploadedName
              ? "다음 지시를 입력해줘…"
              : "영상을 먼저 업로드하거나, 어떤 편집을 원하는지 입력해줘"
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={1}
        />

        <div className={styles.tools}>
          <label className={styles.iconBtn} title="첨부">
            <Paperclip size={14} />
            <input
              type="file"
              accept="video/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  setAttached(f);
                  useAgentStore.getState().setUpload(100, f.name);
                }
              }}
            />
          </label>

          <div className={styles.grow} />

          <div className={styles.shortcuts}>
            <kbd>⌘</kbd>
            <kbd>↵</kbd>
          </div>

          <button
            type="button"
            className={styles.sendBtn}
            onClick={handleSend}
            disabled={!text.trim()}
            aria-label="보내기"
          >
            <ArrowUp size={14} strokeWidth={2.6} />
          </button>
        </div>

        {dragging && (
          <div className={styles.dropOverlay}>
            <div className={styles.dropText}>영상을 여기에 놓아줘</div>
          </div>
        )}
      </motion.div>

      {connection === "offline" && (
        <div className={styles.offlineHint}>
          백엔드 오프라인 상태 · 데모 시나리오는 위 예시로 확인 가능
        </div>
      )}
    </div>
  );
}

function detectMockable(t: string): "shorts" | "concept" | null {
  const l = t.toLowerCase();
  if (l.includes("컨셉") || l.includes("아이디어") || l.includes("모르")) {
    return "concept";
  }
  if (
    l.includes("쇼츠") ||
    l.includes("잘라") ||
    l.includes("자막") ||
    l.includes("맛있다")
  ) {
    return "shorts";
  }
  return null;
}
