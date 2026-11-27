import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as contracts from "@thetis/contracts";
import { describe, expect, it } from "vitest";
import {
  FAILED_COMMAND_MESSAGES,
  failedCommandCopy,
  HANDOVER_FAILED_MESSAGES,
  LATER_FAILED_CODES,
  LOADING_FAILED_MESSAGES,
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
      "This batch can't be handed over now (ShipmentNotOpen).",
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

describe("record_loading copy (field-app.md T067r.3 fold 47: a loan in Recovery)", () => {
  const upperSnake = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
  const vars = { org: "Port Terminal T1", owner: "Khunou Ore Exports" };

  it("every loading key is exported by @thetis/contracts", () => {
    const keys = Object.keys(LOADING_FAILED_MESSAGES);
    expect(keys.sort()).toStrictEqual(["AcceptanceMissing", "LoanNotActive"]);
    for (const key of keys) {
      expect(contracts, key).toHaveProperty(`THETIS_ERROR__${upperSnake(key)}`);
    }
  });

  it("a missing acceptance and a loan in recovery say the next step (fold 47, PR #76 D2)", () => {
    expect(failedCommandCopy("AcceptanceMissing", vars, "record_loading")).toBe(
      "Not every lender with a lock on this lot has accepted this loading. Ask each lender with a lock on this lot to accept the loading in Thetis. If a loan on this lot is in recovery, the lot can't be loaded until the lender's recovery clears its lock.",
    );
    expect(
      failedCommandCopy("AcceptanceMissing", { ...vars, lender: "Lender One" }, "record_loading"),
    ).toContain("Ask Lender One to accept the loading in Thetis.");
    expect(failedCommandCopy("LoanNotActive", vars, "record_loading")).toBe(
      "A loan on this lot is in recovery; the lot cannot be loaded until it is settled.",
    );
    expect(
      failedCommandCopy("LoanNotActive", { ...vars, lender: "Lender One" }, "record_loading"),
    ).toBe("Lender One's loan is in recovery; the lot cannot be loaded until it is settled.");
    // Other kinds keep the shared table; a code without a loading row falls back to it.
    expect(failedCommandCopy("LoanNotActive", vars, "issue_lot")).toBe(
      "See the transaction on the explorer for the program's message.",
    );
    expect(failedCommandCopy("InvalidField", vars, "record_loading")).toBe(
      "Thetis refused one of the values in this text.",
    );
  });

  it("the relay's own loading refusals at create say the next step and that nothing was sent (PR #76 D2, D3)", () => {
    const relay = { org: "Port Terminal T1", kind: "record_loading", lender: "Lender One" };
    expect(relayErrorCopy("ACCEPTANCE_MISSING", "create", relay)).toBe(
      "Not every lender with a lock on this lot has accepted this loading. Ask Lender One to accept the loading in Thetis. Nothing was sent.",
    );
    expect(relayErrorCopy("LOAN_NOT_ACTIVE", "create", relay)).toBe(
      "Lender One's loan is in recovery; the lot cannot be loaded until it is settled. Nothing was sent.",
    );
    expect(relayErrorCopy("LOAN_NOT_ACTIVE", "create", { org: "Port Terminal T1" })).toBe(
      "A loan on this lot is in recovery; the lot cannot be loaded until it is settled. Nothing was sent.",
    );
    expect(relayErrorCopy("TOO_MANY_LOANS", "create", relay)).toBe(
      "More than four loans hold locks on this lot, and one loading takes at most four. Nothing was sent.",
    );
  });

  it("a caller that is neither the owner nor the terminal is told so on create", () => {
    expect(
      relayErrorCopy("NOT_AUTHORISED", "create", { org: "Mosela Haulage", kind: "record_loading" }),
    ).toBe(
      "Mosela Haulage is neither the owner nor the terminal of this loading. Nothing was sent.",
    );
    expect(relayErrorCopy("NOT_AUTHORISED", "create", { org: "Mosela Haulage" })).toBe(
      "Thetis could not prepare this text (NOT_AUTHORISED). Nothing was sent. Try again.",
    );
  });

  it("at sign, a record_loading NOT_AUTHORISED is the generic line, not the initiator row (PR #76 D5)", () => {
    expect(
      relayErrorCopy("NOT_AUTHORISED", "signatures", {
        org: "Port Terminal T1",
        kind: "record_loading",
      }),
    ).toBe("Thetis could not take your signature (NOT_AUTHORISED). Nothing was sent. Try again.");
    expect(
      relayErrorCopy("NOT_AUTHORISED", "renew", {
        org: "Port Terminal T1",
        kind: "record_loading",
      }),
    ).toBe("Thetis could not prepare this text (NOT_AUTHORISED). Nothing was sent. Try again.");
  });
});

describe("handover and loading copy (field-app.md §6.7, the rows added for custody)", () => {
  const upperSnake = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
  const vars = {
    org: "Kopano Stockyard Custody",
    owner: "Khunou Ore Exports",
    to: "Mosela Haulage",
    holder: "Kopano Stockyard Custody",
  };
  const shared = (code: string) => FAILED_COMMAND_MESSAGES[code]?.({ ...vars, code });

  it("LATER_FAILED_CODES is exactly Anchor3012: the codes that are not program errors besides Anchor0", () => {
    expect([...LATER_FAILED_CODES]).toStrictEqual(["Anchor3012"]);
  });

  it("the shared table has the custody and loading keys", () => {
    for (const key of [
      "RecipientNotApproved",
      "StaleRevision",
      "Anchor3012",
      "ManifestMismatch",
      "StageOutOfOrder",
      "ShipmentNotOpen",
      "ShipmentIncomplete",
      "DepartureDocumentInvalid",
      "Restricted",
      "AcceptanceMissing",
      "AcceptanceStale",
      "LoadingExpired",
      "LoadingNotOpen",
      "LotNotStored",
    ]) {
      expect(FAILED_COMMAND_MESSAGES, key).toHaveProperty(key);
    }
  });

  it("every new shared key, except Anchor0 and Anchor3012, is exported by @thetis/contracts", () => {
    const keys = Object.keys(FAILED_COMMAND_MESSAGES).filter(
      (key) => key !== "Anchor0" && !LATER_FAILED_CODES.has(key),
    );
    for (const key of [
      "RecipientNotApproved",
      "StaleRevision",
      "ManifestMismatch",
      "StageOutOfOrder",
      "ShipmentNotOpen",
      "ShipmentIncomplete",
      "DepartureDocumentInvalid",
      "Restricted",
      "AcceptanceMissing",
      "AcceptanceStale",
      "LoadingExpired",
      "LoadingNotOpen",
      "LotNotStored",
    ]) {
      expect(keys, key).toContain(key);
      expect(contracts, key).toHaveProperty(`THETIS_ERROR__${upperSnake(key)}`);
    }
    expect(contracts).not.toHaveProperty("THETIS_ERROR__ANCHOR3012");
  });

  it("every handover key, except Anchor0 and Anchor3012, is exported by @thetis/contracts", () => {
    const keys = Object.keys(HANDOVER_FAILED_MESSAGES);
    expect([...keys].sort()).toStrictEqual(["Anchor0", "Anchor3012", "StaleRevision"]);
    for (const key of keys.filter((k) => k !== "Anchor0" && k !== "Anchor3012")) {
      expect(contracts, key).toHaveProperty(`THETIS_ERROR__${upperSnake(key)}`);
    }
  });

  it("the shared rows, verbatim", () => {
    expect(shared("RecipientNotApproved")).toBe(
      "Mosela Haulage is not the next holder this batch allows.",
    );
    expect(shared("StaleRevision")).toBe(
      "Another change reached this record first. Start again from the current state.",
    );
    expect(shared("Anchor3012")).toBe(
      "An authority or record this action needs does not exist on this Thetis instance.",
    );
    for (const code of [
      "ManifestMismatch",
      "StageOutOfOrder",
      "ShipmentNotOpen",
      "ShipmentIncomplete",
      "DepartureDocumentInvalid",
      "Restricted",
    ]) {
      expect(shared(code), code).toBe(`This batch can't be handed over now (${code}).`);
    }
    for (const code of [
      "AcceptanceMissing",
      "AcceptanceStale",
      "LoadingExpired",
      "LoadingNotOpen",
      "LotNotStored",
    ]) {
      expect(shared(code), code).toBe(`This loading can't be recorded now (${code}).`);
    }
  });

  it("a failed handover: another handover landed first, whatever the code the chain used", () => {
    const line =
      "Another handover of this batch was recorded first. Nothing was recorded for this one. Open the batch again to see who holds it.";
    expect(failedCommandCopy("StaleRevision", vars, "handover")).toBe(line);
    expect(failedCommandCopy("Anchor0", vars, "handover")).toBe(line);
    expect(HANDOVER_FAILED_MESSAGES.StaleRevision?.({ ...vars, code: "StaleRevision" })).toBe(line);
    expect(HANDOVER_FAILED_MESSAGES.Anchor0?.({ ...vars, code: "Anchor0" })).toBe(line);
  });

  it("a failed handover: wrong driver refused names who still holds the batch", () => {
    expect(failedCommandCopy("Anchor3012", vars, "handover")).toBe(
      "An authority or record this action needs does not exist on this Thetis instance. Kopano Stockyard Custody still holds the batch.",
    );
    expect(failedCommandCopy("Anchor3012", { ...vars, holder: "Mosela Haulage" }, "handover")).toBe(
      "An authority or record this action needs does not exist on this Thetis instance. Mosela Haulage still holds the batch.",
    );
  });

  it("a failed handover falls back to the shared rows for every other code", () => {
    expect(failedCommandCopy("DepartureDocumentInvalid", vars, "handover")).toBe(
      "This batch can't be handed over now (DepartureDocumentInvalid).",
    );
    expect(failedCommandCopy("RecipientNotApproved", vars, "handover")).toBe(
      "Mosela Haulage is not the next holder this batch allows.",
    );
    expect(failedCommandCopy("ShipmentNotOpen", vars, "handover")).toBe(
      "This batch can't be handed over now (ShipmentNotOpen).",
    );
    expect(failedCommandCopy("WrongSigner", vars, "handover")).toBe(
      "A signer's authority does not allow this action.",
    );
    expect(failedCommandCopy("Paused", vars, "handover")).toBe(
      "This action is paused on this Thetis instance.",
    );
    expect(failedCommandCopy("TransactionError", vars, "handover")).toBe(
      "See the transaction on the explorer for the program's message.",
    );
  });

  it("the handover rows are for handovers only: other kinds keep the shared and own rows", () => {
    expect(failedCommandCopy("Anchor0", vars, "issue_lot")).toBe(
      "Thetis already has this intake or this lot ID. A second lot for the same intake is refused.",
    );
    expect(failedCommandCopy("Anchor0", vars)).toBe(
      "Thetis already has this intake or this lot ID. A second lot for the same intake is refused.",
    );
    expect(failedCommandCopy("StaleRevision", vars, "issue_lot")).toBe(
      "Another change reached this record first. Start again from the current state.",
    );
    expect(failedCommandCopy("StaleRevision", vars, "record_observation")).toBe(
      "Another observation of this batch was recorded first. Prepare the text again.",
    );
    expect(failedCommandCopy("Anchor3012", vars, "record_observation")).toBe(
      "An authority or record this action needs does not exist on this Thetis instance.",
    );
    expect(failedCommandCopy("Anchor3012", vars)).toBe(
      "An authority or record this action needs does not exist on this Thetis instance.",
    );
  });

  it("a failed loading: the rows for the chain's loading refusals", () => {
    for (const code of ["AcceptanceStale", "LoadingExpired", "LoadingNotOpen", "LotNotStored"]) {
      expect(failedCommandCopy(code, vars, "record_loading"), code).toBe(
        `This loading can't be recorded now (${code}).`,
      );
    }
    expect(failedCommandCopy("AcceptanceMissing", vars, "record_loading")).toContain(
      "Ask each lender with a lock on this lot to accept the loading in Thetis.",
    );
    expect(failedCommandCopy("AcceptanceMissing", vars, "issue_lot")).toBe(
      "This loading can't be recorded now (AcceptanceMissing).",
    );
  });

  it("no en or em dash in any row of any failed-command table, and at most one middle dot", () => {
    const full = {
      ...vars,
      site: "KOPANO-YARD-1",
      quantity: "5,000.000 t",
      lender: "Lender One Bank",
    };
    const tables = [
      FAILED_COMMAND_MESSAGES,
      HANDOVER_FAILED_MESSAGES,
      OBSERVATION_FAILED_MESSAGES,
      LOADING_FAILED_MESSAGES,
    ];
    for (const table of tables) {
      for (const [code, message] of Object.entries(table)) {
        const text = message({ ...full, code });
        expect(text.includes("\u2013"), code).toBe(false);
        expect(text.includes("\u2014"), code).toBe(false);
        expect(text.split("\u00b7").length - 1, code).toBeLessThanOrEqual(1);
        expect(text, code).not.toMatch(/undefined|null/);
      }
    }
  });
});
