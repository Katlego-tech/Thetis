// voice.md §5.2, field column: the only path from a navigate_to call to a tab. Pure; no React.
// The types and ID_PATTERN duplicate the web's lib/voice.ts.
import { VOICE_COPY } from "../copy";
import type { Tab } from "../nav";

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

const SCREENS: readonly VoiceScreen[] = ["queue", "exceptions", "lot", "release", "account"];

/** Trimmed and upper-cased, if it then matches ID_PATTERN; otherwise null. */
export function normaliseId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim().toUpperCase();
  return ID_PATTERN.test(id) ? id : null;
}

function refuse(reason: NavigateRefusal, message: string) {
  return { result: { ok: false as const, reason, message }, tab: null };
}

/**
 * Resolution order: unknown screen, then no phone equivalent (before the id, since no id makes it
 * reachable), then busy. The phone has no lot or release screen, so the id is never read here.
 */
export function resolveNavigate(
  args: Record<string, unknown>,
  busy: boolean,
): { result: NavigateResult; tab: Tab | null } {
  const screen = SCREENS.find((s) => s === args.screen);
  if (!screen) return refuse("UNKNOWN_SCREEN", VOICE_COPY.refusals.UNKNOWN_SCREEN);
  if (screen === "exceptions" || screen === "lot" || screen === "release")
    return refuse("NOT_ON_PHONE", VOICE_COPY.refusals.NOT_ON_PHONE[screen]);
  if (busy) return refuse("BUSY", VOICE_COPY.refusals.BUSY);
  return { result: { ok: true, screen }, tab: screen === "queue" ? "home" : "account" };
}
