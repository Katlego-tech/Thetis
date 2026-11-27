// Whether this person, organisation and wallet look ready to issue. Informational only: the
// relay and the program decide at signing.
import type { AuthorityView, ChainOrganisation } from "./data/reads";
import { formatDate, shortAddress } from "./format";

export type LinkState = "not_linked" | "linked" | "linked_elsewhere" | "linked_other_org";

export const ISSUE_SCOPE = 1;

const SCOPE_WORDS: ReadonlyArray<readonly [number, string]> = [
  [0, "Issue"],
  [3, "Redeem"],
  [10, "Carry"],
  [11, "Observe"],
  [12, "Load"],
  [14, "Attest transport"],
];

export function scopeWords(scopes: number): string {
  const words = SCOPE_WORDS.filter(([bit]) => (scopes & (1 << bit)) !== 0).map(([, word]) => word);
  return words.length > 0 ? words.join(", ") : "None";
}

export type AuthorityState =
  | { kind: "none" }
  | { kind: "other_org"; otherOrg: string }
  | { kind: "revoked"; at: string }
  | { kind: "expired"; at: string }
  | { kind: "no_issue"; words: string }
  | { kind: "ok"; words: string; expires: string };

export function authorityState(
  authority: AuthorityView | null,
  orgId: string,
  otherOrgName: (orgId: string) => string | null,
  now: bigint,
): AuthorityState {
  if (!authority) return { kind: "none" };
  if (authority.orgId !== orgId) {
    return { kind: "other_org", otherOrg: otherOrgName(authority.orgId) ?? "another organisation" };
  }
  if (authority.revokedAt !== null)
    return { kind: "revoked", at: formatDate(BigInt(authority.revokedAt)) };
  const expires = BigInt(authority.expiresAt);
  if (expires <= now) return { kind: "expired", at: formatDate(expires) };
  const words = scopeWords(authority.scopes);
  if ((authority.scopes & ISSUE_SCOPE) === 0) return { kind: "no_issue", words };
  return { kind: "ok", words, expires: formatDate(expires) };
}

export interface ReadinessInput {
  org: string;
  chainOrganisation: ChainOrganisation | null;
  wallet: string | null;
  link: LinkState | null;
  authority: AuthorityState | null;
}

/** One help line per failed check, in order, as Home shows them. */
export function readinessLines(input: ReadinessInput): string[] {
  const lines: string[] = [];
  if (!input.wallet) {
    lines.push("You can still start an intake. Signing needs a wallet.");
    return lines;
  }
  if (input.link !== "linked") lines.push("Link this wallet");
  const a = input.authority;
  if (!a) return lines;
  switch (a.kind) {
    case "none":
      lines.push(
        `Ask an admin of ${input.org} to delegate Issue to ${shortAddress(input.wallet)}.`,
      );
      break;
    case "other_org":
      lines.push(
        `Ask an admin of ${input.org} to delegate a different wallet. Linking alone gives no signing authority.`,
      );
      break;
    case "no_issue":
      lines.push(
        "Ask your admin to delegate Issue to this wallet. Delegations can't be widened, so this means a new wallet.",
      );
      break;
    case "revoked":
    case "expired":
      lines.push(
        `This wallet can no longer sign for ${input.org}. Ask your admin to delegate a new wallet.`,
      );
      break;
    case "ok":
      break;
  }
  return lines;
}

export function isReadyToIssue(input: ReadinessInput): boolean {
  return (
    input.chainOrganisation?.role === "Custodian" &&
    input.wallet !== null &&
    input.link === "linked" &&
    input.authority?.kind === "ok"
  );
}
