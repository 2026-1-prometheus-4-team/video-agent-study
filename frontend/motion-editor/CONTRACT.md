# Scene24 Motion Editor — 아키텍처 계약 (패널 작업 공통 기준)

이 문서가 진실이다. 여기 정의된 API 밖에서 다른 모듈 내부에 손대지 말 것.

## 전체 구조

- Next.js 15 (webpack 모드 필수 — turbopack 금지, 엔진이 require.context 사용).
- 엔진 소스는 `@engine/*` = `../remotion/src/*` 로 직접 import (복사 금지).
- Player: `@remotion/player`. 컴포지션 = 엔진 `Ad` (`@engine/motion/SceneRenderer`).
- fps 24 고정 (`@/engine/normalize` 의 `FPS`).
- 스펙 문서 = 엔진 `VideoSpec` (raw SceneSpec 배열). 프리셋 씬은 로드 시 확장.

## 핵심 모듈 (이미 구현됨 — 수정 금지, import 만)

### `@/editor/store.ts` — zustand 스토어
```ts
const doc = useEditor((s) => s.doc);              // VideoSpec | null
const selection = useEditor((s) => s.selection);  // ElementPath[]
const hovered = useEditor((s) => s.hovered);
const activeScene = useEditor((s) => s.activeScene);
const ui = useEditor((s) => s.ui);                // { tool, leftTab, pxPerFrame, showBeatGrid, canvasZoom, easingEditor, libraryRefresh }
const meta = useEditor((s) => s.meta);            // { relPath, loadedShape, hadPresets, dirty }

useEditor.getState().updateDoc(label, (draft) => { ...draft 변형... }, { coalesceKey?, selectAfter? });
useEditor.getState().endCoalescing();             // 드래그 종료 시
useEditor.getState().undo(); .redo();
useEditor.getState().select(paths, { additive? }); .toggleSelect(p); .clearSelection();
useEditor.getState().setHovered(p|null); .setActiveScene(i); .setUI({...});
useEditor.getState().loadDoc(relPath, rawJson);   // 파일 열기
useEditor.getState().markSaved();                 // 저장 성공 후
```
- 스펙의 모든 변경은 updateDoc 로만. 드래그 연속 변경은 같은 coalesceKey.

### `@/editor/specPath.ts` — 요소 경로
- `ElementPath` = `"sceneIdx:elIdx"` 또는 그룹 자식 `"0:2.1"`.
- `parsePath/buildPath/parentPath/getElement/getScene/getContainer/flattenScene/isGroup/normalizeSelection/elementLabel`.

### `@/editor/playerBridge.ts` — 재생 (프레임 상태는 스토어에 없음)
- `setPlayer(ref)` — CanvasStage 가 Player 마운트 시 1회.
- `usePlayerFrame()` / `usePlayerPlaying()` / `usePlayerReady()` 훅.
- `seekTo(f)`, `togglePlay()`, `play()`, `pause()`, `beginScrub()/endScrub()`.

### `@/editor/timing.ts` — 타이밍 (엔진 계산 재사용, 복제 금지)
- `sceneFrames(scene, fps)`, `totalFrames(spec, fps)`, `sceneStarts(spec, fps)`,
  `frameToScene(spec, fps, frame)`, `elementTimings(el, scene, fps)` (TimedLayer[]:
  startFrame/window/role), `elementPhases(el, scene, fps)` ({enterEnd, exitStart, total}),
  `STRUCTURAL` (Set<string> — 구조형 레이어 타입 판별).

### `@/editor/mutations.ts` — 구조 변경 커맨드 (각자 구현 금지)
- `deleteElements(paths)`, `duplicateElements(paths)`, `groupElements(paths)`,
  `ungroupElement(path)`, `nudgeElements(paths, dx, dy)`,
  `addTextElement(sceneIdx, text?)`, `addScene()`, `deleteScene(i)`,
  `duplicateScene(i)`, `moveScene(from, to)`.

### `@/engine/normalize.ts`
- `FPS`(=24), `normalizeSpec(raw)`, `detectShape(raw)`, `containsPreset(raw)`.

### 엔진에서 자주 쓸 것
- 타입: `VideoSpec/SceneSpec/SceneElementSpec/GroupElementSpec/CameraSpec/FlashSpec`
  (`@engine/motion/SceneRenderer`), `TextElementSpec` (`@engine/motion/ComposedText`),
  `LogoElementSpec` (`@engine/motion/ComposedLogo`).
- 레지스트리: `STRUCTURAL_EFFECTS/WRAPPER_EFFECTS/SCENE_TRANSITIONS/CAMERA_MOTIONS`
  + `ExposedField` (`@engine/compose/registry`), 설명 문서 `@engine/compose/catalog`.
- 이징: `EASING` (Record<name, (t)=>number>), `EasingName` (`@engine/motion/core/easing`).
- 레이어 타입: `MotionLayer { type, role: "in"|"hold"|"out"|"afterIn", props }`.

## 캔버스 계측 (엔진에 이미 구현)

Ad 렌더 DOM 안에 `display:contents` 태그가 있다:
- 활성 씬 루트: `[data-scene="i"]` (Sequence 특성상 항상 1개만 마운트).
- 각 요소 래퍼: `[data-el="i"]` — 그룹 자식은 DOM 중첩으로 표현.
- 경로 복원: `[data-scene]` 값 + 조상→자손 `[data-el]` 체인 = `"scene:a.b.c"`.
- 측정: `display:contents` 는 rect 가 없으므로 **element children 의
  getBoundingClientRect union** 으로 박스를 구한다 (그룹은 재귀 union).
  요소가 아직 등장 전이면 children 이 없을 수 있음 — skip.
- CSS px -> 컴포지션 px: `playerRef.getScale()` 로 나눔. Player 컨테이너는
  `getContainerNode()`.

## 파일 소유권 (자기 영역 밖 수정 금지)

- 캔버스: `src/editor/canvas/**` (CanvasStage.tsx 가 default export)
- 타임라인: `src/editor/timeline/**` (TimelinePanel.tsx)
- 인스펙터: `src/editor/inspector/**`, `src/editor/schema.ts`,
  공용 컨트롤 `src/editor/controls/**` (NumberInput/ColorInput/Select/Segmented/Toggle)
- 이징: `src/editor/easing/**` (EasingEditorModal.tsx) + 지정된 엔진 easing 확장
- 라이브러리/레이어/단축키/탑바: `src/editor/library/**`, `src/editor/layers/**`,
  `src/editor/shortcuts.ts`, `src/editor/topbar/**`, `src/app/api/specs/**`
- 셸 조립(`EditorShell.tsx`)은 통합 단계에서 별도 처리 — 건드리지 말 것.

## 컴포넌트 규약

- 각 패널 루트는 props 없는 default export React FC. 상태는 전부 스토어에서.
- "use client" 필수. SSR 에서 window 접근 금지 (모듈 스코프에서 브라우저 API 호출 X).
- 검증: `npx tsc --noEmit` 0 에러 (에디터), 엔진 손댄 경우 엔진 tsc 도
  (`cd ../remotion && npx tsc --noEmit -p tsconfig.json`, three 관련 기존 에러만 허용).

## specs 파일 API (라이브러리 담당이 구현, 나머지는 이 형태 가정)

- `GET /api/specs` -> `{ files: [{ path: "text-motion/words-test.json", shape: "video"|"scene"|"preset", hasPresets: boolean }] }`
- `GET /api/specs/file?path=<rel>` -> 원본 JSON
- `PUT /api/specs/file?path=<rel>` body=JSON -> 저장 (VideoSpec 형태, 2-space pretty)
- `POST /api/specs/file?path=<rel>` -> 새 파일 생성 (존재하면 409)
- specs 루트 = `../remotion/src/specs` (path traversal 방어 필수)
