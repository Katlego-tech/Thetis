// The "Signing as" facts every screen shows: chain organisation, wallet link and authority.
import { useCallback, useEffect, useState } from "react";
import { useApp } from "../context";
import { type AuthorityState, authorityState, type LinkState } from "../readiness";
import {
  type AuthorityView,
  type ChainOrganisation,
  ReadError,
  readAuthority,
  readChainOrganisation,
  readSignerLinks,
  type SignerLink,
} from "./reads";

export function linkStateOf(
  links: readonly SignerLink[],
  userId: string,
  orgId: string,
): LinkState {
  if (links.some((l) => l.userId === userId && l.organisationId === orgId)) return "linked";
  if (links.some((l) => l.userId !== userId)) return "linked_elsewhere";
  if (links.some((l) => l.userId === userId)) return "linked_other_org";
  return "not_linked";
}

export interface SigningFacts {
  loading: boolean;
  error: ReadError | null;
  chainOrganisation: ChainOrganisation | null;
  link: LinkState | null;
  linkOtherOrgId: string | null;
  authorityRow: AuthorityView | null;
  authority: AuthorityState | null;
  /** Set when these facts are this phone's last read, shown offline: the time they were read. */
  asOf: string | null;
  reload: () => void;
}

export function useSigning(): SigningFacts {
  const app = useApp();
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<Omit<SigningFacts, "reload">>({
    loading: true,
    error: null,
    chainOrganisation: null,
    link: null,
    linkOtherOrgId: null,
    authorityRow: null,
    authority: null,
    asOf: null,
  });
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const orgId = app.organisation.organisationId;
  const wallet = app.wallet?.address ?? null;
  const { db, protocol, user, memberships, online, cache } = app;
  const nameOf = useCallback(
    (id: string) => memberships.find((m) => m.organisationId === id)?.name ?? null,
    [memberships],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick forces a re-read
  useEffect(() => {
    let live = true;
    if (!online) {
      // Offline: the last facts read for this organisation, marked with their time. The link and
      // authority count only for the wallet they were read for.
      void cache.signing(user.id, orgId).then((cached) => {
        if (!live) return;
        if (!cached) return setState((s) => ({ ...s, loading: false }));
        const facts = cached.value;
        const sameWallet = wallet !== null && facts.wallet === wallet;
        const now = BigInt(Math.floor(Date.now() / 1_000));
        setState({
          loading: false,
          error: null,
          chainOrganisation: facts.chainOrganisation,
          link: sameWallet ? facts.link : null,
          linkOtherOrgId: sameWallet ? facts.linkOtherOrgId : null,
          authorityRow: sameWallet ? facts.authorityRow : null,
          authority: sameWallet ? authorityState(facts.authorityRow, orgId, nameOf, now) : null,
          asOf: cached.savedAt,
        });
      });
      return () => {
        live = false;
      };
    }
    setState((s) => ({ ...s, loading: true, error: null }));
    (async () => {
      const chainOrganisation = await readChainOrganisation(db, protocol.protocol, orgId);
      let link: LinkState | null = null;
      let linkOtherOrgId: string | null = null;
      let authorityRow: AuthorityView | null = null;
      if (wallet) {
        const links = await readSignerLinks(db, wallet);
        link = linkStateOf(links, user.id, orgId);
        linkOtherOrgId =
          links.find((l) => l.userId === user.id && l.organisationId !== orgId)?.organisationId ??
          null;
        authorityRow = await readAuthority(db, protocol.protocol, wallet);
      }
      const now = BigInt(Math.floor(Date.now() / 1_000));
      const authority = wallet ? authorityState(authorityRow, orgId, nameOf, now) : null;
      if (live) {
        setState({
          loading: false,
          error: null,
          chainOrganisation,
          link,
          linkOtherOrgId,
          authorityRow,
          authority,
          asOf: null,
        });
        void cache.setSigning(
          user.id,
          orgId,
          { wallet, chainOrganisation, link, linkOtherOrgId, authorityRow },
          new Date().toISOString(),
        );
      }
    })().catch((error: unknown) => {
      if (live) {
        setState((s) => ({
          ...s,
          loading: false,
          error: error instanceof ReadError ? error : new ReadError(false, String(error)),
        }));
      }
    });
    return () => {
      live = false;
    };
  }, [db, protocol.protocol, orgId, wallet, user.id, nameOf, online, cache, tick]);

  return { ...state, reload };
}
