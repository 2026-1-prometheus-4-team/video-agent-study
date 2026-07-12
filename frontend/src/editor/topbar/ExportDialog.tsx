// Export 다이얼로그 — 좌: 코덱/화질/스케일 옵션, 우: 라이브 미리보기(자동 재생).
// 페이드 백드롭, ESC/바깥 클릭 닫힘. 렌더는 /api/export 잡으로 서버(Remotion CLI)
// 에서 수행 — 프리뷰와 동일한 스펙 -> Ad 경로라 결과가 화면과 일치한다.

"use client";

import React from "react";
import { Player } from "@remotion/player";
import { Ad, totalFrames, type VideoSpec } from "@engine/motion/SceneRenderer";
import { FPS } from "@/engine/normalize";
import { useEditor } from "@/editor/store";
import { saveCurrentDoc } from "@/editor/library/saveDoc";

const PreviewComp: React.FC<{ spec: VideoSpec }> = ({ spec }) => <Ad spec={spec} />;

type Codec = "h264" | "h265" | "vp9" | "prores" | "gif";
type Quality = "high" | "balanced" | "compact";

const CODECS: Array<{ v: Codec; label: string; note: string }> = [
  { v: "h264", label: "H.264 - MP4", note: "Universal, fast" },
  { v: "h265", label: "H.265 - MP4", note: "Smaller, slower" },
  { v: "vp9", label: "VP9 - WebM", note: "Web, alpha-capable" },
  { v: "prores", label: "ProRes - MOV", note: "Editing master" },
  { v: "gif", label: "GIF", note: "Loop preview" },
];
const CRF: Record<Codec, Record<Quality, number | null>> = {
  h264: { high: 16, balanced: 20, compact: 26 },
  h265: { high: 20, balanced: 24, compact: 30 },
  vp9: { high: 28, balanced: 34, compact: 42 },
  prores: { high: null, balanced: null, compact: null },
  gif: { high: null, balanced: null, compact: null },
};

// 진행 중 잡은 다이얼로그 밖에 보관 — 닫았다 다시 열어도 폴링에 재접속한다
// (렌더는 서버에서 계속 돌므로, 잃어버리면 "눌렀는데 사라짐"이 된다).
let ACTIVE_JOB: string | null = null;
let LAST_FILE: string | null = null;

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const doc = useEditor((s) => s.doc);
  const meta = useEditor((s) => s.meta);
  const [codec, setCodec] = React.useState<Codec>("h264");
  const [quality, setQuality] = React.useState<Quality>("balanced");
  const [scale, setScale] = React.useState(1);
  const [job, setJob] = React.useState<string | null>(ACTIVE_JOB);
  const [starting, setStarting] = React.useState(false);
  const [progress, setProgress] = React.useState(-1);
  const [stage, setStage] = React.useState<"prepare" | "render">("prepare");
  const [frameInfo, setFrameInfo] = React.useState<{ cur: number; total: number } | null>(null);
  const [file, setFile] = React.useState<string | null>(LAST_FILE);
  const [error, setError] = React.useState<string | null>(null);
  // 무거운 프리뷰(전체 컴포지션 Player)는 다이얼로그가 먼저 그려진 뒤 마운트 —
  // 동기 마운트하면 Export 클릭 후 다이얼로그가 뜨기까지 수백 ms 멈춘 듯 보인다.
  const [previewReady, setPreviewReady] = React.useState(false);
  const panelRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const t = setTimeout(() => setPreviewReady(true), 30);
    return () => clearTimeout(t);
  }, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [onClose]);

  // 잡 폴링
  React.useEffect(() => {
    if (!job) return;
    const t = setInterval(async () => {
      const r = await fetch(`/api/export?job=${job}`);
      if (r.status === 404) {
        // 서버 재시작/리로드로 잡 유실 — 무한 폴링 대신 명확히 종료
        clearInterval(t);
        setJob(null);
        ACTIVE_JOB = null;
        setError("Export job lost (server restarted) — run export again");
        return;
      }
      const j = await r.json();
      setProgress(j.progress ?? -1);
      setStage(j.stage ?? "prepare");
      setFrameInfo(j.cur != null && j.total != null ? { cur: j.cur, total: j.total } : null);
      if (j.done) {
        clearInterval(t);
        setJob(null);
        ACTIVE_JOB = null;
        if (j.error) setError(`${j.error}\n${j.log ?? ""}`);
        else {
          setFile(j.file);
          LAST_FILE = j.file;
        }
      }
    }, 800);
    return () => clearInterval(t);
  }, [job]);

  const start = async () => {
    if (!meta.relPath || job || starting) return; // 더블클릭 이중 렌더 방지
    setStarting(true); // await 전에 동기로 — 클릭 즉시 버튼이 반응해야 한다
    setError(null);
    setFile(null);
    LAST_FILE = null;
    setProgress(-1);
    setStage("prepare");
    setFrameInfo(null);
    try {
      await saveCurrentDoc(); // 렌더는 디스크의 스펙을 읽는다
      // 컴포지션 id 규칙 = Root.tsx 등록과 동일: .json 제거 + "/" -> "-"
      // (중첩 폴더 스펙: base44/s1.json -> base44-s1)
      const compId = meta.relPath.replace(/\.json$/, "").replace(/\//g, "-");
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ compId, codec, crf: CRF[codec][quality], scale }),
      });
      const j = await res.json();
      if (j.job) {
        setJob(j.job);
        ACTIVE_JOB = j.job;
      } else setError(j.error ?? "failed to start");
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setStarting(false);
    }
  };

  const frames = doc ? Math.max(1, totalFrames(doc, FPS)) : 1;
  const busy = !!job || starting;
  // 에디터 토큰 기반 — 외곽선 칩 금지, 선택만 액센트(단일 크로마), 호버 fill.
  const opt: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };
  const lbl: React.CSSProperties = { color: "var(--text-4)", fontSize: 11, fontWeight: 550, letterSpacing: "0.03em", textTransform: "uppercase" };
  const chipRow: React.CSSProperties = { display: "flex", gap: 4, flexWrap: "wrap" };
  const chip = (active: boolean): React.CSSProperties => ({
    padding: "7px 11px",
    borderRadius: 8,
    border: "none",
    background: active ? "var(--accent-muted)" : "var(--bg-card)",
    color: active ? "var(--accent-strong)" : "var(--text-3)",
    fontWeight: active ? 600 : 400,
    fontSize: 12,
    cursor: "pointer",
  });

  return (
    <>
      <style>{`
        @keyframes exportFade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes exportPop { from { opacity: 0; transform: translate(-50%, -46%) scale(0.97); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
        @keyframes exportSweep { from { transform: translateX(-110%); } to { transform: translateX(360%); } }
        @keyframes exportSpin { to { transform: rotate(360deg); } }
      `}</style>
      <div style={{ position: "fixed", inset: 0, zIndex: 400, background: "rgba(0,0,0,0.5)", animation: "exportFade 160ms ease-out" }} />
      <div
        ref={panelRef}
        style={{
          position: "fixed",
          left: "50%",
          top: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 401,
          animation: "exportPop 200ms cubic-bezier(0.2, 0.9, 0.3, 1)",
          background: "var(--bg-panel)",
          border: "1px solid rgba(255,255,255,0.07)",
          borderRadius: 12,
          boxShadow: "0 24px 80px rgba(0,0,0,0.55)",
          width: 880,
          maxWidth: "94vw",
          padding: 20,
          display: "flex",
          gap: 18,
        }}
      >
        {/* 좌: 옵션 */}
        <div style={{ width: 300, display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ color: "var(--text-1)", fontSize: 14, fontWeight: 600 }}>Export</div>
            <button onClick={onClose} aria-label="Close" style={{ background: "none", border: "none", color: "var(--text-4)", cursor: "pointer", padding: 2 }}>
              <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            </button>
          </div>

          <div style={opt}>
            <div style={lbl}>Codec</div>
            <div style={chipRow}>
              {CODECS.map((c) => (
                <div key={c.v} style={chip(codec === c.v)} onClick={() => setCodec(c.v)} title={c.note}>
                  {c.label}
                </div>
              ))}
            </div>
          </div>

          {CRF[codec].high != null && (
            <div style={opt}>
              <div style={lbl}>Quality</div>
              <div style={chipRow}>
                {(["high", "balanced", "compact"] as Quality[]).map((q) => (
                  <div key={q} style={chip(quality === q)} onClick={() => setQuality(q)}>
                    {q === "high" ? "High" : q === "balanced" ? "Balanced" : "Compact"}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={opt}>
            <div style={lbl}>Resolution</div>
            <div style={chipRow}>
              {[0.5, 1, 2].map((sc) => (
                <div key={sc} style={chip(scale === sc)} onClick={() => setScale(sc)}>
                  {sc === 1 ? "1920 x 1080" : sc === 0.5 ? "960 x 540" : "3840 x 2160"}
                </div>
              ))}
            </div>
          </div>

          <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
            {busy && (
              <>
                <div style={{ height: 5, borderRadius: 3, background: "var(--bg-inset)", overflow: "hidden" }}>
                  <div
                    style={{
                      height: "100%",
                      width: progress >= 0 ? `${Math.round(progress * 100)}%` : "30%",
                      background: "var(--accent)",
                      borderRadius: 3,
                      transition: progress >= 0 ? "width 300ms" : undefined,
                      // 진행률을 모르는 동안(번들링)은 좌우 스윕 — 살아있음이 보이게
                      ...(progress < 0 ? { animation: "exportSweep 1.1s ease-in-out infinite" } : {}),
                    }}
                  />
                </div>
                <div style={{ color: "var(--text-4)", fontSize: 10.5, textAlign: "center", marginTop: -4 }}>
                  {starting
                    ? "Saving spec and starting the renderer..."
                    : stage === "prepare"
                      ? "Preparing renderer (bundling) — the first export takes 10-20s to warm up"
                      : frameInfo
                        ? `${frameInfo.cur} / ${frameInfo.total} frames`
                        : "Rendering..."}
                </div>
              </>
            )}
            {error && <div style={{ color: "var(--danger, #f87171)", fontSize: 11, whiteSpace: "pre-wrap", maxHeight: 120, overflow: "auto" }}>{error}</div>}
            {file && (
              <a
                href={`/api/export/file?f=${encodeURIComponent(file)}`}
                download
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  padding: "10px 12px",
                  borderRadius: 9,
                  background: "var(--accent)",
                  color: "#FFFFFF",
                  fontSize: 13,
                  fontWeight: 600,
                  textDecoration: "none",
                }}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M7 1.5v7.5M7 9l-3-3M7 9l3-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M2 11.5h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                Download video
              </a>
            )}
            {file && (
              <div style={{ color: "var(--text-4)", fontSize: 10, textAlign: "center", marginTop: -4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file}</div>
            )}
            <button
              onClick={start}
              disabled={busy || !doc}
              style={{
                padding: "10px 12px",
                borderRadius: 9,
                border: "none",
                background: busy ? "var(--bg-elevated)" : file ? "var(--bg-card)" : "var(--accent)",
                color: busy ? "var(--text-3)" : file ? "var(--text-2)" : "#FFFFFF",
                fontSize: 13,
                fontWeight: 600,
                cursor: busy ? "default" : "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
              }}
            >
              {busy && (
                <span
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: "50%",
                    border: "1.5px solid var(--hairline)",
                    borderTopColor: "var(--accent)",
                    animation: "exportSpin 0.7s linear infinite",
                    flex: "none",
                  }}
                />
              )}
              {starting
                ? "Starting..."
                : busy
                  ? progress >= 0
                    ? `Rendering ${Math.round(progress * 100)}%`
                    : "Preparing..."
                  : file
                    ? "Export again"
                    : "Export video"}
            </button>
          </div>
        </div>

        {/* 우: 라이브 미리보기 (자동 재생 루프) */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={lbl}>Preview</div>
          <div style={{ borderRadius: 8, overflow: "hidden", border: "1px solid rgba(255,255,255,0.07)", background: "#000", lineHeight: 0, position: "relative" }}>
            {/* 프리뷰 마운트 전 자리 지킴 — 16:9 비율 확보 + 은은한 로딩 표시 */}
            {doc && !previewReady && (
              <div style={{ aspectRatio: "16/9", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-4)", fontSize: 11, lineHeight: 1.4 }}>
                Loading preview...
              </div>
            )}
            {doc && previewReady && (
              // 오버스캔 1px — Remotion Player 는 컴포지션을 축소 렌더할 때 우/하단에
              // 서브픽셀 갭이 남아 컨테이너 배경이 비쳐 "가장자리가 짤린 듯" 보인다.
              // margin:-1 로 클립박스보다 2px 넓게 그려 hairline 을 잘라내면 씬 배경과
              // 무관하게 가장자리가 꽉 찬다. export(Remotion CLI 원본 렌더)엔 없는
              // 프리뷰 전용 아티팩트라 결과물엔 영향 없음.
              <div style={{ margin: -1 }}>
                <Player
                  component={PreviewComp}
                  inputProps={{ spec: doc }}
                  durationInFrames={frames}
                  fps={FPS}
                  compositionWidth={1920}
                  compositionHeight={1080}
                  style={{ width: "100%", display: "block" }}
                  controls
                  loop
                  autoPlay
                  initiallyMuted
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
