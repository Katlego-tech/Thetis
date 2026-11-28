// voice.md §5.2 and §5.3: the only path from a navigate_to call (or the typed fallback) to a route.
// Pure: no React, no fetch. A route is built only for a target the rail lists for this organisation.

import type { RailItem, RailSection } from "@/components/shell/rail-nav";

export const ID_PATTERN = /^[A-Z0-9-]{1,16}$/;

export type VoiceScreen = "queue" | "exceptions" | "lot" | "release" | "account";
export type NavigateRefusal =
  | "UNKNOWN_SCREEN"
  | "BAD_ID"
  | "NOT_FOUND"
  | "MANY_RELEASES"
  | "NOT_ON_PHONE"
  | "BUSY";
export type NavigateResult =
  | { ok: true; screen: VoiceScreen }
  | { ok: false; reason: NavigateRefusal; message: string };

export interface VoiceTargets {
  organisationId: string;
  lots: RailItem[];
  releases: RailItem[];
}

const SCREENS: readonly VoiceScreen[] = ["queue", "exceptions", "lot", "release", "account"];

/** Every web string in voice.md §5.1 and §5.2, verbatim. */
export const VOICE_COPY = {
  heading: "Voice",
  talk: {
    idle: { label: "Talk", name: "Talk to the Thetis navigator" },
    connecting: { label: "Connecting", name: "Connecting to voice" },
    live: { label: "End", name: "End voice session" },
    unavailable: { label: "Talk", name: "Try voice again" },
  },
  status: {
    idle: "Ask to open a screen, or what evidence a lot has.",
    connecting: "Starting voice.",
    refetching: "Getting a new voice session.",
    listening: "Listening.",
    speaking: "Speaking.",
    unavailable: "Voice is unavailable. Use the controls below.",
    microphone: "Microphone access is off for this site. Allow it in the browser, then press Talk.",
  },
  fallback: {
    screenLabel: "Open a screen",
    idLabel: "Lot id",
    idPlaceholder: "CR-0001",
    open: "Open",
    screens: {
      queue: "Work queue",
      exceptions: "Exceptions",
      lot: "Lot",
      release: "Release",
      account: "Your account",
    } satisfies Record<VoiceScreen, string>,
  },
  refusals: {
    UNKNOWN_SCREEN: "That screen is not in Thetis.",
    BAD_ID: "That is not a lot id. Lot ids look like CR-0001.",
    notFoundLot: (id: string) => `Lot ${id} is not in this workspace.`,
    notFoundRelease: (id: string) => `There is no release for lot ${id} in this workspace.`,
    MANY_RELEASES: (id: string) =>
      `Lot ${id} has more than one release. Choose one under Releases.`,
  },
} as const;

/** The lots and releases the rail lists for this organisation (§5.2 step 5). */
export function targetsFrom(organisationId: string, sections: RailSection[]): VoiceTargets {
  const items = (segment: RailSection["segment"]) =>
    sections.find((section) => section.segment === segment)?.items ?? [];
  return { organisationId, lots: items("lots"), releases: items("releases") };
}

/** Trim, upper-case and check against ID_PATTERN; null for anything else. */
export function normaliseId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim().toUpperCase();
  return ID_PATTERN.test(id) ? id : null;
}

function refuse(reason: NavigateRefusal, message: string) {
  return { result: { ok: false as const, reason, message }, href: null };
}

/** voice.md §5.2's resolution order, web column. The client navigates only to a returned href. */
export function resolveNavigate(
  args: Record<string, unknown>,
  targets: VoiceTargets,
): { result: NavigateResult; href: string | null } {
  const screen = SCREENS.find((candidate) => candidate === args.screen);
  if (!screen) return refuse("UNKNOWN_SCREEN", VOICE_COPY.refusals.UNKNOWN_SCREEN);
  const base = `/${targets.organisationId}`;
  const done = (href: string) => ({ result: { ok: true as const, screen }, href });
  switch (screen) {
    case "queue":
      return done(`${base}/queue`);
    case "exceptions":
      return done(`${base}/exceptions`);
    case "account":
      return done("/account");
    case "lot": {
      const id = normaliseId(args.id);
      if (id === null) return refuse("BAD_ID", VOICE_COPY.refusals.BAD_ID);
      if (!targets.lots.some(({ label }) => label === id))
        return refuse("NOT_FOUND", VOICE_COPY.refusals.notFoundLot(id));
      return done(`${base}/lots/${encodeURIComponent(id)}`);
    }
    case "release": {
      const id = normaliseId(args.id);
      if (id === null) return refuse("BAD_ID", VOICE_COPY.refusals.BAD_ID);
      const matches = targets.releases.filter(({ label }) => label === id);
      const [only] = matches;
      if (!only) return refuse("NOT_FOUND", VOICE_COPY.refusals.notFoundRelease(id));
      if (matches.length > 1) return refuse("MANY_RELEASES", VOICE_COPY.refusals.MANY_RELEASES(id));
      return done(only.href);
    }
  }
}
