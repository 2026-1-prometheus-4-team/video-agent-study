"use client";

// StudioShell — Video Agent Studio 레이아웃.
// 좌: 채팅 레일(에이전트 대화) / 우: 프리뷰 스테이지 + 영상 타임라인.
// 편집 결과 버전(v1, v2, ...)은 상단 필로 전환. 세부 모션 편집은 /motion.

import React from "react";
import { useAgent, AGENT_API, type FinalResult } from "@/editor/agent/agentStore";
import ChatRail from "./ChatRail";
import VideoStage from "./VideoStage";
import VideoTimeline from "./VideoTimeline";
import s from "./studio.module.css";

export type Version = {
  label: string; // "원본" | "v1" | ...
  url: string;   // 절대 URL
  result?: FinalResult;
};

export default function StudioShell() {
  const videoUrl = useAgent((st) => st.videoUrl);
  const feed = useAgent((st) => st.feed);
  const status = useAgent((st) => st.status);
  const sessionId = useAgent((st) => st.sessionId);

  // 버전 목록: 업로드 원본 + final 결과들
  const versions = React.useMemo<Version[]>(() => {
    const list: Version[] = [];
    if (videoUrl) list.push({ label: "원본", url: videoUrl });
    let n = 0;
    for (const item of feed) {
      if (item.kind === "final" && item.result.outputUrl) {
        n += 1;
        const u = item.result.outputUrl;
        list.push({
          label: `v${n}`,
          url: u.startsWith("http") ? u : `${AGENT_API}${u}`,
          result: item.result,
        });
      }
    }
    return list;
  }, [videoUrl, feed]);

  const [selected, setSelected] = React.useState(0);
  // 새 결과가 도착하면 자동으로 최신 버전 선택
  const prevCount = React.useRef(versions.length);
  React.useEffect(() => {
    if (versions.length > prevCount.current) setSelected(versions.length - 1);
    prevCount.current = versions.length;
  }, [versions.length]);

  const current = versions[Math.min(selected, versions.length - 1)] ?? null;

  // 프리뷰 재생 위치 (타임라인 동기화)
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const [time, setTime] = React.useState(0);
  const [duration, setDuration] = React.useState(0);

  const seek = React.useCallback((t: number) => {
    const v = videoRef.current;
    if (v && Number.isFinite(t)) v.currentTime = Math.max(0, Math.min(t, v.duration || t));
  }, []);

  // 표시할 video_context: 최신 final 우선
  const videoContext = React.useMemo(() => {
    for (let i = feed.length - 1; i >= 0; i--) {
      const it = feed[i];
      if (it.kind === "final" && it.result.videoContext) return it.result.videoContext;
    }
    return null;
  }, [feed]);

  return (
    <div className={s.shell}>
      <header className={s.topbar}>
        <span className={s.brand}>VIDEO AGENT</span>
        <div className={s.versions}>
          {versions.map((v, i) => (
            <button
              key={v.label}
              className={s.versionPill}
              data-active={i === selected}
              onClick={() => setSelected(i)}
            >
              {v.label}
            </button>
          ))}
        </div>
        <div className={s.topRight}>
          <span className={s.sessionInfo}>
            <span className={s.statusDot} data-status={status} />
            {sessionId ? `session ${sessionId}` : "세션 없음"}
          </span>
          <a className={s.motionLink} href="/motion">
            모션 에디터
          </a>
        </div>
      </header>

      <div className={s.body}>
        <aside className={s.chatRail}>
          <ChatRail />
        </aside>

        <main className={s.stageCol}>
          <VideoStage
            videoRef={videoRef}
            src={current?.url ?? null}
            label={current?.label ?? null}
            onTime={(t, d) => {
              setTime(t);
              if (d && d !== duration) setDuration(d);
            }}
          />
          <VideoTimeline
            duration={duration}
            time={time}
            videoContext={videoContext}
            onSeek={seek}
          />
        </main>
      </div>
    </div>
  );
}
