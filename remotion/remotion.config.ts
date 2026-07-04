import { Config } from "@remotion/cli/config";

// Render settings — scene24 / motion-directing.md 의 deterministic render 룰 따름.
// 1920x1080, 30fps 가 default. ClipEffect 컴포지션이 props 로 width/height/fps override 가능.

Config.setVideoImageFormat("png");
Config.setOverwriteOutput(true);
Config.setConcurrency(null); // null = 자동 (CPU 코어 수)
