// pick-elements.mjs  — AI 디렉터(Set-of-Mark 비전).
// capture-lab 산출물(marked.png + candidates + pageTargets)을 Gemini 비전에 넣어
// "기획서(plan)"를 받는다: 입력/전송 grounding + 사이트에 맞는 모션 shot 시퀀스.
// 좌표는 번호->요소 매핑으로 우리가 가지고 있으므로 비전은 grounding 만 하면 된다.
//
//   tsx --env-file=.env scripts/pick-elements.mjs <capture-dir>
// 결과: <capture-dir>/plan.json
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error("GEMINI_API_KEY required (tsx --env-file=.env)"); process.exit(1); }
const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const dir = process.argv[2];
if (!dir) { console.error("usage: pick-elements.mjs <capture-dir>"); process.exit(1); }
const markedPath = join(dir, "marked.png");
const candPath = join(dir, "candidates.json");
const targPath = join(dir, "pageTargets.json");
for (const p of [markedPath, candPath]) {
  if (!existsSync(p)) { console.error(`missing ${p} (run capture.py first)`); process.exit(1); }
}

const candidates = JSON.parse(readFileSync(candPath, "utf8"));
const pageTargets = existsSync(targPath) ? JSON.parse(readFileSync(targPath, "utf8")) : [];
const imageB64 = readFileSync(markedPath).toString("base64");

const candList = candidates
  .map((c) => `  #${c.id}: <${c.tag}>${c.role ? ` role=${c.role}` : ""}${c.input ? " [input]" : ""}${c.isBox ? " [container]" : ""} text="${c.text}" ${c.relBox.w}x${c.relBox.h}`)
  .join("\n");
const targList = pageTargets
  .map((t) => `  ${t.id}: <${t.tag}> text="${t.text}" ${t.box.w}x${t.box.h}`)
  .join("\n") || "  (none)";

const systemPrompt = `You are a motion director for a short product ad built from a captured website. Red NUMBER badges mark interaction candidates inside the product's input UI; blue LETTER badges mark page-level camera targets (headline, hero images).

Output ONLY raw JSON, no fences:
{
  "input": <red number of the MAIN text field the user types into (textarea/textbox/contenteditable; NOT a dropdown/toggle)>,
  "send": <red number of the button that SUBMITS the prompt. Priority: (1) a button with an arrow icon (up/right) or text containing "Send"/"Submit"/"Send message" — usually the RIGHTMOST small square icon button in the input's control row; (2) otherwise the main primary action button such as "Build now" or "Generate". DO NOT pick secondary option/mode selectors ("Standard", "Plan", a model picker), and if a dedicated Send button exists, prefer it over a bare "Build" label. Use null only if there is truly no submit control.>,
  "typedText": "<short realistic prompt a user would type into THIS product; 3-8 words, lowercase, no quotes>",
  "shots": [ <shot>, ... ],
  "brand": {
    "name": "<the product/brand name read from the logo or headline, e.g. 'Lovable', 'v0'>",
    "tagline": "<a punchy 3-6 word marketing tagline for this product, lowercase>",
    "colors": ["<hex>", "<hex>", "<hex>"],   // 2-3 accent/brand colors sampled from the page
    "background": "<a dark hex for the outro background, e.g. #0B0A0E>"
  },
  "note": "<one short sentence>"
}

Shot vocabulary (each object: kind + durationInFrames at 24fps):
- {"kind":"hold","durationInFrames":N}                                     page-wide establishing pause
- {"kind":"spotlight","target":"<LETTER>","durationInFrames":N}            zoom-punch onto a page target, then hold
- {"kind":"heroPan","from":"<LETTER>","to":"<LETTER>","durationInFrames":N} slow drift between two targets
- {"kind":"focusInput","durationInFrames":N}                               zoom into the input box
- {"kind":"typeInto","durationInFrames":N}                                 type into the input (caret follows)
- {"kind":"panToSend","durationInFrames":N}                                pan from input to the send button
- {"kind":"clickFill","durationInFrames":N}                                click send, screen fills to transition out

Rules:
- The core interaction MUST appear in this order: focusInput -> typeInto -> (panToSend if send != null) -> clickFill.
- OPEN with variety chosen from the page. If a strong headline/hero target (LETTER) exists, start with a short hold then a spotlight (or heroPan) on it before focusInput. If the page is plain, just a short hold then focusInput. DO NOT always use the same opening across sites.
- typeInto duration ~ round(1.5 * typedText length), min 24.
- Total of all durationInFrames between 110 and 180.
- Reference only badge numbers/letters that exist below.`;

const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{
      role: "user",
      parts: [
        { text: `Interaction candidates (red numbers):\n${candList}\n\nPage camera targets (blue letters):\n${targList}\n\nThe screenshot with matching badges:` },
        { inlineData: { mimeType: "image/png", data: imageB64 } },
      ],
    }],
    generationConfig: { temperature: 0.6, responseMimeType: "application/json" },
  }),
});
if (!res.ok) { console.error(`Gemini error ${res.status}: ${await res.text()}`); process.exit(1); }
const data = await res.json();
const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
if (!text) { console.error("empty response"); process.exit(1); }

let plan;
try { plan = JSON.parse(text); }
catch { const m = text.match(/\{[\s\S]*\}/); plan = m ? JSON.parse(m[0]) : null; }
if (!plan) { console.error("unparseable:", text); process.exit(1); }

const byId = Object.fromEntries(candidates.map((c) => [c.id, c]));
if (plan.input != null && !byId[plan.input]) console.warn(`! input id ${plan.input} not in candidates`);

// 결정적 안전망: 명시적 "Send/Submit" 텍스트 버튼이 있는데 LLM 이 다른 걸 골랐으면
// 그쪽으로 교정(LLM 이 'Build' 같은 모드 버튼을 send 로 오선택하는 사례 방지).
const explicitSend = candidates.find((c) => c.clickable && /\b(send|submit)\b/i.test(c.text || ""));
if (explicitSend && plan.send !== explicitSend.id) {
  console.warn(`! send corrected ${plan.send} -> ${explicitSend.id} (explicit "${explicitSend.text}")`);
  plan.send = explicitSend.id;
}

writeFileSync(join(dir, "plan.json"), JSON.stringify(plan, null, 2));

console.log(`Model: ${model}`);
console.log(`input #${plan.input}  send ${plan.send}  typed "${plan.typedText}"`);
console.log(`shots: ${(plan.shots || []).map((s) => s.kind + (s.target ? `(${s.target})` : s.from ? `(${s.from}->${s.to})` : "") + `:${s.durationInFrames}`).join("  ")}`);
if (plan.brand) console.log(`brand: "${plan.brand.name}" — "${plan.brand.tagline}"  ${JSON.stringify(plan.brand.colors)}`);
console.log(`note: ${plan.note}`);
console.log(`written -> ${join(dir, "plan.json")}`);
