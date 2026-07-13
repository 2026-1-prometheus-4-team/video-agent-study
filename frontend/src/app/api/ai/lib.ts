// /api/ai 공용 — ElevenLabs 호출 + 생성 오디오를 에셋으로 저장.
// 키는 .env.local 의 ELEVENLABS_API_KEY 만 사용 (코드/응답에 노출 금지).
// 생성물은 업로드 에셋과 동일하게 public/assets + remotion 미러에 저장해
// 프리뷰와 익스포트가 같은 경로(/assets/...)를 본다.

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const ASSETS_DIR = path.resolve(process.cwd(), "public/assets");
const RENDER_ASSETS_DIR = path.resolve(process.cwd(), "./remotion/public/assets");

export const ELEVEN_BASE = "https://api.elevenlabs.io";

export function elevenKey(): string | null {
  return process.env.ELEVENLABS_API_KEY || null;
}

export function keyMissingResponse(): Response {
  return Response.json(
    { error: "ELEVENLABS_API_KEY not set — add it to motion-editor/.env.local and restart the dev server" },
    { status: 500 },
  );
}

/** ElevenLabs POST — 성공 시 오디오 바이너리, 실패 시 에러 텍스트를 던진다 */
export async function elevenPost(pathname: string, body: unknown): Promise<ArrayBuffer> {
  const res = await fetch(`${ELEVEN_BASE}${pathname}`, {
    method: "POST",
    headers: { "xi-api-key": elevenKey()!, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw new Error(`ElevenLabs ${res.status}: ${detail}`);
  }
  return res.arrayBuffer();
}

/** 생성 오디오 저장 — 이름 충돌 방지 타임스탬프 접미사, 두 에셋 dir 미러 */
export async function saveAudioAsset(audio: ArrayBuffer, baseName: string): Promise<string> {
  const safe = baseName.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_").slice(0, 40) || "audio";
  const name = `${safe}-${Date.now().toString(36)}.mp3`;
  const buf = Buffer.from(audio);
  await mkdir(ASSETS_DIR, { recursive: true });
  await mkdir(RENDER_ASSETS_DIR, { recursive: true });
  await writeFile(path.join(ASSETS_DIR, name), buf);
  await writeFile(path.join(RENDER_ASSETS_DIR, name), buf);
  return `/assets/${name}`;
}

export function errorResponse(e: unknown): Response {
  return Response.json({ error: String((e as Error).message ?? e) }, { status: 502 });
}
