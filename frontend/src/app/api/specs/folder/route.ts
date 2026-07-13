// POST /api/specs/folder?path=<rel> — specs 루트 밑에 폴더 생성(mkdir -p).
// VSCode 식 폴더 만들기. 빈 폴더도 라이브러리에 뜨도록 GET /api/specs 가 dir 도 반환.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SPECS_ROOT = path.resolve(process.cwd(), "./remotion/src/specs");

function resolveSafe(rel: string | null): string | null {
  if (!rel) return null;
  const abs = path.resolve(SPECS_ROOT, rel);
  const relCheck = path.relative(SPECS_ROOT, abs);
  if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) return null;
  return abs;
}

export async function POST(req: NextRequest) {
  const abs = resolveSafe(req.nextUrl.searchParams.get("path"));
  if (!abs) return NextResponse.json({ error: "invalid path" }, { status: 400 });
  try {
    await mkdir(abs, { recursive: true });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "mkdir failed" }, { status: 500 });
  }
}
