// /api/export/file?f=<name> — 렌더 산출물 다운로드 (out/exports 한정).

import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXPORTS = path.resolve(process.cwd(), "../remotion/out/exports");

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".gif": "image/gif",
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const f = url.searchParams.get("f") ?? "";
  const full = path.resolve(EXPORTS, f);
  if (!full.startsWith(EXPORTS + path.sep)) return NextResponse.json({ error: "bad path" }, { status: 400 });
  try {
    const buf = await readFile(full);
    const ext = path.extname(full).toLowerCase();
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": MIME[ext] ?? "application/octet-stream",
        "Content-Disposition": `attachment; filename="${path.basename(full)}"`,
      },
    });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
