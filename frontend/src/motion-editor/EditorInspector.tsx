"use client";

import { motion } from "motion/react";
import { useAgentStore } from "@/studio-v2/state";
import { FONT_OPTIONS } from "@/studio-v2/subtitle/subtitleApi";
import { useEditorStore } from "./editorState";
import styles from "./editor-inspector.module.css";

const POSITIONS = [
  { key: "top", label: "위" },
  { key: "middle", label: "중앙" },
  { key: "bottom", label: "아래" },
] as const;

const FONT_WEIGHTS = [400, 500, 600, 700];
const COLORS = ["#ffffff", "#FFE600", "#7C8DF1", "#F07278", "#3ECF8E"];

export function EditorInspector() {
  const videoContext = useAgentStore((s) => s.videoContext);
  const lastFinal = useAgentStore((s) => s.lastFinal);
  const selectionKind = useEditorStore((s) => s.selectionKind);
  const selectionIndex = useEditorStore((s) => s.selectionIndex);
  const overrides = useEditorStore((s) => s.subtitleOverrides);
  const updateSubtitle = useEditorStore((s) => s.updateSubtitle);

  const transcript = lastFinal?.transcript ?? videoContext?.transcript ?? [];
  const isSubtitle = selectionKind === "subtitle" && selectionIndex !== null;
  const seg = isSubtitle ? transcript[selectionIndex!] : undefined;
  const override = isSubtitle ? overrides[selectionIndex!] : undefined;

  if (!isSubtitle || !seg) {
    return (
      <div className={styles.wrap}>
        <div className={styles.header}>인스펙터</div>
        <div className={styles.empty}>
          왼쪽에서 자막 세그먼트를 선택해봐.
        </div>
      </div>
    );
  }

  // 값의 출처는 세 겹이다: 편집 중인 오버라이드 > 큐 자신의 스타일 > 기본값.
  // 가운데 겹을 빼먹으면 제목을 열었을 때 실제 서식(위·48px) 대신 기본값
  // (아래·26px)이 뜨고, 아무거나 건드리는 순간 그 기본값이 저장돼버린다.
  const cue = seg.style ?? {};
  const isTitle = seg.role === "title";

  const text = override?.text ?? seg.text;
  const fontSize = override?.fontSize ?? cue.size ?? (isTitle ? 48 : 26);
  const fontWeight =
    override?.fontWeight ?? (cue.bold === false ? 400 : cue.bold ? 700 : 600);
  const color = override?.color ?? cue.color ?? "#ffffff";
  const position = override?.position ?? cue.position ?? (isTitle ? "top" : "bottom");
  const font = override?.font ?? cue.font ?? "";
  const start = override?.start ?? seg.start;
  const end = override?.end ?? seg.end;

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        {isTitle ? "제목 편집" : "자막 편집"}
        <span className={styles.headerIdx}>#{selectionIndex! + 1}</span>
      </div>

      <div className={styles.body}>
        <div className={styles.section}>
          <div className={styles.label}>텍스트</div>
          <motion.textarea
            className={styles.textarea}
            value={text}
            onChange={(e) =>
              updateSubtitle(selectionIndex!, { text: e.target.value })
            }
            rows={3}
            layout
          />
        </div>

        <div className={styles.section}>
          <div className={styles.label}>
            크기
            <span className={styles.value}>{fontSize}px</span>
          </div>
          <input
            type="range"
            min={14}
            max={64}
            step={1}
            value={fontSize}
            onChange={(e) =>
              updateSubtitle(selectionIndex!, {
                fontSize: parseInt(e.target.value, 10),
              })
            }
            className={styles.slider}
          />
        </div>

        <div className={styles.section}>
          <div className={styles.label}>폰트</div>
          <select
            className={styles.select}
            value={font}
            onChange={(e) =>
              updateSubtitle(selectionIndex!, { font: e.target.value })
            }
          >
            {/* 빈 값 = 문서 기본 폰트. 굳이 큐에 박아 넣지 않는다. */}
            <option value="">기본 폰트</option>
            {FONT_OPTIONS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.section}>
          <div className={styles.label}>굵기</div>
          <div className={styles.weightRow}>
            {FONT_WEIGHTS.map((w) => (
              <button
                key={w}
                type="button"
                className={styles.weightBtn}
                data-active={w === fontWeight || undefined}
                onClick={() =>
                  updateSubtitle(selectionIndex!, { fontWeight: w })
                }
              >
                <span style={{ fontWeight: w }}>Aa</span>
                <span className={styles.weightNum}>{w}</span>
              </button>
            ))}
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.label}>색상</div>
          <div className={styles.colorRow}>
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={styles.colorSwatch}
                style={{ background: c }}
                data-active={c === color || undefined}
                onClick={() => updateSubtitle(selectionIndex!, { color: c })}
                aria-label={`색 ${c}`}
              />
            ))}
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.label}>위치</div>
          <div className={styles.tabs}>
            {POSITIONS.map((p) => (
              <button
                key={p.key}
                type="button"
                className={styles.tab}
                data-active={p.key === position || undefined}
                onClick={() =>
                  updateSubtitle(selectionIndex!, { position: p.key })
                }
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* 타이밍은 읽기 전용이었다. 제목은 대사와 달리 "언제부터 언제까지"
            자체가 디자인이라 여기서 바꿀 수 있어야 한다. */}
        <div className={styles.section}>
          <div className={styles.label}>
            타이밍
            <span className={styles.value}>{(end - start).toFixed(2)}s</span>
          </div>
          <div className={styles.timeRow}>
            <label className={styles.timeField}>
              <span className={styles.timeKey}>시작</span>
              <input
                type="number"
                className={styles.timeInput}
                value={start.toFixed(2)}
                min={0}
                step={0.1}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  if (!Number.isFinite(v) || v < 0) return;
                  // 시작이 끝을 넘으면 큐가 사라진다. 끝을 같이 민다.
                  updateSubtitle(selectionIndex!, {
                    start: v,
                    ...(v >= end ? { end: v + 0.5 } : {}),
                  });
                }}
              />
            </label>
            <label className={styles.timeField}>
              <span className={styles.timeKey}>끝</span>
              <input
                type="number"
                className={styles.timeInput}
                value={end.toFixed(2)}
                min={0}
                step={0.1}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  if (!Number.isFinite(v) || v <= start) return;
                  updateSubtitle(selectionIndex!, { end: v });
                }}
              />
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
