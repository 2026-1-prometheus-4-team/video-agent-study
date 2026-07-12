"use client";

// AudioClipInspector — 타임라인 오디오 레인/씬 패널에서 선택한 클립의 상세
// 편집. 시간 단위: Start/Duration/Fade = 컴프 프레임, Trim head = 소스 초.
// BPM 은 음악 클립에만 — 첫 BPM 클립이 타임라인 비트 그리드의 앵커가 된다.

import React from "react";
import { useEditor } from "@/editor/store";
import { Section, Row, NumberInput, TextInput } from "@/editor/controls";
import { getPlayer, usePlayerFrame } from "@/editor/playerBridge";
import {
  docAudioClips,
  updateAudioClip,
  removeAudioClip,
  removeAudioClips,
  duplicateAudioClip,
  splitAudioClipAt,
  replaceAudioClipFile,
} from "@/editor/audioClips";
import { FPS } from "@/engine/normalize";
import { totalFrames } from "@/editor/timing";
import s from "./inspector.module.css";

// 다중 선택 — 목록 + 일괄 삭제 (Backspace 와 동일)
export function AudioMultiInspector({ clipIds }: { clipIds: string[] }) {
  const doc = useEditor((st) => st.doc);
  const clips = docAudioClips(doc).filter((c) => clipIds.includes(c.id ?? ""));
  return (
    <div className={s.body}>
      <div className={s.elHeader}>
        <span className={s.elKind}>Audio</span>
        <span style={{ color: "var(--text-3)", fontSize: 12 }}>{clips.length} clips selected</span>
      </div>
      <Section title="Clips">
        {clips.map((c) => (
          <Row key={c.id} label="" wide>
            <button
              style={{ width: "100%", height: 24, borderRadius: 6, padding: "0 8px", fontSize: 11.5, textAlign: "left", background: "var(--bg-inset)", color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              onClick={() => useEditor.getState().setUI({ selectedAudio: c.id ? [c.id] : [] })}
              title="Click to edit this clip alone"
            >
              {c.name ?? c.src.split("/").pop()}
            </button>
          </Row>
        ))}
      </Section>
      <Section title="Actions">
        <Row label="" wide>
          <button
            style={{ width: "100%", height: 24, borderRadius: 6, background: "var(--bg-inset)", color: "var(--danger, #F87171)", fontSize: 11 }}
            onClick={() => removeAudioClips(clipIds)}
          >
            Delete {clips.length} clips
          </button>
        </Row>
        <div className={s.hint}>Backspace 도 동일하게 선택된 클립 전체를 지운다. shift 클릭으로 선택에서 빼거나 더할 수 있다.</div>
      </Section>
    </div>
  );
}

export function AudioClipInspector({ clipId }: { clipId: string }) {
  const doc = useEditor((st) => st.doc);
  const globalFrame = usePlayerFrame();
  const clip = docAudioClips(doc).find((c) => c.id === clipId);
  if (!doc || !clip) return <div className={s.hint}>Audio clip not found</div>;

  const total = totalFrames(doc, FPS);
  const start = clip.start ?? 0;
  const durF = clip.duration ?? Math.max(1, total - start);
  const maxDur = clip.sourceSec != null ? Math.round((clip.sourceSec - (clip.trimStart ?? 0)) * FPS) : 100000;
  const gf = Math.round(globalFrame);
  const canSplit = gf > start && gf < start + durF;

  const write = (patch: Parameters<typeof updateAudioClip>[1], label: string, live = false) =>
    updateAudioClip(clipId, patch, label, live);

  return (
    <div className={s.body}>
      <div className={s.elHeader}>
        <span className={s.elKind}>Audio clip</span>
        <TextInput
          value={clip.name ?? ""}
          placeholder={clip.src.split("/").pop()}
          onChange={() => {}}
          onCommit={(v) => write({ name: v || undefined }, "Audio name")}
        />
      </div>

      <Section title="Source">
        <Row label="File" wide>
          <button
            style={{ width: "100%", height: 26, borderRadius: 6, background: "var(--bg-inset)", color: "var(--text-2)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: "0 8px", textAlign: "left" }}
            onClick={() => replaceAudioClipFile(clipId)}
            title={`${clip.src} — click to replace`}
          >
            {clip.src.split("/").pop()}
          </button>
        </Row>
        {clip.sourceSec != null && (
          <Row label="Length">
            <span style={{ color: "var(--text-3)", fontSize: 12 }} className="tnum">
              {clip.sourceSec.toFixed(1)}s source
            </span>
          </Row>
        )}
      </Section>

      <Section title="Timing">
        <Row label="Start at">
          <NumberInput value={start} min={0} max={100000} step={1} unit="f" onChange={(v, o) => write({ start: Math.max(0, Math.round(v)) }, "Audio start", o.live)} />
        </Row>
        <Row label="Duration">
          <NumberInput value={durF} min={1} max={maxDur} step={1} unit="f" onChange={(v, o) => write({ duration: Math.max(1, Math.min(maxDur, Math.round(v))) }, "Audio duration", o.live)} />
        </Row>
        <Row label="Trim head">
          <NumberInput value={clip.trimStart ?? 0} min={0} max={clip.sourceSec ?? 600} step={0.1} unit="s" onChange={(v, o) => write({ trimStart: Math.max(0, v) }, "Audio trim", o.live)} />
        </Row>
      </Section>

      <Section title="Mix">
        <Row label="Volume">
          <NumberInput value={clip.volume ?? 1} min={0} max={2} step={0.05} displayScale={100} unit="%" onChange={(v, o) => write({ volume: v }, "Audio volume", o.live)} />
        </Row>
        <Row label="Fade in">
          <NumberInput value={clip.fadeIn ?? 0} min={0} max={durF} step={1} unit="f" onChange={(v, o) => write({ fadeIn: Math.round(v) > 0 ? Math.round(v) : undefined }, "Audio fade in", o.live)} />
        </Row>
        <Row label="Fade out">
          <NumberInput value={clip.fadeOut ?? 0} min={0} max={durF} step={1} unit="f" onChange={(v, o) => write({ fadeOut: Math.round(v) > 0 ? Math.round(v) : undefined }, "Audio fade out", o.live)} />
        </Row>
      </Section>

      <Section title="Beat">
        <Row label="BPM">
          <NumberInput value={clip.bpm ?? 0} min={0} max={220} step={1} onChange={(v, o) => write({ bpm: Math.round(v) > 0 ? Math.round(v) : undefined }, "Audio BPM", o.live)} />
        </Row>
        <div className={s.hint}>
          0 = off. BPM 을 가진 첫 클립(=음악)이 타임라인 비트 그리드의 간격과
          시작점을 정한다 — 씬 컷/시킹이 비트선에 스냅.
        </div>
      </Section>

      <Section title="Actions">
        <Row label="" wide>
          <div style={{ display: "flex", gap: 6, width: "100%" }}>
            <button
              style={{ flex: 1, height: 24, borderRadius: 6, background: "var(--bg-inset)", color: canSplit ? "var(--text-2)" : "var(--text-4)", fontSize: 11 }}
              disabled={!canSplit}
              title={canSplit ? "Split this clip at the playhead" : "Move the playhead inside this clip first"}
              onClick={() => splitAudioClipAt(clipId, Math.round(getPlayer()?.getCurrentFrame() ?? 0))}
            >
              Split at playhead
            </button>
            <button
              style={{ flex: 1, height: 24, borderRadius: 6, background: "var(--bg-inset)", color: "var(--text-2)", fontSize: 11 }}
              onClick={() => duplicateAudioClip(clipId)}
            >
              Duplicate
            </button>
          </div>
        </Row>
        <Row label="" wide>
          <button
            style={{ width: "100%", height: 24, borderRadius: 6, background: "var(--bg-inset)", color: "var(--danger, #F87171)", fontSize: 11 }}
            onClick={() => removeAudioClip(clipId)}
          >
            Delete clip
          </button>
        </Row>
      </Section>
    </div>
  );
}
