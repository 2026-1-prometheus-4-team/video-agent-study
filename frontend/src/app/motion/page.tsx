"use client";

import dynamic from "next/dynamic";

// 우리 프로젝트 전용 모션 에디터 — studio-v2 store 를 그대로 이어받아 편집.
// (예전 scene24 이식본 `editor/EditorShell` 은 이 라우트에서 더 이상 사용하지 않음.)
const MotionEditorShell = dynamic(
  () =>
    import("@/motion-editor/MotionEditorShell").then(
      (m) => m.MotionEditorShell
    ),
  {
    ssr: false,
    loading: () => (
      <div
        style={{
          height: "100vh",
          display: "grid",
          placeItems: "center",
          color: "var(--text-3)",
          fontSize: "var(--fs-12)",
        }}
      >
        editor 로드 중…
      </div>
    ),
  }
);

export default function Page() {
  return <MotionEditorShell />;
}
