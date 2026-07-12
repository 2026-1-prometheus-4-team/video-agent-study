// build-fullad.mjs — 캡쳐 dir + 디렉터 plan(brand 포함) -> FullAd props.
// build-spec 과 같은 캡쳐 spec 을 만들고, brand 를 붙여 완성 광고(캡쳐+아웃트로)용
// props 를 쓴다. 캡쳐 채움색(outroFill)을 아웃트로 배경과 맞춰 컷이 매끄럽게.
//
//   tsx scripts/build-fullad.mjs <capture-dir> <site-id>
//   npx remotion render src/index.ts FullAd out.mp4 --props=<dir>/fullad.json
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSpecFromPlan } from "../src/captured/plan.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.argv[2];
const id = process.argv[3];
if (!dir || !id) { console.error("usage: build-fullad.mjs <capture-dir> <site-id>"); process.exit(1); }

const readJson = (p) => JSON.parse(readFileSync(join(dir, p), "utf8"));
const capture = readJson("element.json");
const candidates = existsSync(join(dir, "candidates.json")) ? readJson("candidates.json") : [];
const pageTargets = existsSync(join(dir, "pageTargets.json")) ? readJson("pageTargets.json") : [];
if (!existsSync(join(dir, "plan.json"))) { console.error(`missing ${dir}/plan.json (run pick-elements.mjs first)`); process.exit(1); }
const plan = readJson("plan.json");

const assets = {
  cleanplate: `cap-${id}-cleanplate.png`,
  elementHtml: `cap-${id}-element.html`,
  elementPng: `cap-${id}-element.png`,
};
copyFileSync(join(dir, "cleanplate.png"), join(root, "public", assets.cleanplate));
copyFileSync(join(dir, "element.html"), join(root, "public", assets.elementHtml));
copyFileSync(join(dir, "element.png"), join(root, "public", assets.elementPng));

const brand = plan.brand || { name: id, tagline: "", colors: ["#5B8CFF", "#FF5CA8", "#FF9A5C"], background: "#0B0A0E" };

const { spec, warnings } = buildSpecFromPlan(capture, assets, candidates, pageTargets, plan, {
  outroFill: brand.background, // 캡쳐 채움색 = 아웃트로 배경 (매끄러운 컷)
});

const props = { captured: spec, brand };
writeFileSync(join(dir, "fullad.json"), JSON.stringify(props, null, 2));

const capTotal = spec.choreo.shots.reduce((s, sh) => s + sh.durationInFrames, 0);
console.log(`site ${id}: captured ${capTotal}f + outro(brand "${brand.name}" / "${brand.tagline}")`);
console.log(`shots: ${spec.choreo.shots.map((s) => s.kind + ":" + s.durationInFrames).join(" ")}`);
if (warnings.length) console.log(`warnings:\n  ${warnings.join("\n  ")}`);
console.log(`props -> ${join(dir, "fullad.json")}`);
