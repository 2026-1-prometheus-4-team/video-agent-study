// /api/engine-public/[...path] — 엔진(labs/remotion/public) 정적 에셋 폴백.
// 스펙 JSON 이 staticFile 이름("cap-....png")으로 public 에셋을 참조하면 플레이어는
// "/<이름>" 을 요청하는데, 에디터 Next 서버엔 그 파일이 없어 404 가 났다(실측:
// decompose-demo 이미지 404). next.config 의 afterFiles rewrite 가 에디터 public 에
// 없는 요청을 이 라우트로 넘기고, 여기서 엔진 public 을 읽어 서빙한다.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ENGINE_PUBLIC = path.resolve(process.cwd(), "./remotion/public");

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".otf": "font/otf",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  // 3D 모델/디코더 (device 요소)
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".wasm": "application/wasm",
  ".js": "text/javascript",
};

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const { path: segs } = await ctx.params;
  const rel = (segs ?? []).join("/");
  // 경로 탈출 방지 — 엔진 public 밖 접근 금지.
  const abs = path.resolve(ENGINE_PUBLIC, rel);
  if (!abs.startsWith(ENGINE_PUBLIC + path.sep)) {
    return new NextResponse("forbidden", { status: 403 });
  }
  const ext = path.extname(abs).toLowerCase();
  const mime = MIME[ext];
  if (!mime) return new NextResponse("not found", { status: 404 });
  try {
    const buf = await readFile(abs);
    return new NextResponse(new Uint8Array(buf), {
      headers: { "content-type": mime, "cache-control": "no-cache" },
    });
  } catch {
    return new NextResponse("not found", { status: 404 });
  }
}
