// scripts/measure-centroid.mjs
//
// Renders a composition (default: dream) then measures the per-frame
// horizontal centroid of luminous pixels (anything brighter than a
// threshold against the dark scene background). The output is a CSV-like
// table of `frame, centroid_x_px, delta_from_prev_px` so we can see
// whether the line bounces side-to-side between frames.
//
// usage: node scripts/measure-centroid.mjs [composition=dream]
//
// Requires `ffmpeg` on PATH. No extra npm deps.

import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const composition = process.argv[2] || "dream";
const outDir = resolve(root, "out");
const mp4 = resolve(outDir, `${composition}-centroid.mp4`);
const SCALE_W = 480;
const SCALE_H = 270;
const FULL_W = 1920;
const THRESHOLD = 120; // luminance 0-255 — text core only, no halo/Aurora

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

function run(cmd, args, { quiet = false } = {}) {
  return new Promise((res, rej) => {
    const proc = spawn(cmd, args, { stdio: quiet ? "ignore" : "inherit" });
    proc.on("close", (code) => {
      code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`));
    });
    proc.on("error", rej);
  });
}

async function renderComposition() {
  console.error(`> rendering ${composition} -> ${mp4}`);
  await run("pnpm", [
    "exec",
    "remotion",
    "render",
    composition,
    mp4,
    "--codec",
    "h264",
    "--log",
    "warn",
  ]);
}

async function measure() {
  console.error(`> measuring centroid @ ${SCALE_W}x${SCALE_H} grayscale`);
  const args = [
    "-loglevel",
    "error",
    "-i",
    mp4,
    "-vf",
    `scale=${SCALE_W}:${SCALE_H},format=gray`,
    "-f",
    "rawvideo",
    "-",
  ];
  const ff = spawn("ffmpeg", args);
  const frameBytes = SCALE_W * SCALE_H;
  let buf = Buffer.alloc(0);
  const results = []; // { frame, centroid_full_px, weight }

  ff.stderr.pipe(process.stderr);
  for await (const chunk of ff.stdout) {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= frameBytes) {
      const frame = buf.subarray(0, frameBytes);
      buf = buf.subarray(frameBytes);
      let sumX = 0;
      let weight = 0;
      for (let y = 0; y < SCALE_H; y++) {
        const row = y * SCALE_W;
        for (let x = 0; x < SCALE_W; x++) {
          const v = frame[row + x];
          if (v >= THRESHOLD) {
            const w = v - THRESHOLD;
            sumX += x * w;
            weight += w;
          }
        }
      }
      const centroidSmall = weight > 0 ? sumX / weight : SCALE_W / 2;
      const centroidFull = centroidSmall * (FULL_W / SCALE_W);
      results.push({
        frame: results.length,
        centroid: centroidFull,
        weight,
      });
    }
  }
  return results;
}

(async () => {
  if (!existsSync(mp4)) {
    await renderComposition();
  } else {
    console.error(`> reusing existing ${mp4} (delete to re-render)`);
  }
  const results = await measure();
  // Output: frame, centroid_x_px, delta_px, weight
  console.log("frame,centroid_x,delta,weight");
  let prev = null;
  let maxAbsDelta = 0;
  let sumAbsDelta = 0;
  let count = 0;
  for (const r of results) {
    if (r.weight < 5000) {
      console.log(`${r.frame},,,${r.weight}`);
      prev = null;
      continue;
    }
    const delta = prev === null ? 0 : r.centroid - prev;
    if (prev !== null) {
      maxAbsDelta = Math.max(maxAbsDelta, Math.abs(delta));
      sumAbsDelta += Math.abs(delta);
      count++;
    }
    console.log(
      `${r.frame},${r.centroid.toFixed(2)},${delta.toFixed(2)},${r.weight}`,
    );
    prev = r.centroid;
  }
  const avg = count > 0 ? sumAbsDelta / count : 0;
  console.error(`> frames analysed (with content): ${count + (count > 0 ? 1 : 0)}`);
  console.error(`> max |delta| between consecutive frames: ${maxAbsDelta.toFixed(2)} px`);
  console.error(`> mean |delta|: ${avg.toFixed(2)} px`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
