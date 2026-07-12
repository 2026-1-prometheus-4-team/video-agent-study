// playerBridge.ts
// Player 는 시간에 대해 uncontrolled — ref 로 명령하고 이벤트로 구독한다.
// 프레임 상태를 zustand 에 넣으면 매 프레임 전체 재렌더가 나므로, 여기서
// 모듈 레벨 브리지 + useSyncExternalStore 훅으로 격리한다.
// (근거: remotion 공식 best practices — scratchpad/research/remotion-player.md)

"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { PlayerRef, CallbackListener } from "@remotion/player";

let playerRef: PlayerRef | null = null;
const refListeners = new Set<() => void>();

export function setPlayer(ref: PlayerRef | null) {
  playerRef = ref;
  for (const l of refListeners) l();
}

export function getPlayer(): PlayerRef | null {
  return playerRef;
}

/** ref 장착/해제 자체를 구독 (Player 마운트 후 이벤트 리스너 재부착용) */
export function usePlayerReady(): boolean {
  const subscribe = useCallback((cb: () => void) => {
    refListeners.add(cb);
    return () => {
      refListeners.delete(cb);
    };
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => playerRef !== null,
    () => false,
  );
}

/** 현재 프레임 구독. frameupdate 마다 이 훅을 쓴 컴포넌트만 재렌더. */
export function usePlayerFrame(): number {
  const subscribe = useCallback((onChange: () => void) => {
    const attach = () => {
      const p = playerRef;
      if (!p) return () => undefined;
      const updater: CallbackListener<"frameupdate"> = () => onChange();
      p.addEventListener("frameupdate", updater);
      return () => p.removeEventListener("frameupdate", updater);
    };
    let detach = attach();
    const onRefChange = () => {
      detach();
      detach = attach();
      onChange();
    };
    refListeners.add(onRefChange);
    return () => {
      detach();
      refListeners.delete(onRefChange);
    };
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => playerRef?.getCurrentFrame() ?? 0,
    () => 0,
  );
}

/** 재생 여부 구독 */
export function usePlayerPlaying(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const attach = () => {
      const p = playerRef;
      if (!p) return () => undefined;
      const onPlay: CallbackListener<"play"> = () => onChange();
      const onPause: CallbackListener<"pause"> = () => onChange();
      p.addEventListener("play", onPlay);
      p.addEventListener("pause", onPause);
      return () => {
        p.removeEventListener("play", onPlay);
        p.removeEventListener("pause", onPause);
      };
    };
    let detach = attach();
    const onRefChange = () => {
      detach();
      detach = attach();
      onChange();
    };
    refListeners.add(onRefChange);
    return () => {
      detach();
      refListeners.delete(onRefChange);
    };
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => playerRef?.isPlaying() ?? false,
    () => false,
  );
}

export function seekTo(frame: number) {
  playerRef?.seekTo(Math.max(0, Math.round(frame)));
}

// dev 전용 플레이헤드 제어 훅 — 브라우저 자동화(MCP) 시각 검증용. production 제외.
if (process.env.NODE_ENV === "development" && typeof window !== "undefined") {
  (window as unknown as { __seekTo?: typeof seekTo }).__seekTo = seekTo;
}

export function togglePlay(e?: Parameters<PlayerRef["toggle"]>[0]) {
  playerRef?.toggle(e);
}

export function pause() {
  playerRef?.pause();
}

export function play() {
  playerRef?.play();
}

/** 스크럽 패턴: pointerdown 때 재생 중이었다면 기억하고 pause, pointerup 때 재개 */
let wasPlayingBeforeScrub = false;
export function beginScrub() {
  wasPlayingBeforeScrub = playerRef?.isPlaying() ?? false;
  playerRef?.pause();
}
export function endScrub() {
  if (wasPlayingBeforeScrub) playerRef?.play();
  wasPlayingBeforeScrub = false;
}
