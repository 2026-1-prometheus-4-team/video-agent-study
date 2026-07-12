// audioClips.ts — 오디오 레인 편집 뮤테이션 + 파형 피크 캐시.
// 오디오는 문서(전체 영상) 레벨 클립 배열(doc.audio) — 씬 경계와 무관하게
// 음악이 전 씬을 관통하고, 효과음(SFX)을 원하는 프레임에 얹는다.
// 컷 편집의 진실은 세 값: start(컴프 프레임) / duration(프레임) / trimStart(초).

import { useEditor } from "./store";
import { uploadAsset } from "./imageInsert";
import { audioClipList, type AudioClipSpec, type VideoSpec } from "@engine/motion/SceneRenderer";
import { FPS } from "@/engine/normalize";

let clipSeq = 0;

export function docAudioClips(doc: VideoSpec | null): AudioClipSpec[] {
  return doc ? audioClipList(doc.audio) : [];
}

function writeClips(label: string, recipe: (clips: AudioClipSpec[]) => AudioClipSpec[], coalesceKey?: string) {
  useEditor.getState().updateDoc(
    label,
    (draft) => {
      const next = recipe(audioClipList(draft.audio));
      if (next.length === 0) delete (draft as { audio?: unknown }).audio;
      else (draft as { audio: AudioClipSpec[] }).audio = next;
    },
    coalesceKey ? { coalesceKey } : undefined,
  );
}

function newClipId(clips: AudioClipSpec[]): string {
  let id = "";
  do {
    id = `audio-${Date.now().toString(36)}-${++clipSeq}`;
  } while (clips.some((c) => c.id === id));
  return id;
}

/** 소스 길이(초) — 메타데이터만 로드해서 잰다 (파형 디코드보다 훨씬 싸다) */
function probeDuration(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const a = document.createElement("audio");
    a.preload = "metadata";
    a.onloadedmetadata = () => resolve(Number.isFinite(a.duration) ? a.duration : null);
    a.onerror = () => resolve(null);
    a.src = url;
  });
}

/** 파일 피커 → 업로드 → 플레이헤드 프레임에 클립 추가 + 선택.
 *  duration 은 소스 전체 길이(프레임)로 시작 — 이후 트림/컷은 사용자가. */
export function addAudioClipFromFile(atFrame: number) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "audio/mpeg,audio/wav,audio/mp4,audio/aac,audio/ogg";
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    const url = await uploadAsset(f);
    const sec = await probeDuration(url);
    const st = useEditor.getState();
    const clips = docAudioClips(st.doc);
    const id = newClipId(clips);
    const clip: AudioClipSpec = {
      id,
      src: url,
      name: f.name.replace(/\.[a-z0-9]+$/i, ""),
      start: Math.max(0, Math.round(atFrame)),
      ...(sec ? { duration: Math.round(sec * FPS), sourceSec: sec } : {}),
    };
    writeClips("Add audio clip", (cs) => [...cs, clip]);
    st.clearSelection();
    useEditor.getState().setUI({ selectedAudio: [id] });
  };
  input.click();
}

/** 이미 에셋으로 저장된 오디오(URL)를 클립으로 추가 — AI 생성 패널용.
 *  duration 을 주면 그대로(예: 영상 전체 길이), 없으면 소스 길이로. */
export async function addAudioClipFromUrl(
  url: string,
  name: string,
  atFrame: number,
  opts?: { bpm?: number; duration?: number },
): Promise<void> {
  const sec = await probeDuration(url);
  const st = useEditor.getState();
  const clips = docAudioClips(st.doc);
  const id = newClipId(clips);
  const clip: AudioClipSpec = {
    id,
    src: url,
    name,
    start: Math.max(0, Math.round(atFrame)),
    ...(opts?.duration != null
      ? { duration: Math.max(1, Math.round(opts.duration)) }
      : sec
        ? { duration: Math.round(sec * FPS) }
        : {}),
    ...(sec ? { sourceSec: sec } : {}),
    ...(opts?.bpm ? { bpm: Math.round(opts.bpm) } : {}),
  };
  writeClips("Add audio clip", (cs) => [...cs, clip]);
  st.clearSelection();
  useEditor.getState().setUI({ selectedAudio: [id] });
}

/** 클립의 소스 파일 교체 — 타이밍(start/트림)은 유지, 소스 길이 한계만 갱신 */
export function replaceAudioClipFile(id: string) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "audio/mpeg,audio/wav,audio/mp4,audio/aac,audio/ogg";
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    const url = await uploadAsset(f);
    const sec = await probeDuration(url);
    const c = docAudioClips(useEditor.getState().doc).find((cl) => cl.id === id);
    const patch: Partial<AudioClipSpec> = { src: url, name: f.name.replace(/\.[a-z0-9]+$/i, "") };
    if (sec) {
      patch.sourceSec = sec;
      const maxDur = Math.round((sec - (c?.trimStart ?? 0)) * FPS);
      if (c?.duration == null || c.duration > maxDur) patch.duration = Math.max(1, maxDur);
    }
    updateAudioClip(id, patch, "Replace audio file");
  };
  input.click();
}

export function updateAudioClip(id: string, patch: Partial<AudioClipSpec>, label: string, live = false) {
  writeClips(
    label,
    (cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    live ? `audio-clip-${id}-${label}` : undefined,
  );
  if (!live) useEditor.getState().endCoalescing();
}

export function removeAudioClip(id: string) {
  removeAudioClips([id]);
}

/** 복수 클립 동시 이동 — 다중 선택 드래그 (한 updateDoc = 부드러운 라이브) */
export function moveAudioClipsBulk(entries: { id: string; start0: number }[], delta: number, live = false) {
  const map = new Map(entries.map((e) => [e.id, e.start0]));
  writeClips(
    entries.length > 1 ? "Move audio clips" : "Move audio clip",
    (cs) => cs.map((c) => (c.id && map.has(c.id) ? { ...c, start: Math.max(0, Math.round(map.get(c.id)! + delta)) } : c)),
    live ? "audio-move-bulk" : undefined,
  );
  if (!live) useEditor.getState().endCoalescing();
}

/** 복수 클립 삭제 — 다중 선택 Backspace/우클릭 삭제용 (undo 1건) */
export function removeAudioClips(ids: string[]) {
  if (ids.length === 0) return;
  const set = new Set(ids);
  writeClips(ids.length > 1 ? `Remove ${ids.length} audio clips` : "Remove audio clip", (cs) => cs.filter((c) => !set.has(c.id ?? "")));
  const st = useEditor.getState();
  if (st.ui.selectedAudio.some((x) => set.has(x))) {
    st.setUI({ selectedAudio: st.ui.selectedAudio.filter((x) => !set.has(x)) });
  }
}

/** 클립 복제 — 원본 바로 뒤에 이어 붙인다 (SFX 반복 배치 관례) */
export function duplicateAudioClip(id: string) {
  const st = useEditor.getState();
  const clips = docAudioClips(st.doc);
  const src = clips.find((c) => c.id === id);
  if (!src) return;
  const nid = newClipId(clips);
  const dur = src.duration ?? FPS;
  const copy: AudioClipSpec = { ...src, id: nid, start: (src.start ?? 0) + dur };
  writeClips("Duplicate audio clip", (cs) => [...cs, copy]);
  st.setUI({ selectedAudio: [nid] });
}

/** 플레이헤드(전역 프레임)에서 클립을 둘로 자른다 — NLE blade.
 *  왼쪽이 fadeIn/bpm(비트 그리드 앵커 보존), 오른쪽이 fadeOut 을 가져간다. */
export function splitAudioClipAt(id: string, globalFrame: number): boolean {
  const st = useEditor.getState();
  const clips = docAudioClips(st.doc);
  const c = clips.find((cl) => cl.id === id);
  if (!c) return false;
  const start = c.start ?? 0;
  const dur = c.duration ?? Infinity;
  const cut = Math.round(globalFrame) - start; // 클립 로컬 프레임
  if (cut <= 0 || cut >= dur) return false;
  const rightId = newClipId(clips);
  const left: AudioClipSpec = { ...c, duration: cut, fadeOut: undefined };
  const right: AudioClipSpec = {
    ...c,
    id: rightId,
    start: start + cut,
    trimStart: (c.trimStart ?? 0) + cut / FPS,
    ...(c.duration != null ? { duration: c.duration - cut } : {}),
    fadeIn: undefined,
    bpm: undefined,
  };
  writeClips("Split audio clip", (cs) => cs.flatMap((cl) => (cl.id === id ? [left, right] : [cl])));
  st.setUI({ selectedAudio: [rightId] });
  return true;
}

// ---- 파형 피크 캐시 ----
// 클립 바에 파형을 그리기 위해 소스를 한 번 디코드해 초당 PEAKS_PER_SEC 개
// 피크(최대 절대값)로 다운샘플한다. src 별 1회 — 결과는 세션 내 재사용.
const PEAKS_PER_SEC = 40;
type Peaks = { peaks: Float32Array; secPerBucket: number };
const peaksCache = new Map<string, Promise<Peaks | null>>();

export function getAudioPeaks(src: string): Promise<Peaks | null> {
  let p = peaksCache.get(src);
  if (p) return p;
  p = (async () => {
    try {
      const res = await fetch(src);
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const decoded = await ctx.decodeAudioData(buf);
      void ctx.close();
      const ch = decoded.getChannelData(0);
      const nBuckets = Math.max(1, Math.ceil(decoded.duration * PEAKS_PER_SEC));
      const per = Math.max(1, Math.floor(ch.length / nBuckets));
      const peaks = new Float32Array(nBuckets);
      for (let b = 0; b < nBuckets; b++) {
        let max = 0;
        const end = Math.min(ch.length, (b + 1) * per);
        // 버킷 안을 성기게 훑어도 파형 실루엣은 충분 (풀 스캔은 긴 곡에서 느림)
        for (let i = b * per; i < end; i += 8) {
          const v = Math.abs(ch[i]);
          if (v > max) max = v;
        }
        peaks[b] = max;
      }
      return { peaks, secPerBucket: decoded.duration / nBuckets };
    } catch {
      return null;
    }
  })();
  peaksCache.set(src, p);
  return p;
}
