// /api/ai/sfx — ElevenLabs Sound Effects 로 효과음 생성.
// POST { prompt, durationSec? } -> { url, name }

import { NextResponse, type NextRequest } from "next/server";
import { elevenKey, elevenPost, saveAudioAsset, keyMissingResponse, errorResponse } from "../lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!elevenKey()) return keyMissingResponse();
  try {
    const { prompt, durationSec } = (await req.json()) as { prompt?: string; durationSec?: number };
    if (!prompt?.trim()) return NextResponse.json({ error: "prompt required" }, { status: 400 });
    const body: Record<string, unknown> = { text: prompt.trim() };
    // 미지정이면 모델이 적정 길이를 고른다 (0.5~30s 범위만 유효)
    if (durationSec != null && durationSec > 0) {
      body.duration_seconds = Math.max(0.5, Math.min(30, durationSec));
    }
    const audio = await elevenPost("/v1/sound-generation?output_format=mp3_44100_128", body);
    const url = await saveAudioAsset(audio, `sfx-${prompt.trim().slice(0, 24)}`);
    return NextResponse.json({ url, name: prompt.trim().slice(0, 40) });
  } catch (e) {
    return errorResponse(e);
  }
}
