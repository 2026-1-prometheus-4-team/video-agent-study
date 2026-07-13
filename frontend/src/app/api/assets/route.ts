// /api/assets — 이미지/영상 에셋 업로드 + 목록. public/assets 에 저장(=/assets/… 서빙).
//   GET       -> { assets: [{ name, url, kind }] }
//   POST form(file) -> { ok, url }

import { readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ASSETS_DIR = path.resolve(process.cwd(), "public/assets");
// 렌더(remotion 번들)는 remotion/public 에서 에셋을 찾는다 — 여기에도 미러
// 저장 (안 하면 에디터 프리뷰는 되고 익스포트만 404 -> MEDIA Format error).
const RENDER_ASSETS_DIR = path.resolve(process.cwd(), "./remotion/public/assets");
const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".avif"]);
const VID_EXT = new Set([".mp4", ".mov", ".webm", ".m4v"]);
const AUD_EXT = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg"]);

export async function GET() {
  try {
    const entries = await readdir(ASSETS_DIR, { withFileTypes: true });
    const assets = entries
      .filter((e) => e.isFile() && !e.name.startsWith("."))
      .map((e) => {
        const ext = path.extname(e.name).toLowerCase();
        const kind = IMG_EXT.has(ext) ? "image" : VID_EXT.has(ext) ? "video" : AUD_EXT.has(ext) ? "audio" : null;
        return kind ? { name: e.name, url: `/assets/${e.name}`, kind } : null;
      })
      .filter(Boolean);
    return NextResponse.json({ assets });
  } catch {
    return NextResponse.json({ assets: [] });
  }
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "no file" }, { status: 400 });
    }
    const ext = path.extname(file.name).toLowerCase();
    if (!IMG_EXT.has(ext) && !VID_EXT.has(ext) && !AUD_EXT.has(ext)) {
      return NextResponse.json({ error: "unsupported type" }, { status: 400 });
    }
    // 안전한 파일명 (충돌 시 접미사 없이 덮어씀 — 같은 이름이면 교체)
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    await mkdir(ASSETS_DIR, { recursive: true });
    await mkdir(RENDER_ASSETS_DIR, { recursive: true });
    const buf = Buffer.from(await file.arrayBuffer());
    await writeFile(path.join(ASSETS_DIR, safe), buf);
    await writeFile(path.join(RENDER_ASSETS_DIR, safe), buf);
    return NextResponse.json({ ok: true, url: `/assets/${safe}` });
  } catch {
    return NextResponse.json({ error: "upload failed" }, { status: 500 });
  }
}
