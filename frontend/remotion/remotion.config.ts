/**
 * Note: When using the Node.JS APIs, the config file
 * doesn't apply. Instead, pass options directly to the APIs.
 *
 * All configuration options: https://remotion.dev/docs/config
 */

import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
// Needed for @remotion/three (WebGL) to render headlessly. ANGLE is the
// software/translation GL backend Remotion recommends for 3D renders.
Config.setChromiumOpenGlRenderer("angle");
