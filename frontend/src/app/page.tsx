"use client";

import dynamic from "next/dynamic";

// Video Agent Studio — 채팅으로 영상을 편집하는 제품 UI.
// v2: studio-v2/ 새 컴포넌트 (모션 · 스트리밍 · 반응형 · 미니멀).
const StudioShell = dynamic(
  () => import("@/studio-v2/StudioShell").then((m) => m.StudioShell),
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
        studio 로드 중…
      </div>
    ),
  }
);

export default function Page() {
  return <StudioShell />;
}
