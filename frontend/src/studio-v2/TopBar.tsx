"use client";

import { Download, PanelLeft, PanelRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useAgentStore } from "./state";
import { outputFileUrl } from "./subtitle/subtitleApi";
import styles from "./topbar.module.css";

interface TopBarProps {
  historyOpen: boolean;
  chatOpen: boolean;
  onToggleHistory: () => void;
  onToggleChat: () => void;
}

/**
 * TopBar — 앱 최상단. 카드도 배경도 테두리도 없다.
 *
 * 배경을 깔거나 구분선을 그으면 "웹사이트 헤더" 처럼 읽힌다. 아래 카드들과의
 * 간격만으로 층을 만든다. 여기 있는 것은 전부 실제로 누를 수 있는 것뿐이고,
 * 상태 표시등(초록 점 · "연결됨") 같은 장식은 두지 않는다 — 사용자가 그걸로
 * 할 수 있는 일이 없다. 연결이 끊겼을 때만 문구로 알린다.
 */
export function TopBar({
  historyOpen,
  chatOpen,
  onToggleHistory,
  onToggleChat,
}: TopBarProps) {
  const router = useRouter();
  const connection = useAgentStore((s) => s.connection);
  const lastFinal = useAgentStore((s) => s.lastFinal);
  const offline = connection === "offline";

  const finalUrl = lastFinal
    ? lastFinal.outputUrl || outputFileUrl(lastFinal.outputPath)
    : null;

  return (
    <header className={styles.bar}>
      <div className={styles.left}>
        {/* 마크 — 채운 박스 대신 선으로만. 재생 삼각형 + 컷 슬래시.
            "영상을 자른다" 를 한 획으로 쓴 것이고, 24px 에서도 형태가 남는다. */}
        {/* 그림 마크를 두지 않는다. 재생 삼각형이든 필름이든 이 카테고리에서는
            이미 닳은 기호라, 붙이는 순간 흔해 보인다. 글자만으로 세운다.
            색은 마침표 하나에만 — 그게 유일한 크로마다. */}
        <span className={styles.wordmark}>
          <span className={styles.wordmarkStrong}>vibe</span>
          <span className={styles.wordmarkLight}>edit</span>
          <span className={styles.wordmarkDot} aria-hidden />
        </span>
      </div>

      <div className={styles.center}>
        {offline && (
          <span className={styles.offline} role="status">
            백엔드 연결 끊김
          </span>
        )}
      </div>

      <div className={styles.right}>
        <button
          type="button"
          className={styles.ghost}
          onClick={onToggleHistory}
          data-active={historyOpen || undefined}
          aria-label="기록 패널"
          title="기록 (⌘⇧B)"
        >
          <PanelLeft size={14} />
        </button>
        <button
          type="button"
          className={styles.ghost}
          onClick={onToggleChat}
          data-active={chatOpen || undefined}
          aria-label="대화 패널"
          title="대화 (⌘B)"
        >
          <PanelRight size={14} />
        </button>

        <button
          type="button"
          className={styles.editor}
          onClick={() => router.push("/motion")}
        >
          모션 에디터
        </button>

        <a
          className={styles.export}
          href={finalUrl ?? undefined}
          download={lastFinal ? "" : undefined}
          data-disabled={!finalUrl || undefined}
          aria-disabled={!finalUrl}
        >
          <Download size={13} strokeWidth={2.2} />
          <span>내보내기</span>
        </a>
      </div>
    </header>
  );
}
