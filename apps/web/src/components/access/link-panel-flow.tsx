"use client";

import { getWallets } from "@wallet-standard/app";
import type { WalletAccount } from "@wallet-standard/base";
import type { StandardConnectFeature, StandardEventsFeature } from "@wallet-standard/features";
import { StandardConnect, StandardEvents } from "@wallet-standard/features";
import { useEffect, useRef, useState } from "react";
import { accessMessages } from "@/lib/access-messages";
import { type ApiResult, apiPost, type WalletChallenge, type WalletLink } from "@/lib/api";
import { formatClockTime } from "@/lib/format";
import { type LinkableWallet, linkableWallets, signLinkMessage } from "@/lib/wallets";

const messages = accessMessages.link;

export type LinkOrganisation = { id: string; name: string };
export type LinkRow = {
  id: string;
  wallet: string;
  organisation_id: string;
  revoked_at: string | null;
};

export type Phase =
  | "choose"
  | "connecting"
  | "preparing"
  | "ready"
  | "signing"
  | "checking"
  | "linked"
  | "mismatch"
  | "expired"
  | "taken"
  | "unconfirmed"
  | "failed";

export type FlowState = {
  phase: Phase;
  wallet: LinkableWallet | null;
  account: WalletAccount | null;
  org: LinkOrganisation | null;
  challenge: WalletChallenge | null;
  linked: WalletLink | null;
  /** the list reload after Linked failed, so the page may not show the new row yet */
  listFailed: boolean;
  error: string;
};

export type FlowProps = {
  /** reads the current session at call time; null when there is none */
  getAccessToken: () => Promise<string | null>;
  memberships: LinkOrganisation[];
  reloadLinks: () => Promise<LinkRow[] | null>;
  reloadMemberships: () => void;
  onSessionExpired: () => void;
};

const initial: FlowState = {
  phase: "choose",
  wallet: null,
  account: null,
  org: null,
  challenge: null,
  linked: null,
  listFailed: false,
  error: "",
};

const maxTimerDelay = 2 ** 31 - 1;

function isSolanaAccount(account: WalletAccount): boolean {
  return account.chains.some((chain) => chain.startsWith("solana:"));
}

function sessionEnded(result: ApiResult<unknown>): boolean {
  return !result.ok && (result.status === 401 || result.code === "NOT_AUTHENTICATED");
}

async function post<T>(
  getAccessToken: FlowProps["getAccessToken"],
  path: string,
  body: unknown,
): Promise<ApiResult<T>> {
  let token: string | null;
  try {
    token = await getAccessToken();
  } catch {
    return { ok: false, code: "NETWORK", status: 0 };
  }
  if (!token) return { ok: false, code: "NOT_AUTHENTICATED", status: 401 };
  return apiPost<T>(path, body, token);
}

export function useLinkFlow(props: FlowProps) {
  const [state, setState] = useState<FlowState>(initial);
  const [wallets, setWallets] = useState<LinkableWallet[]>([]);
  const [orgId, setOrgId] = useState("");
  const latest = useRef(props);
  latest.current = props;
  const current = useRef(state);
  current.current = state;
  const generation = useRef(0);

  const org = props.memberships.find((m) => m.id === orgId) ?? props.memberships[0] ?? null;

  useEffect(() => {
    const registry = getWallets();
    const refresh = () => setWallets(linkableWallets(registry.get()));
    refresh();
    const offRegister = registry.on("register", refresh);
    const offUnregister = registry.on("unregister", refresh);
    return () => {
      offRegister();
      offUnregister();
    };
  }, []);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  function discard(next: Partial<FlowState> = {}) {
    generation.current += 1;
    setState({ ...initial, ...next });
  }

  const connectedWallet = state.wallet?.wallet;
  const connectedAddress = state.account?.address;
  useEffect(() => {
    if (!connectedWallet || !connectedAddress) return;
    const events = connectedWallet.features[StandardEvents] as
      | StandardEventsFeature[typeof StandardEvents]
      | undefined;
    if (!events) return;
    return events.on("change", ({ accounts }) => {
      if (!accounts) return;
      if (accounts.find(isSolanaAccount)?.address === connectedAddress) return;
      generation.current += 1;
      setState(initial);
    });
  }, [connectedWallet, connectedAddress]);

  const challengeExpiry = state.phase === "ready" ? state.challenge?.expiresAt : undefined;
  useEffect(() => {
    if (!challengeExpiry) return;
    const delay = Math.min(Math.max(0, Date.parse(challengeExpiry) - Date.now()), maxTimerDelay);
    const timer = setTimeout(
      () => setState((s) => (s.phase === "ready" ? { ...s, phase: "expired", error: "" } : s)),
      delay,
    );
    return () => clearTimeout(timer);
  }, [challengeExpiry]);

  async function prepare(
    gen: number,
    wallet: LinkableWallet,
    account: WalletAccount,
    target: LinkOrganisation,
  ) {
    setState({ ...initial, phase: "preparing", wallet, account, org: target });
    const result = await post<WalletChallenge>(
      latest.current.getAccessToken,
      "/v1/wallet-links/challenges",
      { organisationId: target.id, wallet: account.address },
    );
    if (gen !== generation.current) return;
    if (sessionEnded(result)) {
      latest.current.onSessionExpired();
    } else if (result.ok) {
      setState({
        ...initial,
        phase: "ready",
        wallet,
        account,
        org: target,
        challenge: result.data,
      });
    } else if (result.code === "NOT_AUTHORISED") {
      setState({ ...initial, error: messages.notMember({ org: target.name }) });
      latest.current.reloadMemberships();
    } else if (result.code === "WALLET_INVALID") {
      setState({ ...initial, error: messages.walletInvalid({ wallet: wallet.name }) });
    } else {
      setState({ ...initial, error: messages.failed });
    }
  }

  async function connect(wallet: LinkableWallet) {
    if (!org) return;
    const gen = ++generation.current;
    setState({ ...initial, phase: "connecting", wallet, org });
    let account: WalletAccount | undefined;
    try {
      const feature = wallet.wallet.features[StandardConnect] as
        | StandardConnectFeature[typeof StandardConnect]
        | undefined;
      account = (await feature?.connect())?.accounts.find(isSolanaAccount);
    } catch {
      account = undefined;
    }
    if (gen !== generation.current) return;
    if (!account) {
      setState({ ...initial, error: messages.connectRefused({ wallet: wallet.name }) });
      return;
    }
    await prepare(gen, wallet, account, org);
  }

  async function prepareAgain() {
    const { wallet, account, org: target } = current.current;
    if (!wallet || !account || !target) return;
    await prepare(++generation.current, wallet, account, target);
  }

  async function sign() {
    const { wallet, account, challenge, org: target } = current.current;
    if (!wallet || !account || !challenge || !target) return;
    if (Date.parse(challenge.expiresAt) <= Date.now()) {
      generation.current += 1;
      setState((s) => ({ ...s, phase: "expired", error: "" }));
      return;
    }
    const gen = ++generation.current;
    setState((s) => ({ ...s, phase: "signing", error: "" }));
    let signature: string;
    try {
      signature = await signLinkMessage(wallet.wallet, account, challenge.message);
    } catch {
      if (gen !== generation.current) return;
      setState((s) => ({
        ...s,
        phase: "ready",
        error: messages.signCancelled({
          wallet: wallet.name,
          time: formatClockTime(challenge.expiresAt),
        }),
      }));
      return;
    }
    if (gen !== generation.current) return;
    setState((s) => ({ ...s, phase: "checking" }));
    const result = await post<WalletLink>(latest.current.getAccessToken, "/v1/wallet-links", {
      challengeId: challenge.challengeId,
      signatureBase58: signature,
    });

    if (!result.ok && (result.code === "NETWORK" || result.code === "INTERNAL")) {
      await reconcile(gen, wallet, account, target);
      return;
    }
    if (gen !== generation.current) return;

    if (sessionEnded(result)) {
      latest.current.onSessionExpired();
    } else if (result.ok) {
      setState((s) => ({ ...s, phase: "linked", linked: result.data }));
      void latest.current.reloadLinks().then((fresh) => {
        if (fresh === null) {
          setState((s) => (s.phase === "linked" ? { ...s, listFailed: true } : s));
        }
      });
    } else if (result.code === "BAD_SIGNATURE") {
      setState((s) => ({ ...s, phase: "mismatch" }));
    } else if (result.code === "CHALLENGE_INVALID") {
      setState((s) => ({ ...s, phase: "expired" }));
    } else if (result.code === "WALLET_ALREADY_LINKED") {
      setState((s) => ({ ...s, phase: "taken" }));
    } else {
      setState((s) => ({ ...s, phase: "failed" }));
    }
  }

  // The consuming call may have committed: read the list before claiming either outcome. The
  // read and the list update run even if the panel was reset meanwhile; only the panel's own
  // state is skipped then.
  async function reconcile(
    gen: number,
    wallet: LinkableWallet,
    account: WalletAccount,
    target: LinkOrganisation,
  ) {
    const fresh = await latest.current.reloadLinks();
    if (gen !== generation.current) return;
    if (fresh === null) {
      setState((s) => ({ ...s, phase: "unconfirmed", wallet, account, org: target }));
      return;
    }
    const match = fresh.find(
      (row) =>
        row.wallet === account.address && row.organisation_id === target.id && !row.revoked_at,
    );
    setState((s) =>
      match
        ? {
            ...s,
            phase: "linked",
            linked: { linkId: match.id, wallet: match.wallet, organisationId: target.id },
          }
        : { ...s, phase: "failed" },
    );
  }

  async function checkAgain() {
    const { wallet, account, org: target } = current.current;
    if (!wallet || !account || !target) return;
    await reconcile(++generation.current, wallet, account, target);
  }

  function chooseOrganisation(id: string) {
    setOrgId(id);
    discard();
  }

  return {
    state,
    wallets,
    org,
    connect,
    prepareAgain,
    sign,
    checkAgain,
    discard,
    chooseOrganisation,
  };
}
