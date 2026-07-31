"use client";

import { motion } from "motion/react";
import { useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { Check, CornerDownLeft, Play } from "lucide-react";
import type { ClarifyCandidate, StreamItem } from "../state";
import { useAgentStore } from "../state";
import { tryResumeClarify } from "../backend";
import { formatSeconds } from "@/lib/format";
import styles from "./rows.module.css";

/**
 * ClarifyCard — 에이전트가 되묻는 질문 카드 (interrupt payload.type === "clarify").
 *
 * - 후보 칩 클릭 = 원본 소스로 전환 후 해당 구간으로 시킹 (미리보기)
 * - 체크 토글로 후보 다중 선택, options 는 단일 선택
 * - 자유 텍스트 답변 가능. 전송 성공 후에만 resolved 마킹 (mock 폴백 없음)
 */
export function ClarifyCard({
  item,
}: {
  item: Extract<StreamItem, { kind: "interrupt" }>;
}) {
  const [text, setText] = useState("");
  const [selectedIdx, setSelectedIdx] = useState<number[]>([]);
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const resolved = item.resolved;

  const candidates = item.candidates ?? [];
  const options = item.options ?? [];

  const preview = (c: ClarifyCandidate) => {
    const store = useAgentStore.getState();
    // 후보 구간은 항상 원본 기준 — 편집본을 보고 있었으면 원본으로 전환.
    if (store.stageViewMode !== "source") {
      store.setStageViewMode("source");
    }
    store.requestSeek(c.startMs / 1000);
  };

  const toggleCandidate = (idx: number) => {
    if (resolved) return;
    setSelectedIdx((prev) =>
      prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx]
    );
  };

  const composeReply = (): string => {
    const t = text.trim();
    if (t) return t;
    if (selectedOption !== null && options[selectedOption]) {
      return options[selectedOption];
    }
    if (selectedIdx.length > 0) {
      const labels = [...selectedIdx]
        .sort((a, b) => a - b)
        .map((i) => candidates[i]?.label || `후보 ${i + 1}`);
      return labels.join(", ");
    }
    return "";
  };

  const canSend =
    !resolved &&
    (text.trim().length > 0 ||
      selectedIdx.length > 0 ||
      selectedOption !== null);

  const send = () => {
    if (!canSend) return;
    const reply = composeReply();
    const selected = [...selectedIdx].sort((a, b) => a - b);
    // 전송 성공 후에만 resolved 마킹 — 실패 시 카드 유지 + 재시도 가능.
    const sent = tryResumeClarify(reply, selected);
    if (!sent) {
      useAgentStore
        .getState()
        .pushError(
          "답변 전송 실패",
          "백엔드 연결 상태를 확인하고 카드에서 다시 시도해줘."
        );
      return;
    }
    // Keep the answer and card visible until resume_accepted arrives. This
    // lets AgentSocket retry a transient RESUME_NOT_READY without losing the
    // user's selection.
  };

  useHotkeys(
    "meta+enter, ctrl+enter",
    () => send(),
    { enableOnFormTags: ["TEXTAREA", "INPUT"] },
    [text, selectedIdx, selectedOption, resolved]
  );

  return (
    <motion.div
      className={styles.interruptCard}
      data-resolved={resolved || undefined}
      initial={{ opacity: 0, y: -12, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{
        type: "spring",
        stiffness: 300,
        damping: 32,
        mass: 0.9,
      }}
    >
      <div className={styles.interruptHeader}>
        <motion.span
          className={styles.interruptDot}
          animate={
            !resolved
              ? { scale: [1, 1.35, 1], opacity: [0.6, 1, 0.6] }
              : { scale: 1 }
          }
          transition={{
            duration: 1.6,
            repeat: !resolved ? Infinity : 0,
            ease: "easeInOut",
          }}
        />
        <div className={styles.interruptTitle}>
          {resolved ? "답변 전송됨" : "확인이 필요해"}
        </div>
        {!resolved && (
          <div className={styles.interruptHint}>
            <kbd>⌘</kbd>
            <kbd>↵</kbd>
          </div>
        )}
      </div>

      {item.question && (
        <div className={styles.clarifyQuestion}>{item.question}</div>
      )}
      {item.context && (
        <div className={styles.clarifyContext}>{item.context}</div>
      )}

      {candidates.length > 0 && (
        <div className={styles.candidateList}>
          {candidates.map((c, idx) => {
            const checked = selectedIdx.includes(idx);
            return (
              <div
                key={idx}
                className={styles.candidateRow}
                data-checked={checked || undefined}
              >
                <button
                  type="button"
                  className={styles.candidateToggle}
                  data-checked={checked || undefined}
                  onClick={() => toggleCandidate(idx)}
                  disabled={!!resolved}
                  aria-label={checked ? "후보 선택 해제" : "후보 선택"}
                >
                  {checked && <Check size={10} strokeWidth={3} />}
                </button>
                <button
                  type="button"
                  className={styles.candidateChip}
                  onClick={() => preview(c)}
                  title="이 구간 미리보기"
                >
                  <Play size={10} className={styles.candidatePlay} />
                  <span className={styles.candidateLabel}>
                    {c.label || `후보 ${idx + 1}`}
                  </span>
                  <span className={styles.candidateTime}>
                    {formatSeconds(c.startMs / 1000, false)}
                    {"–"}
                    {formatSeconds(c.endMs / 1000, false)}
                  </span>
                  {typeof c.score === "number" && (
                    <span className={styles.candidateScore}>
                      {formatScore(c.score)}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {options.length > 0 && (
        <div className={styles.optionList}>
          {options.map((opt, idx) => (
            <button
              key={idx}
              type="button"
              className={styles.optionBtn}
              data-active={selectedOption === idx || undefined}
              onClick={() =>
                !resolved &&
                setSelectedOption((prev) => (prev === idx ? null : idx))
              }
              disabled={!!resolved}
            >
              {opt}
            </button>
          ))}
        </div>
      )}

      {!resolved && (
        <div className={styles.interruptFoot}>
          <textarea
            className={styles.interruptInput}
            placeholder="후보를 고르거나, 원하는 구간을 직접 설명해줘"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
          />
          <div className={styles.interruptActions}>
            <button
              type="button"
              className={styles.btnPrimary}
              onClick={send}
              disabled={!canSend}
            >
              <CornerDownLeft size={12} />
              <span>답변 전송</span>
            </button>
          </div>
        </div>
      )}
    </motion.div>
  );
}

/** score 0..1 은 백분율, 그 외엔 소수 1자리로 표기. */
function formatScore(score: number): string {
  if (score >= 0 && score <= 1) return `${Math.round(score * 100)}%`;
  return score.toFixed(1);
}
