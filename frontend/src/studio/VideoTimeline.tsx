"use client";

// VideoTimeline — 실제 영상 기준 타임라인 (모션 에디터의 spec 타임라인과 다름).
// 레인 1: 분석 씬 블록 (video_context.scenes) — hover 로 설명
// 레인 2: 자막 세그먼트 (video_context.transcript)
// 클릭 = 시킹, 플레이헤드는 프리뷰와 동기.

import React from "react";
import type { FinalResult } from "@/editor/agent/agentStore";
import s from "./studio.module.css";

type Ctx = NonNullable<FinalResult["videoContext"]>;

// 눈금 간격 후보 (초) — 라벨이 12개를 넘지 않는 가장 촘촘한 단위 선택
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

export default function VideoTimeline({
  duration,
  time,
  videoContext,
  mismatch = false,
  onSeek,
}: {
  duration: number;
  time: number;
  videoContext: Ctx | null;
  /** 선택된 버전 길이와 분석 컨텍스트 길이가 어긋남 (레인은 원본 기준) */
  mismatch?: boolean;
  onSeek: (t: number) => void;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);

  const total = duration || videoContext?.duration || 0;
  const scenes = videoContext?.scenes ?? [];
  const transcript = videoContext?.transcript ?? [];

  const toPct = (t: number) => (total ? Math.min(100, Math.max(0, (t / total) * 100)) : 0);

  const clickSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!total || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    onSeek(((e.clientX - r.left) / r.width) * total);
  };

  // 눈금: 라벨 12개 이하가 되는 가장 촘촘한 단위 (긴 영상 라벨 폭발 방지)
  const tick = TICK_STEPS.find((step) => total / step <= 12) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const ticks: number[] = [];
  for (let t = 0; t <= total; t += tick) ticks.push(t);

  return (
    <div className={s.timeline}>
      <div className={s.timelineHead}>
        <span>타임라인</span>
        {!videoContext && (
          <span className={s.timelineHint}>
            첫 편집 지시를 내리면 장면 분석 결과가 여기 표시됩니다
          </span>
        )}
        {mismatch && (
          <span className={s.timelineHint}>장면·자막 레인은 원본 기준입니다</span>
        )}
      </div>

      <div className={s.timelineBody} ref={ref} onClick={clickSeek}>
        {/* 눈금 */}
        <div className={s.ruler}>
          {ticks.map((t) => (
            <span key={t} className={`${s.tick} tnum`} style={{ left: `${toPct(t)}%` }}>
              {t}s
            </span>
          ))}
        </div>

        {/* 씬 레인 */}
        <div className={s.lane}>
          <span className={s.laneLabel}>장면</span>
          <div className={s.laneTrack}>
            {scenes.map((sc, i) => (
              <div
                key={i}
                className={s.sceneBlock}
                data-odd={i % 2 === 1}
                style={{ left: `${toPct(sc.start)}%`, width: `${toPct(sc.end) - toPct(sc.start)}%` }}
                title={`${sc.start.toFixed(1)}s - ${sc.end.toFixed(1)}s\n${sc.description}`}
              >
                <span className={s.sceneText}>{sc.description}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 자막 레인 */}
        <div className={s.lane}>
          <span className={s.laneLabel}>자막</span>
          <div className={s.laneTrack}>
            {transcript.map((tr, i) => (
              <div
                key={i}
                className={s.subBlock}
                style={{ left: `${toPct(tr.start)}%`, width: `${toPct(tr.end) - toPct(tr.start)}%` }}
                title={`${tr.start.toFixed(1)}s - ${tr.end.toFixed(1)}s\n${tr.text}`}
              >
                <span className={s.sceneText}>{tr.text}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 플레이헤드 */}
        {total > 0 && <div className={s.playhead} style={{ left: `${toPct(time)}%` }} />}
      </div>
    </div>
  );
}
