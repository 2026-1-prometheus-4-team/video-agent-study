"use client";

// imageInsert — 이미지/영상/로고 붙여넣기·드롭·업로드 공용 경로.
// 세 진입점(⌘V 붙여넣기 / 캔버스 드롭 / 독 버튼)이 전부 insertMediaFromFile 하나를 탄다.
// 파일 타입으로 image → image 요소, video → video 요소로 라우팅.
//
// 스토리지 무관: uploadAsset 은 파일을 POST /api/assets 로 올리고 URL 만 받는다.
// (지금은 로컬 public/assets. scene24 이식 시 route 구현만 R2 로 갈아끼우면 됨.)

import { useEditor } from "./store";
import { getElement } from "@/editor/specPath";
import { addImageElement, addVideoElement } from "./mutations";
import { COMP_W, COMP_H } from "./canvas/PlayerCanvas";

// 파일을 업로드하고 URL 을 돌려준다. 계약: 파일 POST → { url }.
export async function uploadAsset(file: File | Blob, filename?: string): Promise<string> {
  const name =
    filename ??
    (file instanceof File && file.name
      ? file.name
      : `paste-${Date.now()}-${Math.round(Math.random() * 1e6)}.${extFromType(file.type)}`);
  const fd = new FormData();
  fd.append("file", file, name);
  const res = await fetch("/api/assets", { method: "POST", body: fd });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  const data = (await res.json()) as { url?: string };
  if (!data?.url) throw new Error("upload: no url");
  return data.url;
}

function extFromType(type: string): string {
  const t = type || "";
  const img = /image\/(png|jpeg|jpg|webp|gif|svg\+xml|avif)/.exec(t);
  if (img) return img[1] === "svg+xml" ? "svg" : img[1] === "jpeg" ? "jpg" : img[1];
  const vid = /video\/(mp4|webm|quicktime|ogg)/.exec(t);
  if (vid) return vid[1] === "quicktime" ? "mov" : vid[1];
  return "png";
}

// 미디어 파일의 가로/세로 비율(w/h). 이미지/영상 모두. 실패/불명 시 16/9.
function mediaAspect(file: File | Blob): Promise<number> {
  const isVideo = file.type?.startsWith("video/");
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    if (isVideo) {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => {
        const a = v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 16 / 9;
        URL.revokeObjectURL(url);
        resolve(a > 0 ? a : 16 / 9);
      };
      v.onerror = () => { URL.revokeObjectURL(url); resolve(16 / 9); };
      v.src = url;
    } else {
      const img = new Image();
      img.onload = () => {
        const a = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1;
        URL.revokeObjectURL(url);
        resolve(a > 0 ? a : 1);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(1); };
      img.src = url;
    }
  });
}

// 비율대로 초기 크기(vw/vh) 계산 — 폭 기준, 너무 크면 높이 제한.
function sizeForAspect(aspect: number, baseWidthVw: number): { width: number; height: number } {
  const ratio = COMP_W / COMP_H;
  let widthVw = baseWidthVw;
  let heightVh = (widthVw * ratio) / aspect;
  const MAXH = 82;
  if (heightVh > MAXH) {
    heightVh = MAXH;
    widthVw = (MAXH * aspect) / ratio;
  }
  return { width: Math.round(widthVw * 10) / 10, height: Math.round(heightVh * 10) / 10 };
}

/** 이미지/영상 파일 하나를 현재(또는 지정) 씬에 요소로 삽입. 타입으로 라우팅.
 *  Finder 복사 파일 등 type 이 비면 확장자로 판별. */
export async function insertMediaFromFile(
  file: File | Blob,
  sceneIdx?: number,
): Promise<void> {
  const name = file instanceof File ? file.name : "";
  const isImage =
    file.type?.startsWith("image/") ||
    (!file.type && /\.(png|jpe?g|webp|gif|svg|avif|heic)$/i.test(name));
  const isVideo =
    file.type?.startsWith("video/") ||
    (!file.type && /\.(mp4|webm|mov|m4v|ogg)$/i.test(name));
  if (!isImage && !isVideo) return;
  const aspect = await mediaAspect(file);
  const url = await uploadAsset(file);
  const si = sceneIdx ?? useEditor.getState().activeScene;
  // Figma 로직: frame(크롬 목업 포함)이 선택돼 있으면 그 "안"으로 — 스크린을
  // 채우는 자식으로 들어간다 (목업 UI 채우기 워크플로우).
  const st = useEditor.getState();
  const sel = st.selection;
  const selEl = sel.length === 1 && st.doc ? getElement(st.doc, sel[0]) : null;
  if (selEl && (selEl as { element?: string }).element === "frame") {
    const kind = isVideo ? "video" : "image";
    st.updateDoc(`insert ${kind} into frame`, (draft) => {
      const fr = getElement(draft, sel[0]) as { children?: unknown[] } | null;
      if (!fr) return;
      if (!Array.isArray(fr.children)) fr.children = [];
      fr.children.push({
        element: kind,
        id: `${kind}-${fr.children.length + 1}`,
        base: { src: url, width: 100, height: 100, position: { x: 0.5, y: 0.5 }, fit: "cover" },
      });
    });
    return;
  }
  if (isVideo) {
    const { width, height } = sizeForAspect(aspect, 55); // 영상은 크게(배경 관례)
    addVideoElement(si, { src: url, width, height });
  } else {
    const { width, height } = sizeForAspect(aspect, 34);
    addImageElement(si, { src: url, width, height });
  }
}

/** 파일 선택 다이얼로그를 열어 이미지/영상을 삽입 (독 버튼용). */
export function pickAndInsertMedia(sceneIdx?: number): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept =
    "image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/avif,video/mp4,video/webm,video/quicktime";
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) void insertMediaFromFile(f, sceneIdx);
  };
  input.click();
}
