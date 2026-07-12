"use client";

// LibraryPanel — specs 파일 브라우저. 폴더별 그룹, shape 배지, 열기(더티 가드).

import { uiConfirm, uiPrompt } from "@/editor/ui/dialogs";
import React from "react";
import { useEditor } from "@/editor/store";
import { newDocGuarded } from "./newDoc";
import { createSpecFile, createSpecFolder, renameSpecPath } from "./saveDoc";
import { showToast } from "./toast";

const EMPTY_SPEC = {
  fps: 24,
  brandDefaults: {
    background: "#0D0B10",
    fontFamily: "General Sans, Inter, Helvetica, Arial, sans-serif",
    colors: ["#7C4DFF", "#FF4D9D", "#4D7DFF"],
  },
  scenes: [{ id: "scene-1", duration: 2.5, elements: [] }],
};

type SpecFile = { path: string; shape: string; hasPresets: boolean };

export default function LibraryPanel() {
  const relPath = useEditor((st) => st.meta.relPath);
  const dirty = useEditor((st) => st.meta.dirty);
  const libraryRefresh = useEditor((st) => st.ui.libraryRefresh);

  const [files, setFiles] = React.useState<SpecFile[]>([]);
  const [folders, setFolders] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  // 인라인 rename (Figma 식 더블클릭) — path 는 파일 rel 경로 또는 폴더명
  const [renaming, setRenaming] = React.useState<{ kind: "file" | "folder"; path: string } | null>(null);
  const [ctxMenu, setCtxMenu] = React.useState<{ x: number; y: number; kind: "file" | "folder"; path: string } | null>(null);

  // rename 실행 + 열린 문서의 relPath 도 따라가게 (autosave 가 새 경로로)
  const doRename = async (kind: "file" | "folder", oldPath: string, newName: string) => {
    setRenaming(null);
    const trimmed = newName.trim().replace(/\/+$/, "");
    if (!trimmed) return;
    let from = oldPath;
    let to: string;
    if (kind === "file") {
      const dir = oldPath.includes("/") ? oldPath.slice(0, oldPath.lastIndexOf("/") + 1) : "";
      const withExt = trimmed.endsWith(".json") ? trimmed : `${trimmed}.json`;
      to = dir + withExt;
    } else {
      to = trimmed;
    }
    if (to === from) return;
    const ok = await renameSpecPath(from, to);
    if (!ok) return;
    const st = useEditor.getState();
    const cur = st.meta.relPath;
    if (cur) {
      if (kind === "file" && cur === from) {
        useEditor.setState((s) => ({ meta: { ...s.meta, relPath: to } }));
      } else if (kind === "folder" && (cur === from || cur.startsWith(from + "/"))) {
        useEditor.setState((s) => ({ meta: { ...s.meta, relPath: to + cur.slice(from.length) } }));
      }
    }
    useEditor.setState((s) => ({ ui: { ...s.ui, libraryRefresh: s.ui.libraryRefresh + 1 } }));
    showToast(`Renamed · ${to}`);
  };

  const load = React.useCallback(() => {
    setLoading(true);
    fetch("/api/specs")
      .then((r) => r.json())
      .then((d) => { setFiles(d.files ?? []); setFolders(d.folders ?? []); })
      .catch(() => { setFiles([]); setFolders([]); })
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    load();
  }, [load, libraryRefresh]);

  const openFile = async (f: SpecFile) => {
    if (f.shape === "invalid") return;
    if (dirty && !(await uiConfirm("Discard unsaved changes?", { message: "Open this file and lose current edits?", danger: true, okLabel: "Discard" }))) return;
    try {
      const res = await fetch(`/api/specs/file?path=${encodeURIComponent(f.path)}`);
      if (!res.ok) {
        showToast("Failed to open file", "error");
        return;
      }
      const json = await res.json();
      useEditor.getState().loadDoc(f.path, json);
    } catch {
      showToast("Failed to open file", "error");
    }
  };

  // 폴더별 그룹 (빈 폴더도 포함 — VSCode 식). top folder 기준.
  const groups = React.useMemo(() => {
    const g: Record<string, SpecFile[]> = {};
    for (const f of files) {
      const top = f.path.includes("/") ? f.path.split("/")[0] : "(root)";
      (g[top] ??= []).push(f);
    }
    // 빈 top-level 폴더도 그룹으로 노출
    for (const d of folders) {
      const top = d.split("/")[0];
      if (!(top in g)) g[top] = [];
    }
    return Object.entries(g).sort((a, b) => a[0].localeCompare(b[0]));
  }, [files, folders]);

  // VSCode 식 새 파일: 경로 지정 -> 디스크 생성 -> 빈 문서로 열기(이미 저장된 파일).
  const createFile = async (folder?: string) => {
    if (dirty && !(await uiConfirm("Discard unsaved changes?", { message: "Create a new file and lose current edits?", danger: true, okLabel: "Discard" }))) return;
    const suggested = folder ? `${folder}/untitled.json` : "drafts/untitled.json";
    const input = await uiPrompt("New file", suggested, { message: "Path relative to specs/" });
    if (!input) return;
    const path = input.endsWith(".json") ? input : `${input}.json`;
    const ok = await createSpecFile(path);
    if (!ok) return; // createSpecFile 이 토스트 처리(409 등)
    useEditor.getState().loadDoc(path, EMPTY_SPEC);
    useEditor.setState((st) => ({ ui: { ...st.ui, libraryRefresh: st.ui.libraryRefresh + 1 } }));
    showToast(`New file · ${path}`);
  };

  // VSCode 식 새 폴더: specs 밑에 mkdir. 빈 폴더도 목록에 뜬다.
  const createFolder = async () => {
    const input = await uiPrompt("New folder", "", { message: "Path relative to specs/", placeholder: "my-project or ads/2026" });
    if (!input) return;
    const ok = await createSpecFolder(input.replace(/\/+$/, ""));
    if (!ok) return;
    useEditor.setState((st) => ({ ui: { ...st.ui, libraryRefresh: st.ui.libraryRefresh + 1 } }));
    showToast(`New folder · ${input}`);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <Header onNew={() => createFile()} onNewFolder={createFolder} onRefresh={load} />
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 0 12px" }}>
        {loading ? (
          <div style={hintStyle}>Loading...</div>
        ) : groups.length === 0 ? (
          <div style={hintStyle}>No spec files</div>
        ) : (
          groups.map(([folder, items]) => (
            <div key={folder} className="lib-group" style={{ marginBottom: 6 }}>
              <div style={{ display: "flex", alignItems: "center", background: folder === "(root)" ? undefined : "rgba(255,255,255,0.028)", borderRadius: 6, margin: "0 6px" }}>
                {renaming?.kind === "folder" && renaming.path === folder ? (
                  <div style={{ ...groupHeaderStyle, flex: 1 }}>
                    <svg width="12" height="12" viewBox="0 0 14 14" style={{ color: "var(--accent-strong, #7C8CF8)", flex: "none", opacity: 0.9 }}>
                      <path d="M1.5 3.5h3.7l1.1 1.3h6.2a0 0 0 010 0V11h-11z" stroke="currentColor" strokeWidth="1.2" fill="rgba(124,140,248,0.16)" strokeLinejoin="round" />
                    </svg>
                    <RenameInput initial={folder} onCommit={(v) => doRename("folder", folder, v)} onCancel={() => setRenaming(null)} />
                  </div>
                ) : (
                <button
                  onClick={() => setCollapsed((c) => ({ ...c, [folder]: !c[folder] }))}
                  onDoubleClick={() => folder !== "(root)" && setRenaming({ kind: "folder", path: folder })}
                  onContextMenu={(e) => {
                    if (folder === "(root)") return;
                    e.preventDefault();
                    setCtxMenu({ x: e.clientX, y: e.clientY, kind: "folder", path: folder });
                  }}
                  style={{ ...groupHeaderStyle, flex: 1 }}
                >
                  <svg width="9" height="9" viewBox="0 0 10 10" style={{ transform: collapsed[folder] ? "rotate(-90deg)" : undefined, color: "var(--text-4)", transition: "transform 120ms", flex: "none" }}>
                    <path d="M3 2.5l3 2.5-3 2.5z" fill="currentColor" transform="rotate(90 5 5)" />
                  </svg>
                  {folder !== "(root)" && (
                    <svg width="12" height="12" viewBox="0 0 14 14" style={{ color: "var(--accent-strong, #7C8CF8)", flex: "none", opacity: 0.9 }}>
                      <path d="M1.5 3.5h3.7l1.1 1.3h6.2a0 0 0 010 0V11h-11z" stroke="currentColor" strokeWidth="1.2" fill="rgba(124,140,248,0.16)" strokeLinejoin="round" />
                    </svg>
                  )}
                  <span style={{ color: folder === "(root)" ? "var(--text-4)" : "var(--text-1, #E8ECF4)", fontWeight: 600 }}>{folder === "(root)" ? "specs" : folder}</span>
                  <span style={{ color: "var(--text-4)", fontWeight: 400 }}>{items.length}</span>
                </button>
                )}
                {folder !== "(root)" && (
                  <button
                    className="lib-group-add icon-btn"
                    style={{ width: 22, height: 22, marginRight: 6 }}
                    title={`New file in ${folder}`}
                    onClick={() => createFile(folder)}
                  >
                    <svg width="12" height="12" viewBox="0 0 14 14"><path d="M7 3v8M3 7h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
                  </button>
                )}
              </div>
              {!collapsed[folder] && items.length === 0 && (
                <div style={{ ...rowStyle, color: "var(--text-4)", fontSize: "var(--fs-10)", cursor: "default" }}>Empty folder — add a file with +</div>
              )}
              {!collapsed[folder] &&
                items.map((f) => {
                  const inFolder = folder !== "(root)";
                  const name = f.path.split("/").pop() ?? f.path;
                  const isCurrent = f.path === relPath;
                  const indent = inFolder ? { marginLeft: 16, width: "calc(100% - 22px)", borderLeft: "1px solid rgba(255,255,255,0.07)", borderRadius: "0 6px 6px 0" } : {};
                  if (renaming?.kind === "file" && renaming.path === f.path) {
                    return (
                      <div key={f.path} style={{ ...rowStyle, ...indent }}>
                        <RenameInput
                          initial={name}
                          selectLen={name.endsWith(".json") ? name.length - 5 : name.length}
                          onCommit={(v) => doRename("file", f.path, v)}
                          onCancel={() => setRenaming(null)}
                        />
                      </div>
                    );
                  }
                  return (
                    <button
                      key={f.path}
                      className="lib-row"
                      onClick={() => openFile(f)}
                      onDoubleClick={() => setRenaming({ kind: "file", path: f.path })}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setCtxMenu({ x: e.clientX, y: e.clientY, kind: "file", path: f.path });
                      }}
                      disabled={f.shape === "invalid"}
                      style={{
                        ...rowStyle,
                        // 폴더 자식: 들여쓰기 + 세로 가이드 라인 (가시성)
                        ...indent,
                        background: isCurrent ? "var(--accent-muted)" : undefined,
                        opacity: f.shape === "invalid" ? 0.4 : 1,
                      }}
                    >
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: isCurrent ? "var(--accent-strong)" : "var(--text-2)" }}>
                        {name}
                      </span>
                      {isCurrent && dirty && <span style={dotStyle} />}
                      {f.hasPresets && <Badge kind="preset" />}
                      {f.shape === "scene" && <Badge kind="scene" />}
                      {f.shape === "invalid" && <Badge kind="invalid" />}
                    </button>
                  );
                })}
            </div>
          ))
        )}
      </div>
      <div style={footerStyle}>
        <span className="keycap">⌘S</span> Save
      </div>
      {/* 우클릭 메뉴 — Rename (더블클릭과 같은 인라인 편집으로 진입) */}
      {ctxMenu && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 400 }}
            onPointerDown={() => setCtxMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }}
          />
          <div style={{ position: "fixed", left: ctxMenu.x, top: ctxMenu.y, zIndex: 401, minWidth: 150, padding: 4, background: "var(--bg-float)", borderRadius: 8, boxShadow: "var(--shadow-float)", border: "1px solid rgba(255,255,255,0.08)", display: "flex", flexDirection: "column" }}>
            <button
              style={menuItemStyle}
              onClick={() => { setRenaming({ kind: ctxMenu.kind, path: ctxMenu.path }); setCtxMenu(null); }}
            >
              Rename
              <span style={{ color: "var(--text-4)", fontSize: 10 }}>double-click</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// 인라인 rename 입력 — Enter/blur 확정, Esc 취소, 이름 부분 자동 선택 (Figma 식)
function RenameInput({ initial, selectLen, onCommit, onCancel }: { initial: string; selectLen?: number; onCommit: (v: string) => void; onCancel: () => void }) {
  const ref = React.useRef<HTMLInputElement>(null);
  const done = React.useRef(false); // Enter 후 blur 이중 커밋 방지
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(0, selectLen ?? initial.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <input
      ref={ref}
      defaultValue={initial}
      spellCheck={false}
      style={{ flex: 1, minWidth: 0, background: "var(--bg-inset)", border: "1px solid var(--accent, #4C8DFF)", borderRadius: 4, padding: "2px 6px", color: "var(--text-1)", fontSize: "var(--fs-12)", outline: "none", fontFamily: "inherit" }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          done.current = true;
          onCommit((e.target as HTMLInputElement).value);
        } else if (e.key === "Escape") {
          done.current = true;
          onCancel();
        }
      }}
      onBlur={(e) => {
        if (!done.current) onCommit(e.target.value);
      }}
    />
  );
}

function Header({ onNew, onNewFolder, onRefresh }: { onNew: () => void; onNewFolder: () => void; onRefresh: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", height: 30, padding: "0 8px 0 14px" }}>
      <span style={{ flex: 1, fontSize: "var(--fs-11)", fontWeight: 550, letterSpacing: "0.03em", color: "var(--text-3)", textTransform: "uppercase" }}>Specs</span>
      <button className="icon-btn" onClick={onNew} title="New file (choose path)">
        <svg width="13" height="13" viewBox="0 0 14 14"><path d="M3 2h5l3 3v7H3z" stroke="currentColor" strokeWidth="1.1" fill="none" strokeLinejoin="round" /><path d="M7 6.5v3M5.5 8h3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" /></svg>
      </button>
      <button className="icon-btn" onClick={onNewFolder} title="New folder">
        <svg width="13" height="13" viewBox="0 0 14 14"><path d="M1.5 3.5h3.5l1 1.2h6.5V11h-11z" stroke="currentColor" strokeWidth="1.1" fill="none" strokeLinejoin="round" /><path d="M7 7v2.4M5.8 8.2h2.4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" /></svg>
      </button>
      <button className="icon-btn" onClick={onRefresh} title="Refresh">
        <svg width="13" height="13" viewBox="0 0 14 14"><path d="M11 4a5 5 0 10.8 4" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" /><path d="M11 1.5V4H8.5" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
    </div>
  );
}

function Badge({ kind }: { kind: "preset" | "scene" | "invalid" }) {
  const map = {
    preset: { label: "preset", bg: "var(--warn-muted)", fg: "var(--warn)", title: "Opens in expanded edit — saving flattens the preset structure" },
    scene: { label: "scene", bg: "rgba(255,255,255,0.06)", fg: "var(--text-4)", title: "Single-scene spec" },
    invalid: { label: "!", bg: "var(--danger-muted)", fg: "var(--danger)", title: "Can't parse" },
  }[kind];
  return (
    <span title={map.title} style={{ flex: "none", fontSize: 9, fontWeight: 600, padding: "1px 5px", borderRadius: 3, background: map.bg, color: map.fg }}>
      {map.label}
    </span>
  );
}

const hintStyle: React.CSSProperties = { padding: "16px 12px", color: "var(--text-4)", fontSize: "var(--fs-12)" };
const menuItemStyle: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, height: 26, padding: "0 10px", borderRadius: 5, color: "var(--text-2)", fontSize: "var(--fs-12)", textAlign: "left" };
const groupHeaderStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, width: "100%", height: 26, padding: "0 12px", fontSize: "var(--fs-11)", fontWeight: 500, color: "var(--text-2)", textAlign: "left" };
const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, width: "calc(100% - 12px)", margin: "0 6px", height: 26, padding: "0 8px 0 20px", fontSize: "var(--fs-12)", textAlign: "left" };
const dotStyle: React.CSSProperties = { width: 6, height: 6, borderRadius: 9999, background: "var(--warn)", flex: "none" };
const footerStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, height: 30, padding: "0 14px 4px", fontSize: "var(--fs-11)", color: "var(--text-4)" };
