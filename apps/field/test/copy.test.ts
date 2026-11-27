import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as contracts from "@thetis/contracts";
import { describe, expect, it } from "vitest";
import { FAILED_COMMAND_MESSAGES, LATER_FAILED_CODES } from "../src/copy";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const SRC = join(__dirname, "..", "src");
const APP = [...files(SRC), join(__dirname, "..", "App.tsx")];

describe("copy rules", () => {
  it("no en or em dash anywhere in the app's source", () => {
    for (const file of APP) {
      const text = readFileSync(file, "utf8");
      expect(text.includes("–"), file).toBe(false);
      expect(text.includes("—"), file).toBe(false);
    }
  });

  it("no kit document or task id in the app's source", () => {
    for (const file of APP) {
      const text = readFileSync(file, "utf8");
      expect(/\bT0\d\d[a-z]?\b/.test(text), file).toBe(false);
      expect(/AGENTS\.md|field-app\.md|TASKS\.md/.test(text), file).toBe(false);
    }
  });
});

describe("failed-command keys are program error names", () => {
  const upperSnake = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();

  it("every key not marked for later, except Anchor0, is exported by @thetis/contracts", () => {
    const keys = Object.keys(FAILED_COMMAND_MESSAGES).filter(
      (key) => key !== "Anchor0" && !LATER_FAILED_CODES.has(key),
    );
    expect(keys.length).toBeGreaterThan(15);
    for (const key of keys) {
      expect(contracts, key).toHaveProperty(`THETIS_ERROR__${upperSnake(key)}`);
    }
  });

  it("maps ScopeMissing to THETIS_ERROR__SCOPE_MISSING", () => {
    expect(upperSnake("ScopeMissing")).toBe("SCOPE_MISSING");
    expect(typeof contracts.THETIS_ERROR__SCOPE_MISSING).toBe("number");
  });
});
