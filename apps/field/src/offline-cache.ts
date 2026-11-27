// What the gates and the "Signing as" card last read, kept so a cold start with no network can
// still open Home and its drafts (A24). Stored in the session's encrypted storage, each entry
// with the time it was read; it is never evidence of anything on chain.
import type { AuthorityView, ChainOrganisation, Membership } from "./data/reads";
import type { ProtocolContext } from "./protocol";
import type { LinkState } from "./readiness";
import type { KeyValueStorage } from "./secure-session";

export interface Cached<T> {
  value: T;
  savedAt: string;
}

/** The "Signing as" facts for one organisation, as last read for one wallet. */
export interface CachedSigning {
  wallet: string | null;
  chainOrganisation: ChainOrganisation | null;
  link: LinkState | null;
  linkOtherOrgId: string | null;
  authorityRow: AuthorityView | null;
}

const key = {
  memberships: (userId: string) => `thetis.field.cache.memberships.${userId}`,
  protocol: (userId: string) => `thetis.field.cache.protocol.${userId}`,
  signing: (userId: string, orgId: string) => `thetis.field.cache.signing.${userId}.${orgId}`,
};

export function createOfflineCache(storage: KeyValueStorage) {
  async function read<T>(name: string): Promise<Cached<T> | null> {
    try {
      const raw = await storage.getItem(name);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Cached<T>;
      return typeof parsed.savedAt === "string" && "value" in parsed ? parsed : null;
    } catch {
      return null;
    }
  }
  async function write<T>(name: string, value: T, savedAt: string): Promise<void> {
    try {
      await storage.setItem(name, JSON.stringify({ value, savedAt }));
    } catch {
      // A cache that can't be written only means the next offline start shows the gate's error.
    }
  }
  return {
    memberships: (userId: string) => read<Membership[]>(key.memberships(userId)),
    setMemberships: (userId: string, rows: Membership[], savedAt: string) =>
      write(key.memberships(userId), rows, savedAt),
    protocol: (userId: string) => read<ProtocolContext>(key.protocol(userId)),
    setProtocol: (userId: string, context: ProtocolContext, savedAt: string) =>
      write(key.protocol(userId), context, savedAt),
    signing: (userId: string, orgId: string) => read<CachedSigning>(key.signing(userId, orgId)),
    setSigning: (userId: string, orgId: string, facts: CachedSigning, savedAt: string) =>
      write(key.signing(userId, orgId), facts, savedAt),
  };
}

export type OfflineCache = ReturnType<typeof createOfflineCache>;
