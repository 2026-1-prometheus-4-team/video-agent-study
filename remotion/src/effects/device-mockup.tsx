/**
 * DeviceMockup — 3D device frame with screenshot mapped inside.
 *
 * Usage context for LLM:
 *   Show the product in a real device context.
 *   The device frame adds credibility and premium feel.
 *   Angle/rotation makes it look "designed" not "screenshot pasted."
 *
 *   From LangEase analysis:
 *     - iPhone 14/15 Pro style with dynamic island
 *     - Isometric angle: ~30deg rotation, perspective tilt
 *     - Multiple devices at screen corners (4 directions)
 *     - Each device has different rotation angle
 *     - Shadow underneath for depth
 *
 *   Device types and their usage:
 *     - "macbook": hero product shots, dashboard demos
 *     - "iphone": mobile-first products, app showcases
 *     - "ipad": tablet UIs, reading/media apps
 *     - "browser": web tools, SaaS dashboards
 *
 * Combines well with:
 *   - TextOverlay (text in front of device)
 *   - ZoomIntoScreen (camera pushes into device screen)
 *   - DeviceCascade (multiple devices from different directions)
 *   - HandCursor (cursor interacting with device screen)
 *
 * NOTE: MVP uses CSS 3D transform with device frame images.
 *       Production upgrade: Three.js with actual 3D models.
 */

import React from "react";
import { Img, useCurrentFrame, useVideoConfig, spring } from "remotion";
import { type BrandEnergy, getSpring, DURATION_MULTIPLIER } from "../atoms/spring-config";

type DeviceType = "iphone" | "macbook" | "ipad" | "browser";

interface DeviceMockupProps {
  /** Device type */
  device: DeviceType;
  /** Screenshot to show inside the device screen */
  screenshotSrc: string;
  /** 3D rotation angles in degrees */
  rotateX?: number;
  rotateY?: number;
  rotateZ?: number;
  /** CSS perspective value */
  perspective?: number;
  /** Scale of the device (1 = natural size relative to screen) */
  scale?: number;
  /** Whether to show shadow underneath */
  showShadow?: boolean;
  /** Animation: frame at which device enters (undefined = static) */
  enterFrame?: number;
  /** Direction device enters from */
  enterFrom?: "left" | "right" | "top" | "bottom" | "top-left" | "top-right" | "bottom-left" | "bottom-right";
  /** Brand energy for entrance animation */
  energy?: BrandEnergy;
  style?: React.CSSProperties;
}

/** Device frame dimensions and screen area (percentages of device frame) */
const DEVICE_SPECS: Record<DeviceType, {
  aspectRatio: number;
  screenTop: string;
  screenLeft: string;
  screenWidth: string;
  screenHeight: string;
  borderRadius: string;
  frameColor: string;
}> = {
  iphone: {
    aspectRatio: 9 / 19.5,
    screenTop: "3%",
    screenLeft: "5%",
    screenWidth: "90%",
    screenHeight: "94%",
    borderRadius: "36px",
    frameColor: "#1A1A1A",
  },
  macbook: {
    aspectRatio: 16 / 10,
    screenTop: "4%",
    screenLeft: "8%",
    screenWidth: "84%",
    screenHeight: "88%",
    borderRadius: "8px",
    frameColor: "#2D2D2D",
  },
  ipad: {
    aspectRatio: 3 / 4,
    screenTop: "4%",
    screenLeft: "4%",
    screenWidth: "92%",
    screenHeight: "92%",
    borderRadius: "20px",
    frameColor: "#1A1A1A",
  },
  browser: {
    aspectRatio: 16 / 10,
    screenTop: "5%",
    screenLeft: "0%",
    screenWidth: "100%",
    screenHeight: "95%",
    borderRadius: "12px",
    frameColor: "#F0F0F0",
  },
};

export const DeviceMockup: React.FC<DeviceMockupProps> = ({
  device,
  screenshotSrc,
  rotateX = 0,
  rotateY = 0,
  rotateZ = 0,
  perspective = 1200,
  scale = 1,
  showShadow = true,
  enterFrame,
  enterFrom = "bottom",
  energy = "moderate",
  style = {},
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const spec = DEVICE_SPECS[device];

  // Entrance animation
  let entranceTranslate = "";
  let entranceOpacity = 1;

  if (enterFrame !== undefined) {
    const localFrame = Math.max(0, frame - enterFrame);
    const springConfig = getSpring("entrance", energy);
    const dur = Math.round(20 * DURATION_MULTIPLIER[energy]);

    const progress = spring({
      frame: localFrame,
      fps,
      from: 0,
      to: 1,
      durationInFrames: dur,
      config: springConfig,
    });

    entranceOpacity = Math.min(1, progress * 2.5);

    const offset = 400 * (1 - progress);
    const entranceMap: Record<string, string> = {
      "bottom": `translateY(${offset}px)`,
      "top": `translateY(${-offset}px)`,
      "left": `translateX(${-offset}px)`,
      "right": `translateX(${offset}px)`,
      "bottom-left": `translate(${-offset * 0.7}px, ${offset * 0.7}px)`,
      "bottom-right": `translate(${offset * 0.7}px, ${offset * 0.7}px)`,
      "top-left": `translate(${-offset * 0.7}px, ${-offset * 0.7}px)`,
      "top-right": `translate(${offset * 0.7}px, ${-offset * 0.7}px)`,
    };
    entranceTranslate = entranceMap[enterFrom] ?? "";

    if (frame < enterFrame) return null;
  }

  // Device frame dimensions (base width for sizing)
  const baseWidth = 300;
  const baseHeight = baseWidth / spec.aspectRatio;

  return (
    <div
      style={{
        perspective: `${perspective}px`,
        display: "inline-block",
        ...style,
      }}
    >
      <div
        style={{
          transform: `${entranceTranslate} rotateX(${rotateX}deg) rotateY(${rotateY}deg) rotateZ(${rotateZ}deg) scale(${scale})`,
          opacity: entranceOpacity,
          transformStyle: "preserve-3d",
          position: "relative",
        }}
      >
        {/* Device frame */}
        <div
          style={{
            width: baseWidth,
            height: baseHeight,
            backgroundColor: spec.frameColor,
            borderRadius: spec.borderRadius,
            position: "relative",
            overflow: "hidden",
            boxShadow: showShadow
              ? `0 20px 60px rgba(0,0,0,0.25), 0 4px 12px rgba(0,0,0,0.1)`
              : undefined,
          }}
        >
          {/* Dynamic island (iPhone only) */}
          {device === "iphone" && (
            <div
              style={{
                position: "absolute",
                top: "4%",
                left: "50%",
                transform: "translateX(-50%)",
                width: "28%",
                height: "3%",
                backgroundColor: "#000",
                borderRadius: 100,
                zIndex: 10,
              }}
            />
          )}

          {/* Browser top bar */}
          {device === "browser" && (
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                height: "5%",
                backgroundColor: "#F5F5F5",
                borderBottom: "1px solid #E0E0E0",
                display: "flex",
                alignItems: "center",
                paddingLeft: 12,
                gap: 6,
                zIndex: 10,
              }}
            >
              <div style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: "#FF5F57" }} />
              <div style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: "#FEBC2E" }} />
              <div style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: "#28C840" }} />
            </div>
          )}

          {/* Screenshot inside screen area */}
          <div
            style={{
              position: "absolute",
              top: spec.screenTop,
              left: spec.screenLeft,
              width: spec.screenWidth,
              height: spec.screenHeight,
              overflow: "hidden",
              borderRadius: device === "iphone" ? "28px" : "4px",
            }}
          >
            <Img
              src={screenshotSrc}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * DeviceCascade — multiple devices entering from different screen edges.
 *
 * Usage context for LLM:
 *   "Multi-platform" or "works everywhere" messaging.
 *   4 devices from 4 corners, staggered entrance.
 *   Text in the center between devices.
 */
interface DeviceCascadeProps {
  devices: Array<{
    type: DeviceType;
    screenshotSrc: string;
    enterFrom: "top-left" | "top-right" | "bottom-left" | "bottom-right";
    rotateZ: number;
  }>;
  /** Base frame for the first device entrance */
  startFrame: number;
  /** Frames between each device entrance */
  staggerFrames?: number;
  energy?: BrandEnergy;
}

export const DeviceCascade: React.FC<DeviceCascadeProps> = ({
  devices,
  startFrame,
  staggerFrames = 4,
  energy = "moderate",
}) => {
  const positionMap: Record<string, React.CSSProperties> = {
    "top-left": { position: "absolute", top: "-5%", left: "-5%" },
    "top-right": { position: "absolute", top: "-5%", right: "-5%" },
    "bottom-left": { position: "absolute", bottom: "-5%", left: "-5%" },
    "bottom-right": { position: "absolute", bottom: "-5%", right: "-5%" },
  };

  return (
    <>
      {devices.map((dev, i) => (
        <div key={i} style={positionMap[dev.enterFrom]}>
          <DeviceMockup
            device={dev.type}
            screenshotSrc={dev.screenshotSrc}
            rotateZ={dev.rotateZ}
            rotateX={-5}
            rotateY={dev.enterFrom.includes("left") ? 10 : -10}
            enterFrame={startFrame + i * staggerFrames}
            enterFrom={dev.enterFrom}
            energy={energy}
            scale={0.8}
          />
        </div>
      ))}
    </>
  );
};
