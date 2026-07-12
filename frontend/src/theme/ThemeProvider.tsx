"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { PropsWithChildren } from "react";

/**
 * ThemeProvider — next-themes 래퍼.
 * defaultTheme=dark (다크 canonical), attribute=data-theme (:root[data-theme=…]),
 * disableTransitionOnChange 로 테마 전환 시 CSS transition flash 방지.
 */
export function ThemeProvider({ children }: PropsWithChildren) {
  return (
    <NextThemesProvider
      attribute="data-theme"
      defaultTheme="dark"
      enableSystem={false}
      storageKey="video-agent-theme"
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
