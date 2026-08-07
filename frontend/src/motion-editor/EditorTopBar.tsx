"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Download, Save, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useAgentStore } from "@/studio-v2/state";
import {
  outputFileUrl,
  pathStem,
  renderSubtitles,
  updateSubtitleCues,
  type CueUpdate,
} from "@/studio-v2/subtitle/subtitleApi";
import { useEditorStore } from "./editorState";
import styles from "./editor-topbar.module.css";

export function EditorTopBar() {
  const uploadedName = useAgentStore((s) => s.uploadedName);
  const serverVideoPath = useAgentStore((s) => s.serverVideoPath);
  const lastFinal = useAgentStore((s) => s.lastFinal);
  const videoContext = useAgentStore((s) => s.videoContext);
  const dirty = useEditorStore((s) => s.dirty);
  const overrides = useEditorStore((s) => s.subtitleOverrides);
  const markSaved = useEditorStore((s) => s.markSaved);

  const [busy, setBusy] = useState<"save" | "export" | null>(null);

  // 자막 큐 문서는 자막을 입힌 편집 결과물 stem 으로 키가 잡힌다.
  const stem = pathStem(lastFinal?.outputPath) || pathStem(serverVideoPath);

  // 인스펙터/목록이 보는 것과 같은 배열이어야 index -> id 매핑이 맞는다.
  const transcript = lastFinal?.transcript ?? videoContext?.transcript ?? [];

  const label =
    lastFinal?.outputPath ||
    uploadedName ||
    "새 프로젝트";

  const buildUpdates = (): CueUpdate[] =>
    Object.entries(overrides)
      .map(([idx, o]) => {
        const style: Record<string, unknown> = {};
        if (o.fontSize !== undefined) style.size = o.fontSize;
        if (o.color !== undefined) style.color = o.color;
        if (o.fontWeight !== undefined) style.bold = o.fontWeight >= 600;
        if (o.position !== undefined) style.position = o.position;
        // 빈 문자열 = "문서 기본 폰트로" 라, 큐에 빈 font 를 박지 않는다.
        if (o.font) style.font = o.font;

        // 배열 위치 대신 큐 id 로 지목한다. 목록이 한 칸이라도 어긋나면
        // (제목이 시간순으로 끼어들 때 실제로 그렇다) 엉뚱한 큐가 수정된다.
        const cueId = transcript[Number(idx)]?.id;
        const update: CueUpdate = cueId
          ? { id: cueId }
          : { index: Number(idx) };

        if (o.text !== undefined) update.text = o.text;
        if (o.start !== undefined) update.start = o.start;
        if (o.end !== undefined) update.end = o.end;
        if (Object.keys(style).length) update.style = style;
        return update;
      })
      .filter(
        (u) =>
          u.text !== undefined ||
          u.style ||
          u.start !== undefined ||
          u.end !== undefined
      );

  const onSave = async () => {
    if (busy) return;
    const updates = buildUpdates();
    if (!updates.length) {
      markSaved();
      return;
    }
    if (!stem) {
      toast.error("저장 실패", { description: "저장할 영상이 없어" });
      return;
    }
    setBusy("save");
    try {
      const res = await updateSubtitleCues(stem, updates);
      markSaved();
      toast.success("편집 저장", {
        description: `자막 ${res.updated?.length ?? updates.length}개 서버 큐 문서 반영`,
      });
    } catch (e) {
      const is404 = e instanceof Error && /404/.test(e.message);
      toast.error("저장 실패", {
        description: is404
          ? "이 영상의 자막 데이터가 아직 없어 — 자막 생성 후 다시 저장해줘"
          : "백엔드 연결을 확인해줘",
      });
    } finally {
      setBusy(null);
    }
  };

  const onExport = async () => {
    if (busy) return;
    if (!stem) {
      toast.error("내보내기 실패", { description: "내보낼 영상이 없어" });
      return;
    }
    setBusy("export");
    try {
      // 저장 안 된 편집이 있으면 먼저 큐 문서에 반영 후 렌더.
      const updates = buildUpdates();
      if (dirty && updates.length) {
        await updateSubtitleCues(stem, updates);
        markSaved();
      }
      const result = await renderSubtitles(stem);
      const url = outputFileUrl(result.output_path);
      if (url) window.open(url, "_blank");
      toast.success("내보내기 완료", { description: result.output_path });
    } catch (e) {
      // 자막 큐가 없는 영상 = 번인할 게 없음 — 현재 결과물 파일을 그대로 연다.
      const is404 = e instanceof Error && /404/.test(e.message);
      const directUrl =
        lastFinal?.outputUrl ?? outputFileUrl(lastFinal?.outputPath);
      if (is404 && directUrl) {
        window.open(directUrl, "_blank");
        toast("자막 큐 없음 — 현재 결과물을 그대로 열었어");
      } else {
        toast.error("내보내기 실패", {
          description: is404
            ? "자막 데이터도 결과물도 아직 없어"
            : "백엔드 연결을 확인해줘",
        });
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={styles.bar}>
      <div className={styles.left}>
        <Link href="/" className={styles.back} aria-label="스튜디오로">
          <ArrowLeft size={14} strokeWidth={2.2} />
          <span>스튜디오</span>
        </Link>
        <div className={styles.divider} />
        <div className={styles.brand}>
          <div className={styles.brandMark}>
            <Sparkles size={11} strokeWidth={2.2} />
          </div>
          <div className={styles.brandText}>
            <span className={styles.brandTitle}>모션 에디터</span>
            <span className={styles.brandCaption}>Refine</span>
          </div>
        </div>
      </div>

      <div className={styles.center}>
        <div className={styles.project}>
          <span className={styles.projectMono}>{label}</span>
          {dirty && (
            <span className={styles.dirtyDot} title="저장되지 않은 변경" />
          )}
        </div>
      </div>

      <div className={styles.right}>
        <button
          type="button"
          className={styles.btnGhost}
          onClick={onSave}
          disabled={!dirty || busy !== null}
          title="저장 (⌘S)"
        >
          <Save size={12} />
          <span>{busy === "save" ? "저장 중…" : dirty ? "저장" : "저장됨"}</span>
        </button>
        <button
          type="button"
          className={styles.btnPrimary}
          onClick={onExport}
          disabled={busy !== null}
          title="내보내기 (⌘E)"
        >
          <Download size={12} />
          <span>{busy === "export" ? "렌더링 중…" : "내보내기"}</span>
        </button>
      </div>
    </div>
  );
}
