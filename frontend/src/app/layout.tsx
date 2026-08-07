import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Toaster } from "sonner";
import { ThemeProvider } from "@/theme/ThemeProvider";
import "@/theme/tokens.css";
import "./globals.css";

/**
 * Pretendard Variable — self-host (public/fonts-local/).
 * 외부 CDN 금지. Weight 45~920 하나의 파일.
 */
const pretendard = localFont({
  src: "../../public/fonts-local/PretendardVariable.woff2",
  variable: "--font-ui",
  display: "swap",
  weight: "45 920",
  style: "normal",
  preload: true,
});

export const metadata: Metadata = {
  title: "Vibe Edit",
  description:
    "자연어로 영상을 편집하는 AI 에이전트. 업로드 → 지시 → 계획 승인 → 실행 → 프리뷰까지 대화 한 번으로.",
  applicationName: "Vibe Edit",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "dark",
  themeColor: [{ media: "(prefers-color-scheme: dark)", color: "#000000" }],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="ko"
      suppressHydrationWarning
      className={pretendard.variable}
    >
      <body>
        <ThemeProvider>
          {children}
          <Toaster
            position="top-center"
            theme="dark"
            richColors={false}
            expand={false}
            visibleToasts={3}
            gap={8}
            offset={20}
          />
        </ThemeProvider>
      </body>
    </html>
  );
}
