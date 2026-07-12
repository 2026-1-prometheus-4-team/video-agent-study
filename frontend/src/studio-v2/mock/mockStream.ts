/**
 * mockStream — 백엔드 오프라인 상태에서도 완결된 스트리밍 UX 를 확인하기 위한
 * 시나리오 재생기.
 *
 * 사용:
 *   playScenario("shorts") — "맛있다 부분 잘라서 쇼츠" 시나리오 재생
 *
 * 시나리오는 각 이벤트마다 delay 를 두고 store 액션을 호출.
 */

import { useAgentStore, type PlanStep } from "../state";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let running = false;

/** 텍스트를 chunk 로 쪼개서 stream 하듯 append */
async function typeText(
  id: string,
  text: string,
  chunkSize = 12,
  chunkDelayMs = 45
) {
  const store = useAgentStore.getState();
  for (let i = 0; i < text.length; i += chunkSize) {
    if (!running) return;
    const chunk = text.slice(i, i + chunkSize);
    store.appendAgentChunk(id, chunk);
    await sleep(chunkDelayMs);
  }
}

export function stopScenario() {
  running = false;
}

export async function playScenario(kind: "shorts" | "concept" = "shorts") {
  const store = useAgentStore.getState();
  running = true;
  store.clearStream();
  store.setConnection("online");
  store.startSession(`demo-${Date.now().toString(36).slice(-6)}`);

  if (kind === "shorts") {
    // 유저 지시
    store.appendUser(
      "이 영상에서 '맛있다' 부분만 잘라서 60초 쇼츠로 만들어줘",
      ["cooking-2m.mp4"]
    );
    store.setUpload(100, "cooking-2m.mp4");
    await sleep(400);

    // 에이전트 첫 메세지
    const msg1 = `agent-${Date.now().toString(36)}`;
    store.startAgentMsg(msg1, "orchestrator");
    await typeText(
      msg1,
      "요청 확인했어. 먼저 영상을 분석하고 '맛있다' 발화 구간을 찾아볼게."
    );
    store.endAgentMsg(msg1);
    await sleep(350);

    // Tool: analyze_video
    const t1 = `tool-${Date.now().toString(36)}`;
    store.startTool(t1, "orchestrator", "analyze_video", {
      video_path: "cooking-2m.mp4",
    });
    await sleep(1400);
    store.endTool(t1, true, {
      scenes: 12,
      transcript_segments: 24,
      duration: 118.4,
    });
    store.setVideoContext({
      file_path: "cooking-2m.mp4",
      duration: 118.4,
      sceneCount: 12,
      transcriptCount: 24,
    });
    await sleep(300);

    // Tool: transcribe (병렬)
    const t2 = `tool-${Date.now().toString(36)}`;
    store.startTool(t2, "orchestrator", "transcribe_video", {
      video_path: "cooking-2m.mp4",
    });
    await sleep(1600);
    store.endTool(t2, true, {
      segments: 24,
      language: "ko",
    });
    await sleep(280);

    // 에이전트 메세지 2
    const msg2 = `agent-${Date.now().toString(36)}`;
    store.startAgentMsg(msg2, "planning");
    await typeText(
      msg2,
      "분석 완료. '맛있다' 구간이 세 곳에서 감지됐어 (11.2s, 15.4s, 23.6s). 아래 계획으로 진행할까?"
    );
    store.endAgentMsg(msg2);
    await sleep(400);

    // Interrupt
    const plan: PlanStep[] = [
      {
        id: 1,
        action: "cut_video",
        expert: "edit",
        rationale: "'맛있다' 구간 3곳을 각각 2초씩 잘라내기",
        estimatedSec: 2,
        parallelGroup: 1,
      },
      {
        id: 2,
        action: "merge_video",
        expert: "edit",
        rationale: "잘라낸 클립 3개를 순서대로 이어붙이기",
        estimatedSec: 3,
        dependsOn: [1],
      },
      {
        id: 3,
        action: "resize",
        expert: "edit",
        rationale: "9:16 쇼츠 비율로 리프레임 (1080x1920)",
        estimatedSec: 4,
        dependsOn: [2],
      },
      {
        id: 4,
        action: "add_subtitle",
        expert: "edit",
        rationale: "자막 자동 생성 + 화면 중앙 큰 폰트",
        estimatedSec: 3,
        dependsOn: [3],
      },
      {
        id: 5,
        action: "add_bgm",
        expert: "edit",
        rationale: "밝은 요리 분위기 BGM, 발화 구간 자동 감쇠",
        estimatedSec: 2,
        dependsOn: [4],
      },
    ];
    store.pushInterrupt(plan, []);
    // Interrupt 후에는 UI 가 사용자 승인을 기다림. 여기서 재생 정지.
    // 실제 승인 액션은 UI 의 버튼이 트리거.
  } else if (kind === "concept") {
    store.appendUser("여행 영상 만들고 싶은데 뭐 만들지 모르겠어. 컨셉 추천해줘");
    await sleep(300);

    const msg1 = `agent-${Date.now().toString(36)}`;
    store.startAgentMsg(msg1, "research");
    await typeText(
      msg1,
      "여행 주제 트렌드부터 확인해볼게. 한국 쇼츠 트렌드와 유사 채널 3곳을 병렬로 분석 중이야."
    );
    store.endAgentMsg(msg1);
    await sleep(280);

    const t1 = `tool-${Date.now().toString(36)}`;
    store.startTool(t1, "research", "youtube_trend", {
      category: "travel_events",
      region: "KR",
    });
    const t2 = `tool-${Date.now().toString(36)}`;
    store.startTool(t2, "research", "web_search", {
      query: "한국 여행 쇼츠 트렌드 2026",
    });
    await sleep(1400);
    store.endTool(t1, true, { videos: 10 });
    await sleep(300);
    store.endTool(t2, true, { results: 5 });
    await sleep(400);

    const t3 = `tool-${Date.now().toString(36)}`;
    store.startTool(t3, "research", "concept_brainstorm", {
      topic: "여행",
      format: "shorts",
      count: 3,
    });
    await sleep(1200);
    store.endTool(t3, true, {
      concepts: 3,
    });
    await sleep(300);

    const msg2 = `agent-${Date.now().toString(36)}`;
    store.startAgentMsg(msg2, "research");
    await typeText(
      msg2,
      "컨셉 3개 준비됐어. 하나 골라주면 스토리보드와 후킹 멘트까지 자동으로 만들게.\n\n1) **강릉 카페 5곳 리스티클** (listicle · 60s)\n2) **원데이 서울 vs 시골 비교** (comparison · 45s)\n3) **혼여 첫날 브이로그** (day-in-life · 90s)"
    );
    store.endAgentMsg(msg2);
    await sleep(200);
    store.pushInfo("컨셉 선택을 기다리는 중… 원하는 번호를 입력해줘 (1/2/3)");
  }
}

/** InterruptCard 의 '승인' 버튼이 호출. 이후 실행 시나리오 재생. */
export async function playApprovedContinuation() {
  const store = useAgentStore.getState();
  if (!running) return;

  const msg = `agent-${Date.now().toString(36)}`;
  store.startAgentMsg(msg, "edit");
  await typeText(msg, "좋아. 편집 시작할게. 5단계 순서대로 진행 중.");
  store.endAgentMsg(msg);
  await sleep(300);

  // Step 1: cut (병렬 3회)
  const cutTools = [
    { id: `cut1-${Date.now().toString(36)}`, args: { start: 11.2, end: 13.2 } },
    { id: `cut2-${Date.now().toString(36)}`, args: { start: 15.4, end: 17.4 } },
    { id: `cut3-${Date.now().toString(36)}`, args: { start: 23.6, end: 25.6 } },
  ];
  cutTools.forEach((t) => store.startTool(t.id, "edit", "cut_video", t.args));
  await sleep(1800);
  cutTools.forEach((t, i) =>
    store.endTool(t.id, true, { output: `videos/clips/cut_${i}.mp4` })
  );
  await sleep(300);

  // Step 2: merge
  const mergeId = `merge-${Date.now().toString(36)}`;
  store.startTool(mergeId, "edit", "merge_video", { paths: 3 });
  await sleep(1500);
  store.endTool(mergeId, true, { output: "videos/clips/merged.mp4" });
  await sleep(300);

  // Step 3: resize
  const resizeId = `resize-${Date.now().toString(36)}`;
  store.startTool(resizeId, "edit", "resize", { aspect: "9:16" });
  await sleep(1400);
  store.endTool(resizeId, true, { output: "videos/clips/shorts.mp4" });
  await sleep(300);

  // Step 4: subtitle
  const subId = `sub-${Date.now().toString(36)}`;
  store.startTool(subId, "edit", "add_subtitle", { auto: true });
  await sleep(1300);
  store.endTool(subId, true, { output: "videos/clips/shorts_sub.mp4" });
  await sleep(300);

  // Step 5: bgm
  const bgmId = `bgm-${Date.now().toString(36)}`;
  store.startTool(bgmId, "edit", "add_bgm", {
    mood: "bright cooking",
    ducking: true,
  });
  await sleep(1200);
  store.endTool(bgmId, true, { output: "videos/output.mp4" });
  await sleep(300);

  // Critic
  const criticId = `critic-${Date.now().toString(36)}`;
  store.startTool(criticId, "critic", "verify_output", {});
  await sleep(900);
  store.endTool(criticId, true, { verdict: "PASS" });
  await sleep(200);

  // Final
  store.pushFinal(
    "videos/output.mp4",
    58.4,
    "쇼츠 형식, 자막 가독성 우수, BGM 자동 감쇠 정상"
  );
  store.pushInfo("세션 종료 · 총 처리 시간 12.4s");
}
