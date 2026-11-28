// Renders the Solana dApp Store listing art and the Android launcher icon from the field app's
// brand: the rail-dark ground, the THETIS wordmark in Archivo SemiBold and the oxide-green rule
// (src/theme.ts). Run from apps/field: `pnpm store:assets`. Outputs are committed; rerun after a
// brand change. See docs/dapp-store.md.
//
// sharp ships with Next.js in this workspace, so it is resolved through apps/web's `next` rather
// than added as a field dependency.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const field = join(here, "..");
const fontDirs = [
  join(field, "node_modules/@expo-google-fonts/archivo/600SemiBold"),
  join(field, "node_modules/@expo-google-fonts/jetbrains-mono/500Medium"),
];

// librsvg finds fonts through fontconfig: point it at the app's own font files only, so the art
// never falls back to a system face. Set before sharp loads.
const fontconfig = mkdtempSync(join(tmpdir(), "thetis-fonts-"));
writeFileSync(
  join(fontconfig, "fonts.conf"),
  `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>${fontDirs
    .map((dir) => `<dir>${dir}</dir>`)
    .join("")}<cachedir>${fontconfig}/cache</cachedir></fontconfig>`,
);
process.env.FONTCONFIG_FILE = join(fontconfig, "fonts.conf");

const nextRequire = createRequire(
  createRequire(join(field, "../web/package.json")).resolve("next/package.json"),
);
const sharp = nextRequire("sharp");

// src/theme.ts: rail (light) as the ground, white wordmark as in Frame.tsx, act (dark) for the
// rule because it is the green that reads on the rail.
const RAIL = "#1B2023";
const WORD = "#FFFFFF";
const RAIL_INK = "#DDE3E0";
const RAIL_MUTE = "#9AA5A9";
const ACT = "#5FAF92";
const SANS = "Archivo SemiBold";
const MONO = "JetBrains Mono Medium";

/** The mark: a capital T over a short oxide-green rule, centred in a `size` square. */
function mark(size, { ground }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  ${ground ? `<rect width="512" height="512" fill="${RAIL}"/>` : ""}
  <text x="256" y="${ground ? 332 : 300}" text-anchor="middle" font-family="${SANS}" font-size="${ground ? 300 : 200}" fill="${WORD}">T</text>
  <rect x="${ground ? 196 : 216}" y="${ground ? 370 : 326}" width="${ground ? 120 : 80}" height="${ground ? 16 : 11}" fill="${ACT}"/>
</svg>`;
}

function banner() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600" viewBox="0 0 1200 600">
  <rect width="1200" height="600" fill="${RAIL}"/>
  <text x="96" y="262" font-family="${SANS}" font-size="132" letter-spacing="6" fill="${WORD}">THETIS</text>
  <rect x="100" y="300" width="132" height="10" fill="${ACT}"/>
  <text font-family="${SANS}" font-size="38" fill="${RAIL_INK}">
    <tspan x="98" y="380">Custody, collateral and release coordination</tspan>
    <tspan x="98" y="430">for mineral lots.</tspan>
  </text>
  <text x="98" y="520" font-family="${MONO}" font-size="20" letter-spacing="2" fill="${RAIL_MUTE}">SOLANA DEVNET DEMO · ANDROID FIELD APP</text>
</svg>`;
}

async function png(svg, out) {
  mkdirSync(dirname(out), { recursive: true });
  await sharp(Buffer.from(svg), { density: 72 }).png({ compressionLevel: 9 }).toFile(out);
  const { width, height } = await sharp(out).metadata();
  console.log(`${out.slice(field.length + 1)} ${width}x${height}`);
}

await png(mark(512, { ground: true }), join(here, "icon-512.png"));
await png(banner(), join(here, "banner-1200x600.png"));
await png(mark(1024, { ground: true }), join(field, "assets/icon.png"));
await png(mark(1024, { ground: false }), join(field, "assets/adaptive-icon.png"));
