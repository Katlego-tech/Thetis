import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as contracts from "@thetis/contracts";
import { describe, expect, it } from "vitest";
import {
  FAILED_COMMAND_MESSAGES,
  failedCommandCopy,
  LATER_FAILED_CODES,
  OBSERVATION_FAILED_MESSAGES,
  relayErrorCopy,
} from "../src/copy";

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

describe("record_observation copy (field-app.md §6.7 observation rows, §7.8)", () => {
  const upperSnake = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
  const vars = { org: "Kopano Stockyard Custody", owner: "Khunou Ore Exports" };

  it("every observation key is exported by @thetis/contracts", () => {
    const keys = Object.keys(OBSERVATION_FAILED_MESSAGES);
    expect(keys.sort()).toStrictEqual(["ShipmentNotOpen", "StaleRevision", "WrongRole"]);
    for (const key of keys) {
      expect(contracts, key).toHaveProperty(`THETIS_ERROR__${upperSnake(key)}`);
    }
  });

  it("an observation's WrongRole names the organisation and the border rule, not an exporter", () => {
    expect(failedCommandCopy("WrongRole", vars, "record_observation")).toBe(
      "Kopano Stockyard Custody can't record this kind of observation. A border crossing is recorded only by a transporter or a terminal.",
    );
    expect(failedCommandCopy("WrongRole", vars, "issue_lot")).toBe(
      "Khunou Ore Exports is not accredited as an exporter, so it can't own a new lot.",
    );
    expect(failedCommandCopy("WrongRole", vars)).toBe(
      "Khunou Ore Exports is not accredited as an exporter, so it can't own a new lot.",
    );
  });

  it("a cancelled shipment and a stale count have observation copy; other kinds keep their own", () => {
    expect(failedCommandCopy("ShipmentNotOpen", vars, "record_observation")).toBe(
      "This batch's shipment was cancelled, so no observation can be recorded for it.",
    );
    expect(failedCommandCopy("StaleRevision", vars, "record_observation")).toBe(
      "Another observation of this batch was recorded first. Prepare the text again.",
    );
    expect(failedCommandCopy("ShipmentNotOpen", vars, "issue_lot")).toBe(
      "See the transaction on the explorer for the program's message.",
    );
    // Codes without an observation row fall back to the shared table.
    expect(failedCommandCopy("InvalidField", vars, "record_observation")).toBe(
      "Thetis refused one of the values in this text.",
    );
  });

  it("relay refusals of an observation: an organisation that can't observe, and a phone clock ahead of devnet", () => {
    const relay = { org: "Khunou Ore Exports", kind: "record_observation" };
    expect(relayErrorCopy("NOT_AUTHORISED", "create", relay)).toBe(
      "Khunou Ore Exports can't record observations. Only a custodian, a transporter, a terminal or an inspector can. Nothing was sent.",
    );
    expect(relayErrorCopy("VALIDATION", "create", { ...relay, detail: "observedAt" })).toBe(
      "This phone's clock is ahead of devnet's. Set the phone's time to automatic, retake the photo, and try again.",
    );
    expect(relayErrorCopy("VALIDATION", "create", { ...relay, detail: "args.locationCode" })).toBe(
      "Thetis could not prepare this text (VALIDATION). Nothing was sent. Try again.",
    );
    expect(relayErrorCopy("NOT_AUTHORISED", "create", { org: "Khunou Ore Exports" })).toBe(
      "Thetis could not prepare this text (NOT_AUTHORISED). Nothing was sent. Try again.",
    );
  });
});
