// voice.md §5.2: the web column of the screen mapping and every refusal message. The rail items
// below are the synthetic demo cast's (Lender One Bank's lots and releases); nothing here reads a
// database or the chain.

import { describe, expect, test } from "vitest";
import type { RailItem, RailSection } from "@/components/shell/rail-nav";
import {
  ID_PATTERN,
  normaliseId,
  resolveNavigate,
  targetsFrom,
  VOICE_COPY,
  type VoiceTargets,
} from "@/lib/voice";

const RELEASE_ONE = "7VDNjuhymdWkPh1isgKCw36ESFCKf6uieAyzbVJWiyxs";
const RELEASE_TWO = "6QWeT6FpJrm8AF1btu6pTTmbDRDW8WHrpXUbFg59iCes";

const lot = (id: string): RailItem => ({
  key: id,
  label: id,
  detail: null,
  href: `/lender-one/lots/${encodeURIComponent(id)}`,
});
const release = (lotId: string, address: string): RailItem => ({
  key: address,
  label: lotId,
  detail: "2,000.000 t",
  href: `/lender-one/releases/${address}`,
});

function sections(lots: RailItem[], releases: RailItem[]): RailSection[] {
  return [
    {
      segment: "queue",
      label: "Work queue",
      count: 3,
      href: "/lender-one/queue",
      items: [],
      empty: null,
    },
    {
      segment: "lots",
      label: "Lots",
      count: lots.length,
      href: null,
      items: lots,
      empty: "No lots yet",
    },
    {
      segment: "releases",
      label: "Releases",
      count: releases.length,
      href: null,
      items: releases,
      empty: "No releases yet",
    },
    {
      segment: "exceptions",
      label: "Exceptions",
      count: 0,
      href: "/lender-one/exceptions",
      items: [],
      empty: null,
    },
  ];
}

const targets: VoiceTargets = targetsFrom(
  "lender-one",
  sections(
    [lot("CR-0001"), lot("CR-0002")],
    [
      release("CR-0001", RELEASE_ONE),
      release("CR-0002", RELEASE_TWO),
      release("CR-0002", "x".repeat(44)),
    ],
  ),
);

describe("voice navigation (web)", () => {
  test("maps each screen to its workspace route and account to /account", () => {
    expect(targets).toEqual({
      organisationId: "lender-one",
      lots: [lot("CR-0001"), lot("CR-0002")],
      releases: [
        release("CR-0001", RELEASE_ONE),
        release("CR-0002", RELEASE_TWO),
        release("CR-0002", "x".repeat(44)),
      ],
    });
    expect(resolveNavigate({ screen: "queue" }, targets)).toEqual({
      result: { ok: true, screen: "queue" },
      href: "/lender-one/queue",
    });
    expect(resolveNavigate({ screen: "exceptions", id: "ignored" }, targets)).toEqual({
      result: { ok: true, screen: "exceptions" },
      href: "/lender-one/exceptions",
    });
    expect(resolveNavigate({ screen: "account" }, targets)).toEqual({
      result: { ok: true, screen: "account" },
      href: "/account",
    });
  });

  test("opens a lot only when the rail lists it", () => {
    expect(resolveNavigate({ screen: "lot", id: " cr-0002 " }, targets)).toEqual({
      result: { ok: true, screen: "lot" },
      href: "/lender-one/lots/CR-0002",
    });
    expect(resolveNavigate({ screen: "lot", id: "CR-0009" }, targets)).toEqual({
      result: { ok: false, reason: "NOT_FOUND", message: "Lot CR-0009 is not in this workspace." },
      href: null,
    });
  });

  test("opens the one release whose lot id matches, and refuses none or several", () => {
    expect(resolveNavigate({ screen: "release", id: "CR-0001" }, targets)).toEqual({
      result: { ok: true, screen: "release" },
      href: `/lender-one/releases/${RELEASE_ONE}`,
    });
    expect(resolveNavigate({ screen: "release", id: "CR-0003" }, targets)).toEqual({
      result: {
        ok: false,
        reason: "NOT_FOUND",
        message: "There is no release for lot CR-0003 in this workspace.",
      },
      href: null,
    });
    expect(resolveNavigate({ screen: "release", id: "cr-0002" }, targets)).toEqual({
      result: {
        ok: false,
        reason: "MANY_RELEASES",
        message: "Lot CR-0002 has more than one release. Choose one under Releases.",
      },
      href: null,
    });
    // An intent address is never a release id: it fails the id pattern.
    expect(resolveNavigate({ screen: "release", id: RELEASE_ONE }, targets).result).toMatchObject({
      ok: false,
      reason: "BAD_ID",
    });
  });

  test("refuses an unknown screen and a bad or missing id without navigating", () => {
    const unknown = {
      ok: false,
      reason: "UNKNOWN_SCREEN",
      message: "That screen is not in Thetis.",
    };
    const badId = {
      ok: false,
      reason: "BAD_ID",
      message: "That is not a lot id. Lot ids look like CR-0001.",
    };
    for (const screen of ["settings", "Lot", "", undefined, 3, null]) {
      expect(resolveNavigate({ screen, id: "CR-0001" }, targets)).toEqual({
        result: unknown,
        href: null,
      });
    }
    // The model's raw screen string is never echoed.
    expect(JSON.stringify(resolveNavigate({ screen: "<script>" }, targets))).not.toContain(
      "script",
    );
    for (const id of [undefined, "", "   ", "CR 0001", "CR-0001-0001-0001X", 1, null, "cr_0001"]) {
      expect(resolveNavigate({ screen: "lot", id }, targets)).toEqual({
        result: badId,
        href: null,
      });
      expect(resolveNavigate({ screen: "release", id }, targets)).toEqual({
        result: badId,
        href: null,
      });
    }
    // The unknown screen is checked before the id.
    expect(resolveNavigate({ screen: "dossier", id: "bad id" }, targets).result).toEqual(unknown);

    expect(ID_PATTERN.source).toBe("^[A-Z0-9-]{1,16}$");
    expect(normaliseId(" cr-0001 ")).toBe("CR-0001");
    expect(normaliseId("CR-0001-0001-001")).toBe("CR-0001-0001-001");
    expect(normaliseId("CR-0001-0001-0001")).toBeNull();
    expect(normaliseId(42)).toBeNull();
    expect(VOICE_COPY.refusals.UNKNOWN_SCREEN).toBe("That screen is not in Thetis.");
    expect(VOICE_COPY.refusals.BAD_ID).toBe("That is not a lot id. Lot ids look like CR-0001.");
  });
});
