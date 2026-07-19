# Gemini 급 멀티영상 창작 편집 — E2E 갭 분석 + 빌드플랜

2026-07-19. 사용자가 보여준 Gemini 웹 기획 예시(이사 브이로그 4영상 → 트렌드 리서치 → 리치 기획안 → 그 감성에 맞는 편집)를 우리 플랫폼에서 재현하기 위한 갭 분석.

5-에이전트 병렬 추적(research/planning/edit-tools/orchestration) + 종합. 아래는 종합 빌드플랜 전문.

---

# Build Plan: Gemini-Quality Multi-Video Creative Edits

## Framing

The target splits into two deliverables the platform must produce from `[4 videos + loose prompt]`:
- **A** — the rich readable 기획안 (concept, trend analysis, timeline+script, BGM arc, editing tips) — target items 1-8 as *text/plan*.
- **B** — the actually-executed shorts that matches that plan — items 4,6,7 as *rendered video*.

The key strategic insight from the tracers: **A is almost entirely prompt/schema work on top of data the platform already computes but throws away.** B is where the genuine new-tool work lives. So we can hit a visible Gemini-style plan *first*, cheaply, and let the execution tools land incrementally behind it.

Ordering principle below: unlock the most target items per line of code, and never build execution for a plan the schema can't yet express.

---

## Phase 0 — Wiring & unblocks (mostly-there, low code)

These are things the backend already supports that just need the last wire connected. Do these first; everything downstream depends on them.

| Work | Files | Effort | Delivers |
|---|---|---|---|
| **Multi-video upload in UI.** Backend is end-to-end ready (`video_paths` is a list, `analysis_node` parallel-analyzes N, tags each scene with `video`). Add `multiple` to the two file inputs, loop `uploadVideo()` per file into a `serverVideoPaths[]`, pass array to `createSession`. `/upload` needs **no** change. | `Composer.tsx:225`, `EmptyState.tsx:72`, `state.ts:145`, `backend.ts:369` | small | **all items** (the input is 4 videos) |
| **Stop stripping emotional data in `analysis_node`.** Today each scene collapses to `{start,end,description,video}` and `transcript=[]`. Carry `mood/actions/people/transcript` through onto each scene, hoist per-segment transcript into `video_context.transcript`, widen the `Scene` TypedDict. `edit.py` already reads these exact keys, so low risk. | `graph.py:124-143`, `state.py:19-40`, mirror in `backend.ts:152` | small | **1** (name emotional contrast), **5** (pick 렌치-실패 beats), **6** (narration grounded in real speech) |
| **Add `YOUTUBE_API_KEY` to `backend/.env`.** All three YouTube tools are real API calls returning `missing_api_key` today. Enable YouTube Data API v3 in Google Cloud, drop the key in. No code change. | `backend/.env` | prompt-only | **2** (real 이사 shorts trend pull) |

**Why first:** the multi-video input and the un-stripping are prerequisites for *any* Gemini-level output — without them the planner is emotion-blind and can only see one video.

---

## Phase 1 — The rich plan schema + readable 기획안 (prompt/schema only — NO new tools) ⭐ FIRST MILESTONE

This is the highest-leverage phase. It makes the output *look like the Gemini plan* using data the model already has. No FFmpeg, no Remotion, no research yet — just schema fields, prompt instructions, and one frontend renderer.

**What to build:**

1. **Extend the `ScriptPlan` schema** (in `SCRIPT_NODE_INSTRUCTION`, `prompt_builder.py:222-296`, and `state.py:55-65`) with the fields the current schema cannot express:
   - `concept: {name, logline, emotional_contrast}` → item 3
   - `trend_elements: [string]` (the distilled 3) → item 2/5 (filled properly in Phase 2, but the *slot* exists now)
   - `bgm_progression: [{start_ms, end_ms, mood, cue}]` replacing the single `bgm_choice.mood` (accept either for back-compat) → item 4
   - `timeline: [{index, label, start_ms, end_ms, source_videos, transition, subtitle_text, narration_text, sfx, emphasis_note}]` — the narrative section abstraction that binds time-range → videos → actual Korean lines → SFX. Sits **alongside** `steps` (timeline = human plan, steps = machine execution derived from it) → items 5, 6
   - `editing_tips: [string]` (배속 / 화면분할 / 자막 폰트) → item 7
   - `references: [{title, url}]` → item 2 provenance

2. **Prompt: allow authored subtitle/narration TEXT.** Today the prompt hard-forbids authored lines and forces STT. Add an *authored* mode so the model writes the actual 훅 문구/내레이션 into `timeline[].subtitle_text/narration_text`. (`prompt_builder.py:279-285`)

3. **`plan_markdown` field** — a single Korean markdown doc (concept + timeline table + script + BGM arc + editing tips) the model fills for edit mode. The model already has every input once Phase 0 lands.

4. **Frontend: render `plan_markdown` in `InterruptCard`** instead of raw plan JSON. The interrupt payload already carries the whole plan, so **no server change** — just a markdown renderer in the approval card. (`InterruptCard.tsx:124`)

5. **Beat-selection heuristic** in `AGENTS.md`/`SOUL.md`: for shorts, weight `mood ∈ {tense,energetic}` + fail/mistake actions + reaction moments as highlight candidates. Prompt-only, uses the fields Phase 0 now carries. → item 5

**Files:** `prompt_builder.py:222-296`, `state.py:55-65`, `nodes/script_node.py:167-198`, `InterruptCard.tsx:124`, `workspace/AGENTS.md`, `workspace/SOUL.md`

**Effort:** medium overall, but all schema/prompt + one small FE component — no new tools.

**Delivers:** items **1, 3, 4, 5, 6, 7, 8** *as a readable plan*. This is the milestone: **a user uploads 4 이사 clips + the loose prompt and sees a Gemini-style 기획안 they can approve — before a single new edit tool exists.** BGM progression, split-screen, SFX all appear as *plan text and editing tips* here; they get *executed* in Phase 3.

> Recommended demo checkpoint. Ship Phase 0+1 as one PR-set and you have a visible, screenshot-able 기획안 from multiple videos.

---

## Phase 2 — Research before planning (medium code)

The one genuine *architectural* gap: research today can only run **after** approval as a dead-end execution step, so trends can never shape the concept/BGM/pacing. Gemini researched *then* planned.

**What to build:**

1. **`research_prepass` node** between `analysis` and `script` (`graph.py:684`). Gated on research intent in the prompt (`트렌드/요즘/쇼츠 분석`) so plain edits (`자막 넣어줘`) skip it. It calls `youtube_search(query='이사 쇼츠', sort_by='viewCount')` + `web_search`, then distills.
2. **`trend_distill(niche, samples, format)` tool** in `research_llm.py` — mirrors the existing `_llm_json` pattern, returns the exact schema `{niche, trend_elements:[3], named_concept, pacing_notes, bgm_progression, references:[{title,url}]}`.
3. **Inject the resulting `state['trend_brief']`** into `script_node`'s user prompt and `build_script_node_system_prompt` so concept/BGM/pacing are grounded in it. The `trend_elements`/`references` slots from Phase 1 now get filled for real.
4. **Prompt fix:** advertise `youtube_search`/`channel_analysis` to the planner and add "for a niche use `youtube_search`, not `youtube_trend`" (mostPopular ignores the query). (`prompt_builder.py:258`)

**Files:** `graph.py:684`, `nodes/script_node.py:100`, `prompt_builder.py:258,299`, `tools/research_llm.py:299`, `tools/research_external.py:202`

**Effort:** medium.

**Delivers:** items **2** (real trend analysis folding into the plan) and **5**, grounds **3**.

**Already there, just reused:** `research_expert` sub-agent is fully wired; Tavily is live; YouTube tools are real (need the Phase-0 key); domain-prior docs (`TREND_RESEARCH.md`, `CONCEPT_PATTERNS.md`, `HOOKS_LIBRARY.md`) already load as the research prompt.

---

## Phase 3 — Execution tools to *realize* the plan (new-tool work)

Now that the plan can *express* everything, build the FFmpeg/asset tools that turn plan sections into rendered video. These are independent and can land in any order / in parallel — each is a self-contained tool registered in `TOOLS + tool_map`. Ordered here by value-per-effort:

| Tool | What | Files | Effort | Delivers |
|---|---|---|---|---|
| **Font asset drop** | Add BM Jua / CookieRun OFL TTFs to `assets/fonts/`. `_scan_fonts` auto-discovers them; the styling engine (thick outline, bold, family select) already works and falls back to Arial only because the fonts are absent. Set shorts default style to the round font + `stroke_width~3`. **Verify licensing.** | `assets/fonts/`, `subtitle.py:47,203` | tiny (asset) | **7** (자막 폰트) |
| **`speed_video`** | `setpts=PTS/f` + chained `atempo` (caps at 2.0, so 4x = `atempo=2.0,atempo=2.0`). Same libx264/veryfast/crf20 encode so it stays concat-compatible. | `edit.py:537` | small | **7** (배속), **6** pacing |
| **`split_screen`** | `filter_complex` two inputs, scale each to half-canvas, `vstack` (top/bottom fits 9:16 shorts) or `hstack`. Reuse existing scale/pad pattern. | `edit.py:603-659` | small | **7** (화면분할 contrast) |
| **`generate_sfx` + SFX bank** | (a) ElevenLabs Sound-Effects API (same key already used for music/TTS) — text prompt → mp3, mirror `generate_bgm.py`; and/or (b) a small labeled royalty-free pack under `assets/sfx/` with a name→path resolver (한숨/샤라랑/띠로리/삐끗). `add_sfx` mechanic already works given a path. | `sfx.py:18`, `generate_bgm.py:153` | medium | **6** (per-section SFX) |
| **`add_bgm_progression`** | List of `{bgm_path, start_sec, end_sec}` + optional `acrossfade`: `atrim` each track, `adelay` to its start, `amix` all + original audio. Keep `add_bgm`'s ducking/loudnorm chain. | `bgm.py:19` | medium | **4** (경쾌→개그→힐링) |
| **Cross-cut transitions** | Hard cross-cut needs **nothing new** (interleave `clip_paths` in `merge_video`). For actual dissolves, add an **FFmpeg `xfade`** two-clip tool first (cheap). The richer Remotion `TransitionSeries` route (wiring the existing but unreachable `transitions.tsx`) is **large** — defer. | `edit.py:603`, `remotion/.../transitions.tsx` | small (xfade) / large (Remotion) | **6** (cross-cut) |

**Already there, just reused:** frame-accurate `cut_video`, cross-res `merge_video` (scale+pad+concat), `add_sfx` timestamp mechanic, `add_bgm` ducking, ElevenLabs `generate_bgm`/`text_to_speech` (covers the item-8 AI-TTS answer), full ASS subtitle engine, semantic `search_video_segments`/`cut_by_description` to pick which clip feeds each section.

---

## Phase 4 — Polish & richer UX (optional, post-demo)

- **Pick-1-of-3-concepts interrupt** variant in `InterruptCard` (Gemini offered 3 options) — map selection back through existing resume/clarify transport. (`InterruptCard.tsx`, item 3/8)
- **Research caching** (24h TTL keyed on tool+query) — `TOOLS.md` already promises it; zero code exists. Matters once the pre-pass runs every session and burns YouTube quota (100 units/search). (item 2 reliability)
- **Deeper trend read**: transcribe top-N reference shorts and feed transcripts into `trend_distill` (heavier). (item 2 quality)
- **Persist `trend_brief` to state/memory** so "now make it trendier" doesn't re-research from scratch.

---

## Honest difficulty read

**Genuinely straightforward** (data/wiring/atomic FFmpeg): multi-video upload, un-stripping analysis data, the entire rich-plan schema + `plan_markdown`, speed ramp, split-screen, BGM progression, font drop, xfade. These are well-scoped and low-risk — the primitives exist.

**Genuinely hard:**
- **Real YouTube trend *quality*.** Even with the key, tools return *metadata only* — the agent never watches the shorts (`SOUL.md:41`). Gemini's read of pacing/emotion is inferred from titles + view counts, shallower than a true content read. Acceptable for demo; a real gap.
- **Matching the emotional *vibe*.** "Pick 렌치 실패 as the highlight" depends on the Gemini analysis JSON actually tagging that segment's mood/action well, plus a heuristic to rank it. This is subjective and will need prompt iteration — not a one-shot.
- **Remotion transition timeline** (`TransitionSeries`) — large: new composition + render tool + props schema. Do FFmpeg `xfade` first; treat Remotion transitions as a stretch.

**The core reframe:** ~80% of the *visible* Gemini output (items 1-8 as a plan) is prompt+schema+one FE renderer on data already computed. The new-tool work is what makes the rendered video match the plan — valuable, but it can trail the 기획안 milestone.

---

## Recommended sequencing

1. **Phase 0 + Phase 1 together** → first PR-set → *visible Gemini-style 기획안 from 4 videos*. This is the milestone to hit before anything fancy.
2. **Phase 2** → the plan becomes trend-grounded (real research-before-plan).
3. **Phase 3** tools land incrementally (font+speed+split first — smallest, most visible), each making the *executed* shorts match more of the approved plan.
4. **Phase 4** when polishing for demo day.

---

# 영역별 상세 추적 (raw)

## research

The research CAPABILITY is real code, not stubs: Tavily web_search works (key set), and youtube_trend/youtube_search/channel_analysis are genuine YouTube Data API v3 calls (not dummies) — but YOUTUBE_API_KEY is empty in .env, so every YouTube tool returns a friendly missing_api_key error today. The fatal architectural gap is that research can NEVER run before planning and never feeds the plan. graph.py wires START→analysis→script→interrupt→supervisor→critic; script_node (script_node.py:75) builds the plan from video_context + user_request ONLY, and build_script_node_system_prompt (prompt_builder.py:299) is passed only video_context. research_expert is spawnable, but ONLY as an optional execution STEP the supervisor runs AFTER the plan (with its concept/BGM/pacing/format fields) is already fixed. Its output lands in execution_trace as a dead-end text blob (graph.py:305 _build_trace_from_messages) — there is no loop back to re-plan, so a "요즘 이사 쇼츠 분석" step, even if it ran, could not change the concept name, trend elements, or pacing the plan already committed to. To hit the Gemini bar (item 2 real trend pull + item 5 distilled 3 trend elements folded into concept/BGM/pacing), you need a research pre-pass node BEFORE script_node whose structured brief is injected into the planning prompt, plus a dedicated trend-distillation output schema and the YouTube key.

**있는 것:**
- web_search (Tavily) is real and live — POSTs to api.tavily.com (research_external.py:52-99); TAVILY_API_KEY is SET in .env (len 57), so general web trend search works today.
- youtube_trend is REAL, not a dummy — genuine GET to googleapis.com/youtube/v3/videos chart=mostPopular (research_external.py:171-195). youtube_search (keyword search, sort_by relevance/viewCount/date, research_external.py:202-238) and channel_analysis (uploads-playlist pattern mining: avg duration, view count, title keywords, cadence, research_external.py:245-342) are also real HTTP calls with ISO-duration parsing.
- LLM-only planning tools are real Gemini calls: concept_brainstorm, storyboard_from_concept, hook_suggest, cta_suggest, music_mood_recommend (research_llm.py, each _llm_json → make_llm → JSON extract).
- research_expert sub-agent is fully wired end-to-end: config.ROLE_TO_TOOL_GROUP['research_expert']='research' (config.py:102), tool_groups['research'] = research_llm + research_external tools (tools/__init__.py:74-77), spawnable as tool name 'research' via make_spawn_tools (sub_agent.py:314-339), and its SOUL/AGENTS/TOOLS + TREND_RESEARCH.md/CONCEPT_PATTERNS.md/HOOKS_LIBRARY.md are loaded as the stable-prefix system prompt (prompt_builder.build_sub_agent_system_prompt:324-388, extras glob at :359).
- Strong domain priors exist as workspace docs (TREND_RESEARCH.md, CONCEPT_PATTERNS.md 12 story patterns, HOOKS_LIBRARY.md 5 hook categories) so the research LLM can reason without extra retrieval.
- AGENTS.md already envisions research as plan step 1 ('research_expert (선택) 트렌드/유사 영상 구조 참고', AGENTS.md:101) — the intent is documented, only the wiring to feed planning is missing.

**갭:**
- [medium-code] Research never runs BEFORE planning. script_node produces the entire plan (concept, target_format, bgm_choice, color_grade, subtitle_style, pacing) from video_context + user_request only; no trend signal is ever consulted. There is no research node in the graph (grep confirms zero research references in graph.py nodes / nodes/*.py besides the _SPAWN_TOOL_NAMES literal).
  → Add a research_prepass node between analysis and script. When the user prompt contains a research intent (e.g. '트렌드/분석/요즘/쇼츠 분석해줘'), the node spawns research_expert (or calls youtube_search+web_search directly) to produce a compact 'trend_brief' (niche, 3 distilled trend elements, reference titles+URLs, suggested pacing, BGM progression), stashes it in state (e.g. state['trend_brief']), and script_node injects it into its user prompt AND build_script_node_system_prompt so the plan's concept/bgm/pacing are grounded in it. Wire graph: START→analysis→research_prepass→script (graph.py:684-685).
- [medium-code] Even when research runs as an execution step, its output is a dead-end. The supervisor's research spawn result is stored as a text summary in execution_trace (graph.py:305-361) and there is no edge back to script_node — the plan's concept/BGM/pacing are already frozen, so trend findings can never alter them.
  → Prefer the pre-pass above (research→plan) over post-hoc. If keeping a mid-execution research step, add a re-plan loop: after a research step completes, route back to script_node with the trend_brief as feedback so the plan is regenerated grounded in the findings, then re-approve. Simpler and demo-safe is the pre-pass.
- [small-code] No structured trend-distillation tool/schema. research_llm has concept/hook/CTA/music tools but nothing that ingests youtube_search results + web snippets and returns the exact Gemini deliverable: {niche, trend_elements:[3], named_concept, pacing_notes, bgm_progression, references:[{title,url}]}. Today distillation would be free-form LLM prose with no schema the plan can consume.
  → Add a trend_distill(niche, samples, format='shorts') @tool in research_llm.py that takes youtube_search/web_search payloads and returns that JSON schema (mirror the existing _llm_json pattern). The research_prepass node calls youtube_search+web_search then trend_distill to build the trend_brief.
- [prompt-only] YOUTUBE_API_KEY is empty in .env, so youtube_trend / youtube_search / channel_analysis all return {status:error, error:missing_api_key} today (_yt_call, research_external.py:109-113). '요즘 이사 쇼츠 분석' via YouTube is impossible until the key is added — only Tavily web_search works right now.
  → User enables YouTube Data API v3 in Google Cloud Console and adds YOUTUBE_API_KEY=AIza... to backend/.env (referenced only via os.getenv, no code change). 10k units/day free; youtube_search=100 units/call so budget it.
- [prompt-only] youtube_trend is the WRONG tool for a niche like '이사 쇼츠' — mostPopular chart takes only category, ignores query, so it returns generic KR trending, not moving-vlog shorts. The correct tool is youtube_search(query='이사 쇼츠', sort_by='viewCount'), but the script_node prompt advertises only 'web_search, youtube_trend' for research_expert (prompt_builder.py:258) and omits youtube_search + the concept tools, so the planner won't reach for the right tool.
  → In SCRIPT_NODE_INSTRUCTION (prompt_builder.py:258) and research_expert AGENTS.md, expand the research action list to include youtube_search/channel_analysis/concept_brainstorm and add guidance: 'for a specific niche use youtube_search(query, sort_by=viewCount), not youtube_trend'. Also have the pre-pass call youtube_search directly.
- [small-code] YouTube tools return metadata only (title, description, view_count) — the agent never watches the shorts (SOUL.md:41 admits '채널 영상을 실제로 보지 않는다 — metadata만 활용'). So trend distillation is inferred from titles/view counts, shallower than Gemini's apparent content-level read of pacing/emotion. Quality gap, not a blocker.
  → Accept metadata-only distillation for the demo (LLM infers pacing/hook patterns from top titles+view counts), OR optionally transcribe top-N reference shorts via the existing transcribe tool and feed transcripts into trend_distill for a deeper read (heavier, out of core scope).
- [small-code] No research caching despite TOOLS.md promising 24h TTL '.cache/research/' — grep confirms zero cache code. Every run re-hits Tavily/YouTube, burning quota (youtube_search=100 units) and adding latency for repeated demos.
  → Add a simple file/JSON TTL cache keyed on (tool, query) around _yt_call and web_search (24h TTL). Minor for a single demo but matters once the pre-pass runs on every session.
- [small-code] Research provenance is never surfaced into the plan or to the user. SOUL.md mandates 'always attach source URLs' but the plan schema (prompt_builder.py:222-251) has no field for references/trend_brief, so even successful research produces no visible citations in the approval card.
  → Add a 'research_brief' + 'references' field to the plan JSON schema in SCRIPT_NODE_INSTRUCTION and carry the pre-pass trend_brief through so the interrupt approval card can show the concept rationale + source URLs.

## Planning richness (script_node / ScriptPlan schema / prompt) — target items 1,3,4,5,6

The current plan is a machine tool-call step-list, not a readable 기획안, and its schema cannot express most of the Gemini output. Concretely: (a) there is NO named-concept field, NO BGM progression (only a single bgm_choice.mood), NO authored narration/subtitle TEXT (the prompt actively forbids authored lines and forces STT transcription), NO section abstraction that binds a time-range to {videos, transition, subtitle/narration, SFX}, and NO human-readable plan surface — the interrupt gate ships raw plan JSON. (b) Even the raw material to "understand the videos and pick emotional beats" (렌치 실패, 먹방) never reaches the planner: analysis_node in graph.py collapses each analyzed segment down to {start, end, description, video?} and sets transcript=[], discarding the per-segment mood / actions / people / transcript / key_moments that analyze.py produces. So the planner sees only generic visual descriptions and cannot tag emphasis beats or emotional contrast the way Gemini did. The multi-video scene.video tag DOES exist, so cross-cutting attribution and cross-video merge are the one target-6 field genuinely supported today. Fixing to Gemini level is mostly schema + prompt + a one-function analysis passthrough, plus a small frontend renderer for the readable plan — no new tooling.

**있는 것:**
- Multi-video cross-cut attribution: analysis_node tags each scene with `video` and the prompt instructs cut steps to use scene.video, with merge_video across differing videos — graph.py:130-131, state.py:23-25, prompt_builder.py:286-288. This covers target-6 'which video(s)'.
- Per-cut time ranges: steps[].params start_ms/end_ms with an explicit rule to snap to scene boundaries — prompt_builder.py:254, 265-267. Covers target-6 'time range' but as flat cut steps, not narrative sections.
- SFX / transition / effect exist as callable step actions (add_sfx, apply_remotion_effect, apply_transition) — prompt_builder.py:256-258, 292. Present but not bound to a section.
- Single BGM choice with ducking — state.py:64 (bgm_choice), prompt_builder.py:244. Only one mood for the whole video.
- Subtitle font/style knob — state.py:63 (subtitle_style), prompt_builder.py:243. Partial cover of target-7 자막 폰트.
- Follow-up question channel (target item 8, narration voice): plan.questions surfaced via interrupt_gate — state.py:65, graph.py:170-176. TTS voice catalog already injected — prompt_builder.py:66-85, 242.
- The rich data Gemini needs DOES get computed upstream (per-segment mood/actions/people/transcript/objects and top-level key_moments/highlight_candidates) — analyze.py:932-963 and the videos/*_analysis*.json segment schema. It is just discarded before the planner.

**갭:**
- [small-code] analysis_node strips all emotional/semantic signal before the planner sees it: it maps each segment to only {start, end, description, video?} and hard-codes transcript=[]. Per-segment mood / actions / people / transcript and top-level key_moments / highlight_candidates / boring_candidates are dropped. Result: the planner physically cannot pick '렌치 실패' (a mistake action/mood) or '먹방' (eating action) as beats, and cannot name the emotional contrast — it only has generic visual descriptions. This is the root blocker for target items 1 and 5.
  → In analysis_node, carry the fields through onto each scene (add mood, actions, transcript, people/emotion, and thread each source video's key_moments/highlight_candidates into ctx), and populate ctx['transcript'] from segment transcript instead of []. Widen the Scene TypedDict accordingly. _format_video_context already dumps the full ctx JSON, so once the data is in ctx the planner sees it with no prompt change.
- [small-code] No named-concept field. The plan can say target_format='shorts' but has nowhere to hold a concept title/logline like '우당탕탕 복층 오피스텔 현실 이사 1일차'.
  → Add `concept: {title, logline, emotional_hook}` (or flat concept/logline strings) to ScriptPlan, and one instruction line telling the model to name it. Schema change + prompt line.
- [small-code] BGM is a single object (bgm_choice.mood) — cannot express a progression across sections (경쾌 → 렌치 실패 시 정적/개그 → 먹방 시 힐링). Target item 4 is explicitly a time-ranged mood arc.
  → Change bgm_choice to a list: bgm_plan: [{start_ms, end_ms, mood, ducking, cue}]. Prompt: 'BGM은 구간별 무드 전환으로 기획하라'. Keep single-object back-compat by accepting either. Execution wiring to add_bgm per-range is out of my area (edit/audio expert), but the PLAN can express it.
- [medium-code] No authored narration/subtitle TEXT. The prompt hard-defaults subtitles to STT of the source audio and explicitly forbids using scene descriptions as subtitles (prompt_builder.py:280-282); tts_choice carries only a voice id, no script. For a from-scratch shorts the actual Korean lines ('훅 문구', 내레이션) have nowhere to live. This is the single biggest content gap vs Gemini's per-section script.
  → Distinguish two subtitle modes in the prompt: STT (existing) vs authored. Add a narration/caption field per section (see next gap) holding actual text, and let text_to_speech / add_title / add_caption steps consume that text. Mostly prompt, but needs the section schema to hold the lines and a note that authored text bypasses transcribe.
- [medium-code] No 'section' abstraction. Gemini's timeline is a list of narrative sections, each = {time range, source video(s)+transition, subtitle/narration lines, SFX, note}. Ours scatters these across independent expert steps (a cut step here, an add_sfx step there) with no grouping, so a section's intent is never expressed as one unit and the emphasis note (target 5) has no home.
  → Add a `timeline: [{index, label, start_ms, end_ms, source_videos, transition, subtitle_text, narration_text, sfx, emphasis_note}]` field to ScriptPlan that sits ALONGSIDE steps (timeline = human/narrative plan, steps = machine execution derived from it). Prompt instructs the model to fill timeline first, then emit steps consistent with it. This also carries the emphasis/인간미 note (item 5) and per-section SFX/transition (item 6).
- [small-code] No human-readable 기획안 the user SEES and approves. script_node output is a JSON step-list; interrupt_gate ships the raw plan dict as the approval payload (graph.py:172-177) and the frontend has zero components that render plan fields (grep for target_format/bgm_choice/subtitle_style in frontend returned nothing). Gemini's deliverable is a readable concept+timeline+script; ours is machine-facing. Only mode='chat' has a readable `reply`.
  → Prompt-only for generation: add a `plan_markdown` (concept + timeline table + script + BGM arc + editing tips, in Korean) field the model fills for edit mode — the model already has all inputs. Small frontend change to render plan_markdown in the approval card instead of raw JSON (interrupt payload already carries the whole plan, so no server change). This is the piece that makes the output actually 'look like the Gemini plan'.

## Editing tools to realize the plan (cross-cut, speed ramp, split-screen, SFX, BGM progression, styled subtitles)

The primitives for a linear cut-and-concat shorts pipeline exist and are solid: frame-accurate cut, and a merge that already re-encodes across DIFFERENT resolutions/codecs (scale+pad+setsar+audio-normalize+concat). SFX-at-timestamp, single-track BGM with speech ducking, and a full ASS/force_style subtitle engine (thick outline, bold, per-cue overrides, custom font by family) all work. But six of the plan's signature mechanics are missing or half-there: (1) cross-cut works only as HARD-cut sequential concat — no transition between merged clips (a transitions.tsx library exists but is unreachable: not in EFFECT_MAP, and its outgoing/incoming two-scene API is incompatible with the single-clip apply_remotion_effect tool); (2) speed ramp / 배속 does not exist at all (no setpts/atempo anywhere, cut_video has no speed param); (3) split-screen / 화면분할 does not exist (merge only concats sequentially, no hstack/vstack/xstack, no Remotion split composition); (4) SFX insertion works mechanically but there is NO SFX library — the user must supply each sfx file path, no 한숨/샤라랑/띠로리 asset bank or by-name resolver; (5) BGM is global-only — add_bgm loops one track over the whole video with -stream_loop -1/-shortest, no time-range scheduling, so the 경쾌→정적→힐링 progression is impossible without a new tool; (6) the styled-subtitle ENGINE is fully capable of the rounded+thick-outline vibe, but the actual display fonts are absent — assets/fonts holds only NotoSansKR-Regular.ttf, no 주아체(BM Jua)/쿠키런, so _resolve_font falls back to Arial and the vibe font never renders (though _scan_fonts already scans the dir, so it's an asset drop, not a code change).

**있는 것:**
- Cross-source merge across different res/codec: merge_video re-encodes when streams differ — backend/agent/tools/edit.py:104 (_streams_compatible) and :659-708 (scale=WxH:force_original_aspect_ratio=decrease + pad + setsar=1 + aresample 48k stereo + concat). Sequential cross-cut is achievable by cutting segments and ordering clip_paths interleaved.
- Frame-accurate cut with re-encode (safe for concat): cut_video backend/agent/tools/edit.py:537 (libx264/veryfast/crf20, uniform encode so concat -c copy path stays valid).
- Semantic/keyword scene search + auto-cut driving which clip/segment feeds the timeline: search_video_segments edit.py:725, cut_by_description edit.py:794 (Gemini-embedding cosine + keyword fallback + adjacent-merge).
- SFX-at-timestamp mechanic: add_sfx backend/agent/tools/sfx.py:18 (adelay=delay|delay + amix inputs=2:duration=first, keeps video -c:v copy). Works if a file path is supplied.
- Single global BGM with speech-aware ducking + optional narration mix + loudnorm: add_bgm backend/agent/tools/bgm.py:19 (sidechaincompress, -stream_loop -1, target_lufs -14/-16 for shorts).
- BGM generation (per-track) via ElevenLabs Music API incl. video-to-music: generate_bgm backend/agent/tools/generate_bgm.py:153.
- TTS narration via ElevenLabs multilingual (catalog + explicit voice_id): text_to_speech backend/agent/tools/tts.py:147 — covers the 'AI TTS narration' follow-up.
- Styled-subtitle engine with thick outline + bold + custom font: subtitle.py force_style (FontName/FontSize/OutlineColour/Outline stroke) :203-224, add_subtitle/add_auto_subtitle/add_title/add_caption/add_emoji_overlay TOOLS :657; per-cue ASS overrides incl. \bord outline width, bold, color and a font-family resolver that scans assets/fonts: subtitle_cues.py :387-441, render_subtitles + set_subtitle_style TOOLS :820.
- Remotion effect-apply harness (overlay/wrap/replace) for single-clip motion/text effects: apply_remotion_effect backend/agent/tools/remotion_render.py:103; 20-pattern catalog incl. TypewriterText/TextReveal/KineticWordSwap/ZoomIntoScreen/FilmGrain — backend/remotion/src/ClipEffect.tsx:45 EFFECT_MAP, agent/effects/registry.json.

**갭:**
- [small-code] Speed ramp / 배속 (2x-4x on a segment) does not exist. No setpts/atempo filter anywhere; cut_video has no speed param. Needed for the plan's '지루한/이사 구간 2-4x 배속' editing tip and pacing.
  → Add a speed_video tool (or a speed param on cut_video) in edit.py using FFmpeg setpts=PTS/{factor} for video and atempo for audio. atempo caps at 2.0 per instance so chain it (e.g. 4x = atempo=2.0,atempo=2.0). Re-encode with the same libx264/veryfast/crf20/yuv420p settings the cut/merge path already uses so the sped clip stays concat-compatible. Register in TOOLS + tool_map.
- [small-code] Split-screen / 화면분할 (two videos stacked/side-by-side) does not exist. merge_video only concatenates sequentially; no hstack/vstack/xstack; Remotion has no split composition. The plan explicitly wants split-screen contrast between clean Video1 and messy Video4.
  → New split_screen tool in edit.py: FFmpeg filter_complex with two -i inputs, scale each to half-canvas, then hstack (or vstack for vertical shorts) — e.g. [0:v]scale=w:h[l];[1:v]scale=w:h[r];[l][r]hstack. For 9:16 shorts a stacked (vstack) top/bottom split fits better. Pick one audio track or amix. Reuse _ffprobe_video_meta + the scale/pad pattern already in the reencode branch. A Remotion 2-tile composition is the richer alternative but heavier.
- [medium-code] No SFX library / by-name resolver. add_sfx requires the caller to already have a file path; there is no bank of 한숨/샤라랑/삐끗/띠로리 effects and no way to fetch one by name. The agent cannot realize item 6's per-section SFX (한숨 효과음, 샤라랑, 띠로리) autonomously.
  → Two options, ideally both: (a) generate_sfx tool hitting ElevenLabs Sound-Effects API (they already use ElevenLabs for music/TTS, same key) — text prompt like 'comedic sigh' -> mp3, mirror generate_bgm.py structure; (b) bundle a small labeled royalty-free SFX pack under assets/sfx/ with a name->path resolver (한숨/샤라랑/띠로리/삐끗) so add_sfx can accept a logical name. Wire whichever into TOOLS.
- [medium-code] BGM cannot be a progression. add_bgm loops ONE track over the whole video (-stream_loop -1, -shortest); no time-range scheduling. The plan's core music idea (경쾌한 브이로그 -> 정적/개그 -> 힐링) over 00:00-15 / 15-30 / 30-55 is impossible with the current tool.
  → New add_bgm_progression tool taking a list of {bgm_path, start_sec, end_sec} plus optional crossfade_ms. In FFmpeg: atrim each track to its section length, adelay to its start, then amix all sections + original video audio; optionally acrossfade at boundaries. Keep add_bgm's ducking/loudnorm chain. Alternatively orchestrate by calling add_bgm on pre-cut sub-clips before final merge, but a single scheduling tool is cleaner and preserves ducking. Reuse audio_common resolve/run helpers.
- [small-code] Rounded display fonts (주아체/BM Jua, 쿠키런) are absent — assets/fonts holds only NotoSansKR-Regular.ttf, so _resolve_font returns None and subtitle burn-in falls back to Arial. The styling engine (thick outline, bold, family selection) is fully present, so this is an asset gap, not an engine gap.
  → Drop the OFL/free round display TTFs (e.g. BMJUA_ttf.ttf, CookieRun) into backend/assets/fonts/ — subtitle_cues._scan_fonts already auto-discovers any family in that dir, and subtitle.force_style already emits FontName/Outline. Optionally set the shorts default style (font + stroke_width ~3) to the round font in DEFAULT_STYLE / _default_style so the vibe is on by default. Verify licensing before bundling.
- [large-code] Cross-cut between merged clips is HARD-cut only — no dissolve/transition between videos. A transitions library (Dissolve/SlidePush/LightSweep/MaskWipe/ZoomTransition) exists but is unreachable: it is not in ClipEffect's EFFECT_MAP and its outgoing/incoming two-scene API is incompatible with the single-clipPath apply_remotion_effect tool. Plan item 6 calls for cross-cut / cross-fade between clips.
  → Hard cross-cut needs nothing new (order clip_paths interleaved in merge_video). For actual transitions, either (a) FFmpeg xfade between two clips in a new tool — cheap, covers dissolve/wipe/slide (medium-code), or (b) a proper multi-clip Remotion timeline composition (Series/TransitionSeries) wiring the existing transitions.tsx — richer and reuses the built components but requires a new composition + a new render tool + props schema (large-code). Recommend the FFmpeg xfade tool first for demo-day value.

## Orchestration / vibe-to-edit bridge + multi-video UX (loose creative brief -> rich plan -> executed shorts)

Node order today is START -> analysis -> script -> interrupt_gate -> supervisor -> (clarify) -> critic -> summary -> END (backend/agent/graph.py:684-723). For a loose creative brief the agent does NOT research-first-then-plan: script_node produces the entire plan in ONE plain llm.invoke with no bound tools (script_node.py:143-150), so concept/BGM/timeline are decided BLIND to trend research. Research (web_search/youtube_trend) can only appear as a research_expert STEP that runs AFTER approval inside the supervisor — too late to shape the plan the user approves. The clarify machinery for creative-direction questions (own-voice vs AI-TTS) IS wired: pre-execution ambiguities go in plan.questions -> interrupt_gate (rendered by InterruptCard), mid-execution ones go through ask_user -> clarify_gate. But the plan schema and InterruptCard have no room for the rich Gemini-style 기획안 (named concept, emotional contrast, trend elements, BGM progression, per-section timeline+narration script, editing tips), and the interrupt is approve/revise on one plan, not pick-1-of-3-concepts. Multi-video is backend-ready end to end (session/analysis accept a list, analysis_node parallel-analyzes N and tags each scene with a `video` field) but blocked entirely on the frontend + single-file /upload. Emotional-beat data (people/actions/mood/per-scene transcript) IS captured by analysis and IS readable by the search tools, but analysis_node strips scenes down to {start,end,description} before storing video_context, so the planner and supervisor's inline view are emotion-blind — and no prompt tells them to pick fail/awkward/relatable beats as the highlight.

**있는 것:**
- Node graph wired and correct: START->analysis->script->interrupt_gate->supervisor->clarify->critic->summary->END, with conditional routing (graph.py:684-723). Loose brief flows analysis -> plan -> confirm -> execute.
- analysis_node already handles N videos: ThreadPoolExecutor parallel analysis, reuses cached <stem>_analysis.json, tags each scene with `video` field so cross-video cuts are traceable (graph.py:88-152).
- Per-scene emotional/humor data is actually computed: video_analysis.py:_build_prompt asks Gemini for people_count, people, actions, mood, per-segment transcript, objects, scene_change (video_analysis.py:172-188) and caches to _analysis.json.
- Search tools DO consume that rich data: edit.py _normalize_segment reads people/actions/mood into the search blob + semantic embeddings (edit.py:238-262), so at EXECUTION time the supervisor can semantically search '렌치 실패' and hit it via search_video_segments / cut_by_description.
- Two-channel clarify is real and wired: plan.questions -> interrupt_gate (graph.py:159-196), ask_user tool -> clarify_gate -> supervisor re-entry (graph.py:203-239, 395-441). SOUL/AGENTS explicitly instruct asking about TTS voice, subtitle font, ambiguous cuts (SOUL.md:29-32, AGENTS.md:119-143).
- Plan schema already carries some creative-direction fields: target_format, target_aspect_ratio, tts_choice, subtitle_style, bgm_choice, color_grade, plus per-format conventions (prompt_builder.py:222-296, SOUL.md:54-69).
- Multi-video is backend end-to-end ready: CreateSessionRequest.video_paths is a list, Session stores the list, graph_input passes video_paths (server.py:270-296, 373-374, 457-477); only upload + frontend are singular.
- InterruptCard renders steps + questions with parallel-group badges and a feedback textarea (InterruptCard.tsx:124-160); resume/clarify transport is complete (backend.ts:413-441).
- Research tools exist and are real (Tavily web_search, youtube_trend/search, channel_analysis) with graceful missing-key errors (research_external.py), and research_expert is a first-class sub-agent in AGENTS.md:44-45.

**갭:**
- [medium-code] Research runs AFTER planning, never before. script_node is a single plain llm.invoke with no bound tools, so the concept/BGM/timeline in the approved plan cannot reflect any trend findings. Gemini researched THEN planned; here trends can only be a research_expert step executed post-approval, whose output can't feed back into the plan except via critic RETRY or a whole new turn.
  → Insert a research pre-pass node between analysis and script (or bind research tools to script_node and make it a mini ReAct loop). Minimal: add research_node that, when the brief is trend-driven, runs youtube_search/youtube_trend/web_search on the topic, distills 3 trend elements into state['trend_brief'], and script_node's user prompt consumes it. Gate it so plain edits ('자막 넣어줘') skip research.
- [medium-code] Plan JSON has no fields for the rich 기획안: named concept, emotional contrast (기대 vs 우당탕탕), distilled trend elements, BGM progression (경쾌 -> 개그 -> 힐링), per-section timeline with video refs + transitions + actual Korean subtitle/narration lines + SFX, and editing tips (배속, split-screen, 자막 폰트). The schema stops at steps + a few style objects.
  → Extend SCRIPT_NODE_INSTRUCTION output schema with concept{name,emotional_hook,contrast}, trend_elements[], bgm_progression[{when,mood}], timeline[{range,videos,transition,subtitle,narration,sfx}], editing_tips[]. Keep steps as the executable spine; timeline is the human-facing 기획안 that the supervisor lowers into steps.
- [medium-code] InterruptCard renders only steps + a flat questions list. There is no surface for the rich plan doc (concept/timeline/BGM progression/tips) and no pick-1-of-3-concepts UX — the interrupt is approve-or-revise on a single plan, whereas Gemini offered 3 concept options and ended with a clarifying choice.
  → Render the new plan fields (concept header, timeline table, BGM progression, tips) in InterruptCard, and add a concept-options variant so the user selects one before steps are finalized. Map selection back through the existing resume/clarify transport.
- [small-code] analysis_node strips each scene to {start,end,description(,video)}, dropping people_count/people/actions/mood/per-scene transcript before storing video_context. So the planner (script_node) and the supervisor's inline video view are emotion/humor-blind; the rich data survives only on disk, reachable via search tools at execution time — not at planning time when the concept and highlight are chosen.
  → Stop stripping: carry people/actions/mood/transcript through in the scene dict at graph.py:124-132 (and widen the Scene TypedDict). Also pass them through the frontend scene mapping so the timeline can show mood. Low risk since edit.py already relies on these exact keys.
- [prompt-only] No instruction anywhere to select beats by emotion/humor/relatability. AGENTS.md 4.5 covers abstract queries via measurable proxies (people_count>=2 for '가족', calm+no-dialogue for '지루한') but nothing tells the planner/supervisor to prioritize fail/awkward/멘붕/relatable moments as the highlight, which is exactly how Gemini chose 렌치 실패.
  → Add a beat-selection heuristic to AGENTS.md/SOUL.md: for shorts, weight mood in {tense,energetic} + fail/mistake actions + reaction moments as highlight candidates; use the mood/actions fields (once carried through) as the ranking signal.
- [small-code] Multi-video upload is blocked on frontend + endpoint despite backend readiness. /upload takes a single UploadFile; the file inputs have no `multiple`; state is singular (serverVideoPath, uploadedName); ensureSessionAndConnect wraps one path into [videoPath]. Uploading 4 이사 clips is impossible from the UI.
  → Add `multiple` to both file inputs; loop uploadVideo() per file (existing single /upload needs NO change) collecting res.path into a new serverVideoPaths[]/uploadedNames[] state; pass the array to createSession (already accepts a list). Optional later: a batch /upload endpoint.
- [small-code] video_context.transcript is [] at planning time (analysis_node sets transcript:[], to be filled later by audio_expert) even though per-segment transcript already exists inside the cached analysis segments. So plan-time narration/script writing (Gemini wrote actual Korean lines per section) has no dialogue to draw from.
  → In analysis_node, hoist each segment's `transcript` field (already present in _analysis.json) into video_context.transcript, or run transcribe in the pre-pass, so script_node can write section-level subtitle/narration grounded in real speech.
- [medium-code] Even when a research_expert step exists, its findings flow into the supervisor's message history but there is no path to persist a distilled trend brief into state for reuse across turns or into the plan card — findings evaporate after the turn, so a follow-up 'now make it trendier' re-researches from scratch.
  → Add a state field (e.g. trend_brief / research_findings) written by the research pre-pass or a memory tool, surfaced in the plan card and re-injected into later script_node turns via conversation_summary-style carryover.

