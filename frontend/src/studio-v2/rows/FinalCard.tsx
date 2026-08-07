"use client";

import { motion } from "motion/react";
import { AlertCircle, CheckCircle2, Download, Film, Loader2, PenLine } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { StreamItem } from "../state";
import { formatSeconds } from "@/lib/format";
import {
  outputFileUrl,
  pathStem,
  renderSubtitles,
} from "../subtitle/subtitleApi";
import styles from "./rows.module.css";

// 파일 URL 을 blob 으로 받아 다운로드 (cross-origin download 속성 무시 방어).
async function downloadFile(url: string, filename: string) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  } catch {
    // blob 실패 시 새 탭으로라도 연다 (사용자가 직접 저장).
    window.open(url, "_blank", "noopener");
  }
}

export function FinalCard({
  item,
}: {
  item: Extract<StreamItem, { kind: "final" }>;
}) {
  const router = useRouter();
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const onRefine = () => {
    // 우리 프로젝트 전용 모션 에디터 (studio-v2 store 를 그대로 참조).
    router.push("/motion");
  };

  // 내보내기: 편집본은 자막을 굽지 않은 깨끗한 영상이므로, 배포본은 cue 를
  // 실제로 태워서(render) 내려받는다. 자막이 없으면(no_cues) 깨끗한 영상 그대로.
  const onExport = async () => {
    if (exporting) return;
    setExporting(true);
    setExportError(null);
    const stem = pathStem(item.outputPath);
    const cleanUrl = item.outputUrl || outputFileUrl(item.outputPath);
    try {
      const result = await renderSubtitles(stem);
      const burnedUrl = outputFileUrl(result.output_path) || cleanUrl;
      if (!burnedUrl) throw new Error("출력 URL 을 만들 수 없어");
      await downloadFile(burnedUrl, `${stem}_subtitled.mp4`);
    } catch (e) {
      // 자막 큐가 없으면 깨끗한 영상 그대로 내려받는다.
      const msg = e instanceof Error ? e.message : String(e);
      if (/404|no_cues/i.test(msg) && cleanUrl) {
        // 조용히 넘어가면 사용자는 자막이 빠진 걸 파일을 열어보고서야 안다.
        // 실패를 삼키지 않고 무엇이 빠졌는지 알린다.
        setExportError(
          "이 영상에는 자막 데이터가 없어서 자막 없이 내보냈어. " +
            "자막이 필요하면 채팅에 '자막 달아줘' 로 요청해줘."
        );
        await downloadFile(cleanUrl, `${stem}.mp4`);
      } else if (cleanUrl) {
        // 렌더 실패해도 최소한 깨끗한 영상은 내려받게.
        setExportError("자막 굽기에 실패해서 자막 없는 영상으로 내보냈어.");
        await downloadFile(cleanUrl, `${stem}.mp4`);
      } else {
        setExportError("내보내기에 실패했어. 잠시 후 다시 시도해줘.");
      }
    } finally {
      setExporting(false);
    }
  };

  const onRetry = () => {
    const prompt = item.criticNote
      ? `미완료된 편집을 이어서 완료해줘. 이전 오류: ${item.criticNote}`
      : "미완료된 편집 단계부터 다시 실행해서 최종 결과물을 완성해줘.";
    window.dispatchEvent(new CustomEvent("va:fill-composer", { detail: prompt }));
  };

  return (
    <motion.div
      className={`${styles.finalCard} ${item.success === false ? styles.finalCardFailed : ""}`}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        type: "spring",
        stiffness: 320,
        damping: 28,
        mass: 0.7,
      }}
    >
      <div className={styles.finalHeader}>
        <div className={item.success === false ? styles.finalFailed : styles.finalCheck}>
          {item.success === false ? (
            <AlertCircle size={14} strokeWidth={2.4} />
          ) : (
            <CheckCircle2 size={14} strokeWidth={2.4} />
          )}
        </div>
        <div className={styles.finalTitle}>
          {item.success === false ? "편집 미완료" : "편집 완료"}
        </div>
        <div className={styles.finalDuration}>
          {formatSeconds(item.duration, false)}
        </div>
      </div>

      <div className={styles.finalPath}>{item.outputPath}</div>

      {item.criticNote && (
        <div className={styles.finalNote}>{item.criticNote}</div>
      )}

      {exportError && <div className={styles.finalNote}>{exportError}</div>}

      <div className={styles.finalActions}>
        <button type="button" className={styles.btnGhost} onClick={onRetry}>
          <PenLine size={12} />
          <span>다시 편집</span>
        </button>
        {item.success !== false && (
          <button
            type="button"
            className={styles.btnGhost}
            onClick={onExport}
            disabled={exporting}
          >
            {exporting ? (
              <Loader2 size={12} className={styles.spin} />
            ) : (
              <Download size={12} />
            )}
            <span>{exporting ? "내보내는 중" : "자막 넣어 내보내기"}</span>
          </button>
        )}
        <button
          type="button"
          className={styles.finalMotionLink}
          onClick={onRefine}
        >
          <Film size={12} />
          <span>모션 에디터에서 다듬기</span>
        </button>
      </div>
    </motion.div>
  );
}
