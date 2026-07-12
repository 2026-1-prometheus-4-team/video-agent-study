"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { motion } from "motion/react";
import { ArrowUp, Paperclip, X } from "lucide-react";
import { toast } from "sonner";
import { useAgentStore } from "./state";
import { playScenario } from "./mock/mockStream";
import { ensureSessionAndConnect, trySendChat, uploadVideo } from "./backend";
import styles from "./composer.module.css";

export function Composer() {
  const [text, setText] = useState("");
  const [dragging, setDragging] = useState(false);
  const [attached, setAttached] = useState<File | null>(null);
  const uploadedName = useAgentStore((s) => s.uploadedName);
  const connection = useAgentStore((s) => s.connection);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow textarea (line-count 기반, max 160px)
  useEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const next = Math.min(ta.scrollHeight, 160);
    ta.style.height = `${next}px`;
  }, [text]);

  const handleSend = useCallback(async () => {
    const t = text.trim();
    if (!t) return;
    const store = useAgentStore.getState();
    const backendUp =
      store.connection === "online" || store.connection === "reconnecting";
    const serverPath = store.serverVideoPath;

    // 유저 메시지는 항상 push (즉각 피드백)
    store.appendUser(t, attached ? [attached.name] : undefined);
    setText("");

    if (backendUp) {
      // 세션 없거나 소켓 없으면 만들고 붙임 (upload 된 서버 path 사용)
      const sock = await ensureSessionAndConnect(serverPath || undefined);
      if (sock) {
        const ok = trySendChat(t);
        if (!ok) {
          toast("메시지 전송 실패, 데모 시나리오로 대체", {
            description: "백엔드 연결 문제",
          });
          const kind = detectMockable(t);
          if (kind) void playScenario(kind);
        }
        return;
      }
    }

    // 백엔드 없음 → mock
    const kind = detectMockable(t);
    if (kind) void playScenario(kind);
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

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    setAttached(f);
    const url = URL.createObjectURL(f);
    const store = useAgentStore.getState();
    store.setUpload(0, f.name, url, null);
    try {
      // 진행률만 갱신 (url 은 넘기지 않음 → revoke 위험 X)
      store.setUpload(30);
      const res = await uploadVideo(f);
      store.setUpload(100, undefined, undefined, res.path);
      toast.success("업로드 완료", { description: res.path });
    } catch {
      store.setUpload(100);
      toast("로컬 프리뷰만 (백엔드 미응답)");
    }
  };

  return (
    <div className={styles.wrap}>
      {uploadedName && !attached && (
        <div className={styles.uploadedRow}>
          <div className={styles.uploadedName}>{uploadedName}</div>
          <button
            type="button"
            onClick={() => useAgentStore.getState().setUpload(null, null, null)}
            aria-label="첨부 취소"
            className={styles.uploadedRemove}
          >
            <X size={11} />
          </button>
        </div>
      )}

      {attached && !uploadedName && (
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
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                setAttached(f);
                const url = URL.createObjectURL(f);
                const store = useAgentStore.getState();
                store.setUpload(0, f.name, url, null);
                try {
                  store.setUpload(30);
                  const res = await uploadVideo(f);
                  store.setUpload(100, undefined, undefined, res.path);
                  toast.success("업로드 완료", {
                    description: res.path,
                  });
                } catch {
                  store.setUpload(100);
                  toast("로컬 프리뷰만 (백엔드 미응답)");
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
