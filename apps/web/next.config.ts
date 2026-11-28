import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@thetis/domain"],
  // The hosted judge build (build:judge) is Next's own standalone server; every other build and
  // `next dev` / `next start` are unchanged.
  output: process.env.THETIS_WEB_OUTPUT === "standalone" ? "standalone" : undefined,
  // The pnpm workspace root, so the standalone trace includes the workspace packages.
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
};

export default config;
