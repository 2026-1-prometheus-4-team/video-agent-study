"use client";

// useImagePaste — ⌘V 붙여넣기 / 드래그 드롭으로 이미지·영상을 캔버스에 바로 삽입.
// 세 진입점(붙여넣기·드롭·독 버튼) 중 두 개. 전부 insertMediaFromFile 로 모인다.
// 입력창에 타이핑 중이면 붙여넣기는 가로채지 않는다(텍스트 붙여넣기 보존).

import React from "react";
import { insertMediaFromFile } from "./imageInsert";
import { pasteElements, ELEMENT_CLIP_MARKER } from "./mutations";
import { useEditor } from "./store";

function isTyping(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement &&
    (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
  );
}

function isMedia(type: string): boolean {
  return type.startsWith("image/") || type.startsWith("video/");
}

// Finder 등에서 복사한 파일은 type 이 비어 오는 경우가 있어 확장자로도 판별.
const MEDIA_EXT = /\.(png|jpe?g|webp|gif|svg|avif|heic|mp4|webm|mov|m4v|ogg)$/i;
function isMediaFile(f: File): boolean {
  return isMedia(f.type) || MEDIA_EXT.test(f.name || "");
}

export function useImagePaste() {
  React.useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e.target)) return;
      // 1) 요소 붙여넣기 — ⌘C 로 복사된 요소 JSON(마커 확인). 크로스 세션도 동작.
      const text = e.clipboardData?.getData("text/plain");
      if (text && text.includes(ELEMENT_CLIP_MARKER)) {
        try {
          const parsed = JSON.parse(text) as { __marker?: string; elements?: unknown[] };
          if (parsed.__marker === ELEMENT_CLIP_MARKER && Array.isArray(parsed.elements) && parsed.elements.length) {
            e.preventDefault();
            pasteElements(useEditor.getState().activeScene, parsed.elements as never[]);
            return;
          }
        } catch {
          /* 마커 우연 포함 텍스트 — 이미지 경로로 계속 */
        }
      }
      // 2) 이미지/영상 파일 붙여넣기 — items 우선, 비어있으면 files 폴백.
      //    (Finder 파일 복사는 브라우저에 따라 items 대신 files 로만 오거나
      //     type 이 빈 문자열로 온다 → 확장자 판별 포함)
      const items = e.clipboardData?.items;
      if (items) {
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          if (it.kind !== "file") continue;
          const f = it.getAsFile();
          if (f && isMediaFile(f)) {
            e.preventDefault();
            void insertMediaFromFile(f);
            return;
          }
        }
      }
      const files = e.clipboardData?.files;
      if (files && files.length > 0) {
        const media = Array.from(files).filter(isMediaFile);
        if (media.length > 0) {
          e.preventDefault();
          media.forEach((f) => void insertMediaFromFile(f));
        }
      }
    };
    // 파일 드래그가 드롭 가능하도록 dragover 기본동작 취소.
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const media = Array.from(files).filter(isMediaFile);
      if (media.length === 0) return;
      e.preventDefault();
      media.forEach((f) => void insertMediaFromFile(f));
    };
    window.addEventListener("paste", onPaste);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);
}
