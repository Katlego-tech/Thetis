// Tokens from the web registry's palette, adapted for a phone. Oxide green only on things a
// person can press; refuse red only for refusals. No gradients, shadows or patterned grounds.
import { useColorScheme } from "react-native";

export interface Palette {
  paper: string;
  sheet: string;
  ink: string;
  ink2: string;
  rule: string;
  hair: string;
  act: string;
  actInk: string;
  refuse: string;
  rail: string;
  railInk: string;
  banner: string;
  bannerInk: string;
}

export const light: Palette = {
  paper: "#F6F7F5",
  sheet: "#FFFFFF",
  ink: "#1B2023",
  ink2: "#545D62",
  rule: "#C7CDCA",
  hair: "#E1E5E3",
  act: "#2E6B57",
  actInk: "#FFFFFF",
  refuse: "#A13A2E",
  rail: "#1B2023",
  railInk: "#DDE3E0",
  banner: "#1B2023",
  bannerInk: "#E8ECEA",
};

export const dark: Palette = {
  paper: "#111517",
  sheet: "#181D20",
  ink: "#E6EAE8",
  ink2: "#A3ADB1",
  rule: "#323B3F",
  hair: "#252C30",
  act: "#5FAF92",
  actInk: "#0E1A15",
  refuse: "#E58273",
  rail: "#0B0E10",
  railInk: "#DDE3E0",
  banner: "#E6EAE8",
  bannerInk: "#111517",
};

export function usePalette(): Palette {
  return useColorScheme() === "dark" ? dark : light;
}

export const font = {
  regular: "Archivo_400Regular",
  semibold: "Archivo_600SemiBold",
  mono: "JetBrainsMono_500Medium",
} as const;

export const radius = 4;
export const touch = 48;

export const type = {
  body: { fontFamily: font.regular, fontSize: 15, lineHeight: 22 },
  small: { fontFamily: font.regular, fontSize: 13, lineHeight: 18 },
  caption: { fontFamily: font.regular, fontSize: 12, lineHeight: 17 },
  title: { fontFamily: font.semibold, fontSize: 24, lineHeight: 28 },
  section: { fontFamily: font.semibold, fontSize: 17, lineHeight: 20 },
  label: { fontFamily: font.semibold, fontSize: 14, lineHeight: 19 },
  strong: { fontFamily: font.semibold, fontSize: 15, lineHeight: 20 },
  mono: { fontFamily: font.mono, fontSize: 12, lineHeight: 17 },
  signed: { fontFamily: font.mono, fontSize: 11.5, lineHeight: 18 },
  tabular: { fontVariant: ["tabular-nums" as const] },
} as const;
