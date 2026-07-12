"use client";

// ChatRail — 스튜디오 좌측 채팅. 에이전트 대화의 메인 표면.
// agentStore (업로드/WS/interrupt) 를 그대로 쓰고, 결과 액션만 스튜디오 문법:
// 결과는 상단 버전 필 + 프리뷰로 자동 반영되고, "모션 에디터에서 다듬기"로 심화 편집.

import React from "react";
import {
  useAgent,
  type FeedItem,
  type InterruptPayload,
  type FinalResult,
} from "@/editor/agent/agentStore";
import { saveResultSpec } from "./resultSpec";
import s from "./studio.module.css";

const EXAMPLES = [
  "하이라이트만 골라서 30초 숏츠로 만들어줘",
  "말하는 내용을 자막으로 넣어줘",
  "분위기에 맞는 BGM 깔아줘",
];

function InterruptCard({ item }: { item: Extract<FeedItem, { kind: "interrupt" }> }) {
  const resolveInterrupt = useAgent((st) => st.resolveInterrupt);
  const [feedback, setFeedback] = React.useState("");
  const plan = item.payload?.plan ?? ({} as NonNullable<InterruptPayload["plan"]>);
  const steps = plan.steps ?? [];
  const questions = item.payload?.questions ?? plan.questions ?? [];

  return (
    <div className={s.planCard} data-resolved={item.resolved ?? ""}>
      <div className={s.cardTitle}>편집 계획</div>
      {(plan.target_format || plan.target_duration_sec || plan.target_aspect_ratio) && (
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
              <b>{st.expert ?? st.action ?? "step"}</b>{" "}
              {String(st.description ?? st.action ?? "")}
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
          <button className={s.approveBtn} onClick={() => resolveInterrupt(true)}>
            승인하고 실행
          </button>
          <div className={s.feedbackRow}>
            <input
              className={s.textField}
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
              className={s.ghostBtn}
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

function FinalCard({ result, version }: { result: FinalResult; version: number }) {
  const [opening, setOpening] = React.useState(false);
  const transcript = result.videoContext?.transcript ?? [];

  const refine = async () => {
    setOpening(true);
    const href = await saveResultSpec(result);
    setOpening(false);
    if (href) window.location.href = href;
  };

  return (
    <div className={s.resultCard}>
      <div className={s.cardTitle}>
        편집 완료 <span className={s.versionTag}>v{version}</span>
      </div>
      {result.critic?.message_to_user ? (
        <div className={s.criticNote}>{result.critic.message_to_user}</div>
      ) : null}
      <div className={s.resultMeta}>
        위 프리뷰에 반영됨
        {transcript.length ? ` · 자막 ${transcript.length}개 추출됨` : ""}
      </div>
      <div className={s.cardActions}>
        <button className={s.ghostBtn} onClick={() => void refine()} disabled={opening}>
          {opening ? "여는 중..." : "모션 에디터에서 다듬기"}
        </button>
      </div>
    </div>
  );
}

function FeedRow({ item, versionOf }: { item: FeedItem; versionOf: (r: FinalResult) => number }) {
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
      return <FinalCard result={item.result} version={versionOf(item.result)} />;
    case "info":
      return <div className={s.infoMsg}>{item.text}</div>;
    case "error":
      return <div className={s.errorMsg}>{item.text}</div>;
  }
}

export default function ChatRail() {
  const status = useAgent((st) => st.status);
  const feed = useAgent((st) => st.feed);
  const uploadAndStart = useAgent((st) => st.uploadAndStart);
  const sendChat = useAgent((st) => st.sendChat);
  const reset = useAgent((st) => st.reset);

  const [input, setInput] = React.useState("");
  const [dragOver, setDragOver] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const feedRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [feed.length, status]);

  const canChat = status === "ready";
  const busy = status === "running" || status === "uploading";

  // final 의 버전 번호 계산 (피드 내 등장 순서)
  const versionOf = React.useCallback(
    (r: FinalResult) => {
      let n = 0;
      for (const it of feed) {
        if (it.kind === "final") {
          n += 1;
          if (it.result === r) break;
        }
      }
      return n;
    },
    [feed],
  );

  const submit = () => {
    if (!input.trim() || !canChat) return;
    sendChat(input);
    setInput("");
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f && f.type.startsWith("video/")) void uploadAndStart(f);
  };

  return (
    <div
      className={s.rail}
      data-dragover={dragOver}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className={s.railHead}>
        <span className={s.railTitle}>대화</span>
        {status !== "no-session" && (
          <button className={s.ghostBtnSm} onClick={reset}>
            새 세션
          </button>
        )}
      </div>

      <div className={s.railFeed} ref={feedRef}>
        {feed.length === 0 ? (
          <div className={s.railEmpty}>
            <div className={s.railEmptyTitle}>영상 하나로 시작하세요</div>
            <div className={s.railEmptyDesc}>
              업로드한 영상을 분석하고, 자연어 지시 한 줄로 컷 편집·자막·BGM 까지
              에이전트가 처리합니다. 실행 전 계획을 먼저 보여드려요.
            </div>
            <button className={s.primaryBtn} onClick={() => fileRef.current?.click()}>
              영상 업로드
            </button>
            <div className={s.dropHint}>또는 여기로 드래그</div>
            <div className={s.examples}>
              {EXAMPLES.map((ex) => (
                <button key={ex} className={s.exampleChip} onClick={() => setInput(ex)}>
                  {ex}
                </button>
              ))}
            </div>
          </div>
        ) : (
          feed.map((item, i) => <FeedRow key={i} item={item} versionOf={versionOf} />)
        )}
        {busy && (
          <div className={s.thinking}>
            <span />
            <span />
            <span />
          </div>
        )}
      </div>

      <div className={s.composer}>
        {status === "no-session" && feed.length > 0 ? (
          <button className={s.primaryBtn} onClick={() => fileRef.current?.click()}>
            영상 업로드
          </button>
        ) : (
          <>
            <textarea
              className={s.composerInput}
              placeholder={canChat ? "편집 지시를 입력하세요..." : "영상 업로드 후 사용할 수 있어요"}
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
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void uploadAndStart(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}
