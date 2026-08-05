"use client";

/**
 * 업로드된 영상 라이브러리.
 *
 * 기존에는 업로드 결과가 파일명 텍스트로만 남아서, 실행이 실패하면 사용자가
 * 같은 파일을 다시 올려야 했다. 여기서는 서버 라이브러리(GET /media)를 그대로
 * 그리고, 어떤 영상을 이번 지시에 쓸지 선택만 바꾸면 되게 한다.
 */

import { AnimatePresence, motion } from "motion/react";
import { Check, Film, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { deleteMedia } from "./backend";
import { useAgentStore, type MediaItem } from "./state";
import styles from "./media-library.module.css";

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "--:--";
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatSize(bytes: number): string {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 1) return `${mb.toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function MediaLibrary() {
  const media = useAgentStore((s) => s.media);
  const selectedPaths = useAgentStore((s) => s.serverVideoPaths);
  const addVideo = useAgentStore((s) => s.addVideo);
  const removeVideo = useAgentStore((s) => s.removeVideo);
  const [busyName, setBusyName] = useState<string | null>(null);

  if (media.length === 0) return null;

  // 복원된 세션이 이미 삭제된 영상을 가리킬 수 있다. 그대로 세면 "5/2 선택"
  // 같은 표시가 나오므로, 라이브러리에 실제로 있는 것만 센다.
  const selectedHere = selectedPaths.filter((p) =>
    media.some((m) => m.path === p)
  ).length;

  const toggle = (item: MediaItem) => {
    if (selectedPaths.includes(item.path)) removeVideo(item.path);
    else addVideo(item.path, item.originalName, item.url);
  };

  const onDelete = async (item: MediaItem) => {
    setBusyName(item.name);
    try {
      const ok = await deleteMedia(item.name);
      if (ok) toast.success(`${item.originalName} 삭제됨`);
      else toast.error("삭제하지 못했어", { description: item.originalName });
    } finally {
      setBusyName(null);
    }
  };

  return (
    <section className={styles.wrap} aria-label="업로드한 영상">
      <div className={styles.head}>
        <span className={styles.headTitle}>내 영상</span>
        <span className={styles.headCount}>
          {selectedHere > 0
            ? `${selectedHere}/${media.length} 선택`
            : `${media.length}개`}
        </span>
      </div>

      <div className={styles.grid}>
        <AnimatePresence initial={false}>
          {media.map((item) => {
            const selected = selectedPaths.includes(item.path);
            const order = selectedPaths.indexOf(item.path) + 1;
            return (
              <motion.div
                key={item.name}
                layout
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
                className={styles.card}
                data-selected={selected}
                data-busy={busyName === item.name}
              >
                <button
                  type="button"
                  className={styles.cardBtn}
                  onClick={() => toggle(item)}
                  aria-pressed={selected}
                  title={item.originalName}
                >
                  <span className={styles.thumb}>
                    {item.thumbnailUrl ? (
                      // 서버가 만든 첫 장면 썸네일. next/image 는 외부 호스트
                      // 설정이 필요해서 여기서는 순수 img 를 쓴다.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={item.thumbnailUrl}
                        alt=""
                        loading="lazy"
                        className={styles.thumbImg}
                      />
                    ) : (
                      <span className={styles.thumbFallback}>
                        <Film size={16} strokeWidth={1.6} />
                      </span>
                    )}

                    <span className={styles.duration}>
                      {formatDuration(item.duration)}
                    </span>

                    {selected && (
                      <motion.span
                        className={styles.check}
                        initial={{ scale: 0.5, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
                      >
                        {selectedPaths.length > 1 ? order : <Check size={11} strokeWidth={3} />}
                      </motion.span>
                    )}
                  </span>

                  <span className={styles.meta}>
                    <span className={styles.name}>{item.originalName}</span>
                    <span className={styles.sub}>
                      {item.width && item.height
                        ? `${item.width}×${item.height}`
                        : formatSize(item.size)}
                    </span>
                  </span>
                </button>

                <button
                  type="button"
                  className={styles.deleteBtn}
                  onClick={() => onDelete(item)}
                  disabled={busyName === item.name}
                  aria-label={`${item.originalName} 삭제`}
                  title="라이브러리에서 삭제"
                >
                  <Trash2 size={11} strokeWidth={2} />
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </section>
  );
}
