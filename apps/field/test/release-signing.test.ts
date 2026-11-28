import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { applyReleaseSigning } = require("../plugins/release-signing.js") as {
  applyReleaseSigning: (gradle: string) => string;
};

// The signingConfigs, buildTypes and packaging blocks of android/app/build.gradle exactly as
// `expo prebuild` writes them for Expo 58.
const template = readFileSync(
  new URL("./fixtures/expo-58-build.gradle.excerpt", import.meta.url),
  "utf8",
);

function block(gradle: string, opener: string): string {
  const start = gradle.indexOf(opener);
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = gradle.indexOf("{", start); i < gradle.length; i++) {
    if (gradle[i] === "{") depth++;
    if (gradle[i] === "}" && --depth === 0) return gradle.slice(start, i + 1);
  }
  throw new Error(`unclosed ${opener}`);
}

describe("release signing config plugin", () => {
  const out = applyReleaseSigning(template);

  it("adds a release signing config read from Gradle properties or the environment", () => {
    const signing = block(out, "signingConfigs {");
    const release = block(signing, "release {");
    for (const name of [
      "THETIS_UPLOAD_STORE_FILE",
      "THETIS_UPLOAD_KEY_ALIAS",
      "THETIS_UPLOAD_PASSWORD_FILE",
    ]) {
      expect(release).toContain(`'${name}'`);
    }
    expect(release).toContain("System.getenv(name)");
    expect(release).toContain("findProperty(name)");
    // The password is read from its file at build time, never written into the build file.
    expect(release).toMatch(/storePassword password\b/);
    expect(release).toMatch(/keyPassword password\b/);
    expect(block(signing, "debug {")).toContain("storeFile file('debug.keystore')");
  });

  it("signs the release build type with the upload key and leaves debug on the debug key", () => {
    const types = block(out, "buildTypes {");
    expect(block(types, "release {")).toContain("signingConfig signingConfigs.release");
    expect(block(types, "release {")).not.toContain("signingConfig signingConfigs.debug");
    expect(block(types, "debug {")).toContain("signingConfig signingConfigs.debug");
  });

  it("refuses to package a release without the upload key, so it is never debug-signed or unsigned", () => {
    const guard = out.slice(out.indexOf("gradle.taskGraph.whenReady"));
    expect(guard).toContain("signingConfigs.release.storeFile == null");
    expect(guard).toContain("throw new GradleException");
    expect(guard).toContain("docs/dapp-store.md");
    expect(out.indexOf("gradle.taskGraph.whenReady")).toBeGreaterThan(
      out.indexOf("androidResources {"),
    );
  });

  it("names no keystore path, alias value or password in the build file", () => {
    expect(out).not.toMatch(/thetis-upload\.(jks|password)|\.config\/thetis/);
  });

  it("is idempotent", () => {
    expect(applyReleaseSigning(out)).toBe(out);
  });

  it("fails loudly when the Expo template changes shape", () => {
    expect(() => applyReleaseSigning(template.replace("signingConfigs {", "signing {"))).toThrow(
      /signingConfigs/,
    );
    expect(() =>
      applyReleaseSigning(
        template.replace(
          /(release \{[\s\S]*?)signingConfig signingConfigs\.debug/,
          "$1signingConfig null",
        ),
      ),
    ).toThrow(/release build type/);
  });
});
