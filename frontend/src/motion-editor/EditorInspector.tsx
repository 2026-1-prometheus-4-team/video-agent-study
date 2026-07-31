"use client";

import { motion } from "motion/react";
import { useAgentStore } from "@/studio-v2/state";
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

  const text = override?.text ?? seg.text;
  const fontSize = override?.fontSize ?? 26;
  const fontWeight = override?.fontWeight ?? 600;
  const color = override?.color ?? "#ffffff";
  const position = override?.position ?? "bottom";

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        자막 편집
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

        <div className={styles.meta}>
          <div className={styles.metaRow}>
            <span className={styles.metaKey}>시작</span>
            <span className={styles.metaVal}>{seg.start.toFixed(2)}s</span>
          </div>
          <div className={styles.metaRow}>
            <span className={styles.metaKey}>끝</span>
            <span className={styles.metaVal}>{seg.end.toFixed(2)}s</span>
          </div>
          <div className={styles.metaRow}>
            <span className={styles.metaKey}>길이</span>
            <span className={styles.metaVal}>
              {(seg.end - seg.start).toFixed(2)}s
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
