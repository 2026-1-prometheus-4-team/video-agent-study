// /api/ai/music — ElevenLabs Music 으로 BGM 생성.
// POST { prompt, lengthMs, bpm? } -> { url, name }
// bpm 을 주면 프롬프트에 명시 — 모델이 거의 정확히 지키는 것을 실측 확인
// (148 요청 -> 147.7 검출). 클립의 bpm 필드는 클라이언트가 채운다.

import { NextResponse, type NextRequest } from "next/server";
import { elevenKey, elevenPost, saveAudioAsset, keyMissingResponse, errorResponse } from "../lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!elevenKey()) return keyMissingResponse();
  try {
    const { prompt, lengthMs, bpm } = (await req.json()) as { prompt?: string; lengthMs?: number; bpm?: number };
    if (!prompt?.trim()) return NextResponse.json({ error: "prompt required" }, { status: 400 });
    const ms = Math.max(3000, Math.min(600000, Math.round(lengthMs ?? 30000)));
    const full = bpm ? `${prompt.trim()}, ${Math.round(bpm)} bpm, steady tempo` : prompt.trim();
    const audio = await elevenPost("/v1/music?output_format=mp3_44100_128", {
      model_id: "music_v2",
      prompt: full,
      music_length_ms: ms,
      force_instrumental: true,
      store_for_inpainting: false,
      sign_with_c2pa: false,
    });
    const url = await saveAudioAsset(audio, `music-${prompt.trim().slice(0, 24)}`);
    return NextResponse.json({ url, name: prompt.trim().slice(0, 40), lengthMs: ms });
  } catch (e) {
    return errorResponse(e);
  }
}
