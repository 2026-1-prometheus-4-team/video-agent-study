"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  Film,
  Type as TypeIcon,
  ZoomIn,
  ZoomOut,
  Maximize2,
} from "lucide-react";
import { useAgentStore } from "./state";
import { formatSeconds } from "@/lib/format";
import styles from "./timeline.module.css";

/* 레인 높이 차등 — 비디오가 가장 두껍다. 세 줄이 같은 높이면 목록처럼 보이고
   어느 것이 주 트랙인지 안 읽힌다. */
const LANE_H = { video: 64, audio: 58, subtitle: 54 } as const;

/* 편집기 타임코드 표기 HH:MM:SS:FF. 초 단위만 보여주면 프레임 단위로
   맞추는 작업에서 쓸모가 없다. fps 를 모를 때는 30 으로 가정한다. */
const TIMECODE_FPS = 30;
function timecode(sec: number): string {
  const total = Math.max(0, sec);
  const f = Math.floor((total % 1) * TIMECODE_FPS);
  const s = Math.floor(total) % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(s)}:${p(f)}`;
}
const TRACK_ROW_HEIGHT = LANE_H.video;

export function Timeline() {
  const videoContext = useAgentStore((s) => s.videoContext);
  const lastFinal = useAgentStore((s) => s.lastFinal);
  const playhead = useAgentStore((s) => s.playhead);
  const setPlayhead = useAgentStore((s) => s.setPlayhead);
  const zoom = useAgentStore((s) => s.timelineZoom);
  const setZoom = useAgentStore((s) => s.setTimelineZoom);
  const selected = useAgentStore((s) => s.selected);
  const selectSegment = useAgentStore((s) => s.selectSegment);

  // 재생 소스 (Stage 와 동일): "final" 편집본 · "source" 원본.
  // 그에 따라 씬/자막 소스 결정 + duration 결정 + 범위 밖 세그먼트 필터.
  const stageViewMode = useAgentStore((s) => s.stageViewMode);
  const stageVideoDuration = useAgentStore((s) => s.stageVideoDuration);
  const showingFinal = stageViewMode === "final" && !!lastFinal;

  const rawScenes = showingFinal
    ? (lastFinal?.scenes ?? [])
    : (videoContext?.scenes ?? []);
  const rawTranscript = showingFinal
    ? (lastFinal?.transcript ?? [])
    : (videoContext?.transcript ?? []);

  // duration 우선 순위:
  // 1) stageVideoDuration — 실제 <video> metadata 에서 읽은 mp4 길이 (진실)
  // 2) lastFinal.duration / videoContext.duration — 그래프 state (편집본이 짧아
  //    졌는데 재분석 안 됐으면 원본 길이가 남아있음 → 부정확)
  // 3) 씬/자막 마지막 end 로 추정
  const authoritative = stageVideoDuration;
  const explicit = showingFinal
    ? (lastFinal?.duration ?? 0)
    : (videoContext?.duration ?? 0);
  const inferred = Math.max(
    0,
    ...rawScenes.map((s) => s.end),
    ...rawTranscript.map((t) => t.end)
  );
  const duration =
    authoritative > 0
      ? authoritative
      : explicit > 0
        ? explicit
        : inferred;

  // 편집본을 보고 있는데 씬/자막 데이터가 원본 걸 그대로 들고 있으면 (max end
  // 가 편집본 duration 을 크게 초과) 사실상 재분석 안 된 상태.
  // 이 경우 씬/자막 track 을 비워서 사용자에게 명확히 알리고 label 로 hint.
  const stalenessThreshold = duration * 1.1 + 0.5; // 10% + 0.5s 여유
  const scenesLookStale =
    showingFinal &&
    duration > 0 &&
    rawScenes.length > 0 &&
    Math.max(...rawScenes.map((s) => s.end)) > stalenessThreshold;
  const transcriptLooksStale =
    showingFinal &&
    duration > 0 &&
    rawTranscript.length > 0 &&
    Math.max(...rawTranscript.map((t) => t.end)) > stalenessThreshold;

  // 실제 렌더용 배열: stale 이면 비움. 아니면 duration 안 세그만 필터.
  const scenes = scenesLookStale
    ? []
    : duration > 0
      ? rawScenes.filter((s) => s.start < duration).map((s) => ({
          ...s,
          end: Math.min(s.end, duration),
        }))
      : rawScenes;
  const transcript = transcriptLooksStale
    ? []
    : duration > 0
      ? rawTranscript.filter((t) => t.start < duration).map((t) => ({
          ...t,
          end: Math.min(t.end, duration),
        }))
      : rawTranscript;

  const finalNotReanalyzed =
    showingFinal && (scenesLookStale || transcriptLooksStale);

  // 오디오 스트림 정보를 따로 받지 않으므로, 재생 중인 소스가 있으면 오디오도
  // 있다고 본다. 파형이나 볼륨 같은 없는 데이터를 그려내지는 않는다.
  const hasAudio = duration > 0;

  // ───────── scrubber (playhead 드래그 seek) ─────────
  const scrubRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [hovering, setHovering] = useState<{
    x: number;
    time: number;
  } | null>(null);

  const timeFromClientX = useCallback(
    (clientX: number): number => {
      const track = scrubRef.current;
      if (!track || duration <= 0) return 0;
      const rect = track.getBoundingClientRect();
      const pct = Math.max(0, Math.min((clientX - rect.left) / rect.width, 1));
      return pct * duration;
    },
    [duration]
  );

  const onScrubStart = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = scrubRef.current;
    if (!el || duration <= 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    setPlayhead(timeFromClientX(e.clientX));
    const move = (ev: PointerEvent) => setPlayhead(timeFromClientX(ev.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onScrubHover = (e: React.PointerEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    const rect = scrubRef.current?.getBoundingClientRect();
    if (!rect) return;
    setHovering({ x: e.clientX - rect.left, time: timeFromClientX(e.clientX) });
  };

  // ───────── ruler ticks ─────────
  const rulerTicks = useMemo(() => {
    if (duration <= 0) return [];
    const targetCount = Math.max(6, Math.floor(6 * zoom));
    const stepBase = duration / targetCount;
    const mag = Math.pow(10, Math.floor(Math.log10(stepBase)));
    const norm = stepBase / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const arr: number[] = [];
    for (let t = 0; t <= duration + 0.001; t += step) arr.push(t);
    return arr;
  }, [duration, zoom]);

  // ───────── 세그먼트 클릭 ─────────
  const onScenePick = (i: number) => {
    const sc = scenes[i];
    if (!sc) return;
    selectSegment("scene", i);
    setPlayhead(sc.start);
  };
  const onSubPick = (i: number) => {
    const sg = transcript[i];
    if (!sg) return;
    selectSegment("subtitle", i);
    setPlayhead(sg.start);
  };

  // ───────── 현재 활성 자막 (playhead 안에 있는 것) ─────────
  const activeSubIdx = useMemo(() => {
    for (let i = 0; i < transcript.length; i++) {
      if (playhead >= transcript[i].start && playhead <= transcript[i].end)
        return i;
    }
    return -1;
  }, [transcript, playhead]);

  // ───────── 키보드 단축 (←→ 프레임 nudge · 1s 뛰기 · Home/End) ─────────
  useEffect(() => {
    if (duration <= 0) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && ["INPUT", "TEXTAREA"].includes(t.tagName)) return;
      if (e.code === "ArrowLeft") {
        e.preventDefault();
        setPlayhead(Math.max(0, playhead - (e.shiftKey ? 5 : 1)));
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        setPlayhead(Math.min(duration, playhead + (e.shiftKey ? 5 : 1)));
      } else if (e.code === "Home") {
        e.preventDefault();
        setPlayhead(0);
      } else if (e.code === "End") {
        e.preventDefault();
        setPlayhead(duration);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [duration, playhead, setPlayhead]);

  // ───────── 세로 스크롤 시 시간축이 아니라 zoom 조절 (Cmd/Ctrl) ─────────
  const onWheel = (e: React.WheelEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setZoom(zoom * dir);
  };

  // 현재 활성 세그먼트 세부.
  const activeScene = useMemo(() => {
    for (let i = 0; i < scenes.length; i++) {
      if (playhead >= scenes[i].start && playhead <= scenes[i].end)
        return { seg: scenes[i], i };
    }
    return null;
  }, [scenes, playhead]);
  const activeSub =
    activeSubIdx >= 0
      ? { seg: transcript[activeSubIdx], i: activeSubIdx }
      : null;

  const playPct = duration ? (playhead / duration) * 100 : 0;

  const contentWidth = `${100 * zoom}%`;
  const canZoom = duration > 0;

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        <div className={styles.headerLabel}>타임라인</div>
        {duration > 0 ? (
          <div className={styles.headerMeta}>
            <span
              className={styles.sourceBadge}
              data-final={showingFinal || undefined}
              title={
                showingFinal
                  ? "편집본 재생 중 — 씬/자막이 원본 기준일 수 있음"
                  : "원본 재생 중"
              }
            >
              {showingFinal ? "편집본" : "원본"}
            </span>
            <span className={styles.nowCode}>{formatSeconds(playhead)}</span>
            <span className={styles.headerMetaSuffix}>/</span>
            <span className={styles.tabular}>{formatSeconds(duration)}</span>
            <span className={styles.headerSep} />
            <span>{scenes.length} 씬</span>
            <span className={styles.headerSep} />
            <span>{transcript.length} 자막</span>
            {finalNotReanalyzed && (
              <span
                className={styles.reanalyzeHint}
                title="편집본이 원본 씬/자막 데이터를 그대로 보고 있어. 편집 후 재분석 요청 필요."
              >
                재분석 필요
              </span>
            )}
            <div className={styles.zoomTools}>
              <button
                type="button"
                className={styles.zoomBtn}
                onClick={() => setZoom(zoom / 1.5)}
                disabled={!canZoom || zoom <= 1}
                title="줌 아웃 (⌘-)"
              >
                <ZoomOut size={11} strokeWidth={2.2} />
              </button>
              <span className={styles.zoomLevel}>
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                className={styles.zoomBtn}
                onClick={() => setZoom(zoom * 1.5)}
                disabled={!canZoom || zoom >= 8}
                title="줌 인 (⌘+)"
              >
                <ZoomIn size={11} strokeWidth={2.2} />
              </button>
              <button
                type="button"
                className={styles.zoomBtn}
                onClick={() => setZoom(1)}
                disabled={!canZoom}
                title="맞춤 (⌘0)"
              >
                <Maximize2 size={11} strokeWidth={2.2} />
              </button>
            </div>
          </div>
        ) : (
          <div className={styles.headerHint}>
            편집 지시를 내리면 여기에 씬 · 자막이 표시돼
          </div>
        )}
      </div>

      <div
        ref={scrollRef}
        className={styles.scrollArea}
        onWheel={onWheel}
      >
        <div className={styles.content} style={{ width: contentWidth }}>
          <div className={styles.labelCol}>
            <div className={styles.labelRuler} />
            <div className={styles.labelRail}>

            {/* 레인 구분은 색 하나에 기대지 않는다 — 높이 · 아이콘 · 라벨 · 개수가
                같이 말한다. 색만으로 나누면 흑백으로 보거나 색각이 다르면 무너진다. */}
            <div
              className={styles.labelRow}
              style={{ height: LANE_H.video }}
              title={`비디오 · ${scenes.length}개`}
            >
              <Film size={15} strokeWidth={2} />
            </div>

            <div
              className={styles.labelRow}
              style={{ height: LANE_H.audio }}
              title="오디오"
            >
              <AudioLines size={15} strokeWidth={2} />
            </div>

            <div
              className={styles.labelRow}
              style={{ height: LANE_H.subtitle }}
              title={`자막 · ${transcript.length}개`}
            >
              <TypeIcon size={15} strokeWidth={2} />
            </div>
            </div>
          </div>

          <div className={styles.tracksCol}>
            {/* Ruler + scrubber (clickable / draggable) */}
            <div
              ref={scrubRef}
              className={styles.ruler}
              onPointerDown={onScrubStart}
              onPointerMove={onScrubHover}
              onPointerLeave={() => setHovering(null)}
            >
              <span className={styles.nowBadge}>{timecode(playhead)}</span>
              {rulerTicks.map((t) => (
                <div
                  key={t}
                  className={styles.rulerTick}
                  style={{
                    left: `${duration ? (t / duration) * 100 : 0}%`,
                  }}
                >
                  <span className={styles.rulerLabel}>{timecode(t)}</span>
                </div>
              ))}
              {hovering && (
                <div
                  className={styles.hoverGuide}
                  style={{ left: hovering.x }}
                >
                  <div className={styles.hoverTip}>
                    {formatSeconds(hovering.time)}
                  </div>
                </div>
              )}
              <div
                className={styles.playhead}
                style={{ left: `${playPct}%` }}
              >
                <div className={styles.playheadCap} />
                <div className={styles.playheadLine} />
              </div>
            </div>

            {/* 비디오 레인 */}
            <div
              className={styles.trackRow}
              data-lane="video"
              style={{ height: LANE_H.video }}
            >
              {duration <= 0 || scenes.length === 0 ? null : (
                scenes.map((sc, i) => {
                  const left = (sc.start / duration) * 100;
                  const width = Math.max(
                    0.6,
                    ((sc.end - sc.start) / duration) * 100 - 0.4
                  );
                  const isSel =
                    selected?.kind === "scene" && selected.index === i;
                  const isActive =
                    activeScene && activeScene.i === i && !isSel;
                  return (
                    <motion.button
                      key={i}
                      type="button"
                      className={styles.sceneBlock}
                      data-selected={isSel || undefined}
                      data-active={isActive || undefined}
                      style={{ left: `${left}%`, width: `${width}%` }}
                      onClick={() => onScenePick(i)}
                      initial={{ opacity: 0, y: 3 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.24, delay: 0.02 * i }}
                      title={
                        sc.description
                          ? `씬 ${i + 1} · ${sc.description}`
                          : `씬 ${i + 1}`
                      }
                    >
                      <span className={styles.clipGrip} aria-hidden>
                        &laquo;
                      </span>
                      <Film size={11} strokeWidth={2.4} className={styles.clipIcon} />
                      <span className={styles.sceneIdx}>{i + 1}</span>
                      {sc.description && (
                        <span className={styles.sceneDesc}>
                          {sc.description}
                        </span>
                      )}
                      <span className={styles.clipGrip} aria-hidden>
                        &raquo;
                      </span>
                    </motion.button>
                  );
                })
              )}
            </div>

            {/* 오디오 레인 — 편집본에 실제 오디오가 있으면 한 덩어리로 표시한다.
                파형은 아직 없다. 없는 데이터를 그럴듯하게 그리지 않는다. */}
            <div
              className={styles.trackRow}
              data-lane="audio"
              style={{ height: LANE_H.audio }}
            >
              {duration <= 0 || !hasAudio ? null : (
                <div
                  className={styles.audioBlock}
                  style={{ left: 0, width: "100%" }}
                  title="편집본 오디오"
                >
                  <span className={styles.clipGrip} aria-hidden>
                    &laquo;
                  </span>
                  <AudioLines size={11} strokeWidth={2.4} className={styles.clipIcon} />
                  <span className={styles.audioLabel}>오디오</span>
                </div>
              )}
            </div>

            {/* 자막 레인 */}
            <div
              className={styles.trackRow}
              data-lane="subtitle"
              style={{ height: LANE_H.subtitle }}
            >
              {duration <= 0 || transcript.length === 0 ? null : (
                transcript.map((sg, i) => {
                  const left = (sg.start / duration) * 100;
                  const width = Math.max(
                    0.4,
                    ((sg.end - sg.start) / duration) * 100 - 0.3
                  );
                  const isSel =
                    selected?.kind === "subtitle" && selected.index === i;
                  const isActive =
                    activeSubIdx === i && !isSel;
                  return (
                    <motion.button
                      key={i}
                      type="button"
                      className={styles.subBlock}
                      data-selected={isSel || undefined}
                      data-active={isActive || undefined}
                      style={{ left: `${left}%`, width: `${width}%` }}
                      onClick={() => onSubPick(i)}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.2, delay: 0.012 * i }}
                      title={sg.text}
                    >
                      <span className={styles.subText}>{sg.text}</span>
                    </motion.button>
                  );
                })
              )}
            </div>

            {/* Playhead line spanning tracks */}
            {duration > 0 && (
              <div
                className={styles.tracksPlayhead}
                style={{ left: `${playPct}%` }}
              />
            )}
          </div>
        </div>
      </div>

      {/* 하단 인스펙터 — 선택 or 활성 세그먼트 상세 */}
      <AnimatePresence mode="wait">
        {(activeSub || activeScene || selected) && (
          <motion.div
            key={
              selected
                ? `sel-${selected.kind}-${selected.index}`
                : activeSub
                  ? `sub-${activeSub.i}`
                  : `sc-${activeScene?.i ?? "x"}`
            }
            className={styles.inspector}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.16 }}
          >
            <InspectorContent
              scenes={scenes}
              transcript={transcript}
              selected={selected}
              activeSub={activeSub}
              activeScene={activeScene}
              onClear={() => selectSegment(null)}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function InspectorContent({
  scenes,
  transcript,
  selected,
  activeSub,
  activeScene,
  onClear,
}: {
  scenes: { start: number; end: number; description?: string }[];
  transcript: { start: number; end: number; text: string }[];
  selected: { kind: "scene" | "subtitle"; index: number } | null;
  activeSub: {
    seg: { start: number; end: number; text: string };
    i: number;
  } | null;
  activeScene: {
    seg: { start: number; end: number; description?: string };
    i: number;
  } | null;
  onClear: () => void;
}) {
  // 선택 우선. 없으면 현재 재생 위치의 자막 > 씬.
  if (selected) {
    if (selected.kind === "subtitle") {
      const sg = transcript[selected.index];
      if (!sg) return null;
      return (
        <SubInspector
          seg={sg}
          idx={selected.index}
          selectedBadge
          onClear={onClear}
        />
      );
    }
    const sc = scenes[selected.index];
    if (!sc) return null;
    return (
      <SceneInspector
        seg={sc}
        idx={selected.index}
        selectedBadge
        onClear={onClear}
      />
    );
  }
  if (activeSub) {
    return <SubInspector seg={activeSub.seg} idx={activeSub.i} />;
  }
  if (activeScene) {
    return (
      <SceneInspector seg={activeScene.seg} idx={activeScene.i} />
    );
  }
  return null;
}

function SubInspector({
  seg,
  idx,
  selectedBadge,
  onClear,
}: {
  seg: { start: number; end: number; text: string };
  idx: number;
  selectedBadge?: boolean;
  onClear?: () => void;
}) {
  return (
    <div className={styles.inspectorBody}>
      <div className={styles.inspectorRow}>
        <div className={styles.inspectorTag} data-kind="subtitle">
          <TypeIcon size={10} strokeWidth={2.4} />
          <span>자막</span>
          <span className={styles.inspectorIdx}>#{idx + 1}</span>
        </div>
        {selectedBadge && (
          <button
            type="button"
            className={styles.inspectorClear}
            onClick={onClear}
          >
            선택 해제
          </button>
        )}
      </div>
      <div className={styles.inspectorText}>{seg.text}</div>
      <div className={styles.inspectorMeta}>
        <span className={styles.tabular}>{formatSeconds(seg.start)}</span>
        <span className={styles.inspectorSep}>→</span>
        <span className={styles.tabular}>{formatSeconds(seg.end)}</span>
        <span className={styles.inspectorSep}>·</span>
        <span>{(seg.end - seg.start).toFixed(2)}s</span>
      </div>
    </div>
  );
}

function SceneInspector({
  seg,
  idx,
  selectedBadge,
  onClear,
}: {
  seg: { start: number; end: number; description?: string };
  idx: number;
  selectedBadge?: boolean;
  onClear?: () => void;
}) {
  return (
    <div className={styles.inspectorBody}>
      <div className={styles.inspectorRow}>
        <div className={styles.inspectorTag} data-kind="scene">
          <Film size={10} strokeWidth={2.4} />
          <span>씬</span>
          <span className={styles.inspectorIdx}>#{idx + 1}</span>
        </div>
        {selectedBadge && (
          <button
            type="button"
            className={styles.inspectorClear}
            onClick={onClear}
          >
            선택 해제
          </button>
        )}
      </div>
      {seg.description ? (
        <div className={styles.inspectorText}>{seg.description}</div>
      ) : (
        <div className={styles.inspectorTextMuted}>설명 없음</div>
      )}
      <div className={styles.inspectorMeta}>
        <span className={styles.tabular}>{formatSeconds(seg.start)}</span>
        <span className={styles.inspectorSep}>→</span>
        <span className={styles.tabular}>{formatSeconds(seg.end)}</span>
        <span className={styles.inspectorSep}>·</span>
        <span>{(seg.end - seg.start).toFixed(2)}s</span>
      </div>
    </div>
  );
}
