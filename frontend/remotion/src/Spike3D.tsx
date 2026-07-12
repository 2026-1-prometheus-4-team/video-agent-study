// THROWAWAY SPIKE — answers: does a real @remotion/three PerspectiveCamera
// give us AE-style 3D moves (dolly in, orbit to the side, lateral truck with
// parallax), and how does text-on-a-plane look as the camera moves around it?
//
// Determinism: camera is driven by useCurrentFrame() ONLY (no useFrame()).
// ThreeCanvas forces frameloop="never".
//
// Text approach here = "postcard in space" (AE's actual 3D-layer model): each
// word is drawn to a 2D canvas, used as a texture on a flat plane in 3D. Robust
// and always renders. Tradeoff vs SDF text (troika): a texture blurs when the
// camera zooms in past its resolution; SDF stays crisp but did NOT render under
// Remotion's headless angle GL in this spike (layout worked, SDF atlas blank).
import React, { useMemo } from "react";
import * as THREE from "three";
import {
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
  spring,
  AbsoluteFill,
} from "remotion";
import { ThreeCanvas } from "@remotion/three";
import { useThree } from "@react-three/fiber";

// Draw a word to a canvas -> CanvasTexture + its aspect ratio.
function makeTextTexture(text: string, color: string) {
  const fontPx = 220;
  const pad = 48;
  const probe = document.createElement("canvas").getContext("2d")!;
  probe.font = `bold ${fontPx}px sans-serif`;
  const w = Math.ceil(probe.measureText(text).width) + pad * 2;
  const h = fontPx + pad * 2;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.font = `bold ${fontPx}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  ctx.fillText(text, w / 2, h / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 16;
  tex.needsUpdate = true;
  return { tex, aspect: w / h };
}

// AE-style camera path over 90 frames, three phases:
//   0-30  dolly in   : straight push toward the text (position.z shrinks)
//   30-60 orbit side : swing out to the right + up, keep looking at center
//                      -> "옆에서 비스듬히 보기" (oblique/side view)
//   60-90 truck      : slide laterally while still facing center -> parallax
function cameraPath(frame: number, fps: number) {
  // Each axis can have its OWN easing curve — exactly like AE's per-property
  // bezier velocity handles. Here:
  //   x (truck/orbit) : ease-in-out cubic  -> smooth accel + decel each leg
  //   z (dolly)       : ease-OUT cubic     -> rushes in, slows as it arrives
  //   y (rise)        : spring             -> overshoots slightly then settles
  const easeIO = Easing.inOut(Easing.cubic);
  const x = interpolate(frame, [0, 30, 60, 90], [0, 0, 7, -6], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeIO,
  });
  const z = interpolate(frame, [0, 30, 60, 90], [9, 4.5, 4.5, 5], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  // Spring-driven rise during the orbit leg (frames 30-60): a touch of
  // overshoot + settle, the kind of "weight" you tune in AE's speed graph.
  const rise = spring({
    frame: frame - 30,
    fps,
    config: { damping: 12, stiffness: 90, mass: 1 },
  });
  const y = rise * 1.6;
  return { x, y, z };
}

const CameraRig: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const camera = useThree((s) => s.camera);
  const { x, y, z } = cameraPath(frame, fps);
  camera.position.set(x, y, z);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  return null;
};

const TextCard: React.FC<{
  text: string;
  color: string;
  position: [number, number, number];
  height: number;
}> = ({ text, color, position, height }) => {
  const { tex, aspect } = useMemo(
    () => makeTextTexture(text, color),
    [text, color],
  );
  return (
    <mesh position={position}>
      <planeGeometry args={[height * aspect, height]} />
      <meshBasicMaterial map={tex} transparent toneMapped={false} />
    </mesh>
  );
};

export const Spike3D: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#0D0B10" }}>
      <ThreeCanvas
        width={1920}
        height={1080}
        camera={{ fov: 45, position: [0, 0, 9], near: 0.1, far: 1000 }}
        style={{ backgroundColor: "#0D0B10" }}
      >
        <color attach="background" args={["#0D0B10"]} />
        <CameraRig />
        {/* Front card (white) at z=0 */}
        <TextCard text="SCENE24" color="#FFFFFF" position={[0, 0.5, 0]} height={1.5} />
        {/* Back card (pink) at z=-3 so depth/parallax is obvious */}
        <TextCard text="MOTION" color="#FF4D9D" position={[0, -0.7, -3]} height={1.5} />
      </ThreeCanvas>
    </AbsoluteFill>
  );
};
