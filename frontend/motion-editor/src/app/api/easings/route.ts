// /api/easings — 사용자 정의 커스텀 이징 라이브러리(이름 붙인 cubic-bezier)를
// 영구 저장. 엔진 옆(../remotion/src/customEasings.json)에 저장해 나중에 엔진이
// import 해서 named 로 쓸 수도 있게(현재는 에디터가 spec 에 cubic() 문자열로 적용).
//   GET  -> { easings: [{ name, bezier: [x1,y1,x2,y2] }] }
//   PUT  { easings } -> 저장

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILE = path.resolve(process.cwd(), "../remotion/src/customEasings.json");

export async function GET() {
  try {
    const text = await readFile(FILE, "utf8");
    const parsed = JSON.parse(text);
    return NextResponse.json({ easings: Array.isArray(parsed.easings) ? parsed.easings : [] });
  } catch {
    return NextResponse.json({ easings: [] });
  }
}

export async function PUT(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const easings = (body as { easings?: unknown }).easings;
  if (!Array.isArray(easings)) {
    return NextResponse.json({ error: "easings must be array" }, { status: 400 });
  }
  try {
    await writeFile(FILE, JSON.stringify({ easings }, null, 2) + "\n", "utf8");
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "write failed" }, { status: 500 });
  }
}
