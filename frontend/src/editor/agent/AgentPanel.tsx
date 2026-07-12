"use client";

// AgentPanel — 좌측 "Agent" 탭. 백엔드 편집 파이프라인과의 채팅 E2E.
// 흐름: 영상 업로드 → 세션 생성 → 자연어 지시 → 계획 승인(interrupt)
//       → 실행 스트리밍(tool_call) → 결과 카드(프리뷰 / 캔버스 열기 / 자막).

import React from "react";
import {
  useAgent,
  AGENT_API,
  type FeedItem,
  type InterruptPayload,
  type FinalResult,
} from "./agentStore";
import { openResultInCanvas, addSubtitleElements } from "./resultToSpec";
import { showToast } from "@/editor/library/toast";
import s from "./agent.module.css";

const EXAMPLES = [
  "하이라이트만 골라서 30초 숏츠로 만들어줘",
  "앞부분 5초 잘라내고 자막 넣어줘",
  "분위기에 맞는 BGM 깔아줘",
];

function InterruptCard({ item }: { item: Extract<FeedItem, { kind: "interrupt" }> }) {
  const resolveInterrupt = useAgent((st) => st.resolveInterrupt);
  const [feedback, setFeedback] = React.useState("");
  const plan = item.payload?.plan ?? ({} as NonNullable<InterruptPayload["plan"]>);
  const steps = plan.steps ?? [];
  const questions = item.payload?.questions ?? plan.questions ?? [];
  const disabled = !!item.resolved;

  return (
    <div className={s.interrupt} data-resolved={item.resolved ?? ""}>
      <div className={s.interruptHead}>편집 계획</div>
      {(plan.target_format || plan.target_duration_sec) && (
        <div className={s.planMeta}>
          {plan.target_format ? <span>{plan.target_format}</span> : null}
          {plan.target_aspect_ratio ? <span>{plan.target_aspect_ratio}</span> : null}
          {plan.target_duration_sec ? <span>{plan.target_duration_sec}s</span> : null}
        </div>
      )}
      {steps.length > 0 && (
        <ol className={s.planSteps}>
          {steps.map((st, i) => (
            <li key={i}>
              <span className={s.stepExpert}>{st.expert ?? st.action ?? "step"}</span>
              <span className={s.stepDesc}>
                {String(st.description ?? st.action ?? "")}
              </span>
            </li>
          ))}
        </ol>
      )}
      {questions.length > 0 && (
        <div className={s.planQuestions}>
          {questions.map((q, i) => (
            <div key={i}>{q}</div>
          ))}
        </div>
      )}
      {item.resolved ? (
        <div className={s.resolvedNote}>
          {item.resolved === "approved" ? "승인됨 — 실행 중" : "수정 요청 보냄"}
        </div>
      ) : (
        <>
          <div className={s.interruptActions}>
            <button className={s.approveBtn} onClick={() => resolveInterrupt(true)} disabled={disabled}>
              승인하고 실행
            </button>
          </div>
          <div className={s.feedbackRow}>
            <input
              className={s.feedbackInput}
              placeholder="수정할 내용 (예: BGM 빼줘)"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && feedback.trim()) {
                  resolveInterrupt(false, feedback.trim());
                  setFeedback("");
                }
              }}
            />
            <button
              className={s.feedbackBtn}
              disabled={!feedback.trim()}
              onClick={() => {
                resolveInterrupt(false, feedback.trim());
                setFeedback("");
              }}
            >
              수정 요청
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function FinalCard({ result }: { result: FinalResult }) {
  const url = result.outputUrl
    ? result.outputUrl.startsWith("http")
      ? result.outputUrl
      : `${AGENT_API}${result.outputUrl}`
    : null;
  const transcript = result.videoContext?.transcript ?? [];

  const openInCanvas = async () => {
    if (await openResultInCanvas(result)) showToast("결과 영상을 캔버스에 열었어요");
    else showToast("결과 URL 이 없어요");
  };
  const addSubs = () => {
    const n = addSubtitleElements(transcript);
    showToast(n ? `자막 ${n}개를 텍스트 요소로 추가했어요` : "추가할 자막이 없어요");
  };

  return (
    <div className={s.finalCard}>
      <div className={s.finalHead}>편집 완료</div>
      {url ? (
        <video className={s.finalVideo} src={url} controls preload="metadata" />
      ) : (
        <div className={s.finalPath}>{result.outputPath}</div>
      )}
      {result.critic?.message_to_user ? (
        <div className={s.criticNote}>{result.critic.message_to_user}</div>
      ) : null}
      <div className={s.finalActions}>
        <button className={s.actBtn} onClick={openInCanvas} disabled={!url}>
          캔버스에 열기
        </button>
        <button
          className={s.actBtn}
          onClick={addSubs}
          disabled={!transcript.length}
          title={transcript.length ? `${transcript.length}개 세그먼트` : "transcript 없음"}
        >
          자막 요소 추가{transcript.length ? ` (${transcript.length})` : ""}
        </button>
        {url ? (
          <a className={s.actBtn} href={url} download>
            다운로드
          </a>
        ) : null}
      </div>
    </div>
  );
}

function FeedRow({ item }: { item: FeedItem }) {
  switch (item.kind) {
    case "user":
      return <div className={s.userMsg}>{item.text}</div>;
    case "agent":
      return (
        <div className={s.agentMsg}>
          <span className={s.nodeTag}>{item.node}</span>
          <div className={s.agentText}>{item.text}</div>
        </div>
      );
    case "tool":
      return (
        <div className={s.toolChip} title={JSON.stringify(item.args)}>
          <span className={s.toolDot} />
          {item.tool}
          <span className={s.toolNode}>{item.node}</span>
        </div>
      );
    case "interrupt":
      return <InterruptCard item={item} />;
    case "final":
      return <FinalCard result={item.result} />;
    case "info":
      return <div className={s.infoMsg}>{item.text}</div>;
    case "error":
      return <div className={s.errorMsg}>{item.text}</div>;
  }
}

export default function AgentPanel() {
  const status = useAgent((st) => st.status);
  const feed = useAgent((st) => st.feed);
  const videoUrl = useAgent((st) => st.videoUrl);
  const uploadAndStart = useAgent((st) => st.uploadAndStart);
  const sendChat = useAgent((st) => st.sendChat);
  const reset = useAgent((st) => st.reset);

  const [input, setInput] = React.useState("");
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const feedRef = React.useRef<HTMLDivElement | null>(null);

  // 새 피드 도착 시 맨 아래로
  React.useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [feed.length, status]);

  const canChat = status === "ready";
  const busy = status === "running" || status === "uploading";

  const submit = () => {
    if (!input.trim() || !canChat) return;
    sendChat(input);
    setInput("");
  };

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) void uploadAndStart(f);
    e.target.value = "";
  };

  return (
    <div className={s.panel}>
      <div className={s.head}>
        <span className={s.statusDot} data-status={status} />
        <span className={s.statusLabel}>
          {status === "no-session" && "영상 업로드로 시작"}
          {status === "uploading" && "업로드 중..."}
          {status === "ready" && "대기 중"}
          {status === "running" && "실행 중..."}
          {status === "awaiting" && "계획 승인 대기"}
          {status === "offline" && "백엔드 오프라인"}
        </span>
        {videoUrl ? (
          <button className={s.resetBtn} onClick={reset} title="세션 초기화">
            새 세션
          </button>
        ) : null}
      </div>

      <div className={s.feed} ref={feedRef}>
        {feed.length === 0 ? (
          <div className={s.empty}>
            <div className={s.emptyTitle}>편집 에이전트</div>
            <div className={s.emptyDesc}>
              영상을 업로드하고 자연어로 편집을 지시하세요. 계획을 확인한 뒤 실행되고,
              결과는 캔버스에서 이어서 다듬을 수 있어요.
            </div>
            <button className={s.uploadBtn} onClick={() => fileRef.current?.click()}>
              영상 업로드
            </button>
            <div className={s.exampleList}>
              {EXAMPLES.map((ex) => (
                <div key={ex} className={s.exampleChip} onClick={() => setInput(ex)}>
                  {ex}
                </div>
              ))}
            </div>
          </div>
        ) : (
          feed.map((item, i) => <FeedRow key={i} item={item} />)
        )}
        {busy && (
          <div className={s.thinking}>
            <span /><span /><span />
          </div>
        )}
      </div>

      <div className={s.composer}>
        {status === "no-session" && feed.length > 0 ? (
          <button className={s.uploadBtn} onClick={() => fileRef.current?.click()}>
            영상 업로드
          </button>
        ) : (
          <>
            <textarea
              className={s.inputBox}
              placeholder={
                canChat ? "편집 지시를 입력하세요..." : "영상 업로드 후 사용할 수 있어요"
              }
              value={input}
              disabled={!canChat}
              rows={2}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <button className={s.sendBtn} onClick={submit} disabled={!canChat || !input.trim()}>
              보내기
            </button>
          </>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="video/*"
        style={{ display: "none" }}
        onChange={onPickFile}
      />
    </div>
  );
}
