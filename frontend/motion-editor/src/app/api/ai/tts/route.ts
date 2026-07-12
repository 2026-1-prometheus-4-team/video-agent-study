// /api/ai/tts — ElevenLabs TTS 로 나레이션 생성.
// POST { text, voiceId } -> { url, name }
// 모델은 eleven_multilingual_v2 — 한국어 포함, 광고 나레이션 품질 기준점.

import { NextResponse, type NextRequest } from "next/server";
import { elevenKey, elevenPost, saveAudioAsset, keyMissingResponse, errorResponse } from "../lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!elevenKey()) return keyMissingResponse();
  try {
    const { text, voiceId } = (await req.json()) as { text?: string; voiceId?: string };
    if (!text?.trim()) return NextResponse.json({ error: "text required" }, { status: 400 });
    if (!voiceId) return NextResponse.json({ error: "voiceId required" }, { status: 400 });
    const audio = await elevenPost(
      `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      { text: text.trim(), model_id: "eleven_multilingual_v2" },
    );
    const url = await saveAudioAsset(audio, `vo-${text.trim().slice(0, 24)}`);
    return NextResponse.json({ url, name: text.trim().slice(0, 40) });
  } catch (e) {
    return errorResponse(e);
  }
}
