"use client";

import Link from "next/link";
import { type CommandView, roleLabels, type SignerRole } from "@/lib/commands";
import { formatClockTime } from "@/lib/format";
import type { SigningWallet } from "@/lib/wallets";
import { shortened } from "./status";

// Each signer, and for the user's own unsigned roles the wallet picker (live-lending.md §6.9.4). A
// terminal signs on the field app, never in the web (§6.10.6, L5): its row offers no wallet.

export type Connection = { address: string | null }; // null: connected, but no account linked here

export function SignersPanel({
  view,
  memberships,
  organisationName,
  links,
  wallets,
  connections,
  busy,
  problem,
  onConnect,
  onSign,
}: {
  view: CommandView;
  memberships: string[];
  organisationName: (id: string) => string;
  /** the user's active signer links by organisation uuid; null while they load */
  links: Map<string, Set<string>> | null;
  wallets: SigningWallet[];
  /** per wallet name, per organisation uuid */
  connections: Map<string, Map<string, Connection>>;
  busy: boolean;
  problem: string | null;
  onConnect: (wallet: SigningWallet) => void;
  onSign: (role: SignerRole, wallet: SigningWallet, address: string) => void;
}) {
  const textSigners = view.signers.filter(({ method }) => method === "text");
  const textSigned = textSigners.filter(({ signed }) => signed !== null).length;
  const textDone = textSigned === textSigners.length;

  return (
    <section className="work-panel" aria-labelledby="command-signers">
      <h2 id="command-signers">Signers</h2>
      <div>
        {view.signers.map(({ role, organisationId, method, signed }) => {
          const name = organisationName(organisationId);
          const field = role === "terminal";
          const mine =
            !field &&
            signed === null &&
            view.status === "awaiting_signatures" &&
            memberships.includes(organisationId);
          const linked = links?.get(organisationId);
          const usable = wallets.filter((wallet) => method === "text" || wallet.signsTransactions);
          const reason =
            method === "transaction" && !textDone
              ? `Sign the text first: ${textSigned} of ${textSigners.length} signed.`
              : null;
          return (
            <div key={role} className="signer-row">
              <div>
                <strong className="font-semibold">{roleLabels[role]}</strong> · {name}
              </div>
              {signed ? (
                <div>
                  Signed by{" "}
                  <span className="font-mono text-[12.5px]">{shortened(signed.wallet, 4)}</span> at{" "}
                  {formatClockTime(signed.signedAt)}
                </div>
              ) : (
                <div className="text-(--ink-2)">Waiting</div>
              )}
              {field && signed === null && <p>{name} signs this on the Thetis field app.</p>}
              {mine && links !== null && !linked?.size && (
                <p className="text-(--ink-2)">
                  Link a wallet for {name} on your{" "}
                  <Link className="text-(--act) underline" href="/account">
                    account page
                  </Link>{" "}
                  first.
                </p>
              )}
              {mine && linked && linked.size > 0 && (
                <>
                  <div className="act-row">
                    {usable.map((wallet) => {
                      const connection = connections.get(wallet.name)?.get(organisationId);
                      if (!connection)
                        return (
                          <button
                            key={wallet.name}
                            type="button"
                            className="act-button"
                            data-variant="outline"
                            disabled={busy}
                            onClick={() => onConnect(wallet)}
                          >
                            Connect {wallet.name}
                          </button>
                        );
                      if (connection.address === null) return null;
                      const address = connection.address;
                      return (
                        <button
                          key={wallet.name}
                          type="button"
                          className="act-button"
                          disabled={busy || reason !== null}
                          aria-describedby={reason ? `reason-${role}` : undefined}
                          onClick={() => onSign(role, wallet, address)}
                        >
                          {method === "text"
                            ? `Sign with ${wallet.name}`
                            : `Sign the transaction with ${wallet.name}`}
                        </button>
                      );
                    })}
                  </div>
                  {usable.map((wallet) =>
                    connections.get(wallet.name)?.get(organisationId)?.address === null ? (
                      <p key={wallet.name} className="text-(--ink-2)">
                        {wallet.name} has no account linked to {name}. Link one on your{" "}
                        <Link className="text-(--act) underline" href="/account">
                          account page
                        </Link>
                        .
                      </p>
                    ) : null,
                  )}
                  {reason && (
                    <p id={`reason-${role}`} className="text-(--ink-2)">
                      {reason}
                    </p>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
      {problem && (
        <p className="form-alert" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
