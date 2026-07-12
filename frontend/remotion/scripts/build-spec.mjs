// build-spec.mjs — 캡쳐 dir + 디렉터 plan -> 렌더 가능한 CapturedAdSpec.
// 에셋(cleanplate/element.html/element.png)을 public/cap-<id>-* 로 복사하고,
// buildSpecFromPlan 으로 spec 을 조립해 <dir>/props.json 으로 쓴다(generic 렌더용).
//
//   tsx scripts/build-spec.mjs <capture-dir> <site-id>
//   npx remotion render src/index.ts CapturedAuto out.mp4 --props=<dir>/props.json
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSpecFromPlan } from "../src/captured/plan.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.argv[2];
const id = process.argv[3];
if (!dir || !id) { console.error("usage: build-spec.mjs <capture-dir> <site-id>"); process.exit(1); }

const readJson = (p) => JSON.parse(readFileSync(join(dir, p), "utf8"));
const capture = readJson("element.json");
const candidates = existsSync(join(dir, "candidates.json")) ? readJson("candidates.json") : [];
const pageTargets = existsSync(join(dir, "pageTargets.json")) ? readJson("pageTargets.json") : [];
if (!existsSync(join(dir, "plan.json"))) { console.error(`missing ${dir}/plan.json (run pick-elements.mjs first)`); process.exit(1); }
const plan = readJson("plan.json");

// 에셋 -> public/cap-<id>-*
const assets = {
  cleanplate: `cap-${id}-cleanplate.png`,
  elementHtml: `cap-${id}-element.html`,
  elementPng: `cap-${id}-element.png`,
};
copyFileSync(join(dir, "cleanplate.png"), join(root, "public", assets.cleanplate));
copyFileSync(join(dir, "element.html"), join(root, "public", assets.elementHtml));
copyFileSync(join(dir, "element.png"), join(root, "public", assets.elementPng));

const { spec, warnings } = buildSpecFromPlan(capture, assets, candidates, pageTargets, plan, {});

const props = { mode: "code", spec };
writeFileSync(join(dir, "props.json"), JSON.stringify(props, null, 2));

const total = spec.choreo.shots.reduce((s, sh) => s + sh.durationInFrames, 0);
console.log(`site ${id}: ${spec.choreo.shots.length} shots, ${total} frames (${(total / 24).toFixed(1)}s)`);
console.log(`shots: ${spec.choreo.shots.map((s) => s.kind + ":" + s.durationInFrames).join(" ")}`);
if (warnings.length) console.log(`warnings:\n  ${warnings.join("\n  ")}`);
console.log(`props -> ${join(dir, "props.json")}`);
