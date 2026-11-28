"use client";

import type { Session } from "@supabase/supabase-js";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/thetis/page-header";
import { accessMessages } from "@/lib/access-messages";
import { formatDateTime } from "@/lib/format";
import { supabaseBrowser } from "@/lib/supabase-browser";
import { LinkPanel } from "./link-panel";
import { isExpiredResponse, loginHref } from "./session-expired";

const messages = accessMessages.account;
const accountPath = "/account";
const walletColumns = ["Wallet", "State", "Action"];
const organisationColumns = ["Organisation", "Kind", "Role", "Member since"];

type Organisation = {
  id: string;
  slug: string;
  name: string;
  kind: string;
  synthetic: boolean;
};

type Membership = {
  id: string;
  member_role: "admin" | "member";
  created_at: string;
  organisations: Organisation | null;
};

type SignerLink = {
  id: string;
  wallet: string;
  organisation_id: string;
  linked_at: string;
  revoked_at: string | null;
};

type Lists =
  | { phase: "loading" | "failed" }
  | { phase: "loaded"; memberships: Membership[]; links: SignerLink[] };

function selectMemberships(userId: string) {
  return supabaseBrowser()
    .from("memberships")
    .select("id, member_role, created_at, organisations(id, slug, name, kind, synthetic)")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .order("created_at", { ascending: true });
}

function selectSignerLinks(userId: string) {
  return supabaseBrowser()
    .from("signer_links")
    .select("id, wallet, organisation_id, linked_at, revoked_at")
    .eq("user_id", userId)
    .order("linked_at", { ascending: false });
}

function AccountTable({
  columns,
  loading = false,
  children,
}: {
  columns: string[];
  loading?: boolean;
  children?: ReactNode;
}) {
  return (
    <table className="access-table">
      <thead>
        <tr>
          {columns.map((column) => (
            <th
              key={column}
              scope="col"
              className={column === "Action" ? "access-table-action" : undefined}
            >
              {column === "Action" ? <span className="sr-only">{column}</span> : column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {loading
          ? [0, 1, 2].map((row) => (
              <tr key={row}>
                {columns.map((column) => (
                  <td key={column}>
                    <span className="access-skeleton" />
                  </td>
                ))}
              </tr>
            ))
          : children}
      </tbody>
    </table>
  );
}

export function AccountScreen() {
  const { replace } = useRouter();
  const [session, setSession] = useState<Session>();
  const [lists, setLists] = useState<Lists>({ phase: "loading" });
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [revokePending, setRevokePending] = useState(false);
  const [revokeAlert, setRevokeAlert] = useState("");
  const [staleLinks, setStaleLinks] = useState(false);
  const [staleMemberships, setStaleMemberships] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const keepButton = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false);

  useEffect(() => {
    let active = true;
    mounted.current = true;

    async function load() {
      try {
        const { data, error } = await supabaseBrowser().auth.getSession();
        if (!active) return;
        if (error?.status === 401) {
          replace(loginHref(accountPath, true));
          return;
        }
        if (error) {
          setLists({ phase: "failed" });
          return;
        }
        if (!data.session) {
          replace(loginHref(accountPath, false));
          return;
        }

        setSession(data.session);
        const userId = data.session.user.id;
        const [membershipsResult, linksResult] = await Promise.allSettled([
          selectMemberships(userId),
          selectSignerLinks(userId),
        ]);
        if (!active) return;

        const memberships =
          membershipsResult.status === "fulfilled" ? membershipsResult.value : null;
        const links = linksResult.status === "fulfilled" ? linksResult.value : null;

        if (
          (memberships && isExpiredResponse(memberships)) ||
          (links && isExpiredResponse(links))
        ) {
          setRedirecting(true);
          replace(loginHref(accountPath, true));
        } else if (!memberships?.data || memberships.error || !links?.data || links.error) {
          setLists({ phase: "failed" });
        } else {
          setLists({
            phase: "loaded",
            // memberships.organisation_id is a many-to-one key, so PostgREST embeds one object;
            // without generated types supabase-js types the embed as an array.
            memberships: memberships.data as unknown as Membership[],
            links: links.data as SignerLink[],
          });
        }
      } catch {
        if (active) setLists({ phase: "failed" });
      }
    }

    void load();
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [replace]);

  const lastConfirmId = useRef<string | null>(null);
  useEffect(() => {
    if (confirmId) keepButton.current?.focus();
    else if (lastConfirmId.current) {
      // Return focus to the row's Revoke button (or the list heading if the row is now revoked).
      const row = document.querySelector<HTMLElement>(`[data-revoke="${lastConfirmId.current}"]`);
      (row ?? document.getElementById("access-wallets"))?.focus();
    }
    lastConfirmId.current = confirmId;
  }, [confirmId]);

  function redirectExpired() {
    setRedirecting(true);
    replace(loginHref(accountPath, true));
  }

  // Reads a list again. A failed read keeps the last loaded tables and marks that list stale
  // (account.refreshFailed); only the first load can replace the page with account.loadFailed.
  async function reloadLinks(): Promise<SignerLink[] | null> {
    if (!session) return null;
    try {
      const result = await selectSignerLinks(session.user.id);
      if (!mounted.current) return null;
      if (isExpiredResponse(result)) {
        redirectExpired();
        return null;
      }
      if (!result.data || result.error) {
        setStaleLinks(true);
        return null;
      }
      const links = result.data as SignerLink[];
      setLists((previous) => (previous.phase === "loaded" ? { ...previous, links } : previous));
      setStaleLinks(false);
      return links;
    } catch {
      if (mounted.current) setStaleLinks(true);
      return null;
    }
  }

  async function reloadMemberships() {
    if (!session) return;
    try {
      const result = await selectMemberships(session.user.id);
      if (!mounted.current) return;
      if (isExpiredResponse(result)) {
        redirectExpired();
      } else if (!result.data || result.error) {
        setStaleMemberships(true);
      } else {
        const next = result.data as unknown as Membership[];
        setLists((previous) =>
          previous.phase === "loaded" ? { ...previous, memberships: next } : previous,
        );
        setStaleMemberships(false);
      }
    } catch {
      if (mounted.current) setStaleMemberships(true);
    }
  }

  async function refreshLists() {
    await Promise.all([reloadLinks(), reloadMemberships()]);
  }

  // The token is read when each request is made: a session refreshed since mount is the one sent.
  async function getAccessToken(): Promise<string | null> {
    const { data, error } = await supabaseBrowser().auth.getSession();
    if (error?.status === 401 || (!error && !data.session)) return null;
    if (error || !data.session) throw error;
    return data.session.access_token;
  }

  async function revoke(linkId: string) {
    if (!session || revokePending || confirmId !== linkId) return;
    setRevokePending(true);

    try {
      const result = await supabaseBrowser()
        .rpc("revoke_wallet_link", { link_id: linkId })
        .then(
          (response) => response,
          () => null,
        );
      if (!mounted.current) return;
      if (result && isExpiredResponse(result)) {
        redirectExpired();
        return;
      }
      setConfirmId(null);
      if (result?.error?.code === "P0001") {
        if (result.error.message === "NOT_AUTHORISED") {
          setRevokeAlert(messages.revokeNotAllowed);
          return;
        }
        setRevokeAlert(
          result.error.message === "LINK_INVALID" ? messages.revokeAlready : messages.revokeFailed,
        );
      } else if (!result || result.error) {
        // The revoke may have committed: reload and let the list say, rather than claim either.
        setRevokeAlert(messages.revokeFailed);
      }
      await reloadLinks();
    } catch {
      if (mounted.current) {
        setConfirmId(null);
        setRevokeAlert(messages.revokeFailed);
        setStaleLinks(true);
      }
    } finally {
      if (mounted.current) setRevokePending(false);
    }
  }

  if (redirecting || (!session && lists.phase === "loading")) return null;

  const loading = lists.phase === "loading";
  const memberships = lists.phase === "loaded" ? lists.memberships : [];
  const links = lists.phase === "loaded" ? lists.links : [];
  const orgNames = new Map<string, string>();
  for (const { organisations } of memberships) {
    if (organisations) orgNames.set(organisations.id, organisations.name);
  }

  return (
    <div className="access-account">
      <PageHeader
        title="Your account"
        sub={session?.user.email}
        aside={
          <div className="access-account-cert">
            <div>Session only</div>
            <div>No signing authority</div>
          </div>
        }
      />
      <div className="access-cols">
        <div>
          <section
            className="access-stack"
            aria-labelledby="access-wallets"
            aria-busy={loading || undefined}
          >
            <h2 id="access-wallets" tabIndex={-1}>
              Linked wallets
            </h2>
            {lists.phase === "failed" && revokeAlert && (
              <div className="access-error" role="alert">
                {revokeAlert}
              </div>
            )}
            {lists.phase === "failed" ? (
              <div className="access-error" role="alert">
                {messages.loadFailed}
              </div>
            ) : (
              <>
                {revokeAlert && (
                  <div className="access-error" role="alert">
                    {revokeAlert}
                  </div>
                )}
                {(staleLinks || staleMemberships) && (
                  <div className="access-stack">
                    <div className="access-error" role="alert">
                      {messages.refreshFailed}
                    </div>
                    <div className="access-actions">
                      <button
                        type="button"
                        className="access-account-button access-outline"
                        onClick={() => void refreshLists()}
                      >
                        Refresh list
                      </button>
                    </div>
                  </div>
                )}
                {loading || links.length ? (
                  <AccountTable columns={walletColumns} loading={loading}>
                    {links.map((link) => {
                      const name = orgNames.get(link.organisation_id);
                      const revoked = link.revoked_at;
                      return (
                        <tr key={link.id}>
                          {confirmId === link.id ? (
                            <td colSpan={3}>
                              <div className="access-stack access-revoke-confirm">
                                <p className="access-wallet-address">{link.wallet}</p>
                                <p>
                                  Revoke this link? Thetis stops treating this wallet as yours for{" "}
                                  {name ? <strong>{name}</strong> : "its organisation"}. You can
                                  link it again later.
                                </p>
                                <div className="access-actions">
                                  <button
                                    type="button"
                                    className="access-primary access-account-button"
                                    disabled={revokePending}
                                    aria-busy={revokePending || undefined}
                                    onClick={() => void revoke(link.id)}
                                  >
                                    Revoke link
                                  </button>
                                  <button
                                    type="button"
                                    className="access-account-button access-outline"
                                    ref={keepButton}
                                    disabled={revokePending}
                                    onClick={() => setConfirmId(null)}
                                  >
                                    Keep link
                                  </button>
                                </div>
                              </div>
                            </td>
                          ) : (
                            <>
                              <td data-label="Wallet">
                                <span className="access-wallet-address">{link.wallet}</span>
                                <span className="access-wallet-basis">
                                  {name && `For ${name}. `}Linked {formatDateTime(link.linked_at)}
                                </span>
                              </td>
                              <td data-label="State">
                                <span className="access-link-state">
                                  <span>Link</span>{" "}
                                  {revoked
                                    ? `Revoked ${formatDateTime(revoked).split(",")[0]}`
                                    : "Active"}
                                </span>
                              </td>
                              <td className="access-table-action" data-label="Action">
                                {!revoked && (
                                  <button
                                    type="button"
                                    className="access-account-button access-outline"
                                    data-revoke={link.id}
                                    disabled={revokePending}
                                    onClick={() => {
                                      setRevokeAlert("");
                                      setConfirmId(link.id);
                                    }}
                                  >
                                    Revoke
                                  </button>
                                )}
                              </td>
                            </>
                          )}
                        </tr>
                      );
                    })}
                  </AccountTable>
                ) : (
                  <p className="access-intro">{messages.noWallets}</p>
                )}
                {!loading && (
                  <p className="access-help">
                    A link records the wallet as yours in Thetis. It is not on chain and gives no
                    signing authority by itself.
                  </p>
                )}
              </>
            )}
          </section>
          {lists.phase !== "failed" && (
            <section
              className="access-stack"
              aria-labelledby="access-organisations"
              aria-busy={loading || undefined}
            >
              <h2 id="access-organisations">Organisations</h2>
              {loading || memberships.length ? (
                <AccountTable columns={organisationColumns} loading={loading}>
                  {memberships.map(
                    ({ id, member_role, created_at, organisations: org }) =>
                      org && (
                        <tr key={id}>
                          <td data-label="Organisation">
                            <Link className="access-link" href={`/${org.slug}/queue`}>
                              {org.name}
                            </Link>
                          </td>
                          <td data-label="Kind">
                            {org.kind.charAt(0).toUpperCase() + org.kind.slice(1)}
                            {org.synthetic && ", synthetic"}
                          </td>
                          <td data-label="Role">{member_role === "admin" ? "Admin" : "Member"}</td>
                          <td data-label="Member since">
                            {formatDateTime(created_at).split(",")[0]}
                          </td>
                        </tr>
                      ),
                  )}
                </AccountTable>
              ) : (
                <p className="access-intro">{messages.noMembership}</p>
              )}
            </section>
          )}
        </div>
        {lists.phase !== "failed" && session && (
          <LinkPanel
            getAccessToken={getAccessToken}
            memberships={
              lists.phase === "loaded"
                ? lists.memberships.flatMap(({ organisations: org }) =>
                    org ? [{ id: org.id, name: org.name }] : [],
                  )
                : null
            }
            reloadLinks={reloadLinks}
            reloadMemberships={() => void reloadMemberships()}
            onSessionExpired={redirectExpired}
          />
        )}
      </div>
    </div>
  );
}
