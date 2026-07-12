"use client";

// PlayerCanvas — @remotion/player 에 엔진 Ad 를 태운다. 시간은 uncontrolled,
// playerBridge 로 명령/구독. inputProps 는 doc identity 로 memo (라이브 갱신).
// clickToPlay / spaceKey 는 끈다 — space 키는 단축키가 소유.

import React from "react";
import { Player, type PlayerRef } from "@remotion/player";
import { Ad, totalFrames, type VideoSpec } from "@engine/motion/SceneRenderer";
import { useEditor } from "@/editor/store";
import { setPlayer } from "@/editor/playerBridge";
import { useEngineFonts } from "@/engine/fonts";
import { FPS } from "@/engine/normalize";

// 모듈 레벨 컴포넌트 (인라인이면 매 렌더 remount). Player 의 component 로 넘긴다.
const SpecVideo: React.FC<{ spec: VideoSpec }> = ({ spec }) => <Ad spec={spec} />;

export const COMP_W = 1920;
export const COMP_H = 1080;

export function PlayerCanvas({ scale }: { scale: number }) {
  const doc = useEditor((s) => s.doc);
  const fontsReady = useEngineFonts();
  const ref = React.useRef<PlayerRef>(null);

  const inputProps = React.useMemo(() => ({ spec: doc as VideoSpec }), [doc]);
  const frames = React.useMemo(
    () => (doc ? Math.max(1, totalFrames(doc, FPS)) : 1),
    [doc],
  );

  React.useEffect(() => {
    setPlayer(ref.current);
    return () => setPlayer(null);
    // ref.current 가 채워진 뒤 등록되도록 doc/frames 변화에도 재확인
  }, [fontsReady]);

  if (!doc || !fontsReady) {
    return (
      <div
        style={{
          width: COMP_W * scale,
          height: COMP_H * scale,
          background: "#000",
          borderRadius: 4,
          display: "grid",
          placeItems: "center",
          color: "var(--text-4)",
          fontSize: "var(--fs-11)",
        }}
      >
        {doc ? "Loading fonts..." : "No spec"}
      </div>
    );
  }

  return (
    <Player
      ref={ref}
      component={SpecVideo}
      inputProps={inputProps}
      durationInFrames={frames}
      fps={FPS}
      compositionWidth={COMP_W}
      compositionHeight={COMP_H}
      style={{ width: COMP_W * scale, height: COMP_H * scale }}
      overflowVisible
      acknowledgeRemotionLicense
      clickToPlay={false}
      doubleClickToFullscreen={false}
      spaceKeyToPlayOrPause={false}
      loop
    />
  );
}
