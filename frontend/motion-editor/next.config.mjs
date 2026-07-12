import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // 에디터 public 에 없는 정적 파일 요청은 엔진(labs/remotion/public)으로 폴백 —
  // 스펙 JSON 의 staticFile 이름("cap-....png")이 에디터 플레이어에서도 뜨게.
  async rewrites() {
    return {
      afterFiles: [{ source: "/:path*", destination: "/api/engine-public/:path*" }],
    };
  },
  // 엔진 소스(../remotion/src)를 앱 밖에서 직접 import 하기 위한 설정.
  // 엔진을 복사하지 않고 단일 소스로 유지한다 (스튜디오/에디터 동일 코드).
  experimental: {
    externalDir: true,
  },
  // wrappers/structural 레지스트리가 require.context 를 쓰므로 webpack 필수
  // (next dev 를 --turbopack 없이 실행할 것).
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@engine": path.resolve(__dirname, "../remotion/src"),
    };
    // 엔진 소스(../remotion/src)가 remotion 을 labs/remotion/node_modules 에서
    // resolve 하면 두 벌이 로드돼 Player 의 React context 가 끊긴다("No video
    // config found"). 엔진 파일에서 나가는 remotion import 만 에디터 사본으로
    // 스코프 alias 한다.
    // 주의: react/react-dom 은 여기서 alias 하면 안 된다 — Next App Router 는
    // 자체 벤더링 react(next/dist/compiled/react)를 전역 alias 로 쓰는데, rule
    // 스코프 alias 가 그걸 덮어써서 두 React 가 로드된다(useId/useContext null).
    config.module.rules.unshift({
      test: /\.(ts|tsx|js|jsx|mjs)$/,
      include: [path.resolve(__dirname, "../remotion/src")],
      resolve: {
        alias: {
          remotion: path.resolve(__dirname, "node_modules/remotion"),
          // @remotion/three 내부의 remotion import 도 에디터 사본으로 — 엔진
          // node_modules 사본이 로드되면 Player 컨텍스트가 끊긴다(ComposedShader).
          "@remotion/three": path.resolve(__dirname, "node_modules/@remotion/three"),
          three: path.resolve(__dirname, "node_modules/three"),
          "@react-three/fiber": path.resolve(__dirname, "node_modules/@react-three/fiber"),
          "@react-three/drei": path.resolve(__dirname, "node_modules/@react-three/drei"),
        },
      },
    });
    return config;
  },
};

export default nextConfig;
