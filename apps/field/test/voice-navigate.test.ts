// voice.md §5.2, field column: the only path from a navigate_to call to a tab, and its refusals.
import { describe, expect, it } from "vitest";
import { VOICE_COPY } from "../src/copy";
import { ID_PATTERN, normaliseId, resolveNavigate } from "../src/voice/navigate";

const NOT_ON_PHONE = {
  exceptions: "Exceptions are on the web workbench, not on this phone.",
  lot: "The lot dossier is on the web workbench, not on this phone.",
  release: "Release review is on the web workbench, not on this phone.",
} as const;

describe("voice navigation on the phone (voice.md §5.2)", () => {
  it("opens the Home tab for queue and the Account tab for account", () => {
    expect(resolveNavigate({ screen: "queue" }, false)).toEqual({
      result: { ok: true, screen: "queue" },
      tab: "home",
    });
    expect(resolveNavigate({ screen: "account", id: "ignored" }, false)).toEqual({
      result: { ok: true, screen: "account" },
      tab: "account",
    });
  });

  it("refuses exceptions, lot and release as not on this phone, whatever the id", () => {
    for (const screen of ["exceptions", "lot", "release"] as const) {
      for (const id of [undefined, "CR-0001", " cr-0001 ", "not an id!", 7]) {
        expect(resolveNavigate({ screen, id }, false)).toEqual({
          result: { ok: false, reason: "NOT_ON_PHONE", message: NOT_ON_PHONE[screen] },
          tab: null,
        });
        // Checked before busy: no wallet state makes these reachable.
        expect(resolveNavigate({ screen, id }, true).result).toMatchObject({
          reason: "NOT_ON_PHONE",
        });
      }
    }
    expect(VOICE_COPY.refusals.NOT_ON_PHONE).toEqual(NOT_ON_PHONE);
  });

  it("refuses navigation while the wallet is signing and queues nothing", () => {
    for (const screen of ["queue", "account"]) {
      expect(resolveNavigate({ screen }, true)).toEqual({
        result: {
          ok: false,
          reason: "BUSY",
          message: "Your wallet is signing. The screen stays as it is until it finishes.",
        },
        tab: null,
      });
    }
  });

  it("refuses an unknown or malformed screen without echoing it", () => {
    for (const args of [{}, { screen: "settings" }, { screen: 3 }, { screen: null }]) {
      const { result, tab } = resolveNavigate(args as Record<string, unknown>, false);
      expect(tab).toBeNull();
      expect(result).toEqual({
        ok: false,
        reason: "UNKNOWN_SCREEN",
        message: "That screen is not in Thetis.",
      });
    }
    expect(resolveNavigate({ screen: "settings" }, true).result).toMatchObject({
      reason: "UNKNOWN_SCREEN",
    });
  });

  it("normalises a lot id: trimmed, upper-cased and matched against ID_PATTERN", () => {
    expect(ID_PATTERN.source).toBe("^[A-Z0-9-]{1,16}$");
    expect(normaliseId(" cr-0001 ")).toBe("CR-0001");
    expect(normaliseId("CR-0001")).toBe("CR-0001");
    for (const bad of ["", "   ", "CR 0001", "CR_0001", "A".repeat(17), 12, null, undefined, {}])
      expect(normaliseId(bad)).toBeNull();
    expect(VOICE_COPY.refusals.BAD_ID).toBe("That is not a lot id. Lot ids look like CR-0001.");
  });
});
