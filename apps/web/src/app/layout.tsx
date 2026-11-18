import type { Metadata } from "next";
import type { ReactNode } from "react";
import { archivo, jetbrainsMono } from "./fonts";
import "./globals.css";

const applyInitialTheme = `(() => {
  let theme = "system";
  try {
    const stored = localStorage.getItem("thetis-theme");
    if (stored === "light" || stored === "dark") theme = stored;
  } catch {}
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle("dark", theme === "dark" ||
    (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches));
})();`;

export const metadata: Metadata = {
  title: "Thetis",
  description: "Custody, collateral and release coordination for mineral lots.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${archivo.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script>{applyInitialTheme}</script>
      </head>
      <body>{children}</body>
    </html>
  );
}
