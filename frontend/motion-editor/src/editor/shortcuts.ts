"use client";

// shortcuts — 전역 키보드 단축키. 인풋 타이핑/이징 모달 열림 중엔 Esc 외 무시.

import React from "react";
import { useEditor } from "./store";
import { showToast } from "./library/toast";
import { togglePlay, seekTo, getPlayer } from "./playerBridge";
import {
  duplicateElements,
  deleteElements,
  nudgeElements,
  groupElements,
  ungroupElement,
  addTextElement,
  addShapeElement,
  splitElementAtPlayhead,
  trimElementTo,
  copyElements,
  reorderElements,
  splitSceneAt,
  copyElementStyle,
  pasteElementStyle,
} from "./mutations";
import { addElementKeyframeAt, channelsForElement } from "./elementKeyframes";
import { removeAudioClips } from "./audioClips";
import { getElement, isGroup, parsePath } from "./specPath";
import { sceneStarts, frameToScene } from "./timing";
import { FPS } from "@/engine/normalize";
import { saveCurrentDoc } from "./library/saveDoc";

function isTyping(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement &&
    (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
  );
}

export function useEditorShortcuts() {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useEditor.getState();
      const mod = e.metaKey || e.ctrlKey;
      const typing = isTyping(e.target);

      if (e.key === "Escape") {
        if (st.ui.easingEditor) st.setUI({ easingEditor: null });
        else if (st.ui.tool === "frame" || st.ui.tool === "scale") st.setUI({ tool: "select" });
        else st.clearSelection();
        return;
      }
      if (typing || st.ui.easingEditor) return;

      const sel = st.selection;
      const frame = getPlayer()?.getCurrentFrame() ?? 0;

      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
        return;
      }
      if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) st.redo();
        else st.undo();
        return;
      }
      if (mod && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        if (sel.length) duplicateElements(sel);
        return;
      }
      if (mod && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        void saveCurrentDoc();
        return;
      }
      // 선택 클립의 씬-로컬 재생헤드 프레임 (컷 편집용).
      const localFrameOf = (path: string) => {
        if (!st.doc) return 0;
        const si = parsePath(path).sceneIdx;
        const starts = sceneStarts(st.doc, FPS);
        return Math.round(frame - (starts[si] ?? 0));
      };
      // 씬 분할 — ⇧S: 재생헤드가 속한 씬을 그 지점에서 둘로 (요소 split 보다 우선)
      if (!mod && e.shiftKey && (e.key === "S" || e.key === "s")) {
        e.preventDefault();
        if (st.doc) {
          const cur = frameToScene(st.doc, FPS, Math.round(frame));
          splitSceneAt(cur.sceneIdx, cur.localFrame);
        }
        return;
      }
      // 컷 편집 — split(자르기): S 또는 ⌘K. 첫 선택 클립을 재생헤드에서 둘로.
      if ((!mod && (e.key === "s" || e.key === "S")) || (mod && (e.key === "k" || e.key === "K"))) {
        e.preventDefault();
        if (sel.length) splitElementAtPlayhead(sel[0], localFrameOf(sel[0]));
        return;
      }
      if (mod && (e.key === "g" || e.key === "G" || e.code === "KeyG")) {
        e.preventDefault();
        if (e.altKey) {
          // ⌥⌘G — Frame selection (bbox 는 캔버스 오버레이가 계산)
          window.dispatchEvent(new Event("scene24:frame-selection"));
        } else if (e.shiftKey) {
          const first = sel[0];
          if (first && st.doc && isGroup(getElement(st.doc, first))) ungroupElement(first);
        } else if (sel.length >= 2) {
          groupElements(sel);
        }
        return;
      }
      // 복사 (⌘C) — 요소를 내부+시스템 클립보드에. 붙여넣기는 paste 이벤트(usePaste).
      // AE Alt+Shift+P/S/R/T — 선택한 "모든" 요소에 채널 키프레임 동시 추가/arm.
      // (요소마다 스톱워치를 하나씩 켜던 불편 해소 — AE 관례 그대로.
      //  e.code 사용: mac 에서 ⌥ 조합 시 e.key 가 특수문자로 변형됨)
      if (e.altKey && e.shiftKey && !mod && ["KeyP", "KeyS", "KeyR", "KeyT"].includes(e.code) && sel.length > 0 && st.doc) {
        e.preventDefault();
        const chans = e.code === "KeyP" ? (["x", "y"] as const) : e.code === "KeyS" ? (["scale"] as const) : e.code === "KeyR" ? (["rotate"] as const) : (["opacity"] as const);
        const label = e.code === "KeyP" ? "Position" : e.code === "KeyS" ? "Scale" : e.code === "KeyR" ? "Rotation" : "Opacity";
        const cur = frameToScene(st.doc, FPS, Math.round(frame));
        st.beginGesture(); // 여러 요소 x 여러 채널 = undo 1건
        try {
          for (const pth of sel) {
            const el = getElement(st.doc, pth);
            const allowed = channelsForElement(el as never);
            for (const c of chans) {
              if (allowed.includes(c)) addElementKeyframeAt(pth, c, cur.localFrame);
            }
          }
        } finally {
          st.endGesture();
        }
        showToast(`${label} keyframe · ${sel.length} element${sel.length > 1 ? "s" : ""}`);
        return;
      }
      // Figma Copy/Paste properties — ⌥⌘C / ⌥⌘V (mac 은 ⌥c 가 "ç" 로 들어옴)
      if (mod && e.altKey && (e.key === "c" || e.key === "C" || e.key === "ç")) {
        e.preventDefault();
        if (sel[0] && copyElementStyle(sel[0])) showToast("Style copied");
        return;
      }
      if (mod && e.altKey && (e.key === "v" || e.key === "V" || e.key === "√")) {
        e.preventDefault();
        if (pasteElementStyle(sel)) showToast("Style pasted");
        return;
      }
      if (mod && (e.key === "c" || e.key === "C")) {
        if (sel.length) {
          e.preventDefault();
          copyElements(sel);
        }
        return;
      }
      // 정렬: ⌘] 맨 앞 / ⌘[ 맨 뒤, ⌥⌘] 앞으로 / ⌥⌘[ 뒤로 한 단계. 선택 전체 적용.
      // Alt 조합은 e.key 가 변형 문자로 바뀌므로 e.code 병용 (비-US 레이아웃은 e.key 로).
      if (mod && (e.key === "]" || e.code === "BracketRight")) {
        e.preventDefault();
        if (sel.length) reorderElements(sel, e.altKey ? "forward" : "front");
        return;
      }
      if (mod && (e.key === "[" || e.code === "BracketLeft")) {
        e.preventDefault();
        if (sel.length) reorderElements(sel, e.altKey ? "backward" : "back");
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (sel.length) {
          e.preventDefault();
          deleteElements(sel);
          return;
        }
        // 요소 선택이 없고 오디오 클립이 선택돼 있으면 클립 삭제 (다중 포함)
        const audioSel = useEditor.getState().ui.selectedAudio;
        if (audioSel.length) {
          e.preventDefault();
          removeAudioClips(audioSel);
        }
        return;
      }
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        // 선택 없음 → 좌우 방향키 = 프레임 스텝 (shift = 10프레임)
        if (sel.length === 0) {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            const step = (e.shiftKey ? 10 : 1) * (e.key === "ArrowLeft" ? -1 : 1);
            seekTo(frame + step);
          }
          return;
        }
        e.preventDefault();
        const d = e.shiftKey ? 0.02 : 0.005;
        const dx = e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0;
        const dy = e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0;
        nudgeElements(sel, dx, dy);
        return;
      }
      // 컷 편집 — 트림: [ = in-point, ] = out-point 를 재생헤드로.
      if (e.key === "[") {
        e.preventDefault();
        if (sel.length) trimElementTo(sel[0], "start", localFrameOf(sel[0]));
        return;
      }
      if (e.key === "]") {
        e.preventDefault();
        if (sel.length) trimElementTo(sel[0], "end", localFrameOf(sel[0]));
        return;
      }
      // 프레임 스텝: , = -1, . = +1 (shift = ±10). ([ ] 를 트림에 넘겨주고 이리로 이동)
      if (e.key === "," || e.key === "<") {
        e.preventDefault();
        seekTo(frame - (e.shiftKey ? 10 : 1));
        return;
      }
      if (e.key === "." || e.key === ">") {
        e.preventDefault();
        seekTo(frame + (e.shiftKey ? 10 : 1));
        return;
      }
      if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        const p = addTextElement(st.activeScene);
        // 생성 즉시 캔버스 인라인 편집 시작 (Figma 식) — 오버레이가 수신.
        if (p) window.dispatchEvent(new CustomEvent("scene24:edit-text", { detail: { path: p } }));
        return;
      }
      if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        addShapeElement(st.activeScene);
        return;
      }
      if (e.key === "o" || e.key === "O") {
        // Figma O — 타원 (독 도형 메뉴 힌트와 일치)
        e.preventDefault();
        addShapeElement(st.activeScene, "ellipse");
        return;
      }
      if (e.key === "l" || e.key === "L") {
        // Figma L — 선
        e.preventDefault();
        addShapeElement(st.activeScene, "line");
        return;
      }
            if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        const cur = useEditor.getState().ui.tool;
        useEditor.getState().setUI({ tool: cur === "scale" ? "select" : "scale" });
        return;
      }
if (e.key === "v" || e.key === "V") {
        st.setUI({ tool: "select" });
        return;
      }
      if (e.key === "f" || e.key === "F") {
        // Figma F — frame 그리기 툴 (캔버스 드래그로 생성, ESC 로 해제)
        st.setUI({ tool: "frame" });
        return;
      }
      if (e.key === "h" || e.key === "H") {
        st.setUI({ tool: "hand" });
        return;
      }
      if (e.key === "1") st.setUI({ leftTab: "library" });
      if (e.key === "2") st.setUI({ leftTab: "layers" });
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        useEditor.getState().endCoalescing();
      }
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);
}
