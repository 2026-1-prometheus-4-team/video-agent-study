"use client";

import { motion } from "motion/react";
import { useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { Check, HelpCircle, MessageSquare, Sparkles } from "lucide-react";
import type { StreamItem } from "../state";
import { useAgentStore } from "../state";
import { tryResumeInterrupt } from "../backend";
import { Markdown } from "../Markdown";
import styles from "./rows.module.css";

const NODE_LABEL: Record<string, string> = {
  orchestrator: "총괄",
  research: "리서치",
  planning: "기획",
  edit: "편집",
  critic: "검증",
};

export function InterruptCard({
  item,
}: {
  item: Extract<StreamItem, { kind: "interrupt" }>;
}) {
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState("");
  const resolved = item.resolved;

  const approve = () => {
    if (resolved) return;
    // 전송 성공 후에만 resolved 마킹 — 실패 시 카드 유지 + 재시도 가능.
    const sent = tryResumeInterrupt(true);
    if (!sent) {
      useAgentStore
        .getState()
        .pushError(
          "승인 전송 실패",
          "백엔드 연결 상태를 확인하고 카드에서 다시 시도해줘."
        );
      return;
    }
  };

  const submitFeedback = () => {
    if (!feedback.trim() || resolved) return;
    const fb = feedback.trim();
    const sent = tryResumeInterrupt(false, fb);
    if (!sent) {
      useAgentStore
        .getState()
        .pushError(
          "피드백 전송 실패",
          "백엔드 연결 상태를 확인하고 카드에서 다시 시도해줘."
        );
      return;
    }
    // Keep the card unresolved until the backend sends resume_accepted.
  };

  useHotkeys(
    "meta+enter, ctrl+enter",
    () => {
      if (showFeedback) submitFeedback();
      else approve();
    },
    { enableOnFormTags: ["TEXTAREA", "INPUT"] },
    [showFeedback, feedback]
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
          {resolved === "approved"
            ? "계획 승인됨"
            : resolved === "revised"
              ? "수정 요청됨"
              : resolved === "answered"
                ? // composer 로 답한 경우 — 승인/수정 판정은 서버가 하므로 중립 표기.
                  "답변 전송됨"
                : "계획 검토가 필요해"}
        </div>
        {!resolved && (
          <div className={styles.interruptHint}>
            <kbd>⌘</kbd>
            <kbd>↵</kbd>
          </div>
        )}
      </div>

      {item.conceptName && (
        <div className={styles.conceptTitle}>{item.conceptName}</div>
      )}

      {item.creativeBrief && <CreativeBriefView brief={item.creativeBrief} />}

      {item.planMarkdown ? (
        // 기획안(마크다운)이 있으면 steps 리스트 대신 렌더. 길 수 있어 내부 스크롤.
        <div className={styles.planMarkdown}>
          <Markdown text={item.planMarkdown} />
        </div>
      ) : (
        <>
          <div className={styles.interruptSub}>
            <Sparkles size={11} className={styles.interruptSubIcon} />
            <span>
              총 {item.plan.length}단계 · 예상 실행 시간 약 {estTotal(item.plan)}초
            </span>
          </div>

          <div className={styles.planList}>
            {item.plan.map((step, idx) => (
              <div key={step.id} className={styles.planStep}>
                <div className={styles.planStepIdx}>{idx + 1}</div>
                <div className={styles.planStepBody}>
                  <div className={styles.planStepTitle}>
                    <span className={styles.planStepAction}>{step.action}</span>
                    <span className={styles.planStepNode}>
                      {NODE_LABEL[step.expert]}
                    </span>
                    {step.estimatedSec && (
                      <span className={styles.planStepEst}>
                        ~{step.estimatedSec}s
                      </span>
                    )}
                  </div>
                  <div className={styles.planStepReason}>{step.rationale}</div>
                  {step.parallelGroup && (
                    <div className={styles.planStepBadge}>병렬 실행</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {item.questions.length > 0 && (
        <div className={styles.interruptQuestions}>
          <div className={styles.interruptQuestionsLabel}>
            <HelpCircle size={11} />
            <span>확인이 필요한 질문</span>
          </div>
          {item.questions.map((q, i) => (
            <div key={i} className={styles.interruptQuestionItem}>
              <span className={styles.interruptQuestionIdx}>Q{i + 1}</span>
              <span>{q}</span>
            </div>
          ))}
        </div>
      )}

      {!resolved && (
        <div className={styles.interruptFoot}>
          {showFeedback ? (
            <>
              <textarea
                className={styles.interruptInput}
                placeholder="어떻게 수정할까?"
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                rows={2}
                autoFocus
              />
              <div className={styles.interruptActions}>
                <button
                  type="button"
                  className={styles.btnGhost}
                  onClick={() => {
                    setShowFeedback(false);
                    setFeedback("");
                  }}
                >
                  취소
                </button>
                <button
                  type="button"
                  className={styles.btnPrimary}
                  onClick={submitFeedback}
                  disabled={!feedback.trim()}
                >
                  피드백 전송
                </button>
              </div>
            </>
          ) : (
            <div className={styles.interruptActions}>
              <button
                type="button"
                className={styles.btnGhost}
                onClick={() => setShowFeedback(true)}
              >
                <MessageSquare size={12} />
                <span>수정 요청</span>
              </button>
              <button
                type="button"
                className={styles.btnPrimary}
                onClick={approve}
              >
                <Check size={12} />
                <span>이대로 진행</span>
              </button>
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
}

function CreativeBriefView({
  brief,
}: {
  brief: NonNullable<
    Extract<StreamItem, { kind: "interrupt" }>["creativeBrief"]
  >;
}) {
  const overview = [
    ["예상 영상 길이", brief.targetDurationSec != null ? `${brief.targetDurationSec}초` : ""],
    ["길이 선정 이유", brief.durationReason],
    ["전체 콘셉트", brief.concept],
    ["추천 BGM", brief.recommendedBgm],
    ["BGM 흐름", brief.bgmFlow],
    ["기획 의도", brief.intent],
    ["초반 Hook", brief.hook],
  ].filter(([, value]) => value);

  return (
    <section className={styles.brief}>
      <div className={styles.briefHeading}>영상 기획안</div>
      {brief.title && <div className={styles.briefTitle}>{brief.title}</div>}

      {overview.length > 0 && (
        <div className={styles.briefOverview}>
          {overview.map(([label, value]) => (
            <div key={label} className={styles.briefOverviewRow}>
              <span>{label}</span>
              <p>{value}</p>
            </div>
          ))}
        </div>
      )}

      {brief.storyboard.length > 0 && (
        <div className={styles.briefSection}>
          <div className={styles.briefSectionTitle}>타임라인 기획</div>
          <div className={styles.briefTimeline}>
            {brief.storyboard.map((scene) => (
              <div key={`${scene.idx}-${scene.outputStartMs}`} className={styles.briefScene}>
                <div className={styles.briefSceneHead}>
                  <span>{formatRange(scene.outputStartMs, scene.outputEndMs)}</span>
                  {scene.role && <strong>{scene.role}</strong>}
                </div>
                {scene.source && (
                  <div className={styles.briefSource}>
                    {scene.source} {formatRange(scene.sourceStartMs, scene.sourceEndMs)}
                  </div>
                )}
                <BriefLine label="장면 설명" value={scene.visual} />
                <BriefLine label="선택 이유" value={scene.selectionReason} />
                <BriefLine label="자막" value={scene.onScreenText} />
                <BriefLine label="내레이션" value={scene.narration} />
                <BriefLine label="편집 연출" value={scene.editDirection} />
                <BriefLine label="효과음" value={scene.sfx} />
              </div>
            ))}
          </div>
        </div>
      )}

      {(brief.directing.cutTempo ||
        brief.directing.subtitleAndFont ||
        brief.directing.visualAndSpeed) && (
        <div className={styles.briefSection}>
          <div className={styles.briefSectionTitle}>편집 디렉팅</div>
          <BriefLine label="컷 길이 및 템포" value={brief.directing.cutTempo} />
          <BriefLine label="자막 및 폰트" value={brief.directing.subtitleAndFont} />
          <BriefLine label="화면 연출 및 배속" value={brief.directing.visualAndSpeed} />
        </div>
      )}

      {brief.userRevisionGuide.length > 0 && (
        <div className={styles.briefGuide}>
          <div className={styles.briefSectionTitle}>수정 가능한 항목</div>
          <div>{brief.userRevisionGuide.join(" · ")}</div>
        </div>
      )}
    </section>
  );
}

function BriefLine({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className={styles.briefLine}>
      <span>{label}</span>
      <p>{value}</p>
    </div>
  );
}

function formatRange(start?: number, end?: number) {
  if (start == null || end == null) return "";
  return `[${formatMs(start)} ~ ${formatMs(end)}]`;
}

function formatMs(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function estTotal(plan: { estimatedSec?: number }[]) {
  return plan.reduce((sum, p) => sum + (p.estimatedSec ?? 0), 0);
}
