import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "node", environment: "node", include: ["test/**/*.test.ts"] },
      },
      {
        extends: true,
        test: { name: "components", environment: "jsdom", include: ["test/**/*.test.tsx"] },
      },
    ],
  },
});
