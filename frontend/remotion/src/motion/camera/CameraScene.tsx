// CameraScene — 범용 카메라 래퍼(Type D). 아무 씬(children)이나 감싸서 우리 shot
// 카메라(shots.ts)를 입힌다. 프리셋 <Ad>, 캡쳐 씬, 커스텀 무엇이든 카메라 무빙
// (pushIn/pullBack/pan/drift/spotlight/heroPan/still) 적용 가능 — "모든 씬에 카메라".
// children 은 컴포지션 크기로 그려지고, 카메라가 그 위를 translate+scale 로 훑는다.
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { planShots, resolveCamera, resolveTransform, type Shot, type ShotCtx } from "../../captured/shots";

export const CameraScene: React.FC<{
  shots: Shot[];
  background?: string;
  width?: number;
  height?: number;
  children: React.ReactNode;
}> = ({ shots, background, width, height, children }) => {
  const frame = useCurrentFrame();
  const cfg = useVideoConfig();
  const W = width ?? cfg.width;
  const H = height ?? cfg.height;
  // 범용 무브만 쓰면 input/send 는 안 쓰이므로 중앙으로 채운 더미 ctx.
  const ctx: ShotCtx = {
    capW: W, capH: H,
    inputLeft: W / 2, inputCY: H / 2,
    sendCenter: { x: W / 2, y: H / 2 },
    caretAt: () => W / 2, caretFullX: W / 2,
  };
  const plan = planShots(shots, ctx);
  const cam = resolveCamera(frame, plan, ctx).cam;
  const transform = resolveTransform(cam, W, H);
  return (
    <AbsoluteFill style={{ background, overflow: "hidden" }}>
      {/* positioned 컨테이너라야 children 의 AbsoluteFill 이 이 div(=카메라 대상)를 채운다 */}
      <div style={{ position: "absolute", left: 0, top: 0, width: W, height: H, transformOrigin: "0 0", transform, willChange: "transform", backfaceVisibility: "hidden" }}>
        {children}
      </div>
    </AbsoluteFill>
  );
};
