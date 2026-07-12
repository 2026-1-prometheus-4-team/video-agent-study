// scripts/compare.mjs
// 한 줄로 렌더 + 원본 대조 montage 생성. 결과를 out/compare/<id>/ 에 저장한다.
// scene24 폴더가 Claude 작업공간에 연결돼 있어서, 여기 저장하면 mp4 업로드
// 없이 Claude 가 montage 와 프레임 png 를 직접 읽고 픽셀 측정까지 한다.
//
// 필요: ffmpeg, imagemagick(convert/montage)  ->  brew install ffmpeg imagemagick
//
// 사용:
//   node scripts/compare.mjs <compositionId> [옵션]
//   npm run compare -- <compositionId> [옵션]
// 옵션:
//   --ref <video>      원본 레퍼런스 영상 경로(있으면 좌:원본 | 우:우리 비교)
//   --refStart <sec>   원본에서 비교 시작 시각(우리 frame 0 에 맞출 지점)
//   --points "a,b,c"   비교할 타임포인트(초). 기본 0.1~1.5 균등
//   --crop WxH+X+Y     텍스트 밴드만 크롭(글자 크게 보기). 예: 1920x720+0+200
// 예:
//   npm run compare -- biasafe-s1c --ref ../../reference/app-launch/biasafe-ai.mp4 --refStart 2.0 --crop 1920x720+0+200

import { execSync } from "node:child_process";
import fs from "node:fs";

const argv = process.argv.slice(2);
const id = argv[0];
if (!id || id.startsWith("--")) {
  console.error("usage: node scripts/compare.mjs <compositionId> [--ref v] [--refStart s] [--points ..] [--crop ..]");
  process.exit(1);
}
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const ref = opt("--ref");
const refStart = parseFloat(opt("--refStart", "0"));
const points = opt("--points", "0.1,0.3,0.5,0.7,0.9,1.1,1.3,1.5")
  .split(",")
  .map((s) => parseFloat(s))
  .filter((n) => !Number.isNaN(n));
const crop = opt("--crop");

const dir = `out/compare/${id}`;
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const sh = (c) => execSync(c, { stdio: "inherit", shell: "/bin/bash" });
const cap = (c) => execSync(c, { shell: "/bin/bash" }).toString().trim();

console.log(`\n[1/4] render ${id} -> ${dir}/ours.mp4`);
sh(`npx remotion render src/index.ts ${id} ${dir}/ours.mp4 --log=error`);

const rate = cap(
  `ffprobe -v error -select_streams v -show_entries stream=r_frame_rate -of csv=p=0 ${dir}/ours.mp4`,
);
const [rn, rd] = rate.split("/").map(Number);
const fps = Math.round(rn / (rd || 1));
const dur = parseFloat(
  cap(`ffprobe -v error -show_entries format=duration -of csv=p=0 ${dir}/ours.mp4`),
);
console.log(`    ${fps}fps, ${dur}s`);

console.log(`[2/4] extract frames @${fps}fps`);
sh(`ffmpeg -y -i ${dir}/ours.mp4 -vf fps=${fps} ${dir}/our_%03d.png 2>/dev/null`);
if (ref) {
  sh(
    `ffmpeg -y -ss ${refStart} -i ${ref} -vf "fps=${fps},scale=1920:1080" -t ${dur} ${dir}/ref_%03d.png 2>/dev/null`,
  );
}

console.log(`[3/4] side-by-side montage @ ${points.join(", ")}s`);
let hasMagick = true;
try {
  execSync("command -v convert >/dev/null 2>&1 && command -v montage >/dev/null 2>&1", { shell: "/bin/bash" });
} catch {
  hasMagick = false;
}
if (!hasMagick) {
  console.log(`[note] imagemagick(convert/montage) 없음 — montage 생략. 프레임 png(our_*/ref_*)는 생성 완료.`);
  console.log(`       'brew install imagemagick' 하면 다음부터 montage 까지 자동으로 뜬다.`);
  console.log(`       (Claude 는 프레임 png 를 직접 읽으므로 montage 없이도 측정·분석함)`);
  process.exit(0);
}
const cropX = crop ? `-crop ${crop} +repage` : "";
const cells = [];
for (const t of points) {
  const fr = Math.round(t * fps) + 1;
  const pad = String(fr).padStart(3, "0");
  const our = `${dir}/our_${pad}.png`;
  if (!fs.existsSync(our)) continue;
  const rf = `${dir}/ref_${pad}.png`;
  const cell = `${dir}/cell_${pad}.png`;
  if (ref && fs.existsSync(rf)) {
    sh(`convert ${rf} ${cropX} -resize 700x394 -bordercolor "#44aaff" -border 3 ${dir}/_l.png`);
    sh(`convert ${our} ${cropX} -resize 700x394 -bordercolor "#ff8844" -border 3 ${dir}/_r.png`);
    sh(
      `convert +append ${dir}/_l.png ${dir}/_r.png -gravity North -background black -splice 0x30 -pointsize 24 -fill yellow -annotate +0+3 "t=${t}s   REF | OURS" ${cell}`,
    );
  } else {
    sh(
      `convert ${our} ${cropX} -resize 700x394 -gravity North -background black -splice 0x30 -pointsize 24 -fill "#ff8844" -annotate +0+3 "t=${t}s  OURS" ${cell}`,
    );
  }
  cells.push(cell);
}
if (cells.length) {
  const rows = Math.ceil(cells.length / 2);
  sh(`montage ${cells.join(" ")} -tile 2x${rows} -geometry +4+4 -background "#111" ${dir}/compare.png`);
}
fs.rmSync(`${dir}/_l.png`, { force: true });
fs.rmSync(`${dir}/_r.png`, { force: true });

console.log(`\n[done] ${dir}/compare.png  (REF=파란테 | OURS=주황테)`);
console.log(`프레임 png(our_*/ref_*)도 ${dir}/ 에 있음 — Claude 가 픽셀 측정에 사용.`);
