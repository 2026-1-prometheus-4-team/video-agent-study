"use client";

// AIPanel — 좌측 "AI" 탭. 음악(BGM) / 효과음(SFX) / 나레이션(Voice) 생성.
// 채팅형 피드 구조: 요청이 위로 쌓이고 결과가 카드로 붙는다 — 이 레이아웃이
// 곧 AI 채팅(대화로 스펙 편집)이 들어올 자리다. 생성물은 서버(/api/ai/*)가
// 에셋으로 저장하고, 카드의 Add 버튼이 타임라인 오디오 레인에 클립을 얹는다.

import React from "react";
import { useEditor } from "@/editor/store";
import { getPlayer } from "@/editor/playerBridge";
import { totalFrames } from "@/editor/timing";
import { FPS } from "@/engine/normalize";
import { addAudioClipFromUrl } from "@/editor/audioClips";
import { showToast } from "@/editor/library/toast";
import s from "./ai.module.css";

type Mode = "music" | "sfx" | "voice";

type FeedItem =
  | { kind: "prompt"; mode: Mode; text: string }
  | { kind: "result"; mode: Mode; url: string; name: string; bpm?: number; lengthMs?: number }
  | { kind: "error"; text: string };

// 탭을 떠났다 와도 피드가 유지되게 모듈 레벨에 보관 (세션 한정, 파일 저장 X)
let FEED: FeedItem[] = [];
let VOICES: { id: string; name: string; labels: string }[] | null = null;
let LAST_VOICE = "";

const MODE_META: Record<Mode, { label: string; placeholder: string; examples: string[] }> = {
  music: {
    label: "Music",
    placeholder: "Describe the track — mood, genre, instruments...",
    examples: ["Cinematic tech, driving electronic, confident", "Warm minimal piano, soft build", "Punchy hip-hop groove, heavy bass"],
  },
  sfx: {
    label: "SFX",
    placeholder: "Describe the sound — whoosh, click, impact...",
    examples: ["Soft UI whoosh, fast", "Deep cinematic impact hit", "Subtle keyboard click"],
  },
  voice: {
    label: "Voice",
    placeholder: "Narration script to speak...",
    examples: ["Meet Scene24. Cinematic ads, on demand.", "당신의 제품을 시네마틱하게."],
  },
};

function MiniPlayer({ url }: { url: string }) {
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = React.useState(false);
  const [pos, setPos] = React.useState(0); // 0..1
  const [dur, setDur] = React.useState(0);

  React.useEffect(() => {
    const a = new Audio(url);
    audioRef.current = a;
    a.onloadedmetadata = () => setDur(a.duration || 0);
    a.ontimeupdate = () => setPos(a.duration ? a.currentTime / a.duration : 0);
    a.onended = () => setPlaying(false);
    return () => {
      a.pause();
      audioRef.current = null;
    };
  }, [url]);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) a.pause();
    else void a.play();
    setPlaying(!playing);
  };
  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = audioRef.current;
    if (!a || !a.duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    a.currentTime = ((e.clientX - r.left) / r.width) * a.duration;
  };

  return (
    <div className={s.player}>
      <button className={s.playBtn} onClick={toggle} title={playing ? "Pause" : "Play"}>
        {playing ? (
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 1.5h2v7H2zM6 1.5h2v7H6z" fill="currentColor" /></svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2.5 1.5v7L8 5z" fill="currentColor" /></svg>
        )}
      </button>
      <div className={s.progress} onClick={seek}>
        <div className={s.progressFill} style={{ width: `${pos * 100}%` }} />
      </div>
      <span className={`${s.dur} tnum`}>{dur ? `${dur.toFixed(1)}s` : ""}</span>
    </div>
  );
}

function ResultCard({ item }: { item: Extract<FeedItem, { kind: "result" }> }) {
  const playhead = () => Math.round(getPlayer()?.getCurrentFrame() ?? 0);
  const addAtPlayhead = async () => {
    await addAudioClipFromUrl(item.url, item.name, playhead(), { bpm: item.bpm });
    showToast("Added to audio lane");
  };
  const addFull = async () => {
    const doc = useEditor.getState().doc;
    const total = doc ? totalFrames(doc, FPS) : undefined;
    await addAudioClipFromUrl(item.url, item.name, 0, { bpm: item.bpm, duration: total });
    showToast("Added across the video");
  };
  return (
    <div className={s.card}>
      <div className={s.cardHead}>
        <span className={s.badge} data-mode={item.mode}>{MODE_META[item.mode].label}</span>
        <span className={s.cardName} title={item.name}>{item.name}</span>
        {item.bpm ? <span className={s.bpmTag}>{item.bpm} BPM</span> : null}
      </div>
      <MiniPlayer url={item.url} />
      <div className={s.cardActions}>
        <button className={s.actBtn} onClick={() => void addAtPlayhead()}>Add at playhead</button>
        {item.mode === "music" && (
          <button className={s.actBtn} onClick={() => void addFull()}>Fit to video</button>
        )}
      </div>
    </div>
  );
}

export default function AIPanel() {
  const doc = useEditor((st) => st.doc);
  const [mode, setMode] = React.useState<Mode>("music");
  const [prompt, setPrompt] = React.useState("");
  const [feed, setFeed] = React.useState<FeedItem[]>(FEED);
  const [busy, setBusy] = React.useState(false);
  // Music 설정
  const [fitVideo, setFitVideo] = React.useState(true);
  const [lengthSec, setLengthSec] = React.useState(30);
  const [bpm, setBpm] = React.useState(0); // 0 = auto
  // SFX 설정
  const [sfxSec, setSfxSec] = React.useState(0); // 0 = auto
  // Voice 설정
  const [voices, setVoices] = React.useState(VOICES);
  const [voiceId, setVoiceId] = React.useState(LAST_VOICE);
  const feedRef = React.useRef<HTMLDivElement>(null);

  const totalF = doc ? totalFrames(doc, FPS) : 0;

  const push = (item: FeedItem) => {
    FEED = [...FEED, item];
    setFeed(FEED);
    requestAnimationFrame(() => feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" }));
  };

  // Voice 모드 첫 진입 시 보이스 목록 로드
  React.useEffect(() => {
    if (mode !== "voice" || VOICES) return;
    fetch("/api/ai/voices")
      .then((r) => r.json())
      .then((j: { voices?: typeof VOICES; error?: string }) => {
        if (j.voices) {
          VOICES = j.voices;
          setVoices(j.voices);
          if (!LAST_VOICE && j.voices[0]) {
            LAST_VOICE = j.voices[0].id;
            setVoiceId(LAST_VOICE);
          }
        } else if (j.error) push({ kind: "error", text: j.error });
      })
      .catch(() => push({ kind: "error", text: "Failed to load voices" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const generate = async () => {
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy(true);
    setPrompt("");
    push({ kind: "prompt", mode, text });
    try {
      let res: Response;
      if (mode === "music") {
        const lengthMs = fitVideo && totalF > 0 ? Math.round((totalF / FPS) * 1000) : Math.round(lengthSec * 1000);
        res = await fetch("/api/ai/music", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: text, lengthMs, bpm: bpm > 0 ? bpm : undefined }),
        });
      } else if (mode === "sfx") {
        res = await fetch("/api/ai/sfx", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: text, durationSec: sfxSec > 0 ? sfxSec : undefined }),
        });
      } else {
        res = await fetch("/api/ai/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, voiceId }),
        });
      }
      const j = (await res.json()) as { url?: string; name?: string; error?: string };
      if (!res.ok || !j.url) {
        push({ kind: "error", text: j.error ?? `Generation failed (${res.status})` });
      } else {
        push({ kind: "result", mode, url: j.url, name: j.name ?? text.slice(0, 40), bpm: mode === "music" && bpm > 0 ? bpm : undefined });
      }
    } catch (e) {
      push({ kind: "error", text: String((e as Error).message ?? e) });
    } finally {
      setBusy(false);
    }
  };

  const meta = MODE_META[mode];

  return (
    <div className={s.panel}>
      {/* 피드 — 생성 이력이 대화처럼 쌓인다 (AI 채팅이 들어올 자리) */}
      <div className={s.feed} ref={feedRef}>
        {feed.length === 0 && !busy && (
          <div className={s.empty}>
            <div className={s.emptyTitle}>Generate audio</div>
            <div className={s.emptyDesc}>
              Music, sound effects and narration — generated in place and dropped onto the audio lane.
            </div>
            <div className={s.exampleList}>
              {meta.examples.map((ex) => (
                <button key={ex} className={s.exampleChip} onClick={() => setPrompt(ex)}>
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}
        {feed.map((item, i) => {
          if (item.kind === "prompt") {
            return (
              <div key={i} className={s.userMsg}>
                <span className={s.userMode}>{MODE_META[item.mode].label}</span>
                {item.text}
              </div>
            );
          }
          if (item.kind === "error") {
            return (
              <div key={i} className={s.errMsg}>
                {item.text}
              </div>
            );
          }
          return <ResultCard key={i} item={item} />;
        })}
        {busy && (
          <div className={s.pending}>
            <span className={s.spinner} />
            {mode === "music" ? "Composing..." : mode === "sfx" ? "Designing sound..." : "Speaking..."}
          </div>
        )}
      </div>

      {/* 컴포저 — 모드 + 설정 + 프롬프트 */}
      <div className={s.composer}>
        <div className={s.modes} role="tablist">
          {(Object.keys(MODE_META) as Mode[]).map((m) => (
            <button key={m} role="tab" className={s.modeChip} data-active={mode === m} onClick={() => setMode(m)}>
              {MODE_META[m].label}
            </button>
          ))}
        </div>

        {mode === "music" && (
          <div className={s.settings}>
            <button className={s.setChip} data-active={fitVideo} onClick={() => setFitVideo(true)} title="Match the full video length">
              Video · {(totalF / FPS).toFixed(1)}s
            </button>
            <button className={s.setChip} data-active={!fitVideo} onClick={() => setFitVideo(false)}>
              Custom
            </button>
            {!fitVideo && (
              <input
                className={s.setInput}
                type="number"
                min={3}
                max={600}
                value={lengthSec}
                onChange={(e) => setLengthSec(Number(e.target.value))}
              />
            )}
            <span className={s.setLabel}>BPM</span>
            <input
              className={s.setInput}
              type="number"
              min={0}
              max={220}
              value={bpm}
              placeholder="auto"
              onChange={(e) => setBpm(Number(e.target.value))}
              title="0 = auto. Set a BPM to lock the beat grid to the track"
            />
          </div>
        )}
        {mode === "sfx" && (
          <div className={s.settings}>
            <span className={s.setLabel}>Duration</span>
            <input
              className={s.setInput}
              type="number"
              min={0}
              max={30}
              step={0.5}
              value={sfxSec}
              onChange={(e) => setSfxSec(Number(e.target.value))}
              title="0 = auto"
            />
            <span className={s.setLabel}>s (0 = auto)</span>
          </div>
        )}
        {mode === "voice" && (
          <div className={s.settings}>
            <select
              className={s.voiceSelect}
              value={voiceId}
              onChange={(e) => {
                setVoiceId(e.target.value);
                LAST_VOICE = e.target.value;
              }}
            >
              {!voices && <option value="">Loading voices...</option>}
              {voices?.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}{v.labels ? ` — ${v.labels}` : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className={s.inputRow}>
          <textarea
            className={s.promptInput}
            rows={2}
            value={prompt}
            placeholder={meta.placeholder}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void generate();
              }
            }}
          />
          <button className={s.sendBtn} disabled={busy || !prompt.trim()} onClick={() => void generate()} title="Generate (Enter)">
            <svg width="13" height="13" viewBox="0 0 14 14">
              <path d="M7 11.5V3M3.5 6.5L7 3l3.5 3.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
