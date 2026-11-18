import localFont from "next/font/local";

export const archivo = localFont({
  src: "../../node_modules/@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2",
  variable: "--font-sans",
  weight: "400 700",
  display: "swap",
  declarations: [{ prop: "font-stretch", value: "100% 125%" }],
});

export const jetbrainsMono = localFont({
  src: "../../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2",
  variable: "--font-mono",
  weight: "500",
  display: "swap",
  adjustFontFallback: false,
});
