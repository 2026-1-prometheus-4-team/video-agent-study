// /api/ai/voices — 나레이션 보이스 목록 (TTS 보이스 피커용).
// GET -> { voices: [{ id, name, labels }] }

import { NextResponse } from "next/server";
import { ELEVEN_BASE, elevenKey, keyMissingResponse, errorResponse } from "../lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!elevenKey()) return keyMissingResponse();
  try {
    const res = await fetch(`${ELEVEN_BASE}/v1/voices`, {
      headers: { "xi-api-key": elevenKey()! },
    });
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as {
      voices?: { voice_id: string; name: string; labels?: Record<string, string> }[];
    };
    const voices = (data.voices ?? []).slice(0, 50).map((v) => ({
      id: v.voice_id,
      name: v.name,
      labels: [v.labels?.gender, v.labels?.age, v.labels?.accent].filter(Boolean).join(" · "),
    }));
    return NextResponse.json({ voices });
  } catch (e) {
    return errorResponse(e);
  }
}
