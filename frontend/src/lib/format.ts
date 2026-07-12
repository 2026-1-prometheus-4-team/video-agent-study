/**
 * 포맷팅 헬퍼 — 시간, 상대시간, 파일 크기.
 * date-fns 를 활용해서 한국어 로케일 지원.
 */

import { formatDistanceToNowStrict } from "date-fns";
import { ko } from "date-fns/locale";

/**
 * 초 (float) → mm:ss.f 형식.
 * 예: 12.4 → "0:12.4", 125.7 → "2:05.7"
 * 타임라인 ruler 나 tool_call 지속시간 표시에 사용.
 */
export function formatSeconds(sec: number, showTenths = true): string {
  if (!Number.isFinite(sec) || sec < 0) return showTenths ? "0:00.0" : "0:00";
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  if (!showTenths) {
    return `${m}:${Math.floor(s).toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

/**
 * ms 단위 → 사람 친화적 지속시간.
 * 예: 320 → "320ms", 1200 → "1.2s", 62_000 → "1:02"
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return formatSeconds(ms / 1000, false);
}

/**
 * 상대 시간 (한국어). "3초 전", "1분 전" 등.
 * date-fns 의 formatDistanceToNowStrict + ko 로케일.
 */
export function formatRelativeTime(date: Date | number): string {
  const d = typeof date === "number" ? new Date(date) : date;
  return formatDistanceToNowStrict(d, { locale: ko, addSuffix: true });
}

/**
 * 파일 크기 (bytes) → 사람 친화적.
 * 예: 1024 → "1 KB", 1_234_567 → "1.2 MB"
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let value = bytes;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const rounded = i === 0 ? value : value.toFixed(value >= 10 ? 0 : 1);
  return `${rounded} ${units[i]}`;
}

/**
 * 숫자 압축 표기. 1_234 → "1.2K", 12_345 → "12K", 1_234_567 → "1.2M"
 */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs < 1000) return `${sign}${abs}`;
  if (abs < 1_000_000) {
    const v = abs / 1000;
    return `${sign}${v >= 10 ? Math.round(v) : v.toFixed(1)}K`;
  }
  const v = abs / 1_000_000;
  return `${sign}${v >= 10 ? Math.round(v) : v.toFixed(1)}M`;
}
