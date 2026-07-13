/**
 * motion-editor 로컬 상태.
 *
 * 원본 영상 · 씬 · 자막은 studio-v2 store 에서 그대로 참조. 여기는 편집 중
 * 선택 / 편집 버퍼 / 저장 여부 같은 에디터 전용 상태만.
 */

import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

export type SelectionKind = "subtitle" | "scene" | null;

export interface EditorSubtitleOverride {
  text?: string;
  fontWeight?: number;
  fontSize?: number;
  color?: string;
  position?: "top" | "middle" | "bottom";
}

export interface EditorState {
  /** 현재 재생 위치 (초) */
  playhead: number;
  /** 재생 중 여부 */
  playing: boolean;
  /** 선택된 항목 종류 */
  selectionKind: SelectionKind;
  /** 선택된 인덱스 (subtitle 이면 transcript index, scene 이면 scenes index) */
  selectionIndex: number | null;

  /** 세그먼트별 편집 오버라이드 (미저장 편집 버퍼) */
  subtitleOverrides: Record<number, EditorSubtitleOverride>;

  /** 저장되지 않은 변경 여부 */
  dirty: boolean;

  // ---- actions ----
  setPlayhead: (t: number) => void;
  setPlaying: (p: boolean) => void;
  select: (kind: SelectionKind, index: number | null) => void;
  updateSubtitle: (index: number, patch: EditorSubtitleOverride) => void;
  clearOverrides: () => void;
  markSaved: () => void;
}

export const useEditorStore = create<EditorState>()(
  immer((set) => ({
    playhead: 0,
    playing: false,
    selectionKind: null,
    selectionIndex: null,
    subtitleOverrides: {},
    dirty: false,

    setPlayhead: (t) =>
      set((s) => {
        s.playhead = t;
      }),

    setPlaying: (p) =>
      set((s) => {
        s.playing = p;
      }),

    select: (kind, index) =>
      set((s) => {
        s.selectionKind = kind;
        s.selectionIndex = index;
      }),

    updateSubtitle: (index, patch) =>
      set((s) => {
        const cur = s.subtitleOverrides[index] ?? {};
        s.subtitleOverrides[index] = { ...cur, ...patch };
        s.dirty = true;
      }),

    clearOverrides: () =>
      set((s) => {
        s.subtitleOverrides = {};
        s.dirty = false;
      }),

    markSaved: () =>
      set((s) => {
        s.dirty = false;
      }),
  }))
);
