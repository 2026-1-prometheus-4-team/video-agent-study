// POST /api/specs/rename — 파일/폴더 이름 변경 (specs 루트 안 rename).
// body: { from: string; to: string } (둘 다 specs 루트 상대 경로)
// 파일은 .json 강제, 대상 존재 시 409. rename 은 원자적.

import { rename, stat, access } from "node:fs/promises";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SPECS_ROOT = path.resolve(process.cwd(), "../remotion/src/specs");

function resolveSafe(rel: string | null): string | null {
  if (!rel) return null;
  const abs = path.resolve(SPECS_ROOT, rel);
  const relCheck = path.relative(SPECS_ROOT, abs);
  if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) return null;
  return abs;
}

async function exists(abs: string): Promise<boolean> {
  try {
    await access(abs);
    return true;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  let body: { from?: string; to?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const from = resolveSafe(body.from ?? null);
  const to = resolveSafe(body.to ?? null);
  if (!from || !to) return NextResponse.json({ error: "invalid path" }, { status: 400 });
  if (from === to) return NextResponse.json({ ok: true });
  if (!(await exists(from))) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (await exists(to)) return NextResponse.json({ error: "already exists" }, { status: 409 });
  try {
    const isDir = (await stat(from)).isDirectory();
    if (!isDir && !to.endsWith(".json")) return NextResponse.json({ error: "file must end with .json" }, { status: 400 });
    await rename(from, to);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "rename failed" }, { status: 500 });
  }
}
