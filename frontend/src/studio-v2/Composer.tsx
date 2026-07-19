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
  tryResumeClarify,
  trySendChat,
  uploadVideos,
} from "./backend";
import styles from "./composer.module.css";

export function Composer() {
  const [text, setText] = useState("");
  const [dragging, setDragging] = useState(false);
  const uploadedNames = useAgentStore((s) => s.uploadedNames);
  const connection = useAgentStore((s) => s.connection);
  const sessionStatus = useAgentStore((s) => s.sessionStatus);
  const pendingInterrupt = useAgentStore((s) => s.pendingInterrupt);
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
    store.appendUser(
      t,
      store.uploadedNames.length > 0 ? store.uploadedNames : undefined
    );
    setText("");

    if (!backendUp) {
      toast("백엔드 오프라인", {
        description: "backend uvicorn 서버가 켜져 있어야 실제 실행됩니다.",
      });
      return;
    }

    // interrupt 대기 중 composer 입력 라우팅.
    const pending = store.pendingInterrupt;
    if (pending) {
      const isClarify = pending.interruptKind === "clarify";
      // clarify 는 reply 를 원문 그대로 서버에 넘기면 되므로 resume 유지.
      // script_approval 은 chat 으로 보낸다 — "좋아" / "이대로 진행해줘" 같은
      // 승인 문구를 resume(approved:false) 로 보내면 서버의 kind-aware 승인
      // 휴리스틱(_reply_to_resume)에 도달하지 못해 무조건 plan 이 재생성된다.
      // 서버는 interrupt 대기 중 chat 을 거부하지 않고 kind 에 맞는 resume 으로
      // 변환하므로, 승인/피드백 판정을 서버에 맡긴다.
      const sent = isClarify ? tryResumeClarify(t, []) : trySendChat(t);
      if (!sent) {
        toast.error("전송 실패", {
          description: "WebSocket 상태를 확인해줘",
        });
        return;
      }
      // 전송 성공 후에만 resolved 마킹. 유저 버블은 위에서 이미 push 됨.
      // script_approval 은 서버 판정 결과(승인/수정)를 모르므로 낙관적 마킹 금지 —
      // 후속 interrupt(재생성된 plan) / final / done 이벤트로 자연 정리된다.
      if (isClarify) store.markInterruptResolved("answered");
      store.startPhase(
        "pending",
        "에이전트 재개 중",
        "응답을 반영해 파이프라인을 이어가는 중이야"
      );
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
  }, [text]);

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
    const files = Array.from(e.dataTransfer.files ?? []).filter((f) =>
      f.type.startsWith("video/")
    );
    if (files.length === 0) return;
    try {
      const ok = await uploadVideos(files);
      if (ok.length > 0) toast.success(`영상 ${ok.length}개 업로드 완료`);
      else throw new Error("no upload");
    } catch {
      toast("로컬 프리뷰만 (백엔드 미응답)");
    }
  };

  return (
    <div className={styles.wrap}>
      {uploadedNames.length > 0 && (
        <div className={styles.uploadedRow}>
          {uploadedNames.map((n, i) => (
            <div key={`${n}-${i}`} className={styles.uploadedName}>
              {n}
            </div>
          ))}
          <button
            type="button"
            onClick={() => useAgentStore.getState().clearVideos()}
            aria-label="첨부 전체 취소"
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
            pendingInterrupt
              ? pendingInterrupt.interruptKind === "clarify"
                ? "후보에 대해 답하거나 다른 요청을 입력해줘…"
                : "이대로 진행할지 답하거나, 수정할 내용을 입력해줘…"
              : uploadedNames.length > 0
                ? "다음 지시를 입력해줘…"
                : "영상을 먼저 업로드하거나, 어떤 편집을 원하는지 입력해줘"
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={1}
        />

        <div className={styles.tools}>
          <label className={styles.iconBtn} title="영상 첨부 (여러 개 가능)">
            <Paperclip size={14} />
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
                  if (ok.length > 0)
                    toast.success(`영상 ${ok.length}개 업로드 완료`);
                  else throw new Error("no upload");
                } catch {
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

