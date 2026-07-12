"use client";

import dynamic from "next/dynamic";

// 에디터 전체는 클라이언트 전용(remotion Player + window 의존).
const EditorShell = dynamic(() => import("@/editor/EditorShell"), {
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
      loading editor...
    </div>
  ),
});

export default function Page() {
  return <EditorShell />;
}
