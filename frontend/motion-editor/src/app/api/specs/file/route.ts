// /api/specs/file — 개별 spec 파일 읽기/쓰기/생성.
//   GET  ?path=rel      -> 파일 JSON
//   PUT  ?path=rel  body -> 덮어쓰기 (2-space pretty + trailing newline)
//   POST ?path=rel  body -> 새로 생성 (존재하면 409)
// 모든 경로는 SPECS_ROOT 안으로 제한 (traversal 방어).

import { readFile, writeFile, mkdir, access, rename } from "node:fs/promises";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SPECS_ROOT = path.resolve(process.cwd(), "../remotion/src/specs");

// rel 을 SPECS_ROOT 기준 절대경로로. 벗어나면 null.
function resolveSafe(rel: string | null): string | null {
  if (!rel || !rel.endsWith(".json")) return null;
  const abs = path.resolve(SPECS_ROOT, rel);
  const relCheck = path.relative(SPECS_ROOT, abs);
  if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) return null;
  return abs;
}

// 원자적 쓰기 — tmp 에 쓰고 rename. 직접 writeFile 은 다른 프로세스(외부 편집,
// dev 서버 리로드 중 read)와 경합하면 torn write 로 JSON 이 깨질 수 있다
// (실측: 유효 JSON 뒤에 이전 파일 꼬리가 남은 "Extra data" 파손).
async function writeAtomic(abs: string, data: string) {
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, abs);
}

async function exists(abs: string): Promise<boolean> {
  try {
    await access(abs);
    return true;
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest) {
  const abs = resolveSafe(req.nextUrl.searchParams.get("path"));
  if (!abs) return NextResponse.json({ error: "invalid path" }, { status: 400 });
  try {
    const text = await readFile(abs, "utf8");
    // 그대로 파싱해 돌려준다 (형태 유지 — 프리셋 씬도 원본 그대로).
    return new NextResponse(text, {
      headers: { "content-type": "application/json" },
    });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}

export async function PUT(req: NextRequest) {
  const abs = resolveSafe(req.nextUrl.searchParams.get("path"));
  if (!abs) return NextResponse.json({ error: "invalid path" }, { status: 400 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }
  try {
    await mkdir(path.dirname(abs), { recursive: true });
    await writeAtomic(abs, JSON.stringify(body, null, 2) + "\n");
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "write failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const abs = resolveSafe(req.nextUrl.searchParams.get("path"));
  if (!abs) return NextResponse.json({ error: "invalid path" }, { status: 400 });
  if (await exists(abs)) {
    return NextResponse.json({ error: "already exists" }, { status: 409 });
  }
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const skeleton = {
    fps: 24,
    brandDefaults: {
      background: "#0D0B10",
      fontFamily: "General Sans, Inter, Helvetica, Arial, sans-serif",
      colors: ["#7C4DFF", "#FF4D9D", "#4D7DFF"],
    },
    scenes: [{ id: "scene-1", duration: 2.5, elements: [] }],
  };
  try {
    await mkdir(path.dirname(abs), { recursive: true });
    await writeAtomic(abs, JSON.stringify(body ?? skeleton, null, 2) + "\n");
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "create failed" }, { status: 500 });
  }
}
