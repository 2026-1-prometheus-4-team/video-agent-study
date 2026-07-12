// /api/export — 현재 스펙을 Remotion CLI 로 렌더하는 잡 러너.
// POST { compId, codec, crf?, scale } -> { job } / GET ?job=<id> -> 진행 상태.
// 렌더는 엔진 패키지(cwd=labs/remotion)에서 `npx remotion render` 로 수행 —
// 에디터 프리뷰와 동일한 코드 경로(스펙 -> Ad 컴포지션)라 결과가 일치한다.

import { spawn } from "node:child_process";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ENGINE = path.resolve(process.cwd(), "../remotion");

type Job = {
  progress: number; // 0..1 (프레임 파싱 실패 시 -1 = 불확정)
  /** prepare = npx/번들링(첫 진행 로그 전 — 첫 실행은 10~20s 걸림), render = 프레임 진행 중 */
  stage: "prepare" | "render";
  cur?: number; // 진행 프레임 (표시용)
  total?: number;
  done: boolean;
  error?: string;
  file?: string; // out/exports/ 상대 파일명
  log: string;
};
// dev HMR 이 라우트 모듈을 재평가해도 진행 중 잡이 살아남게 globalThis 에
// 보존 (실측: 재컴파일 순간 맵이 비워져 폴링이 404 루프에 빠짐).
const jobs: Map<string, Job> = ((globalThis as { __exportJobs?: Map<string, Job> }).__exportJobs ??= new Map());

const EXT: Record<string, string> = { h264: "mp4", h265: "mp4", vp9: "webm", prores: "mov", gif: "gif" };

export async function POST(req: Request) {
  const body = (await req.json()) as { compId?: string; codec?: string; crf?: number; scale?: number };
  const compId = (body.compId ?? "").replace(/[^a-zA-Z0-9-_/]/g, "");
  const codec = EXT[body.codec ?? ""] ? (body.codec as string) : "h264";
  if (!compId) return NextResponse.json({ error: "compId required" }, { status: 400 });

  const id = Math.random().toString(36).slice(2, 10);
  const fileName = `${compId.replace(/\//g, "_")}-${Date.now()}.${EXT[codec]}`;
  const outRel = path.join("out", "exports", fileName);
  await mkdir(path.join(ENGINE, "out", "exports"), { recursive: true });

  const args = ["remotion", "render", compId, outRel, `--codec=${codec}`, "--overwrite"];
  if (body.scale && body.scale !== 1) args.push(`--scale=${body.scale}`);
  if (typeof body.crf === "number" && (codec === "h264" || codec === "h265" || codec === "vp9")) args.push(`--crf=${Math.round(body.crf)}`);

  const job: Job = { progress: -1, stage: "prepare", done: false, log: "" };
  jobs.set(id, job);

  const child = spawn("npx", args, { cwd: ENGINE, env: { ...process.env, CI: "true" } });
  const onChunk = (buf: Buffer) => {
    const s = buf.toString();
    job.log = (job.log + s).slice(-4000);
    // Remotion CLI 진행 표기: "Rendered 123/240" / "123/240 frames"
    const m = [...s.matchAll(/(\d+)\/(\d+)/g)].pop();
    if (m) {
      const cur = parseInt(m[1], 10);
      const total = parseInt(m[2], 10);
      if (total > 0 && cur <= total) {
        job.progress = cur / total;
        job.stage = "render"; // 첫 프레임 진행 로그 = 번들링 끝
        job.cur = cur;
        job.total = total;
      }
    }
  };
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);
  child.on("close", (code) => {
    job.done = true;
    if (code === 0) {
      job.progress = 1;
      job.file = fileName;
    } else {
      job.error = `render exited with code ${code}`;
    }
  });
  child.on("error", (e) => {
    job.done = true;
    job.error = String(e);
  });

  return NextResponse.json({ job: id });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("job") ?? "";
  const job = jobs.get(id);
  if (!job) return NextResponse.json({ error: "unknown job" }, { status: 404 });
  return NextResponse.json({ progress: job.progress, stage: job.stage, cur: job.cur, total: job.total, done: job.done, error: job.error, file: job.file, log: job.error ? job.log.slice(-1200) : undefined });
}
