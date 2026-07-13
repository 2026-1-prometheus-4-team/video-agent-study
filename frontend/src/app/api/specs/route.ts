// GET /api/specs — specs 루트를 재귀 스캔해 spec 파일 목록 + 형태 분류를 준다.
// 서버 번들에 엔진(@engine/*)을 끌어오지 않기 위해 형태 분류는 여기서
// 자체 구현한다 (normalize.detectShape 와 동일 규칙 + "invalid" 추가).

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SPECS_ROOT = path.resolve(process.cwd(), "./remotion/src/specs");

type SpecShape = "video" | "scene" | "preset" | "invalid";

type SpecFileInfo = {
  path: string;
  shape: SpecShape;
  hasPresets: boolean;
};

// normalizeSpec 과 같은 순서로 검사: scenes 배열 -> video, preset 문자열 ->
// preset, elements 배열 -> scene. 그 외(파싱 실패 포함)는 invalid.
function classify(raw: unknown): { shape: SpecShape; hasPresets: boolean } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { shape: "invalid", hasPresets: false };
  }
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj.scenes)) {
    const hasPresets = obj.scenes.some(
      (s) =>
        s !== null &&
        typeof s === "object" &&
        typeof (s as Record<string, unknown>).preset === "string",
    );
    return { shape: "video", hasPresets };
  }
  if (typeof obj.preset === "string") return { shape: "preset", hasPresets: true };
  if (Array.isArray(obj.elements)) return { shape: "scene", hasPresets: false };
  return { shape: "invalid", hasPresets: false };
}

// 숨김 파일/디렉토리 제외하고 *.json 상대 경로 + 디렉토리 목록을 모은다.
// 디렉토리도 반환해야 빈 폴더가 라이브러리에 보인다(VSCode 식).
async function walk(
  dirAbs: string,
  rel: string,
  out: string[],
  dirs: string[],
): Promise<void> {
  const entries = await readdir(dirAbs, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      dirs.push(childRel);
      await walk(path.join(dirAbs, entry.name), childRel, out, dirs);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      out.push(childRel);
    }
  }
}

export async function GET() {
  const relPaths: string[] = [];
  const dirs: string[] = [];
  try {
    await walk(SPECS_ROOT, "", relPaths, dirs);
  } catch (err) {
    // specs 루트 자체가 없으면 빈 목록 (에디터는 빈 상태 UI 를 보여준다)
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ files: [], folders: [] });
    }
    return NextResponse.json({ error: "spec scan failed" }, { status: 500 });
  }

  relPaths.sort((a, b) => a.localeCompare(b));
  dirs.sort((a, b) => a.localeCompare(b));

  const files: SpecFileInfo[] = await Promise.all(
    relPaths.map(async (rel) => {
      try {
        const text = await readFile(path.join(SPECS_ROOT, rel), "utf8");
        return { path: rel, ...classify(JSON.parse(text)) };
      } catch {
        // 파싱 불가 파일도 목록에는 남긴다 (라이브러리에서 비활성 표시)
        return { path: rel, shape: "invalid" as const, hasPresets: false };
      }
    }),
  );

  return NextResponse.json({ files, folders: dirs });
}
