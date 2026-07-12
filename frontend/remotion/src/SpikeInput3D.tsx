// THROWAWAY SPIKE #2 — tests a harder camera scenario the user asked for:
//   1) zoom in to the FRONT/START of a 3D input field
//   2) typing effect fills the field
//   3) camera FOLLOWS the caret as text grows (truck right)
//   4) zoom OUT while SIMULTANEOUSLY swinging to an oblique side view
//      (two moves at once — the real test of compound camera motion)
//
// UI = a real 3D rounded slab (drei RoundedBox, top-lit for depth), dark and
// crisp — deliberately not the glassy/gradient "AI look".
// Determinism: camera driven by useCurrentFrame() only; no useFrame().
import React, { useMemo } from "react";
import * as THREE from "three";
import {
  useCurrentFrame,
  interpolate,
  Easing,
  AbsoluteFill,
} from "remotion";
import { ThreeCanvas } from "@remotion/three";
import { useThree } from "@react-three/fiber";
import { RoundedBox } from "@react-three/drei";

const PROMPT = "a launch ad for my app";

// --- text measuring (shared by the typing plane AND the caret/camera) ---
const FONT_PX = 340;
const TEXT_WORLD_H = 0.95; // text cap height in world units
const CANVAS_H = FONT_PX + 48;
const W_PER_PX = TEXT_WORLD_H / CANVAS_H;
const FONT_CSS = `600 ${FONT_PX}px sans-serif`;

function pxWidth(s: string): number {
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = FONT_CSS;
  return ctx.measureText(s).width;
}
function worldWidth(s: string): number {
  return pxWidth(s) * W_PER_PX;
}

// --- field geometry ---
const BOX_W = 11.5;
const BOX_H = 1.8;
const BOX_D = 0.6;
const TEXT_LEFT = -5.0; // inner-left padding from box edge
const TEXT_Z = BOX_D / 2 + 0.03;

// --- timeline (frames) ---
const ZOOM_IN_END = 24;
const TYPE_START = 30;
const TYPE_END = 80;
const FOLLOW_END = 84;
const TOTAL = 115;

const easeIO = Easing.inOut(Easing.cubic);

function typeProgress(frame: number): number {
  return interpolate(frame, [TYPE_START, TYPE_END], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}
function caretX(frame: number): number {
  // continuous (smooth) caret X so the camera glides; glyphs still pop in
  return TEXT_LEFT + worldWidth(PROMPT) * typeProgress(frame);
}

function makeTextTexture(text: string, color: string) {
  const w = Math.ceil(pxWidth(text)) + 4;
  const c = document.createElement("canvas");
  c.width = Math.max(2, w);
  c.height = CANVAS_H;
  const ctx = c.getContext("2d")!;
  ctx.font = FONT_CSS;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  ctx.fillText(text, 0, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 16;
  tex.needsUpdate = true;
  return { tex, aspect: c.width / c.height };
}

const TypedText: React.FC<{ frame: number }> = ({ frame }) => {
  const count = Math.floor(typeProgress(frame) * PROMPT.length);
  const sub = PROMPT.slice(0, count);
  const data = useMemo(
    () => (sub.length ? makeTextTexture(sub, "#F2F1F6") : null),
    [sub],
  );
  if (!data) return null;
  const planeW = TEXT_WORLD_H * data.aspect;
  return (
    <mesh position={[TEXT_LEFT + planeW / 2, 0, TEXT_Z]}>
      <planeGeometry args={[planeW, TEXT_WORLD_H]} />
      <meshBasicMaterial map={data.tex} transparent toneMapped={false} />
    </mesh>
  );
};

const Caret: React.FC<{ frame: number }> = ({ frame }) => {
  if (frame < 20 || frame > 96) return null;
  const typing = frame >= TYPE_START && frame <= TYPE_END;
  const blinkOn = Math.floor(frame / 8) % 2 === 0;
  if (!typing && !blinkOn) return null;
  return (
    <mesh position={[caretX(frame) + 0.06, 0, TEXT_Z]}>
      <planeGeometry args={[0.07, TEXT_WORLD_H * 0.92]} />
      <meshBasicMaterial color="#FF5C7A" toneMapped={false} />
    </mesh>
  );
};

const InputField: React.FC = () => (
  <RoundedBox args={[BOX_W, BOX_H, BOX_D]} radius={0.18} smoothness={5}>
    <meshStandardMaterial color="#17151C" roughness={0.55} metalness={0.15} />
  </RoundedBox>
);

const CameraRig: React.FC = () => {
  const frame = useCurrentFrame();
  const camera = useThree((s) => s.camera);
  const fullRight = TEXT_LEFT + worldWidth(PROMPT);

  let x: number;
  let z: number;
  let y = 0;
  let lookX: number;

  if (frame <= ZOOM_IN_END) {
    // Phase 1: dolly + pan into the START (left) of the field.
    x = interpolate(frame, [0, ZOOM_IN_END], [0, TEXT_LEFT], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: easeIO,
    });
    z = interpolate(frame, [0, ZOOM_IN_END], [10, 3.2], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    });
    lookX = interpolate(frame, [0, ZOOM_IN_END], [0, TEXT_LEFT], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: easeIO,
    });
  } else if (frame <= FOLLOW_END) {
    // Phase 2: follow the caret (camera trucks right, stays close).
    x = caretX(frame);
    z = 3.2;
    lookX = caretX(frame);
  } else {
    // Phase 3: zoom OUT + orbit to the side, BOTH at once.
    x = interpolate(frame, [FOLLOW_END, TOTAL], [fullRight, 6], {
      extrapolateRight: "clamp",
      easing: easeIO,
    });
    z = interpolate(frame, [FOLLOW_END, TOTAL], [3.2, 12], {
      extrapolateRight: "clamp",
      easing: easeIO,
    });
    y = interpolate(frame, [FOLLOW_END, TOTAL], [0, 2.2], {
      extrapolateRight: "clamp",
      easing: easeIO,
    });
    lookX = interpolate(frame, [FOLLOW_END, TOTAL], [fullRight, 0], {
      extrapolateRight: "clamp",
      easing: easeIO,
    });
  }

  camera.position.set(x, y, z);
  camera.lookAt(lookX, 0, 0);
  camera.updateProjectionMatrix();
  return null;
};

export const SpikeInput3D: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ backgroundColor: "#0B0A0E" }}>
      <ThreeCanvas
        width={1920}
        height={1080}
        camera={{ fov: 45, position: [0, 0, 10], near: 0.1, far: 1000 }}
        style={{ backgroundColor: "#0B0A0E" }}
      >
        <color attach="background" args={["#0B0A0E"]} />
        <ambientLight intensity={0.65} />
        <directionalLight position={[3, 7, 6]} intensity={1.15} />
        <directionalLight position={[-5, 2, 3]} intensity={0.25} />
        <CameraRig />
        <InputField />
        <TypedText frame={frame} />
        <Caret frame={frame} />
      </ThreeCanvas>
    </AbsoluteFill>
  );
};
