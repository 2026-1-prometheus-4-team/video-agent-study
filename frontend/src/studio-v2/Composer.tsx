"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { motion } from "motion/react";
import { ArrowUp, Paperclip, Square, X } from "lucide-react";
import { toast } from "sonner";
import { useAgentStore } from "./state";
import {
  ensureSessionAndConnect,
  tryCancel,
  trySendChat,
  uploadVideo,
} from "./backend";
import styles from "./composer.module.css";

export function Composer() {
  const [text, setText] = useState("");
  const [dragging, setDragging] = useState(false);
  const [attached, setAttached] = useState<File | null>(null);
  const uploadedName = useAgentStore((s) => s.uploadedName);
  const connection = useAgentStore((s) => s.connection);
  const sessionStatus = useAgentStore((s) => s.sessionStatus);
  const isRunning = sessionStatus === "streaming";
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow textarea (line-count 기반, max 160px)
  useEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const next = Math.min(ta.scrollHeight, 160);
    ta.style.height = `${next}px`;
  }, [text]);

  // EmptyState 프롬프트 카드 클릭 → 이 창을 텍스트로 채우고 focus
  useEffect(() => {
    const onFill = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (typeof detail === "string") {
        setText(detail);
        // focus after next frame (렌더링 대기)
        requestAnimationFrame(() => {
          const ta = inputRef.current;
          if (ta) {
            ta.focus();
            ta.setSelectionRange(detail.length, detail.length);
          }
        });
      }
    };
    window.addEventListener("va:fill-composer", onFill);
    return () => window.removeEventListener("va:fill-composer", onFill);
  }, []);

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

    if (!backendUp) {
      toast("백엔드 오프라인", {
        description: "backend uvicorn 서버가 켜져 있어야 실제 실행됩니다.",
      });
      return;
    }

    // 세션 없거나 소켓 없으면 만들고 붙임 (upload 된 서버 path 사용)
    const sock = await ensureSessionAndConnect(serverPath || undefined);
    if (!sock) {
      toast.error("세션 생성 실패", {
        description: "backend /session 응답 없음",
      });
      return;
    }
    const ok = trySendChat(t);
    if (!ok) {
      toast.error("메시지 전송 실패", {
        description: "WebSocket 상태를 확인해줘",
      });
      return;
    }
    // Optimistic pending phase — 백엔드 첫 이벤트 도착 전까지 rail 이 살아있는
    // 것처럼 보이게. 백엔드가 phase_start 를 보내면 endPhase("pending") 로 마감.
    store.startPhase(
      "pending",
      "에이전트 준비 중",
      "요청을 수신하고 파이프라인을 여는 중이야"
    );
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

          {isRunning ? (
            <button
              type="button"
              className={styles.stopBtn}
              onClick={() => {
                const ok = tryCancel();
                if (ok) {
                  toast("중지 요청 전송", {
                    description: "진행 중이던 tool 완료 후 즉시 종료",
                  });
                } else {
                  toast.error("중지 실패", {
                    description: "WebSocket 상태 확인 필요",
                  });
                }
              }}
              aria-label="중지"
              title="중지 (⌘.)"
            >
              <Square size={11} strokeWidth={0} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              className={styles.sendBtn}
              onClick={handleSend}
              disabled={!text.trim()}
              aria-label="보내기"
            >
              <ArrowUp size={14} strokeWidth={2.6} />
            </button>
          )}
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

