// scripts/watch-compare.mjs
// src/ (specs 포함) 변경을 감지해 자동으로 compare 를 돌린다. 사용자는 이
// watcher 를 한 번만 켜두면, Claude 가 spec/코드를 고칠 때마다 렌더+대조가
// out/compare/<id>/ 에 자동 갱신된다. 명령 반복 0.
//
// 사용(별도 터미널에 켜둠):
//   npm run watch:compare -- <compositionId> [--ref v] [--refStart s] [--crop ..] [--points ..]
// 예:
//   npm run watch:compare -- biasafe-s1c --ref ../../reference/app-launch/biasafe-ai.mp4 --refStart 2.0 --crop 1920x720+0+200

import { execSync } from "node:child_process";
import fs from "node:fs";

const argv = process.argv.slice(2);
const id = argv[0];
if (!id || id.startsWith("--")) {
  console.error("usage: npm run watch:compare -- <compositionId> [compare 옵션...]");
  process.exit(1);
}
const passArgs = argv.join(" ");

let rendering = false;
let pending = false;
let timer = null;

function runCompare() {
  rendering = true;
  console.log(`\n[watch ${new Date().toLocaleTimeString()}] compare ${id} ...`);
  try {
    execSync(`node scripts/compare.mjs ${passArgs}`, {
      stdio: "inherit",
      shell: "/bin/bash",
    });
    console.log(`[watch] ok -> out/compare/${id}/compare.png`);
  } catch (e) {
    console.error(`[watch] compare 실패: ${e.message}`);
  }
  rendering = false;
  if (pending) {
    pending = false;
    schedule();
  }
}

function schedule() {
  if (rendering) {
    // 렌더 중 들어온 변경은 끝난 뒤 한 번 더 돌린다(놓침 방지).
    pending = true;
    return;
  }
  clearTimeout(timer);
  timer = setTimeout(runCompare, 800); // debounce: 연속 수정은 마지막 한 번만
}

// mounted/동기화 폴더에서는 fs.watch 이벤트가 누락될 수 있어(특히 원격에서
// 수정한 파일) mtime polling 으로 감지한다. src 트리의 .ts/.tsx/.json 중
// 가장 최근 mtime 이 직전보다 커지면 변경으로 본다.
function maxMtime(dir) {
  let max = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "out") continue;
      max = Math.max(max, maxMtime(p));
    } else if (/\.(tsx?|json)$/.test(e.name)) {
      try {
        max = Math.max(max, fs.statSync(p).mtimeMs);
      } catch {
        /* ignore */
      }
    }
  }
  return max;
}
let lastMtime = maxMtime("src");
setInterval(() => {
  if (rendering) return;
  const m = maxMtime("src");
  if (m > lastMtime) {
    lastMtime = m;
    schedule();
  }
}, 1500);
console.log(
  `[watch] src/ (specs 포함) mtime polling 시작 -> 변경 시 자동 compare ${id}. (Ctrl+C 종료)`,
);
runCompare(); // 켤 때 1회 즉시 실행
