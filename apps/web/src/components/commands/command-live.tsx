"use client";

import { getWallets } from "@wallet-standard/app";
import type { WalletAccount } from "@wallet-standard/base";
import { StandardConnect, type StandardConnectFeature } from "@wallet-standard/features";
import { useCallback, useEffect, useRef, useState } from "react";
import { accessMessages } from "@/lib/access-messages";
import {
  type CommandView,
  getCommand,
  postCommandSignature,
  postCommandTransaction,
  renewCommand,
  requestCommandTransaction,
  type SignerRole,
} from "@/lib/commands";
import { supabaseBrowser } from "@/lib/supabase-browser";
import {
  type SigningWallet,
  signingWallets,
  signTextBytes,
  signTransactionBytes,
} from "@/lib/wallets";
import { CommandScreen, decodeText } from "./command-screen";
import { browserSession, failureMessage } from "./messages";
import { OutcomePanel } from "./outcome-panel";
import { type Connection, SignersPanel } from "./signers-panel";
import { OPEN_STATUSES, statusLine } from "./status";

// The command page's client leaf (live-lending.md §6.9.4): it polls the API while the command is open,
// connects wallets, and posts exactly the bytes the API issued with the wallet's signature.

const POLL_MS = 2000;
// A poll that has not answered after two intervals is abandoned, so a request that never settles
// can't hold the in-flight guard and stop polling (T056x review).
const POLL_TIMEOUT_MS = 2 * POLL_MS;
const textChanged = "The text changed. Reload the page.";
const blockhashExpired = "The transaction took too long to sign. Sign it again.";
const cancelled = (wallet: string) => `You cancelled in ${wallet}. Nothing was signed.`;
const noSession = accessMessages.login.sessionEnded;
const linksUnreadable = "Thetis could not read your linked wallets. Reload the page to sign.";

function isSolanaAccount(account: WalletAccount): boolean {
  return account.chains.some((chain) => chain.startsWith("solana:"));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function CommandLive({
  initial,
  context,
  memberships,
  organisations,
  lotId,
}: {
  initial: CommandView;
  context: string;
  /** the user's organisation uuids */
  memberships: string[];
  /** organisation uuid to display name, for every party the view names */
  organisations: Record<string, string>;
  lotId: string | null;
}) {
  const [view, setViewState] = useState(initial);
  // Every view this page sets itself (a signature, a transaction, a renewal) bumps the generation;
  // a poll that started before it answers with an older view and is dropped (T056x X2).
  const generation = useRef(0);
  const setView = useCallback((next: CommandView) => {
    generation.current += 1;
    setViewState(next);
  }, []);
  const [links, setLinks] = useState<Map<string, Set<string>> | null>(null);
  const [wallets, setWallets] = useState<SigningWallet[]>([]);
  const [connections, setConnections] = useState(new Map<string, Map<string, Connection>>());
  const accounts = useRef(new Map<string, WalletAccount[]>());
  const [busy, setBusy] = useState(false);
  const [signProblem, setSignProblem] = useState<string | null>(null);
  const [outcomeProblem, setOutcomeProblem] = useState<string | null>(null);
  const [renewing, setRenewing] = useState(false);

  const organisationName = useCallback(
    (id: string) => organisations[id] ?? "an organisation you can't see",
    [organisations],
  );

  // Poll while open; stop once the command is confirmed, failed or expired.
  const open = OPEN_STATUSES.includes(view.status);
  useEffect(() => {
    if (!open) return;
    let stopped = false;
    // One poll at a time: a tick while the previous request is out starts nothing (T056x X2).
    let inFlight = false;
    const timer = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const started = generation.current;
        const session = await browserSession().catch(() => null);
        if (!session || stopped) return;
        const result = await getCommand(view.id, session.token, {
          signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
        });
        if (stopped || generation.current !== started) return;
        if (result.ok) {
          setViewState(result.data);
          setOutcomeProblem(null);
        } else {
          setOutcomeProblem(failureMessage(result));
        }
      } finally {
        inFlight = false;
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [open, view.id]);

  // The wallets this browser offers.
  useEffect(() => {
    const registry = getWallets();
    const refresh = () => setWallets(signingWallets(registry.get()));
    refresh();
    const offRegister = registry.on("register", refresh);
    const offUnregister = registry.on("unregister", refresh);
    return () => {
      offRegister();
      offUnregister();
    };
  }, []);

  // The user's active signer links, read as account-screen.tsx reads them. A failed read offers no
  // wallet: it never claims the user has no link.
  useEffect(() => {
    let current = true;
    (async () => {
      const session = await browserSession().catch(() => null);
      if (!current) return;
      if (!session) {
        setSignProblem(noSession);
        return;
      }
      const result = await Promise.resolve(
        supabaseBrowser()
          .from("signer_links")
          .select("wallet, organisation_id")
          .eq("user_id", session.userId)
          .is("revoked_at", null),
      ).catch(() => ({ data: null, error: new Error("unreachable") }));
      if (!current) return;
      if (result.error || !Array.isArray(result.data)) {
        setSignProblem(linksUnreadable);
        return;
      }
      const byOrganisation = new Map<string, Set<string>>();
      for (const row of result.data as { wallet: string; organisation_id: string }[]) {
        const set = byOrganisation.get(row.organisation_id) ?? new Set<string>();
        set.add(row.wallet);
        byOrganisation.set(row.organisation_id, set);
      }
      setLinks(byOrganisation);
    })();
    return () => {
      current = false;
    };
  }, []);

  // Each connected wallet offers its first account linked to each organisation.
  function remember(wallet: SigningWallet, found: WalletAccount[]) {
    accounts.current.set(wallet.name, found);
    const perOrganisation = new Map<string, Connection>();
    for (const organisationId of memberships) {
      const linked = links?.get(organisationId) ?? new Set<string>();
      const account = found.find(({ address }) => linked.has(address));
      perOrganisation.set(organisationId, { address: account?.address ?? null });
    }
    setConnections((current) => new Map(current).set(wallet.name, perOrganisation));
  }

  async function connect(wallet: SigningWallet) {
    setSignProblem(null);
    setBusy(true);
    try {
      const feature = wallet.wallet.features[StandardConnect] as
        | StandardConnectFeature[typeof StandardConnect]
        | undefined;
      const result = await feature?.connect();
      remember(wallet, (result?.accounts ?? []).filter(isSolanaAccount));
    } catch {
      setSignProblem(`${wallet.name} did not connect. Nothing was signed.`);
    } finally {
      setBusy(false);
    }
  }

  async function sign(role: SignerRole, wallet: SigningWallet, address: string) {
    const signer = view.signers.find((entry) => entry.role === role);
    const account = accounts.current.get(wallet.name)?.find((entry) => entry.address === address);
    if (!signer || !account) return;
    setSignProblem(null);
    setBusy(true);
    try {
      const session = await browserSession().catch(() => null);
      if (!session) {
        setSignProblem(noSession);
        return;
      }
      if (signer.method === "text") {
        if (!view.text) return;
        const bytes = decodeText(view.text.messageBase64);
        const messageSha256 = await sha256Hex(bytes);
        if (messageSha256 !== view.text.messageSha256) {
          setSignProblem(textChanged);
          return;
        }
        let signature: string;
        try {
          signature = await signTextBytes(wallet.wallet, account, bytes);
        } catch {
          setSignProblem(cancelled(wallet.name));
          return;
        }
        const posted = await postCommandSignature(
          view.id,
          { role, wallet: address, messageSha256, signature },
          session.token,
        );
        if (posted.ok) setView(posted.data);
        else setSignProblem(failureMessage(posted));
        return;
      }

      const issued = await requestCommandTransaction(view.id, address, session.token);
      if (!issued.ok) {
        setSignProblem(
          issued.code === "BLOCKHASH_EXPIRED" ? blockhashExpired : failureMessage(issued),
        );
        return;
      }
      let signed: Uint8Array;
      try {
        signed = await signTransactionBytes(
          wallet.wallet,
          account,
          decodeText(issued.data.transactionBase64),
        );
      } catch {
        setSignProblem(cancelled(wallet.name));
        return;
      }
      const sent = await postCommandTransaction(view.id, toBase64(signed), session.token);
      if (sent.ok) setView(sent.data);
      else
        setSignProblem(sent.code === "BLOCKHASH_EXPIRED" ? blockhashExpired : failureMessage(sent));
    } finally {
      setBusy(false);
    }
  }

  async function renew() {
    setOutcomeProblem(null);
    setRenewing(true);
    try {
      const session = await browserSession().catch(() => null);
      if (!session) {
        setOutcomeProblem(noSession);
        return;
      }
      const renewed = await renewCommand(view.id, session.token);
      if (renewed.ok) setView(renewed.data);
      else setOutcomeProblem(failureMessage(renewed));
    } finally {
      setRenewing(false);
    }
  }

  return (
    <CommandScreen
      view={view}
      lotId={lotId}
      signers={
        <SignersPanel
          view={view}
          memberships={memberships}
          organisationName={organisationName}
          links={links}
          wallets={wallets}
          connections={connections}
          busy={busy}
          problem={signProblem}
          onConnect={connect}
          onSign={sign}
        />
      }
      outcome={
        <OutcomePanel
          view={view}
          line={statusLine(view, organisationName)}
          context={context}
          lotId={lotId}
          canRenew={memberships.includes(view.initiatorOrganisationId)}
          renewing={renewing}
          onRenew={renew}
          problem={outcomeProblem}
        />
      }
    />
  );
}
