"use client";

// saveDoc — 저장 단일 진입점 (TopBar 버튼 + cmd+S 공용).
// 새 문서면 경로를 물어보고, VideoSpec 형태로 PUT 한다.

import React from "react";
import { useEditor } from "@/editor/store";
import { uiPrompt } from "@/editor/ui/dialogs";
import { showToast } from "./toast";

export async function saveCurrentDoc(): Promise<void> {
  const st = useEditor.getState();
  const { doc, meta } = st;
  if (!doc) return;

  let relPath = meta.relPath;
  if (!relPath) {
    const input = await uiPrompt("Save as", "drafts/untitled.json", { message: "Path relative to specs/", placeholder: "drafts/my-ad.json" });
    if (!input) return;
    relPath = input.endsWith(".json") ? input : `${input}.json`;
  }

  try {
    const res = await fetch(`/api/specs/file?path=${encodeURIComponent(relPath)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(doc),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(`Save failed: ${err.error ?? res.status}`, "error");
      return;
    }
    // meta 갱신 + 라이브러리 새로고침
    useEditor.setState({
      meta: { ...st.meta, relPath, dirty: false },
      ui: { ...st.ui, libraryRefresh: st.ui.libraryRefresh + 1 },
    });
    showToast(`Saved · ${relPath}`);
  } catch {
    showToast("Save failed: network error", "error");
  }
}

// 자동 저장 — 프롬프트/성공 토스트 없이 조용히. 이미 파일 경로가 있고(relPath)
// dirty 일 때만 PUT. 저장 위치를 모르는 새 문서(relPath 없음)는 대상 아님
// (첫 저장은 사용자가 Save 로 경로 지정 → 이후부터 자동).
export async function autoSaveDoc(): Promise<void> {
  const st = useEditor.getState();
  const { doc, meta } = st;
  if (!doc || !meta.relPath || !meta.dirty) return;
  const relPath = meta.relPath;
  try {
    const res = await fetch(`/api/specs/file?path=${encodeURIComponent(relPath)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(doc),
    });
    if (!res.ok) return; // 자동 저장 실패는 조용히(수동 Save 가 에러 표시)
    // 저장 사이 또 편집됐으면 dirty 유지 — doc 이 그대로일 때만 clear.
    const cur = useEditor.getState();
    if (cur.doc === doc) {
      useEditor.setState({ meta: { ...cur.meta, relPath, dirty: false } });
    }
  } catch {
    // 네트워크 오류도 조용히 — 다음 편집 때 재시도됨
  }
}

// useAutoSave — doc 이 dirty 로 바뀌면 debounce 후 자동 저장. 드래그처럼 doc 이
// 연속 갱신되면 타이머가 계속 리셋돼 조작이 끝난 뒤에 한 번 저장된다.
export function useAutoSave(delay = 900) {
  const doc = useEditor((s) => s.doc);
  const dirty = useEditor((s) => s.meta.dirty);
  const relPath = useEditor((s) => s.meta.relPath);
  React.useEffect(() => {
    if (!dirty || !relPath || !doc) return;
    const t = setTimeout(() => {
      void autoSaveDoc();
    }, delay);
    return () => clearTimeout(t);
  }, [doc, dirty, relPath, delay]);
}

// 새 폴더 생성 (VSCode 식). specs 루트 밑에 mkdir -p.
export async function createSpecFolder(relPath: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/specs/folder?path=${encodeURIComponent(relPath)}`, {
      method: "POST",
    });
    if (!res.ok) {
      showToast("Failed to create folder", "error");
      return false;
    }
    return true;
  } catch {
    showToast("Failed to create folder", "error");
    return false;
  }
}

// 새 파일 생성 (라이브러리 '새 문서' 후 저장할 때도 이 경로)
export async function createSpecFile(relPath: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/specs/file?path=${encodeURIComponent(relPath)}`, {
      method: "POST",
    });
    if (res.status === 409) {
      showToast("File already exists", "error");
      return false;
    }
    return res.ok;
  } catch {
    return false;
  }
}

/** 파일/폴더 이름 변경 — 성공 여부 반환 (충돌 등은 토스트). */
export async function renameSpecPath(from: string, to: string): Promise<boolean> {
  try {
    const res = await fetch("/api/specs/rename", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from, to }),
    });
    if (res.status === 409) {
      showToast("Name already exists", "error");
      return false;
    }
    if (!res.ok) {
      showToast("Rename failed", "error");
      return false;
    }
    return true;
  } catch {
    showToast("Rename failed", "error");
    return false;
  }
}
