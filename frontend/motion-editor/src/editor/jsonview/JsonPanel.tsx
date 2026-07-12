"use client";

// JsonPanel — 스펙 JSON 소스 뷰 + 양방향 동기화. 편집하면 파싱·정규화해 doc 교체
// (유효할 때만), 캔버스/인스펙터에서 doc 이 바뀌면(포커스 없을 때) 텍스트 갱신.
// LLM 이 뱉을 실제 산출물(JSON)을 직접 보고 손보는 창.
//
// 렌더 구조: 투명 글자 textarea(입력/캐럿) 아래에 하이라이트된 <pre> 를 겹치고
// 스크롤을 동기화한다 — 의존성 없이 VSCode 풍 구문 색을 얻는 관용 패턴.
// 열릴 때/선택이 바뀔 때 현재 선택 요소(없으면 활성 씬)의 코드 위치로 점프.

import React from "react";
import { useEditor } from "@/editor/store";
import { getElement, buildPath, type ElementPath } from "@/editor/specPath";
import s from "./jsonview.module.css";

const LINE_H = 18; // px — textarea/pre 공통 (스크롤 계산에 사용)

// 한 줄 토크나이즈 — key / string / number / keyword / punctuation
const TOKEN_RE = /("(?:[^"\\]|\\.)*")(\s*:)|("(?:[^"\\]|\\.)*")|(-?\d+\.?\d*(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],])/g;

function highlightLine(line: string, key: number): React.ReactNode {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(line))) {
    if (m.index > last) out.push(line.slice(last, m.index));
    if (m[1] != null) {
      out.push(<span key={out.length} className={s.tKey}>{m[1]}</span>, m[2]);
    } else if (m[3] != null) {
      out.push(<span key={out.length} className={s.tStr}>{m[3]}</span>);
    } else if (m[4] != null) {
      out.push(<span key={out.length} className={s.tNum}>{m[4]}</span>);
    } else if (m[5] != null) {
      out.push(<span key={out.length} className={s.tKw}>{m[5]}</span>);
    } else {
      out.push(<span key={out.length} className={s.tPunc}>{m[6]}</span>);
    }
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return (
    <div key={key} className={s.line}>
      {out.length ? out : " "}
    </div>
  );
}

export default function JsonPanel() {
  const doc = useEditor((st) => st.doc);
  const selection = useEditor((st) => st.selection);
  const activeScene = useEditor((st) => st.activeScene);
  const applyJsonEdit = useEditor((st) => st.applyJsonEdit);
  const setUI = useEditor((st) => st.setUI);

  const [text, setText] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [hlLine, setHlLine] = React.useState<number | null>(null);
  const focusedRef = React.useRef(false);
  const taRef = React.useRef<HTMLTextAreaElement>(null);
  const preRef = React.useRef<HTMLPreElement>(null);

  // doc -> 텍스트 (편집 중이 아닐 때만 덮어씀)
  React.useEffect(() => {
    if (focusedRef.current) return;
    setText(doc ? JSON.stringify(doc, null, 2) : "");
    setError(null);
  }, [doc]);

  // 현재 위치로 점프 — 선택 요소의 "id" 라인 (없으면 활성 씬 id). 열릴 때와
  // 선택/씬이 바뀔 때. 편집 중(포커스)에는 방해하지 않는다.
  React.useEffect(() => {
    if (!doc || !text || focusedRef.current) return;
    let needle: string | null = null;
    if (selection.length > 0) {
      const el = getElement(doc, selection[0]) as { id?: string } | null;
      if (el?.id) needle = `"id": ${JSON.stringify(el.id)}`;
    }
    if (!needle) {
      const sceneId = doc.scenes?.[activeScene]?.id;
      if (sceneId) needle = `"id": ${JSON.stringify(sceneId)}`;
    }
    if (!needle) return;
    const idx = text.indexOf(needle);
    if (idx < 0) return;
    const line = text.slice(0, idx).split("\n").length; // 1-based
    setHlLine(line);
    const ta = taRef.current;
    if (ta) {
      const target = Math.max(0, (line - 1) * LINE_H - ta.clientHeight / 3);
      ta.scrollTop = target;
      if (preRef.current) preRef.current.scrollTop = target;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, activeScene, text ? 1 : 0, doc ? 1 : 0]);

  // 텍스트 위치 -> 요소 경로 맵 — JSON.stringify 는 순회 순서를 보존하므로
  // 요소들의 "id" needle 을 순차 검색하면 중복 id 여도 올바르게 매핑된다.
  const idIndex = React.useMemo(() => {
    if (!doc || !text) return [] as { idx: number; path: ElementPath }[];
    const out: { idx: number; path: ElementPath }[] = [];
    let cursor = 0;
    const visit = (els: unknown[] | undefined, sceneIdx: number, indices: number[]) => {
      if (!els) return;
      els.forEach((el, i) => {
        const rec = el as { id?: string; children?: unknown[] };
        const here = [...indices, i];
        if (rec.id) {
          const needle = `"id": ${JSON.stringify(rec.id)}`;
          const idx = text.indexOf(needle, cursor);
          if (idx >= 0) {
            out.push({ idx, path: buildPath(sceneIdx, here) });
            cursor = idx + needle.length;
          }
        }
        visit(rec.children, sceneIdx, here);
      });
    };
    doc.scenes?.forEach((sc, si) => visit(sc.elements as unknown[], si, []));
    return out;
  }, [doc, text]);

  // 코드 클릭/캐럿 이동 -> 해당 요소 선택 (캐럿 위치 이전의 마지막 id 블록)
  const selectAtCaret = () => {
    const ta = taRef.current;
    if (!ta || idIndex.length === 0) return;
    const pos = ta.selectionStart ?? 0;
    let best: { idx: number; path: ElementPath } | null = null;
    for (const entry of idIndex) {
      if (entry.idx <= pos) best = entry;
      else break;
    }
    if (best && useEditor.getState().selection[0] !== best.path) {
      useEditor.getState().select([best.path]);
    }
  };

  const onChange = (v: string) => {
    setText(v);
    // 유효한 JSON 일 때만 적용 (타이핑 중 매 키 파싱 — 스펙이 크지 않아 부담 적음)
    const res = applyJsonEdit(v);
    setError(res.ok ? null : (res.error ?? "invalid"));
  };

  const syncScroll = () => {
    const ta = taRef.current;
    const pre = preRef.current;
    if (ta && pre) {
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
    }
  };

  const copy = () => {
    if (text) void navigator.clipboard?.writeText(text);
  };
  const format = () => {
    try {
      setText(JSON.stringify(JSON.parse(text), null, 2));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const lines = React.useMemo(() => text.split("\n"), [text]);
  const highlighted = React.useMemo(
    () =>
      lines.map((l, i) => (
        <div key={i} className={i + 1 === hlLine ? s.lineHl : undefined}>
          {highlightLine(l, i)}
        </div>
      )),
    [lines, hlLine],
  );

  return (
    <div className={s.panel}>
      <div className={s.header}>
        <span className={s.title}>JSON Source</span>
        <span className={s.meta}>{lines.length} lines</span>
        <div className={s.headerActions}>
          <button className="icon-btn" onClick={format} title="Format">
            <svg width="13" height="13" viewBox="0 0 14 14"><path d="M2.5 4h9M2.5 7h6M2.5 10h9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
          </button>
          <button className="icon-btn" onClick={copy} title="Copy">
            <svg width="13" height="13" viewBox="0 0 14 14"><rect x="4.5" y="4.5" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill="none" /><path d="M9.5 4.5V3a1.5 1.5 0 00-1.5-1.5H3A1.5 1.5 0 001.5 3v5A1.5 1.5 0 003 9.5h1.5" stroke="currentColor" strokeWidth="1.2" fill="none" /></svg>
          </button>
          <button className="icon-btn" onClick={() => setUI({ jsonOpen: false })} title="Close">
            <svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
          </button>
        </div>
      </div>
      <div className={s.editorWrap}>
        {/* 하이라이트 레이어 — textarea 와 같은 메트릭, 스크롤 동기화 */}
        <pre ref={preRef} className={`${s.highlight} mono`} aria-hidden>
          {highlighted}
        </pre>
        <textarea
          ref={taRef}
          className={`${s.editor} mono`}
          value={text}
          spellCheck={false}
          onFocus={() => (focusedRef.current = true)}
          onBlur={() => {
            focusedRef.current = false;
            // blur 시 doc 기준으로 재동기화(정규화된 형태로 정돈)
            if (!error && doc) setText(JSON.stringify(doc, null, 2));
          }}
          onChange={(e) => onChange(e.target.value)}
          onScroll={syncScroll}
          onClick={selectAtCaret}
          onKeyUp={(e) => {
            if (e.key.startsWith("Arrow")) selectAtCaret();
          }}
        />
      </div>
      {error && <div className={s.error}>Parse error: {error}</div>}
      {!error && <div className={s.ok}>Synced · edits apply to the canvas instantly</div>}
    </div>
  );
}
