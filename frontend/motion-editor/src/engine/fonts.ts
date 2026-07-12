// fonts.ts
// 엔진(Root.tsx)이 스튜디오에서 로드하는 폰트 세트를 에디터 호스트에서 동일하게
// 로드한다. Root.tsx 는 delayRender/require.context 등 스튜디오 전용 부수효과가
// 있어 직접 import 하지 않고, 폰트 로딩만 여기로 미러링했다.
// General Sans OTF 는 public/fonts (remotion/public/fonts 심링크)에서 서빙.

"use client";

import { useEffect, useState } from "react";
import { loadFont as loadFamiljenGrotesk } from "@remotion/google-fonts/FamiljenGrotesk";
import { loadFont as loadSyne } from "@remotion/google-fonts/Syne";
import { loadFont as loadGeist } from "@remotion/google-fonts/Geist";

const GS_DIR = "/fonts/GeneralSans_Complete/Fonts/OTF";
const GS_WEIGHTS: [string, number][] = [
  ["GeneralSans-Extralight.otf", 200],
  ["GeneralSans-Light.otf", 300],
  ["GeneralSans-Regular.otf", 400],
  ["GeneralSans-Medium.otf", 500],
  ["GeneralSans-Semibold.otf", 600],
  ["GeneralSans-Bold.otf", 700],
];

let started = false;
let ready = false;
const waiters: Array<() => void> = [];

async function loadAll(): Promise<void> {
  // Google fonts (엔진과 동일 서브셋/웨이트)
  loadFamiljenGrotesk("normal", { weights: ["400", "500", "600", "700"] });
  loadSyne("normal", { weights: ["500", "600", "700", "800"] });
  loadGeist("normal", { weights: ["400", "500", "600", "700"] });

  // General Sans — static OTF per weight (variable TTF 는 애니 중 hinting 흔들림)
  await Promise.all(
    GS_WEIGHTS.map(([file, wt]) =>
      new FontFace("General Sans", `url(${GS_DIR}/${file}) format("opentype")`, {
        weight: String(wt),
      })
        .load()
        .then((f) => {
          document.fonts.add(f);
        })
        .catch(() => {
          // 폰트 하나 실패해도 에디터는 계속 뜬다 (폴백 폰트로 렌더)
        }),
    ),
  );
}

export function ensureEngineFonts(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (ready) return Promise.resolve();
  if (!started) {
    started = true;
    void loadAll().then(() => {
      ready = true;
      for (const w of waiters.splice(0)) w();
    });
  }
  return new Promise((res) => {
    if (ready) res();
    else waiters.push(res);
  });
}

export function useEngineFonts(): boolean {
  const [ok, setOk] = useState(ready);
  useEffect(() => {
    let alive = true;
    void ensureEngineFonts().then(() => {
      if (alive) setOk(true);
    });
    return () => {
      alive = false;
    };
  }, []);
  return ok;
}
