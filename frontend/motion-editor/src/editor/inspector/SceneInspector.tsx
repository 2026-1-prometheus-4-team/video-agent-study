"use client";

// SceneInspector — 선택 없음일 때. 활성 씬 + 문서(brandDefaults) 편집.

import React from "react";
import { useEditor } from "@/editor/store";
import { Section, Row, NumberInput, ColorInput, Select, TextInput, Segmented, Toggle } from "@/editor/controls";
import { FillStack } from "@/editor/controls/FillStack";
import type { FillSpec } from "@engine/motion/fill";
import { SCENE_TRANSITION_SCHEMA, CAMERA_SCHEMA } from "@/editor/schema";
import { getByPath } from "@/editor/setByPath";
import { EasingChip } from "@/editor/controls";
import { KnobField } from "./KnobField";
import { Curve3DSection } from "./Curve3DSection";
import { docAudioClips, addAudioClipFromFile } from "@/editor/audioClips";
import { writeSceneField, deleteSceneField, writeElementField } from "./writes";
import { useEditor as store } from "@/editor/store";
import {
  getKeyframes,
  enableKeyframeCamera,
  clearCamera,
  addCameraKeyframeAt,
  updateCameraKeyframe,
  deleteCameraKeyframe,
  selectKeyframe,
  focusOnElement,
} from "@/editor/camera";
import { sceneStarts, sceneFrames } from "@/editor/timing";
import { getPlayer, seekTo, usePlayerFrame } from "@/editor/playerBridge";
import { sampleLightKeyframes } from "@engine/motion/lighting";
import { getLightKeyframes, isLightArmed, addLightKeyframeAt, deleteLightKeyframe, writeLightField, disarmLight, toggleLightAt, lightOnAt } from "@/editor/light";
import { uiConfirm } from "@/editor/ui/dialogs";
import { FPS } from "@/engine/normalize";
import s from "./inspector.module.css";
import type { SceneSpec } from "@engine/motion/SceneRenderer";

const TRANSITION_OPTS = [
  { value: "hard_cut", label: "Hard cut" },
  { value: "fade", label: "Fade" },
  ...Object.keys(SCENE_TRANSITION_SCHEMA).map((k) => ({ value: k, label: k })),
];
const CAMERA_OPTS = [
  { value: "none", label: "None" },
  ...Object.keys(CAMERA_SCHEMA).map((k) => ({ value: k, label: k })),
  { value: "keyframes", label: "Keyframes" },
];

function transitionType(t: SceneSpec["transition_out"]): string {
  if (t == null) return "hard_cut";
  if (typeof t === "string") return t;
  return t.type;
}

// --- 씬 배경 fill (Figma 식: 색 / 그라디언트 / 이미지 / 영상) ---
// 요소 FILL 과 동일한 하나의 스택. 씬에 fill 이 없으면 문서 기본
// (brandDefaults.background)이 렌더되므로 그 상속값을 그대로 보여주고,
// 편집하면 씬 fill 로 쓴다. 별도 "document default" UI 없음(통일).
function BackgroundEditor({ activeScene, bg }: { activeScene: number; bg: NonNullable<SceneSpec["background"]> }) {
  const docDefault = store((st) => st.doc?.brandDefaults?.background as FillSpec | undefined);
  const effective: FillSpec | undefined = bg.fill ?? bg.gradient ?? bg.color ?? docDefault;
  const setFill = (f: FillSpec | undefined) => {
    store.getState().updateDoc("Background", (d) => {
      const sc = d.scenes[activeScene];
      if (!sc.background) sc.background = {};
      // 통합: fill 하나로 관리. 기존 color/gradient 는 제거해 중복 렌더 방지.
      delete sc.background.color;
      delete sc.background.gradient;
      if (f == null) delete sc.background.fill;
      else sc.background.fill = f;
    });
  };
  return <FillStack fill={effective} onChange={setFill} label="" allowNone />;
}

// 키프레임 카메라 편집 — 자동키 토글 + 키프레임 추가 + 선택 키프레임의 값 편집.
function KeyframeCameraEditor({ sceneIdx }: { sceneIdx: number }) {
  const doc = store((st) => st.doc);
  const activeScene = store((st) => st.activeScene);
  const camManip = store((st) => st.ui.cameraManip);
  const selectedKf = store((st) => st.ui.selectedKeyframe);
  const selection = store((st) => st.selection);
  const setUI = store((st) => st.setUI);
  const scene = doc?.scenes[sceneIdx];
  const kfs = getKeyframes(scene);

  // 현재 플레이헤드의 씬 로컬 프레임
  const localFrame = () => {
    if (!doc) return 0;
    const starts = sceneStarts(doc, FPS);
    const gf = getPlayer()?.getCurrentFrame() ?? 0;
    return Math.max(0, Math.round(gf - (starts[sceneIdx] ?? 0)));
  };

  const sel = selectedKf?.sceneIdx === sceneIdx ? selectedKf.kfIndex : -1;
  const kf = sel >= 0 ? kfs[sel] : undefined;

  const w = (field: "scale" | "x" | "y" | "rotate" | "rotateX" | "rotateY" | "z", v: number, live: boolean) =>
    updateCameraKeyframe(sceneIdx, sel, { [field]: v }, live);

  const focusEl = selection.length === 1 ? selection[0] : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div className={s.camToggleRow}>
        <span className={s.camToggleLabel}>Canvas control</span>
        <Toggle on={camManip} aria-label="Control camera on canvas" onChange={(v) => setUI({ cameraManip: v })} />
      </div>
      {camManip && <div className={s.camManipHint}>Drag empty canvas = Pan · Wheel = Zoom → auto-keys at the playhead. (Dragging an element still edits the element.)</div>}
      <button
        className={s.kfAddBtn}
        onClick={() => { const idx = addCameraKeyframeAt(sceneIdx, localFrame()); if (idx >= 0) selectKeyframe(sceneIdx, idx); }}
      >
        + Add keyframe at playhead ({kfs.length})
      </button>
      {/* 선택 요소로 포커스(줌+센터) 키프레임 — 여러 요소 순차 포커스로 카메라 이동 */}
      <button
        className={s.kfFocusBtn}
        disabled={!focusEl}
        title={focusEl ? "Zoom + center the camera on the selected element" : "Select an element first"}
        onClick={() => { if (focusEl) { const idx = focusOnElement(sceneIdx, localFrame(), focusEl); if (idx >= 0) selectKeyframe(sceneIdx, idx); } }}
      >
        Focus on selected element
      </button>
      <div className={s.note}>Focus elements one per frame and the camera moves to highlight each. Drag/select diamonds on the track, double-click to delete.</div>

      {/* 이 씬의 카메라 키프레임 목록 — 클릭하면 선택 + 재생헤드 이동. 트랙 안 봐도 됨. */}
      {kfs.length > 0 && (
        <div className={s.kfList}>
          {kfs.map((k, i) => {
            const summary: string[] = [`${(k.scale ?? 1).toFixed(2)}×`];
            if ((k.x ?? 0) !== 0 || (k.y ?? 0) !== 0) summary.push("moved");
            if ((k.rotate ?? 0) !== 0 || (k.rotateX ?? 0) !== 0 || (k.rotateY ?? 0) !== 0) summary.push("rotated");
            return (
              <button
                key={i}
                className={s.kfListItem}
                data-active={i === sel}
                onClick={() => {
                  selectKeyframe(sceneIdx, i);
                  // 씬 안쪽으로 클램프 — 키프레임이 씬 끝 경계(f == 씬 길이)에
                  // 있으면 경계 프레임은 "다음 씬"으로 해석돼 activeScene 이
                  // 넘어가고 이 편집기 자체가 사라진다 (실측 리포트: f49).
                  if (doc) {
                    const sF = sceneFrames(doc.scenes[sceneIdx], FPS);
                    seekTo((sceneStarts(doc, FPS)[sceneIdx] ?? 0) + Math.min(k.frame, Math.max(0, sF - 1)));
                  }
                }}
              >
                <span className={s.kfListDiamond} />
                <span className={s.kfListFrame}>f{k.frame}</span>
                <span className={s.kfListSummary}>{summary.join(" · ")}</span>
              </button>
            );
          })}
        </div>
      )}

      {kf ? (
        <div className={s.kfEdit}>
          <div className={s.kfEditHead}>
            Keyframe f{kf.frame}
            <button className={s.kfDel} onClick={() => deleteCameraKeyframe(sceneIdx, sel)}>Delete</button>
          </div>
          <Row label="Zoom"><NumberInput value={kf.scale ?? 1} min={0.2} max={5} step={0.02} unit="×" onChange={(v, o) => w("scale", v, o.live)} /></Row>
          {/* 달리 — 시차가 생기는 진짜 전진/후퇴 (space:"3d" 씬 전용 의미). Zoom 은 시차 없는 렌즈 줌. */}
          <Row label="Dolly Z"><NumberInput value={(kf as { z?: number }).z ?? 0} min={-2} max={0.85} step={0.01} displayScale={100} unit="%" onChange={(v, o) => w("z", v, o.live)} /></Row>
          <Row label="Move X"><NumberInput value={kf.x ?? 0} min={-1} max={1} step={0.01} displayScale={100} unit="%" onChange={(v, o) => w("x", v, o.live)} /></Row>
          <Row label="Move Y"><NumberInput value={kf.y ?? 0} min={-1} max={1} step={0.01} displayScale={100} unit="%" onChange={(v, o) => w("y", v, o.live)} /></Row>
          <Row label="Rotate (2D)"><NumberInput value={kf.rotate ?? 0} min={-180} max={180} step={1} unit="°" onChange={(v, o) => w("rotate", v, o.live)} /></Row>
          <Row label="3D tilt X"><NumberInput value={kf.rotateX ?? 0} min={-360} max={360} step={1} unit="°" onChange={(v, o) => w("rotateX", v, o.live)} /></Row>
          <Row label="3D pan Y"><NumberInput value={kf.rotateY ?? 0} min={-360} max={360} step={1} unit="°" onChange={(v, o) => w("rotateY", v, o.live)} /></Row>
          <Row label="Easing (prev → this keyframe)">
            <EasingChip value={typeof kf.easing === "string" ? kf.easing : "easeInOut"} target={{ cameraKf: { sceneIdx: activeScene, kfIndex: sel }, value: typeof kf.easing === "string" ? kf.easing : undefined }} />
          </Row>
        </div>
      ) : (
        <div className={s.note}>Select a keyframe to edit zoom, move, and rotate.</div>
      )}
    </div>
  );
}

// Light 섹션 — 활성화 토글(1단계) + 키프레임 토글(2단계) + 필드 편집.
// armed(키 존재)면 필드 편집이 플레이헤드 키에 upsert(AE), 아니면 정적 base.
// 표시값은 항상 "그 프레임의 보간값" — 재생하며 확인 가능.
function LightSection({ activeScene, scene }: { activeScene: number; scene: SceneSpec }) {
  const doc = store((st) => st.doc);
  const gf = usePlayerFrame();
  const light = scene.light;
  const armed = isLightArmed(scene);
  const lf = doc ? Math.max(0, Math.round(gf - (sceneStarts(doc, FPS)[activeScene] ?? 0))) : 0;
  const cur = light ? sampleLightKeyframes(light, lf) : null;
  const kfs = getLightKeyframes(scene);
  const wl = (field: Parameters<typeof writeLightField>[1], v: number, live: boolean) =>
    writeLightField(activeScene, field, v, lf, live);

  return (
    <Section title="Light" defaultOpen={!!light}>
      <Row label="Enable">
        <Toggle
          on={!!light}
          onChange={(v) =>
            v
              ? writeSceneField(activeScene, "light", { azimuth: 135, elevation: 35, intensity: 0.8, ambient: 0.35 }, false, "Light")
              : deleteSceneField(activeScene, "light", "Light")
          }
          aria-label="Scene light"
        />
      </Row>
      {light && cur && (
        <>
          {/* 2단계: 키프레임 — 켜면 플레이헤드에 첫 키(현재 상태 캡처) */}
          <div className={s.camToggleRow}>
            <span className={s.camToggleLabel}>Animate (keyframes{armed ? ` · ${kfs.length}` : ""})</span>
            <Toggle
              on={armed}
              aria-label="Light keyframes"
              onChange={async (v) => {
                if (v) addLightKeyframeAt(activeScene, lf);
                else if (await uiConfirm("Remove all light keyframes?", { danger: true, okLabel: "Remove" })) disarmLight(activeScene, lf);
              }}
            />
          </div>
          {/* on/off 스텝 키 — 이 프레임부터 켜짐/꺼짐. 여러 번 토글 = 다중 구간
              (A on / B off / C on). 첫 키 이전 구간은 기본 켜짐. */}
          <div className={s.camToggleRow}>
            <span className={s.camToggleLabel}>On at playhead</span>
            <Toggle on={lightOnAt(light, lf)} aria-label="Light on/off at playhead" onChange={() => toggleLightAt(activeScene, lf)} />
          </div>
          <Row label="Type">
            <Segmented
              value={light.type === "point" ? "point" : "parallel"}
              options={[
                { value: "parallel", label: "Parallel" },
                { value: "point", label: "Point" },
              ]}
              onChange={(v) =>
                v === "point"
                  ? writeSceneField(activeScene, "light", { ...light, type: "point", position: light.position ?? { x: 0.35, y: 0.3, z: -25 }, falloff: light.falloff ?? 0.6 }, false, "Light type")
                  : writeSceneField(activeScene, "light", { ...light, type: "parallel" }, false, "Light type")
              }
            />
          </Row>
          {light.type === "point" ? (
            <>
              <Row label="Position X">
                <NumberInput value={(cur.position?.x ?? 0.35) * 100} min={-50} max={150} step={1} unit="%" onChange={(v, o) => wl("x", v / 100, o.live)} />
              </Row>
              <Row label="Position Y">
                <NumberInput value={(cur.position?.y ?? 0.3) * 100} min={-50} max={150} step={1} unit="%" onChange={(v, o) => wl("y", v / 100, o.live)} />
              </Row>
              <Row label="Position Z">
                <NumberInput value={cur.position?.z ?? -25} min={-200} max={100} step={1} unit="%" onChange={(v, o) => wl("z", v, o.live)} />
              </Row>
              <Row label="Falloff">
                <NumberInput value={(cur.falloff ?? 0.6) * 100} min={10} max={200} step={5} unit="%" onChange={(v, o) => wl("falloff", v / 100, o.live)} />
              </Row>
            </>
          ) : (
            <>
              <Row label="Direction">
                <NumberInput value={cur.azimuth ?? 90} min={0} max={360} step={5} unit="deg" onChange={(v, o) => wl("azimuth", v, o.live)} />
              </Row>
              <Row label="Elevation">
                <NumberInput value={cur.elevation ?? 35} min={0} max={90} step={5} unit="deg" onChange={(v, o) => wl("elevation", v, o.live)} />
              </Row>
            </>
          )}
          <Row label="Intensity">
            <NumberInput value={cur.intensity ?? 0.8} min={0} max={1.5} step={0.05} displayScale={100} unit="%" onChange={(v, o) => wl("intensity", v, o.live)} />
          </Row>
          <Row label="Ambient">
            <NumberInput value={cur.ambient ?? 0.35} min={0} max={1} step={0.05} displayScale={100} unit="%" onChange={(v, o) => wl("ambient", v, o.live)} />
          </Row>
          <Row label="Color">
            <ColorInput value={light.color ?? "#FFFFFF"} onChange={(v) => v && writeSceneField(activeScene, "light.color", v, false, "Light color")} />
          </Row>
          {/* 키프레임 목록 — 클릭 = 그 프레임으로 시크 (카메라 목록과 동일 문법) */}
          {armed && (
            <div className={s.kfList}>
              {kfs.map((k, i) => (
                <div
                  key={i}
                  className={s.kfListItem}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    // 카메라 kf 목록과 동일 — 씬 끝 경계 키프레임 클릭 시 씬 이탈 방지
                    if (doc) {
                      const sF = sceneFrames(doc.scenes[activeScene], FPS);
                      seekTo((sceneStarts(doc, FPS)[activeScene] ?? 0) + Math.min(k.frame, Math.max(0, sF - 1)));
                    }
                  }}
                >
                  <span className={s.kfListDiamond} style={{ background: "#FDE047" }} />
                  <span className={s.kfListFrame}>f{k.frame}</span>
                  <span className={s.kfListSummary}>
                    {light.type === "point" ? `${Math.round((k.x ?? 0.35) * 100)}%, ${Math.round((k.y ?? 0.3) * 100)}%` : `${Math.round(k.azimuth ?? 135)}deg`} · {Math.round((k.intensity ?? 0.8) * 100)}%
                  </span>
                  <button
                    className={s.kfDel}
                    onClick={(e) => { e.stopPropagation(); deleteLightKeyframe(activeScene, i); }}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className={s.hint}>
            2D 씬 + Point 라이트는 화면에 실제 빛 풀이 비친다 (관찰자 = 정면
            광원). 3D/기울어진 요소는 자세에 따라 밝기가 변한다 (AE Material).
          </div>
        </>
      )}
    </Section>
  );
}


// 오디오 레인 요약 — 문서 레벨 클립 목록 (음악은 전 씬 관통, SFX 는 프레임에
// 얹기). 데이터는 타임라인 하단 오디오 레인과 동일 — 클립을 클릭하면 상세
// 편집(볼륨/페이드/트림/BPM)이 Audio clip 인스펙터로 뜬다.
function AudioSection() {
  const doc = useEditor((st) => st.doc);
  const selectedAudio = useEditor((st) => st.ui.selectedAudio);
  const clips = docAudioClips(doc);
  return (
    <Section title="Audio" defaultOpen={clips.length > 0}>
      {clips.map((c) => {
        const start = c.start ?? 0;
        const durF = c.duration;
        return (
          <Row key={c.id} label="" wide>
            <button
              style={{
                width: "100%", height: 26, borderRadius: 6, padding: "0 8px", fontSize: 12,
                display: "flex", alignItems: "center", gap: 8, textAlign: "left",
                background: selectedAudio.includes(c.id ?? "") ? "var(--accent-muted)" : "var(--bg-inset)",
                color: "var(--text-2)",
              }}
              onClick={() => {
                const st = useEditor.getState();
                st.clearSelection();
                st.setUI({ selectedAudio: c.id ? [c.id] : [] });
              }}
              title={c.src}
            >
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {c.name ?? c.src.split("/").pop()}
              </span>
              <span style={{ color: "var(--text-4)", fontSize: 10, flex: "none" }}>
                f{start}{durF != null ? `–${start + durF}` : "+"}{c.bpm ? ` · ${c.bpm}BPM` : ""}
              </span>
            </button>
          </Row>
        );
      })}
      <Row label="" wide>
        <button
          style={{ width: "100%", height: 24, borderRadius: 6, background: "var(--bg-inset)", color: "var(--text-3)", fontSize: 11 }}
          onClick={() => addAudioClipFromFile(Math.round(getPlayer()?.getCurrentFrame() ?? 0))}
        >
          + Add audio at playhead
        </button>
      </Row>
      {clips.length === 0 && (
        <div className={s.hint}>
          음악 하나가 씬 경계와 무관하게 전체 영상을 관통하고, 효과음 클립을
          원하는 프레임에 얹는다. 타임라인 하단 Audio 레인에서 이동·트림·분할.
        </div>
      )}
    </Section>
  );
}

export function SceneInspector() {
  const doc = useEditor((st) => st.doc);
  const activeScene = useEditor((st) => st.activeScene);
  if (!doc) return <div className={s.hint}>No spec</div>;
  const scene = doc.scenes[activeScene];
  if (!scene) return <div className={s.hint}>No scene</div>;

  const tType = transitionType(scene.transition_out);
  const camType = scene.camera?.type ?? "none";
  const bg = scene.background ?? {};

  const setTransition = (type: string) => {
    if (type === "hard_cut") deleteSceneField(activeScene, "transition_out", "Transition");
    else if (type === "fade") writeSceneField(activeScene, "transition_out", "fade", false, "Transition");
    else {
      const built = SCENE_TRANSITION_SCHEMA[type]?.defaultProps();
      writeSceneField(activeScene, "transition_out", built, false, "Transition");
    }
  };
  const setCamera = (type: string) => {
    if (type === "none") clearCamera(activeScene);
    else if (type === "keyframes") enableKeyframeCamera(activeScene);
    else {
      const built = CAMERA_SCHEMA[type]?.defaultProps();
      writeSceneField(activeScene, "camera", built, false, "Camera");
    }
  };

  const transitionKnobs =
    tType !== "hard_cut" && tType !== "fade" ? SCENE_TRANSITION_SCHEMA[tType]?.knobs ?? [] : [];
  const cameraKnobs = camType !== "none" ? CAMERA_SCHEMA[camType]?.knobs ?? [] : [];

  return (
    <div className={s.body}>
      <div className={s.elHeader}>
        <span className={s.elKind}>Scene</span>
        <TextInput value={scene.id ?? ""} placeholder={`Scene ${activeScene + 1}`} onChange={() => {}} onCommit={(v) => writeSceneField(activeScene, "id", v || undefined, false, "Scene name")} />
      </div>

      {/* 씬 공간 모드 — 3D 면 요소 전부가 하나의 원근 아래 실제 깊이(z)를 갖는다.
          AE 의 레이어별 3D 스위치 대신 씬 단위 (flatten 사고 방지 설계). */}
      <Section title="Space">
        <Row label="Mode">
          <Segmented
            value={scene.space === "3d" ? "3d" : "2d"}
            options={[
              { value: "2d", label: "2D" },
              { value: "3d", label: "3D" },
            ]}
            onChange={(v) => (v === "3d" ? writeSceneField(activeScene, "space", "3d", false, "Scene space") : deleteSceneField(activeScene, "space", "Scene space"))}
          />
        </Row>
        {scene.space === "3d" && (
          <Row label="Perspective">
            {/* AE 카메라 zoom 등가 (px) — 작을수록 광각(원근 왜곡 큼). 기본 50mm = width x 1.3889 */}
            <NumberInput value={scene.perspective ?? 2667} min={500} max={8000} step={10} unit="px" onChange={(v, o) => writeSceneField(activeScene, "perspective", v, o.live, "Perspective")} />
          </Row>
        )}
        {scene.space === "3d" && (
          <div className={s.hint}>
            모든 요소가 실제 깊이를 가진다: Transform 의 Depth Z 로 뒤로 밀고,
            카메라 Keyframes 의 Dolly Z / 3D pan 으로 돌려보면 시차와 깊이 가림이
            드러난다. 궤도(Orbit) 그룹은 진짜 3D 로 돌고 Pin 요소와 자연 가림.
          </div>
        )}
      </Section>

      <Section title="Camera">
        <Row label="Type">
          <Select value={camType} options={CAMERA_OPTS} onChange={setCamera} />
        </Row>
        {camType !== "keyframes" && cameraKnobs.map((k) => (
          <KnobField key={k.path} knob={k} value={getByPath(scene.camera, k.path)} onChange={(v, o) => writeSceneField(activeScene, `camera.${k.path}`, v, o.live, k.label)} />
        ))}
        {camType === "keyframes" && <KeyframeCameraEditor sceneIdx={activeScene} />}
      </Section>

      <LightSection activeScene={activeScene} scene={scene} />

      <Section title="Timing">
        <Row label="Duration">
          <NumberInput value={scene.duration ?? 2.5} min={0.3} max={30} step={0.1} unit="s" disabled={scene.fit === "auto"} onChange={(v, o) => writeSceneField(activeScene, "duration", v, o.live, "Scene duration")} />
        </Row>
        <Row label="Fit">
          <Segmented value={scene.fit ?? "fixed"} options={[{ value: "fixed", label: "Fixed" }, { value: "auto", label: "Auto" }]} onChange={(v) => writeSceneField(activeScene, "fit", v, false, "Scene fit")} />
        </Row>
        {scene.fit === "auto" && <div className={s.note}>Auto: duration computed from content length (duration not editable)</div>}
      </Section>

      <Section title="Fill">
        <BackgroundEditor activeScene={activeScene} bg={bg} />
        <Row label="Fade in frame">
          <NumberInput value={bg.fadeInFrame ?? 0} min={0} max={120} step={1} unit="f" onChange={(v, o) => v > 0 ? writeSceneField(activeScene, "background.fadeInFrame", v, o.live, "Background fade in") : deleteSceneField(activeScene, "background.fadeInFrame", "Background fade in")} />
        </Row>
        {bg.fadeInFrame != null && bg.fadeInFrame > 0 && (
          <Row label="Fade duration">
            <NumberInput value={bg.fadeDuration ?? 8} min={1} max={60} step={1} unit="f" onChange={(v, o) => writeSceneField(activeScene, "background.fadeDuration", v, o.live, "Background fade duration")} />
          </Row>
        )}
      </Section>

      <Section title="Transition (to next scene)">
        <Row label="Type">
          <Select value={tType} options={TRANSITION_OPTS} onChange={setTransition} />
        </Row>
        {transitionKnobs.map((k) => (
          <KnobField key={k.path} knob={k} value={getByPath(scene.transition_out, k.path)} onChange={(v, o) => writeSceneField(activeScene, `transition_out.${k.path}`, v, o.live, k.label)} />
        ))}
      </Section>

      {/* 씬 레벨 3D 캔버스 — 씬의 모든 최상위 요소가 곡면 위에 놓인다.
          주의(과거 제거 사유): 곡면 슬라이스가 씬 전체를 복제하므로 디바이스/
          영상/셰이더가 많은 씬은 무겁다. 그런 씬은 휠 콘텐츠만 group/frame 에
          모아 그 컨테이너의 3D canvas 를 쓰는 게 정석 — 힌트로 안내. */}
      <AudioSection />

      <Curve3DSection
        curve={scene.curve3d}
        write={(f, v, live) => writeSceneField(activeScene, `curve3d.${f}`, v, live, "3D canvas")}
        remove={() => deleteSceneField(activeScene, "curve3d", "3D canvas")}
      />
      {scene.curve3d && (
        <div className={s.hint}>
          씬 전체를 휘는 건 무겁습니다 (디바이스/영상/셰이더 복제). 곡면이 필요한
          콘텐츠만 group/frame 에 모아 그 컨테이너의 3D Canvas 를 쓰는 걸 권장.
        </div>
      )}

    </div>
  );
}
