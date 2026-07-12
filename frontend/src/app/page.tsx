"use client";

import dynamic from "next/dynamic";

// Video Agent Studio — 채팅으로 영상을 편집하는 제품 UI (프로젝트 메인 화면).
// 모션 그래픽 세부 편집은 /motion (에디터) 로 넘긴다.
const StudioShell = dynamic(() => import("@/studio/StudioShell"), {
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
      loading studio...
    </div>
  ),
});

export default function Page() {
  return <StudioShell />;
}
