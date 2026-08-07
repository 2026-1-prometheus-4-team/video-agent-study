"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Check } from "lucide-react";
import { useAgentStore } from "../state";
import { useEditorStore } from "../../motion-editor/editorState";
import { fetchFonts } from "../backend";
import {
  DEFAULT_STYLE,
  FONT_OPTIONS,
  getSubtitleStyle,
  patchSubtitleStyle,
  pathStem,
  type SubtitlePosition,
  type SubtitleStyle,
} from "./subtitleApi";
import styles from "./subtitle-style.module.css";

interface Props {
  id: string;
  stem: string;
  status: "pending" | "applied";
  outputPath?: string;
}

const POSITION_OPTIONS: Array<{ value: SubtitlePosition; label: string }> = [
  { value: "bottom", label: "하단" },
  { value: "middle", label: "중앙" },
  { value: "top", label: "상단" },
];

/** 백엔드 position 값("bottom-left", "center" 등)을 카드의 3분류로 정규화. */
function normalizePosition(p: unknown): SubtitlePosition {
  const v = String(p ?? "");
  if (v.startsWith("top")) return "top";
  if (v.startsWith("middle") || v.startsWith("center")) return "middle";
  return "bottom";
}

export function SubtitleStyleCard({ id, stem, status, outputPath }: Props) {
  const uploadedUrl          = useAgentStore((s) => s.uploadedUrl);
  const lastFinal            = useAgentStore((s) => s.lastFinal);
  const applySubtitle        = useAgentStore((s) => s.applySubtitleStyle);
  const setGlobalSubtitleStyle = useEditorStore((s) => s.setGlobalSubtitleStyle);

  // 자막 큐 문서는 자막을 입힌 *편집 결과물* stem 으로 키가 잡힌다. 카드는 계획
  // 승인 시점(원본 stem)에 만들어지므로, 결과물이 도착하면 그 stem 을 우선한다.
  const effectiveStem = pathStem(lastFinal?.outputPath) || stem;

  const [style, setStyle]     = useState<SubtitleStyle>(DEFAULT_STYLE);
  const [fontOptions, setFontOptions] = useState(FONT_OPTIONS);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [saving, setSaving]   = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);

  // 자막 첫 프레임 고정
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const fix = () => { v.currentTime = 0; };
    v.addEventListener("loadedmetadata", fix);
    return () => v.removeEventListener("loadedmetadata", fix);
  }, [uploadedUrl]);

  // 보유 폰트 목록 — 백엔드가 폰트 내부 family 명으로 내려줌 (없으면 폴백 유지)
  useEffect(() => {
    let alive = true;
    fetchFonts().then((fonts) => {
      if (!alive || !fonts.length) return;
      setFontOptions(fonts.map((f) => ({ label: f.family, value: f.family })));
    });
    return () => { alive = false; };
  }, []);

  // 현재 스타일 로드
  useEffect(() => {
    if (!effectiveStem) return;
    setLoading(true);
    setError(null);
    getSubtitleStyle(effectiveStem)
      .then((s) => setStyle({ ...s, position: normalizePosition(s.position) }))
      .catch(() => {
        // 백엔드 미연결 or cues.json 없음 → 기본값으로 폴백
        setStyle(DEFAULT_STYLE);
      })
      .finally(() => setLoading(false));
  }, [effectiveStem]);

  const update = <K extends keyof SubtitleStyle>(key: K, val: SubtitleStyle[K]) =>
    setStyle((prev) => ({ ...prev, [key]: val }));

  const handleRender = async () => {
    if (saving || !effectiveStem) return;
    setSaving(true);
    setError(null);
    try {
      await patchSubtitleStyle(effectiveStem, style);
      setGlobalSubtitleStyle({
        size: style.size,
        color: style.color,
        bold: style.bold,
        strokeColor: style.stroke_color,
        strokeWidth: style.stroke_width,
        position: style.position,
      });
      applySubtitle(id, outputPath ?? "");
    } catch (e) {
      const isNetworkError =
        e instanceof TypeError ||
        (e instanceof Error && /failed to fetch|networkerror|load failed/i.test(e.message));
      const msg =
        e instanceof Error && /404/.test(e.message)
          ? "아직 자막 데이터가 없어요 — 편집이 끝난 뒤 다시 적용해줘"
          : isNetworkError
            ? "백엔드에 연결할 수 없어요 — 서버가 켜져 있는지 확인해줘"
            : "자막 스타일 저장에 실패했어요 — 다시 시도해줘";
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  const isApplied = status === "applied";

  // ── 미리보기 자막 스타일 계산 ──
  const previewFontSize = Math.max(10, Math.round(
    // 프리뷰 컨테이너 높이를 180px 기준으로 비례 계산
    180 * (style.size / 60) * 0.46
  ));

  // 위치별 프리뷰 배치 — bottom/top 은 여백 비례, middle 은 정중앙.
  const previewPlacement: CSSProperties =
    style.position === "top"
      ? { top: `${4 + (style.margin_v / 100) * 40}%` }
      : style.position === "middle"
        ? { top: "50%", transform: "translateY(-50%)" }
        : { bottom: `${4 + (style.margin_v / 100) * 40}%` };

  const strokeShadow = (() => {
    if (!style.stroke_width) return undefined;
    const s = Math.ceil(style.stroke_width);
    const dirs: string[] = [];
    for (let x = -s; x <= s; x++) {
      for (let y = -s; y <= s; y++) {
        if (x !== 0 || y !== 0) dirs.push(`${x}px ${y}px 0 ${style.stroke_color}`);
      }
    }
    return dirs.join(", ");
  })();

  return (
    <div className={styles.card} data-active={!isApplied || undefined}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerIcon}>T</div>
        <div className={styles.headerText}>
          <div className={styles.headerTitle}>자막 스타일</div>
          <div className={styles.headerSub}>{effectiveStem}.cues.json</div>
        </div>
        {isApplied && (
          <span className={styles.headerBadge} data-status="applied">
            적용 완료
          </span>
        )}
      </div>

      {/* Preview */}
      <div className={styles.preview}>
        {uploadedUrl ? (
          <video
            ref={videoRef}
            src={uploadedUrl}
            className={styles.previewVideo}
            muted
            preload="metadata"
            playsInline
          />
        ) : (
          <div className={styles.previewPlaceholder}>
            <span className={styles.previewPlaceholderIcon}>▶</span>
          </div>
        )}
        <div className={styles.previewDim} />
        <div
          className={styles.previewSubtitle}
          style={{
            ...previewPlacement,
            fontSize: previewFontSize,
            color: style.color,
            fontWeight: style.bold ? 700 : 400,
            textShadow: strokeShadow,
            animation: style.fade ? "subtitleFade 2.4s ease-in-out infinite" : undefined,
          }}
        >
          오늘도 잘 부탁해요 여러분
        </div>
      </div>

      {/* Controls */}
      {loading ? (
        <div className={styles.stateWrap}>
          <div className={styles.spinner} />
          <span>스타일 불러오는 중…</span>
        </div>
      ) : (
        <div className={styles.body}>

          {/* 폰트 */}
          <div className={styles.sectionLabel}>폰트</div>

          <div className={styles.row}>
            <span className={styles.label}>폰트 종류</span>
            <div className={styles.rhs}>
              <select
                className={styles.select}
                value={style.font}
                onChange={(e) => update("font", e.target.value)}
                disabled={isApplied}
              >
                {!fontOptions.some((f) => f.value === style.font) && (
                  <option value={style.font}>{style.font}</option>
                )}
                {fontOptions.map((f) => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className={styles.row}>
            <span className={styles.label}>폰트 크기</span>
            <div className={styles.rhs}>
              <div className={styles.sliderWrap}>
                <input
                  type="range"
                  className={styles.slider}
                  min={8} max={60} value={style.size}
                  disabled={isApplied}
                  onChange={(e) => update("size", Number(e.target.value))}
                  style={{ background: sliderFill(style.size, 8, 60) }}
                />
                <span className={styles.sliderVal}>{style.size}</span>
              </div>
            </div>
          </div>

          <div className={styles.divider} />

          {/* 색상 */}
          <div className={styles.sectionLabel}>색상</div>

          <div className={styles.row}>
            <span className={styles.label}>폰트 색상</span>
            <div className={styles.rhs}>
              <div className={styles.swatch} style={{ background: style.color }}>
                <input
                  type="color"
                  className={styles.swatchInput}
                  value={style.color}
                  disabled={isApplied}
                  onChange={(e) => update("color", e.target.value)}
                />
              </div>
              <span className={styles.hexLabel}>{style.color.toUpperCase()}</span>
            </div>
          </div>

          <div className={styles.row}>
            <span className={styles.label}>테두리 색상</span>
            <div className={styles.rhs}>
              <div className={styles.swatch} style={{ background: style.stroke_color }}>
                <input
                  type="color"
                  className={styles.swatchInput}
                  value={style.stroke_color}
                  disabled={isApplied}
                  onChange={(e) => update("stroke_color", e.target.value)}
                />
              </div>
              <span className={styles.hexLabel}>{style.stroke_color.toUpperCase()}</span>
            </div>
          </div>

          <div className={styles.row}>
            <span className={styles.label}>테두리 두께</span>
            <div className={styles.rhs}>
              <div className={styles.sliderWrap}>
                <input
                  type="range"
                  className={styles.slider}
                  min={0} max={5} step={0.5} value={style.stroke_width}
                  disabled={isApplied}
                  onChange={(e) => update("stroke_width", Number(e.target.value))}
                  style={{ background: sliderFill(style.stroke_width, 0, 5) }}
                />
                <span className={styles.sliderVal}>{style.stroke_width}</span>
              </div>
            </div>
          </div>

          <div className={styles.divider} />

          {/* 위치 */}
          <div className={styles.sectionLabel}>위치</div>

          <div className={styles.row}>
            <span className={styles.label}>자막 위치</span>
            <div className={styles.rhs}>
              <div className={styles.chipGroup} role="radiogroup" aria-label="자막 위치">
                {POSITION_OPTIONS.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    className={styles.chip}
                    data-on={style.position === p.value || undefined}
                    disabled={isApplied}
                    onClick={() => update("position", p.value)}
                  >
                    <span className={styles.chipDot} />
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {style.position !== "middle" && (
            <>
              <div className={styles.row}>
                <span className={styles.label}>가장자리 여백</span>
                <div className={styles.rhs}>
                  <div className={styles.sliderWrap}>
                    <input
                      type="range"
                      className={styles.slider}
                      min={0} max={100} value={style.margin_v}
                      disabled={isApplied}
                      onChange={(e) => update("margin_v", Number(e.target.value))}
                      style={{ background: sliderFill(style.margin_v, 0, 100) }}
                    />
                    <span className={styles.sliderVal}>{style.margin_v}</span>
                  </div>
                </div>
              </div>
              <div className={styles.posHint}>
                <span className={styles.posHintLabel}>
                  {style.position === "top" ? "0 · 상단 밀착" : "0 · 하단 밀착"}
                </span>
                <span className={styles.posHintLabel}>100 · 안쪽으로</span>
              </div>
            </>
          )}

          <div className={styles.divider} />

          {/* 효과 */}
          <div className={styles.sectionLabel}>효과</div>

          <div className={styles.row}>
            <span className={styles.label} />
            <div className={styles.rhs}>
              <div className={styles.chipGroup}>
                <button
                  type="button"
                  className={styles.chip}
                  data-on={style.bold || undefined}
                  disabled={isApplied}
                  onClick={() => update("bold", !style.bold)}
                >
                  <span className={styles.chipDot} />
                  굵게
                </button>
                <button
                  type="button"
                  className={styles.chip}
                  data-on={style.fade || undefined}
                  disabled={isApplied}
                  onClick={() => update("fade", !style.fade)}
                >
                  <span className={styles.chipDot} />
                  페이드
                </button>
              </div>
            </div>
          </div>

        </div>
      )}

      {/* Footer */}
      {isApplied ? (
        <div className={styles.appliedNote}>
          <Check size={12} />
          <span>자막 스타일 저장 완료</span>
        </div>
      ) : (
        <>
          {error && (
            <div className={styles.stateWrap}>
              <span>{error}</span>
            </div>
          )}
          <div className={styles.footer}>
            <button
              type="button"
              className={styles.btnGhost}
              onClick={() => setStyle(DEFAULT_STYLE)}
              disabled={saving}
            >
              기본값
            </button>
            <button
              type="button"
              className={styles.btnPrimary}
              onClick={handleRender}
              disabled={saving || loading}
            >
              {saving ? "저장 중…" : error ? "다시 시도 →" : "스타일 저장 →"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function sliderFill(val: number, min: number, max: number) {
  const pct = ((val - min) / (max - min)) * 100;
  return `linear-gradient(to right, var(--accent) ${pct}%, var(--hairline-strong) ${pct}%)`;
}
