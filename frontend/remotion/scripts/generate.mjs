// generate.mjs
// Calls Gemini with the GENERATED preset contract, validates the returned
// spec against the same contract (zod, with clamp-and-recover), and writes
// it to src/generated-spec.json so Remotion Studio picks it up.
//
// Run under tsx so this .mjs can import the .ts contract:
//   pnpm gen "20초 SaaS 키네틱 타이포 영상"
//   (= tsx --env-file=.env scripts/generate.mjs "...")
//   GEMINI_MODEL=gemini-2.5-pro pnpm gen "..."

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateKnobs } from "../src/presets/contract.ts";
import { isPresetName } from "../src/presets/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY environment variable is required");
  process.exit(1);
}

const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const userPrompt =
  process.argv.slice(2).join(" ") ||
  "Make a 15 second energetic kinetic typography promo for a creative template marketplace. Dark background, neon pink and purple accents.";

// Prefer the generated contract (describes the presets the validator
// enforces); fall back to the legacy hand-written prompt only if the
// generated one hasn't been built yet.
const generatedPromptPath = join(root, "prompt", "system-prompt.generated.md");
const legacyPromptPath = join(root, "prompt", "system-prompt.md");
const systemPrompt = readFileSync(
  existsSync(generatedPromptPath) ? generatedPromptPath : legacyPromptPath,
  "utf8",
);

const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

async function callGemini(extraInstruction) {
  const contents = [{ role: "user", parts: [{ text: userPrompt }] }];
  if (extraInstruction) {
    contents.push({ role: "user", parts: [{ text: extraInstruction }] });
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { temperature: 0.9, responseMimeType: "application/json" },
    }),
  });
  if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Empty response from Gemini");
  return text;
}

function parseSpec(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/); // salvage if wrapped in prose
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

// Validate each scene against the preset contract. Recoverable problems
// (out-of-range numbers) are clamped in place; unrecoverable scenes
// (unknown preset, missing required knob) are dropped with a reason.
// Returns the surviving scenes plus a per-scene report.
function validateScenes(scenes) {
  const kept = [];
  const dropped = [];
  const clampedAll = [];
  scenes.forEach((scene, i) => {
    if (!scene || typeof scene !== "object" || !isPresetName(scene.preset)) {
      dropped.push(`scene ${i}: unknown preset "${scene?.preset}"`);
      return;
    }
    const { preset, ...knobs } = scene;
    const result = validateKnobs(preset, knobs);
    if (!result.ok) {
      dropped.push(`scene ${i} (${preset}): ${result.reason}`);
      return;
    }
    if (result.clamped.length) clampedAll.push(`scene ${i} (${preset}): clamped ${result.clamped.join(", ")}`);
    kept.push({ preset, ...result.value });
  });
  return { kept, dropped, clampedAll };
}

console.log(`Model: ${model}`);
console.log(`Prompt: ${userPrompt}`);

let spec = null;
let report = null;

for (let attempt = 1; attempt <= 2; attempt++) {
  let text;
  try {
    // On retry, tell the model exactly which scenes failed so it can fix them.
    const retryNote =
      attempt === 2 && report
        ? `Your previous output had invalid scenes:\n${report.dropped.join("\n")}\nReturn the FULL corrected JSON using only valid presets and required knobs.`
        : null;
    text = await callGemini(retryNote);
  } catch (e) {
    console.error(e.message);
    if (attempt === 2) process.exit(1);
    continue;
  }

  const parsed = parseSpec(text);
  if (!parsed || !Array.isArray(parsed.scenes) || parsed.scenes.length === 0) {
    console.error(`Attempt ${attempt}: no parseable scenes.`);
    writeFileSync(join(root, "out-raw.json"), text);
    if (attempt === 2) process.exit(1);
    continue;
  }

  report = validateScenes(parsed.scenes);
  if (report.kept.length === 0) {
    console.error(`Attempt ${attempt}: every scene invalid:\n  ${report.dropped.join("\n  ")}`);
    if (attempt === 2) process.exit(1);
    continue; // retry with the failure note
  }

  spec = { ...parsed, scenes: report.kept };
  break;
}

const outPath = join(root, "src", "generated-spec.json");
writeFileSync(outPath, JSON.stringify(spec, null, 2));

if (report.clampedAll.length) {
  console.log(`Clamped:\n  ${report.clampedAll.join("\n  ")}`);
}
if (report.dropped.length) {
  console.log(`Dropped ${report.dropped.length} invalid scene(s):\n  ${report.dropped.join("\n  ")}`);
}
const total = spec.scenes.reduce((s, sc) => s + (sc.duration || 0), 0);
console.log(`OK: ${spec.scenes.length} valid scenes, ~${total.toFixed(1)}s`);
console.log(`Written to ${outPath}`);
console.log("Open Remotion Studio and select the 'Generated' composition.");
