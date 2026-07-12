// GET /api/reference — 레퍼런스 영상 목록(카테고리별). public/reference(심링크 ->
// scene24/reference)를 스캔한다. 영상은 /reference/<cat>/<file> 로 정적 서빙됨.

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REF_ROOT = path.resolve(process.cwd(), "public/reference");
const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".m4v"]);

type RefVideo = { name: string; category: string; url: string; rel: string };

async function walk(dirAbs: string, rel: string, out: RefVideo[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    // 심링크 디렉터리(public/reference/<cat> -> scene24/reference/<cat>)는
    // Dirent.isDirectory() 가 false — stat 으로 판정해야 카테고리가 잡힌다.
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      try {
        isDir = (await stat(path.join(dirAbs, entry.name))).isDirectory();
      } catch {
        continue;
      }
    }
    if (isDir) {
      await walk(path.join(dirAbs, entry.name), childRel, out);
    } else if (VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) {
      const category = rel || "기타";
      const name = entry.name.replace(/\.[^.]+$/, "");
      out.push({ name, category, url: `/reference/${childRel}`, rel: childRel });
    }
  }
}

export async function GET() {
  const videos: RefVideo[] = [];
  await walk(REF_ROOT, "", videos);
  videos.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  return NextResponse.json({ videos });
}
