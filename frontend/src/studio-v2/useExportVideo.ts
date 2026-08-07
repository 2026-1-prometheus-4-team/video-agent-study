"use client";

import { useCallback, useState } from "react";
import { outputFileUrl, pathStem, renderSubtitles } from "./subtitle/subtitleApi";

/**
 * 내보내기 = 렌더. 링크가 아니다.
 *
 * 편집 결과물은 자막을 굽지 않은 깨끗한 영상이고, 자막과 제목은 큐 문서에만
 * 있다. 그래서 그 mp4 로 바로 링크를 걸면 (예전 TopBar 가 <a download> 로 그랬듯)
 * 눌렀을 때 즉시 받아지는 대신 자막도 제목도 없는 파일이 나온다. 내보내기는
 * 반드시 서버 렌더를 한 번 더 거쳐 현재 큐를 태운 결과를 받아야 한다.
 *
 * 이 훅이 그 경로의 단 하나의 구현이다. 화면마다 복사하면 한쪽만 고쳐지고
 * 다른 쪽은 조용히 자막 없는 파일을 계속 내보낸다 — 실제로 그렇게 갈라져 있었다.
 */

/** 파일 URL 을 blob 으로 받아 다운로드 (cross-origin download 속성 무시 방어). */
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

export interface ExportTarget {
  outputPath: string;
  outputUrl?: string;
}

export interface UseExportVideo {
  /** 렌더가 도는 동안 true. 버튼은 이 값으로 진행 상태를 보여야 한다. */
  exporting: boolean;
  /** 자막이 빠진 채 내보내진 경우 등, 사용자가 알아야 할 결과. */
  exportError: string | null;
  clearError: () => void;
  exportVideo: (target: ExportTarget | null) => Promise<void>;
}

export function useExportVideo(): UseExportVideo {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const clearError = useCallback(() => setExportError(null), []);

  const exportVideo = useCallback(
    async (target: ExportTarget | null) => {
      if (!target) return;
      // 렌더는 수십 초 걸린다. 중복 요청은 서버에서 같은 파일을 동시에 쓴다.
      setExporting(true);
      setExportError(null);

      const stem = pathStem(target.outputPath);
      const cleanUrl = target.outputUrl || outputFileUrl(target.outputPath);

      try {
        const result = await renderSubtitles(stem);
        const burnedUrl = outputFileUrl(result.output_path) || cleanUrl;
        if (!burnedUrl) throw new Error("출력 URL 을 만들 수 없어");
        await downloadFile(burnedUrl, `${stem}_subtitled.mp4`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/404|no_cues/i.test(msg) && cleanUrl) {
          // 조용히 넘어가면 사용자는 자막이 빠진 걸 파일을 열어보고서야 안다.
          setExportError(
            "이 영상에는 자막 데이터가 없어서 자막 없이 내보냈어. " +
              "자막이 필요하면 채팅에 '자막 달아줘' 로 요청해줘."
          );
          await downloadFile(cleanUrl, `${stem}.mp4`);
        } else if (cleanUrl) {
          setExportError("자막 굽기에 실패해서 자막 없는 영상으로 내보냈어.");
          await downloadFile(cleanUrl, `${stem}.mp4`);
        } else {
          setExportError("내보내기에 실패했어. 잠시 후 다시 시도해줘.");
        }
      } finally {
        setExporting(false);
      }
    },
    []
  );

  return { exporting, exportError, clearError, exportVideo };
}
