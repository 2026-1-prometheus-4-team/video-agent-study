"use client";

import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { useAgentStore } from "../state";
import {
  DEFAULT_STYLE,
  FONT_OPTIONS,
  getSubtitleStyle,
  renderSubtitles,
  type SubtitleStyle,
} from "./subtitleApi";
import styles from "./subtitle-style.module.css";

interface Props {
  id: string;
  stem: string;
  status: "pending" | "applied";
  outputPath?: string;
}

export function SubtitleStyleCard({ id, stem, status, outputPath }: Props) {
  const uploadedUrl   = useAgentStore((s) => s.uploadedUrl);
  const applySubtitle = useAgentStore((s) => s.applySubtitleStyle);
  const pushFinal     = useAgentStore((s) => s.pushFinal);

  const [style, setStyle]     = useState<SubtitleStyle>(DEFAULT_STYLE);
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

  // 현재 스타일 로드
  useEffect(() => {
    if (!stem) return;
    setLoading(true);
    setError(null);
    getSubtitleStyle(stem)
      .then(setStyle)
      .catch(() => {
        // 백엔드 미연결 or cues.json 없음 → 기본값으로 폴백
        setStyle(DEFAULT_STYLE);
      })
      .finally(() => setLoading(false));
  }, [stem]);

  const update = <K extends keyof SubtitleStyle>(key: K, val: SubtitleStyle[K]) =>
    setStyle((prev) => ({ ...prev, [key]: val }));

  const handleRender = async () => {
    if (saving || !stem) return;
    setSaving(true);
    try {
      const result = await renderSubtitles(stem, style);
      applySubtitle(id, result.output_path);
      pushFinal(result.output_path, result.duration_sec, {
        outputUrl: undefined,
      });
    } catch {
      setError("백엔드 연결 필요 — 실제 렌더링은 백엔드 연결 후 가능해요");
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

  const previewBottom = `${4 + (style.margin_v / 100) * 80}%`;

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
          <div className={styles.headerSub}>{stem}.cues.json</div>
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
            bottom: previewBottom,
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
      ) : error ? (
        <div className={styles.stateWrap}>
          <span>오류: {error}</span>
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
                {FONT_OPTIONS.map((f) => (
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
            <span className={styles.posHintLabel}>0 · 하단</span>
            <span className={styles.posHintLabel}>100 · 상단</span>
          </div>

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
          <span>
            {outputPath ?? "렌더링 완료"} — 스테이지에서 확인해봐
          </span>
        </div>
      ) : (
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
            disabled={saving || loading || !!error}
          >
            {saving ? "렌더링 중…" : "적용하고 제작 시작 →"}
          </button>
        </div>
      )}
    </div>
  );
}

function sliderFill(val: number, min: number, max: number) {
  const pct = ((val - min) / (max - min)) * 100;
  return `linear-gradient(to right, var(--accent) ${pct}%, var(--hairline-strong) ${pct}%)`;
}
