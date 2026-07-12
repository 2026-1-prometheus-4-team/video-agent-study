"use client";

// ScenePlayheadSync — 재생헤드가 들어간 씬을 활성 씬으로 따라가게 한다.
// 이전엔 activeScene 이 "씬 카드 클릭"으로만 바뀌어서, 재생 중 영상은 다음 씬으로
// 넘어가도 하단 타임라인(눈금·요소 행·카메라 트랙)은 이전 씬에 멈춰 있었다.
// 프레임의 순수 함수(frameToScene)로 씬을 계산해 경계를 넘을 때만 setActiveScene.
// 렌더 비용 격리를 위해 화면엔 아무것도 안 그리는 null 컴포넌트로 분리(매 프레임
// 리렌더가 타임라인 전체가 아니라 이 노드에만 국한됨).

import React from "react";
import { useEditor } from "@/editor/store";
import { usePlayerFrame } from "@/editor/playerBridge";
import { frameToScene } from "@/editor/timing";
import { FPS } from "@/engine/normalize";

export default function ScenePlayheadSync() {
  const frame = usePlayerFrame();
  const doc = useEditor((s) => s.doc);
  const activeScene = useEditor((s) => s.activeScene);
  const setActiveScene = useEditor((s) => s.setActiveScene);

  React.useEffect(() => {
    if (!doc || !doc.scenes || doc.scenes.length <= 1) return;
    const { sceneIdx } = frameToScene(doc, FPS, Math.round(frame));
    if (sceneIdx !== activeScene) setActiveScene(sceneIdx);
  }, [frame, doc, activeScene, setActiveScene]);

  return null;
}
