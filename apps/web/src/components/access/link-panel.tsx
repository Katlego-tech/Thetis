"use client";

import type { ReactNode } from "react";
import { accessMessages } from "@/lib/access-messages";
import { formatClockTime } from "@/lib/format";
import type { LinkableWallet } from "@/lib/wallets";
import { type FlowProps, type FlowState, type Phase, useLinkFlow } from "./link-panel-flow";

const messages = accessMessages.link;
const noMembershipReason =
  "Linking needs a membership: a wallet is always linked for one organisation.";
const downloadUrl = "https://solflare.com/download";
const listPhases: Phase[] = ["choose", "ready", "signing", "checking"];

export type LinkPanelProps = Omit<FlowProps, "memberships"> & {
  /** null while the memberships are still loading */
  memberships: FlowProps["memberships"] | null;
};

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function statusText(state: FlowState): string {
  const name = state.wallet?.name ?? "the wallet";
  switch (state.phase) {
    case "connecting":
      return `Waiting for ${name} to connect`;
    case "preparing":
      return "Preparing the message";
    case "ready":
      return "Message ready. Check it, then sign.";
    case "signing":
      return `Waiting for ${name} to sign`;
    case "checking":
      return "Checking the signature";
    case "linked":
      return "Wallet linked";
    default:
      return "";
  }
}

function ActionButton({
  children,
  onClick,
  disabled = false,
  busy = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      className="access-primary"
      disabled={disabled}
      aria-busy={busy || undefined}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function WalletList({
  wallets,
  state,
  onConnect,
}: {
  wallets: LinkableWallet[];
  state: FlowState;
  onConnect: (wallet: LinkableWallet) => void;
}) {
  const choosing = state.phase === "choose";
  return (
    <div className="access-field">
      <span className="access-label" id="access-wallet-label">
        Wallet
      </span>
      <ul className="access-wallets" aria-labelledby="access-wallet-label">
        {wallets.map(({ name, wallet }, index) => {
          const connected = state.wallet?.wallet === wallet && state.account;
          return (
            <li key={name} className={connected ? "access-wallet-on" : undefined}>
              <span>
                {connected ? <strong>{name}</strong> : name}
                <small>
                  {connected && state.account
                    ? `Connected: ${shortAddress(state.account.address)}`
                    : "Installed"}
                </small>
              </span>
              {choosing && (
                <button
                  type="button"
                  className={`access-account-button ${index === 0 ? "access-primary" : "access-outline"}`}
                  aria-label={`Connect ${name}`}
                  onClick={() => onConnect({ name, wallet })}
                >
                  Connect
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Message({ state }: { state: FlowState }) {
  if (!state.challenge) return null;
  const { message, expiresAt } = state.challenge;
  const bytes = new TextEncoder().encode(message).length;
  return (
    <div className="access-field">
      <span className="access-label" id="access-message-label">
        You will sign exactly this text
      </span>
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: web.md §8.9 fixes this label on the pre */}
      <pre className="access-signed" aria-label={`Link message, ${bytes} bytes`}>
        {message}
      </pre>
      <span className="access-bytes">
        {bytes} bytes, UTF-8. Expires at {formatClockTime(expiresAt)}.
      </span>
      {state.phase !== "mismatch" && state.phase !== "expired" && (
        <span className="access-help">
          Signing proves this wallet is yours. The text cannot move funds or approve a transaction,
          and {state.wallet?.name} should show it unchanged.
        </span>
      )}
    </div>
  );
}

function Body({
  state,
  wallets,
  org,
  flow,
  organisations,
}: {
  state: FlowState;
  wallets: LinkableWallet[];
  org: { id: string; name: string } | null;
  flow: ReturnType<typeof useLinkFlow>;
  organisations: { id: string; name: string }[];
}) {
  const name = state.wallet?.name ?? "";
  const linkedFor = state.org?.name ?? org?.name ?? "its organisation";
  const expiresAt = state.challenge ? formatClockTime(state.challenge.expiresAt) : "";
  const showOrg =
    org && ["choose", "preparing", "ready", "signing", "checking"].includes(state.phase);

  return (
    <>
      {showOrg && (
        <div className="access-field">
          {organisations.length > 1 ? (
            <>
              <label className="access-label" htmlFor="access-organisation">
                For organisation
              </label>
              <select
                id="access-organisation"
                className="access-input"
                value={org.id}
                disabled={!["choose", "ready"].includes(state.phase)}
                onChange={(event) => flow.chooseOrganisation(event.target.value)}
              >
                {organisations.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <>
              <span className="access-label">For organisation</span>
              <span>{org.name}</span>
            </>
          )}
        </div>
      )}

      {listPhases.includes(state.phase) && (
        <WalletList wallets={wallets} state={state} onConnect={(w) => void flow.connect(w)} />
      )}

      {state.phase === "connecting" && (
        <>
          <div className="access-note">Approve the connection in {name}.</div>
          <ActionButton disabled busy>
            Waiting for {name}
          </ActionButton>
        </>
      )}

      {state.phase === "preparing" && (
        <>
          <div className="access-field">
            <span className="access-label">You will sign exactly this text</span>
            <span className="access-skeleton access-skeleton-block" />
          </div>
          <ActionButton disabled busy>
            Preparing message
          </ActionButton>
        </>
      )}

      {["ready", "signing", "checking", "mismatch"].includes(state.phase) && (
        <Message state={state} />
      )}

      {state.phase === "ready" && (
        <ActionButton onClick={() => void flow.sign()}>Sign with {name}</ActionButton>
      )}
      {state.phase === "signing" && (
        <>
          <div className="access-note">
            Approve the signature in {name}. Check that it shows the same text as this page.
          </div>
          <ActionButton disabled busy>
            Waiting for {name}
          </ActionButton>
        </>
      )}
      {state.phase === "checking" && (
        <ActionButton disabled busy>
          Checking signature
        </ActionButton>
      )}

      {state.phase === "linked" && state.linked && (
        <>
          <h3 className="access-panel-title">Wallet linked</h3>
          <div className="access-note">
            {name} wallet <span className="access-wallet-address">{state.linked.wallet}</span> is
            linked to your account for <strong>{linkedFor}</strong>.
          </div>
          <p className="access-help">
            {!state.listFailed && "It now appears under Linked wallets. "}Signing for {linkedFor}{" "}
            also needs an on-chain delegation, which an admin records.
          </p>
          <button
            type="button"
            className="access-outline access-wide"
            onClick={() => flow.discard()}
          >
            Link another wallet
          </button>
        </>
      )}

      {state.phase === "mismatch" && (
        <>
          <div className="access-error" role="alert">
            <strong>{name}</strong>
            {messages.badSignature({ wallet: name }).slice(name.length)}
          </div>
          <p className="access-help">{messages.badSignatureHelp}</p>
          <ActionButton onClick={() => flow.discard()}>Choose another wallet</ActionButton>
        </>
      )}
      {state.phase === "taken" && (
        <>
          <div className="access-error" role="alert">
            {messages.alreadyLinked}
          </div>
          <p className="access-help">{messages.alreadyLinkedHelp}</p>
          <ActionButton onClick={() => flow.discard()}>Choose another wallet</ActionButton>
        </>
      )}
      {state.phase === "expired" && (
        <>
          <div className="access-error" role="alert">
            {messages.expired({ time: expiresAt })}
          </div>
          <ActionButton onClick={() => void flow.prepareAgain()}>
            Prepare a new message
          </ActionButton>
        </>
      )}
      {state.phase === "unconfirmed" && (
        <>
          <div className="access-error" role="alert">
            {messages.unconfirmed({ wallet: name })}
          </div>
          <ActionButton onClick={() => void flow.checkAgain()}>Check again</ActionButton>
        </>
      )}
      {state.phase === "failed" && (
        <>
          <div className="access-error" role="alert">
            {messages.failed}
          </div>
          <ActionButton onClick={() => void flow.prepareAgain()}>
            Prepare a new message
          </ActionButton>
        </>
      )}
    </>
  );
}

export function LinkPanel({ memberships, ...rest }: LinkPanelProps) {
  const flow = useLinkFlow({ ...rest, memberships: memberships ?? [] });
  const { state, wallets, org } = flow;
  const choosing = state.phase === "choose";
  const sheetError = ["choose", "ready"].includes(state.phase) ? state.error : "";

  let body: ReactNode;
  if (!memberships) {
    body = <span className="access-skeleton access-skeleton-block" />;
  } else if (!org) {
    body = (
      <div className="access-field">
        <ActionButton disabled>Connect a wallet</ActionButton>
        <span className="access-help">{noMembershipReason}</span>
      </div>
    );
  } else if (choosing && wallets.length === 0) {
    body = (
      <>
        <p className="access-intro">{messages.noWallet}</p>
        <a className="access-link" href={downloadUrl} target="_blank" rel="noreferrer">
          Get Solflare
        </a>
      </>
    );
  } else {
    body = (
      <Body state={state} wallets={wallets} org={org} flow={flow} organisations={memberships} />
    );
  }

  return (
    <section
      className="access-panel"
      aria-labelledby="access-link-heading"
      aria-busy={!memberships || undefined}
    >
      <h2 id="access-link-heading">Link a wallet</h2>
      <p className="sr-only" role="status">
        {statusText(state)}
      </p>
      {sheetError && (
        <div className="access-error" role="alert">
          {sheetError}
        </div>
      )}
      {body}
    </section>
  );
}
