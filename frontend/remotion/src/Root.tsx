import React from "react";
import { Composition, staticFile, delayRender, continueRender } from "remotion";
import { loadFont as loadFamiljenGrotesk } from "@remotion/google-fonts/FamiljenGrotesk";
import { loadFont as loadSyne } from "@remotion/google-fonts/Syne";
import { loadFont as loadGeist } from "@remotion/google-fonts/Geist";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { Ad, totalFrames, type SceneSpec, type VideoSpec } from "./motion/SceneRenderer";
import { composeVideo, composeAd } from "./compose/compose";
import { COMPOSE_SAMPLE } from "./compose/sample";
import { AD_SAMPLE } from "./compose/adSample";
import { BASE44_AD } from "./compose/base44Ad";
import { TRANSITIONS_SAMPLE } from "./compose/transitionsSample";
import demoSpec from "./demo-spec.json";
import generatedSpec from "./generated-spec.json";
import { LabStage, labSchema } from "./Lab";
import { Spike3D } from "./Spike3D";
import { SpikeInput3D } from "./SpikeInput3D";
import { CapturedScene } from "./CapturedScene";
import { capturedFrames, LOVABLE_SPEC, type CapturedAdSpec } from "./captured/spec";
import { BOLT_SPEC, BOLT_VARIETY_SPEC } from "./captured/boltSpec";
import { FullAd, fullAdFrames, type BrandInfo } from "./captured/fullAd";
import { Scene24Ad, SCENE24_AD_FRAMES } from "./Scene24Ad";
import { LovableAd, LOVABLE_AD_FRAMES } from "./LovableAd";
import { expandPresetScene, isPresetName, type Brand } from "./presets";

// Familjen Grotesk: stand-in for Base44's proprietary Miso (humanist-geometric).
// Specs request it via `brand.fontFamily: "Familjen Grotesk"`.
loadFamiljenGrotesk("normal", { weights: ["400", "500", "600", "700"] });
// Syne: Scene24's actual wordmark font (per its logo SVG). Loaded
// alongside Familjen Grotesk so a scene can opt into it via the
// `fontFamily` knob on any preset.
loadSyne("normal", { weights: ["500", "600", "700", "800"] });
// Geist: biasafe 레퍼런스 폰트(모던 그로테스크). spec이 fontFamily:"Geist"로 요청.
loadGeist("normal", { weights: ["400", "500", "600", "700"] });
// Inter: designverse-fst(05 much-faster 등)가 fontFamily:"Inter" 로 요청하는데
// 지금까지 로드가 안 돼서 fallback 폰트로 렌더됐다. 로드해야 원본 폰트로 그려지고
// 규격선 실측 좌표(PIL 측정)도 렌더와 일치한다.
loadInter("normal", { weights: ["400", "500", "600", "700", "800"] });

// General Sans (Fontshare, ITF Free License) — 로컬 static OTF 를 weight 별로
// 로드. Variable TTF 를 쓰면 애니메이션(scale/rotateY) 중 보간 weight 가 매
// 프레임 re-rasterize 되며 sub-pixel hinting 이 미세하게 흔들려 버벅인다.
// static instance 는 weight 별 고정 hinting 이라 애니 중에도 안정적.
const GS_DIR = "fonts/GeneralSans_Complete/Fonts/OTF";
const GS_WEIGHTS: [string, number][] = [
  ["GeneralSans-Extralight.otf", 200],
  ["GeneralSans-Light.otf", 300],
  ["GeneralSans-Regular.otf", 400],
  ["GeneralSans-Medium.otf", 500],
  ["GeneralSans-Semibold.otf", 600],
  ["GeneralSans-Bold.otf", 700],
];
for (const [file, wt] of GS_WEIGHTS) {
  const handle = delayRender(`general-sans-${wt}`);
  // 실패 시 조용히 폴백하면 "그 탭만 폴백 폰트"로 찍혀 렌더가 비결정적이 된다
  // (실측: device-demo 2회 렌더에서 캡션 줄만 탭 단위로 발산). 3회 재시도 후에도
  // 실패하면 크게 로그 — 폴백 진행은 하되 원인이 침묵하지 않게.
  const load = (attempt: number) => {
    new FontFace("General Sans", `url(${staticFile(`${GS_DIR}/${file}`)}) format("opentype")`, {
      weight: String(wt),
    })
      .load()
      .then((loaded) => {
        document.fonts.add(loaded);
        continueRender(handle);
      })
      .catch((err) => {
        if (attempt < 3) {
          setTimeout(() => load(attempt + 1), 300 * attempt);
        } else {
          // eslint-disable-next-line no-console
          console.error(`[fonts] General Sans ${wt} 로드 3회 실패 — 폴백 폰트로 진행 (비결정 위험)`, err);
          continueRender(handle);
        }
      });
  };
  load(1);
}

const FPS = 24;

const SpecVideo: React.FC<{ spec: VideoSpec }> = ({ spec }) => (
  <Ad spec={spec} />
);

// Drop any *.json under src/specs/ and it shows up as its own Studio
// composition. Three accepted shapes:
//   - full VideoSpec : { fps?, brand? | brandDefaults?, scenes: [...] }
//     scenes may be a full SceneSpec OR a preset scene: { preset, ...knobs }
//   - single scene   : { id, duration, elements: [...], ... }
//   - single preset  : { preset, ...knobs }
const SINGLE_SCENE_DEFAULTS: Brand = {
  background: "#0D0B10",
  fontFamily: "General Sans, Inter, Helvetica, Arial, sans-serif",
  colors: ["#7C4DFF", "#FF4D9D", "#4D7DFF"],
};

type PresetSceneInput = { preset: string } & Record<string, unknown>;
type RawScene = SceneSpec | PresetSceneInput;
type RawVideoSpec = {
  fps?: number;
  brand?: Brand;
  brandDefaults?: Brand;
  scenes: RawScene[];
};

function isPresetScene(s: RawScene): s is PresetSceneInput {
  return typeof (s as PresetSceneInput).preset === "string";
}

function expandScene(raw: RawScene, brand: Brand): SceneSpec {
  if (!isPresetScene(raw)) return raw;
  const { preset, ...knobs } = raw;
  if (!isPresetName(preset)) {
    throw new Error(`Unknown preset "${preset}". Expected one of: punch, statement, beat, hero_zoom.`);
  }
  return expandPresetScene(preset, knobs, { brand });
}

function normalizeSpec(raw: unknown): VideoSpec {
  const obj = raw as Partial<RawVideoSpec> & Partial<SceneSpec> & Partial<PresetSceneInput>;

  // Multi-scene VideoSpec (with optional preset scenes + brand alias).
  if (Array.isArray(obj.scenes)) {
    const brand = obj.brand ?? obj.brandDefaults ?? SINGLE_SCENE_DEFAULTS;
    // audio 는 재구성 시 버리면 익스포트(mp4)가 무음이 된다 — 반드시 통과.
    const audio = (obj as { audio?: VideoSpec["audio"] }).audio;
    return {
      fps: obj.fps ?? FPS,
      brandDefaults: brand,
      scenes: obj.scenes.map((s) => expandScene(s, brand)),
      ...(audio ? { audio } : {}),
    };
  }

  // Single-scene preset shorthand.
  if (typeof obj.preset === "string") {
    const brand = SINGLE_SCENE_DEFAULTS;
    return {
      fps: FPS,
      brandDefaults: brand,
      scenes: [expandScene(obj as PresetSceneInput, brand)],
    };
  }

  // Single full SceneSpec.
  if (Array.isArray(obj.elements)) {
    return {
      fps: FPS,
      brandDefaults: SINGLE_SCENE_DEFAULTS,
      scenes: [obj as SceneSpec],
    };
  }

  throw new Error(
    "specs/*.json must be a VideoSpec (`scenes`), a single scene (`elements`), or a preset (`preset`).",
  );
}

// Recursive — picks up specs/preset/*.json and specs/raw/*.json. The
// folder prefix is folded into the composition id with `-` (Remotion
// composition ids must be [a-zA-Z0-9-_]+, no slashes), giving e.g.
// "preset-punch" and "raw-foo" so Studio's list keeps the two groups
// visually adjacent.
const specsCtx = require.context("./specs/", true, /\.json$/);
const autoSpecs = specsCtx.keys().map((key) => {
  const id = key
    .replace(/^\.\//, "")
    .replace(/\.json$/, "")
    .replace(/\//g, "-");
  return { id, spec: normalizeSpec(specsCtx(key)) };
});

export const RemotionRoot: React.FC = () => {
  // Run both through normalizeSpec so preset scenes ({ preset, ...knobs })
  // expand into full SceneSpecs. generate.mjs now emits preset scenes, so
  // skipping this left the Generated composition blank (no elements to
  // render). The auto-registered specs/*.json already go through it.
  const demo = normalizeSpec(demoSpec);
  const generated = normalizeSpec(generatedSpec);
  // compose 계층 데모: sample.ts 의 조합 -> 실제 렌더 스펙. 스튜디오 "Compose".
  const composed = composeVideo(COMPOSE_SAMPLE).spec as unknown as VideoSpec;
  // 씬 레벨 조합(LLM 이 뱉었다 가정한 광고 한 편) -> 스튜디오 "ComposeAd".
  const composedAd = composeAd(AD_SAMPLE).spec as unknown as VideoSpec;
  // Base44 브랜딩 시네마틱 광고(우리 효과 조합) -> 스튜디오 "Base44Ad".
  const composedBase44 = composeAd(BASE44_AD).spec as unknown as VideoSpec;
  // A축(shrink_out/fly_out/typewriter_erase) + B축(scene transitionOut/camera)
  // 을 compose() 를 통과시켜 검증 -> 스튜디오 "ComposeTransitions"
  // (2026-07-07 감사: raw SceneSpec 서베이는 specs/survey/ 에 별도로 있음).
  const composedTransitions = composeAd(TRANSITIONS_SAMPLE).spec as unknown as VideoSpec;
  return (
    <>
      <Composition
        id="Demo"
        component={SpecVideo}
        durationInFrames={Math.max(1, totalFrames(demo, FPS))}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={{ spec: demo }}
      />
      <Composition
        id="Generated"
        component={SpecVideo}
        durationInFrames={Math.max(1, totalFrames(generated, FPS))}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={{ spec: generated }}
      />
      <Composition
        id="Compose"
        component={SpecVideo}
        durationInFrames={Math.max(1, totalFrames(composed, FPS))}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={{ spec: composed }}
      />
      <Composition
        id="ComposeAd"
        component={SpecVideo}
        durationInFrames={Math.max(1, totalFrames(composedAd, FPS))}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={{ spec: composedAd }}
      />
      <Composition
        id="Base44Ad"
        component={SpecVideo}
        durationInFrames={Math.max(1, totalFrames(composedBase44, FPS))}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={{ spec: composedBase44 }}
      />
      <Composition
        id="ComposeTransitions"
        component={SpecVideo}
        durationInFrames={Math.max(1, totalFrames(composedTransitions, FPS))}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={{ spec: composedTransitions }}
      />
      <Composition
        id="Lab"
        component={LabStage}
        schema={labSchema}
        durationInFrames={72}
        fps={24}
        width={1920}
        height={1080}
        defaultProps={{
          text: "Possibilities",
          atomType: "scale" as const,
          duration: 18,
          easing: "easeInCirc" as const,
          fontSize: 10,
          glow: true,
          showReference: false,
          referenceStartSec: 0,
        }}
      />
      <Composition
        id="Spike3D"
        component={Spike3D}
        durationInFrames={90}
        fps={FPS}
        width={1920}
        height={1080}
      />
      <Composition
        id="SpikeInput3D"
        component={SpikeInput3D}
        durationInFrames={115}
        fps={FPS}
        width={1920}
        height={1080}
      />
      <Composition
        id="CapturedV1"
        component={CapturedScene}
        durationInFrames={110}
        fps={FPS}
        width={1440}
        height={900}
        defaultProps={{ mode: "image" as const }}
      />
      <Composition
        id="CapturedV2"
        component={CapturedScene}
        durationInFrames={148}
        fps={FPS}
        width={1440}
        height={900}
        defaultProps={{ mode: "code" as const }}
      />
      <Composition
        id="CapturedBolt"
        component={CapturedScene}
        durationInFrames={capturedFrames(BOLT_SPEC)}
        fps={FPS}
        width={1440}
        height={900}
        defaultProps={{ mode: "code" as const, spec: BOLT_SPEC }}
      />
      <Composition
        id="CapturedBoltVariety"
        component={CapturedScene}
        durationInFrames={capturedFrames(BOLT_VARIETY_SPEC)}
        fps={FPS}
        width={1440}
        height={900}
        defaultProps={{ mode: "code" as const, spec: BOLT_VARIETY_SPEC }}
      />
      {/* generic: 임의 캡쳐 spec 을 --props 로 받아 렌더. 길이/해상도는 spec 에서 계산.
          npx remotion render src/index.ts CapturedAuto out.mp4 --props=<dir>/props.json */}
      <Composition
        id="CapturedAuto"
        component={CapturedScene}
        defaultProps={{ mode: "code" as const, spec: LOVABLE_SPEC }}
        fps={FPS}
        width={1440}
        height={900}
        calculateMetadata={({ props }) => {
          const spec = props.spec as CapturedAdSpec;
          return {
            durationInFrames: Math.max(1, capturedFrames(spec)),
            width: spec.capture.viewport.w,
            height: spec.capture.viewport.h,
          };
        }}
      />
      {/* generic 완성 광고: 캡쳐 씬 + 브랜드 아웃트로. --props 로 {captured, brand}.
          npx remotion render src/index.ts FullAd out.mp4 --props=<dir>/fullad.json */}
      <Composition
        id="FullAd"
        component={FullAd}
        defaultProps={{
          captured: LOVABLE_SPEC,
          brand: {
            name: "Lovable",
            tagline: "you describe it, we build it",
            colors: ["#5B8CFF", "#FF5CA8", "#FF9A5C"],
            background: "#0B0A0E",
          } as BrandInfo,
        }}
        fps={FPS}
        width={1440}
        height={900}
        calculateMetadata={({ props }) => ({
          durationInFrames: Math.max(1, fullAdFrames(props.captured as CapturedAdSpec, props.brand as BrandInfo)),
          width: (props.captured as CapturedAdSpec).capture.viewport.w,
          height: (props.captured as CapturedAdSpec).capture.viewport.h,
        })}
      />
      {/* Scene24 self-ad — 인스타 4:5 세로, 2026 디자인 */}
      <Composition
        id="Scene24Ad"
        component={Scene24Ad}
        durationInFrames={SCENE24_AD_FRAMES}
        fps={FPS}
        width={1080}
        height={1350}
      />
      <Composition
        id="LovableAd"
        component={LovableAd}
        durationInFrames={LOVABLE_AD_FRAMES}
        fps={FPS}
        width={1440}
        height={900}
      />
      {autoSpecs.map(({ id, spec }) => (
        <Composition
          key={id}
          id={id}
          component={SpecVideo}
          durationInFrames={Math.max(1, totalFrames(spec, FPS))}
          fps={FPS}
          width={1920}
          height={1080}
          defaultProps={{ spec }}
        />
      ))}
    </>
  );
};
