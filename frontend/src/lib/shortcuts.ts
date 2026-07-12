/**
 * 전역 키보드 단축키 프리셋 (react-hotkeys-hook 활용).
 *
 * 각 컴포넌트는 여기 상수를 참조하고, useHotkeys(SHORTCUT.X, handler) 로 등록.
 * label 상수도 UI hint 에 재사용해서 문서와 실제 바인딩 어긋나지 않게.
 */

export const SHORTCUT = {
  /** ⌘K — 커맨드 팔레트 열기 */
  commandPalette: "meta+k, ctrl+k",
  /** ⌘⏎ — 채팅 전송 / interrupt 승인 */
  submit: "meta+enter, ctrl+enter",
  /** Esc — 오버레이 / 팔레트 / drawer 닫기 */
  dismiss: "esc",
  /** Space — 프리뷰 재생/일시정지 */
  playPause: "space",
  /** ⌘B — 사이드바 접기/펼치기 */
  toggleSidebar: "meta+b, ctrl+b",
  /** F — 피드백 요청 (interrupt 승인 대신 수정 요청) */
  requestFeedback: "f",
  /** ⌘1, ⌘2, ⌘3 — Empty state 예시 프롬프트 즉시 실행 */
  quickPrompt1: "meta+1, ctrl+1",
  quickPrompt2: "meta+2, ctrl+2",
  quickPrompt3: "meta+3, ctrl+3",
  /** ← → — 프리뷰 프레임 스크럽 */
  frameBack: "left",
  frameForward: "right",
  /** ⌘L — theme toggle (다크 <> 라이트) */
  toggleTheme: "meta+shift+l, ctrl+shift+l",
} as const;

/** UI 에 노출하는 shortcut 라벨 (mac / win 자동 표기) */
export const SHORTCUT_LABEL = {
  commandPalette: "⌘K",
  submit: "⌘↵",
  dismiss: "Esc",
  playPause: "Space",
  toggleSidebar: "⌘B",
  requestFeedback: "F",
  quickPrompt1: "⌘1",
  quickPrompt2: "⌘2",
  quickPrompt3: "⌘3",
  frameBack: "←",
  frameForward: "→",
  toggleTheme: "⌘⇧L",
} as const;

/** OS 감지 후 win/linux 에선 ⌘ → Ctrl 로 자동 치환 */
export function osShortcutLabel(key: keyof typeof SHORTCUT_LABEL): string {
  if (typeof window === "undefined") return SHORTCUT_LABEL[key];
  const isMac = /Mac|iPhone|iPad|iPod/.test(window.navigator.platform);
  if (isMac) return SHORTCUT_LABEL[key];
  return SHORTCUT_LABEL[key]
    .replace(/⌘/g, "Ctrl")
    .replace(/↵/g, "Enter")
    .replace(/⇧/g, "Shift");
}
