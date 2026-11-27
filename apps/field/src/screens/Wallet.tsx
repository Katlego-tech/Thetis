import { useState } from "react";
import { View } from "react-native";
import { ApiError } from "../api/client";
import type { Challenge } from "../api/walletLinks";
import { Cert, Head, Rows, Section } from "../components/Blocks";
import { Button } from "../components/Button";
import { Frame } from "../components/Frame";
import { Freshness } from "../components/Freshness";
import { ErrorBlock, Note } from "../components/Note";
import { Picker } from "../components/Picker";
import { SignedText } from "../components/SignedText";
import { Txt } from "../components/Txt";
import { useApp } from "../context";
import { readSignerLinks } from "../data/reads";
import { useSigning } from "../data/useSigning";
import { formatClock, formatTimeOfDay, shortAddress, unixOf } from "../format";
import { encodeBase64 } from "../lib/encoding";
import { checkLinkChallenge } from "../link-challenge";
import { scopeWords as scopeLine } from "../readiness";
import {
  connectWallet,
  sessionConnection,
  signText,
  WalletAccountError,
  type WalletConnection,
  WalletRefused,
} from "../wallet";

type Step =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "connect_refused" }
  | { kind: "no_account" }
  | { kind: "choose"; connection: WalletConnection }
  | { kind: "preparing" }
  | { kind: "challenge"; challenge: Challenge; note: "ready" | "signing" | "refused" | "checking" }
  | { kind: "linked" }
  | { kind: "link_error"; message: string; action: "new_message" | "another_wallet" | null };

const NO_ACCOUNT =
  "Your wallet returned no Solana account Thetis can use. Choose a Solana account in the wallet and connect again.";

export function Wallet() {
  const app = useApp();
  const signing = useSigning();
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const org = app.organisation.name;
  const orgId = app.organisation.organisationId;
  const otherOrgName =
    app.memberships.find((m) => m.organisationId === signing.linkOtherOrgId)?.name ??
    "another organisation";

  async function chooseAccount(connection: WalletConnection, address: string) {
    app.setConnection(connection);
    await app.setWallet({ address, walletUriBase: connection.walletUri });
    setStep({ kind: "idle" });
  }

  async function connect() {
    setStep({ kind: "connecting" });
    try {
      const connection = await connectWallet(app.wallet?.walletUriBase);
      if (connection.accounts.length > 1) setStep({ kind: "choose", connection });
      else await chooseAccount(connection, connection.accounts[0].address);
    } catch (error) {
      setStep(
        error instanceof WalletAccountError ? { kind: "no_account" } : { kind: "connect_refused" },
      );
    }
  }

  async function disconnect() {
    app.setConnection(null);
    await app.setWallet(null);
    setStep({ kind: "idle" });
  }

  async function landed(): Promise<boolean> {
    if (!app.wallet) return false;
    try {
      const links = await readSignerLinks(app.db, app.wallet.address);
      return links.some((l) => l.userId === app.user.id && l.organisationId === orgId);
    } catch {
      return false;
    }
  }

  function linkError(error: unknown): Step {
    const code = error instanceof ApiError ? error.code : null;
    if (code === "BAD_SIGNATURE") {
      return {
        kind: "link_error",
        message:
          "Your wallet returned a signature that does not match the exact text. Nothing was linked. Some wallets change the text before signing it. Try another wallet, and report the wallet name with this message.",
        action: "another_wallet",
      };
    }
    if (code === "CHALLENGE_INVALID") {
      const at = step.kind === "challenge" ? formatTimeOfDay(unixOf(step.challenge.expiresAt)) : "";
      return {
        kind: "link_error",
        message: `This message expired at ${at}, or was already used. Nothing was linked.`,
        action: "new_message",
      };
    }
    if (code === "WALLET_ALREADY_LINKED") {
      return {
        kind: "link_error",
        message:
          "This wallet is already linked to a Thetis account. A wallet can have only one active link.",
        action: "another_wallet",
      };
    }
    if (code === "NOT_AUTHORISED") {
      return {
        kind: "link_error",
        message: `You are no longer a member of ${org}, so you can't link a wallet for it.`,
        action: null,
      };
    }
    if (code === "NOT_AUTHENTICATED") app.sessionExpired();
    return {
      kind: "link_error",
      message: "Thetis could not complete the link. Nothing was linked. Try again.",
      action: "new_message",
    };
  }

  /** The message is data.md §5's, for this wallet, organisation and person, or it is not signed. */
  function linkMessageOk(challenge: Challenge, address: string): boolean {
    return checkLinkChallenge(challenge.message, {
      wallet: address,
      organisationSlug: app.organisation.slug,
      userId: app.user.id,
    });
  }

  const NOT_A_LINK: Step = {
    kind: "link_error",
    message: `This message from Thetis is not a wallet link for this wallet and ${org}. Your wallet was not opened. Nothing was linked.`,
    action: null,
  };

  async function prepare() {
    if (!app.wallet) return;
    setStep({ kind: "preparing" });
    try {
      const challenge = await app.walletLinks.challenge(orgId, app.wallet.address);
      if (!linkMessageOk(challenge, app.wallet.address)) return setStep(NOT_A_LINK);
      setStep({ kind: "challenge", challenge, note: "ready" });
    } catch (error) {
      setStep(linkError(error));
    }
  }

  async function signLink(challenge: Challenge) {
    if (!app.wallet) return;
    if (!linkMessageOk(challenge, app.wallet.address)) return setStep(NOT_A_LINK);
    const connection = sessionConnection(app.wallet, app.connection);
    setStep({ kind: "challenge", challenge, note: "signing" });
    let result: Awaited<ReturnType<typeof signText>>;
    try {
      result = await signText(
        connection,
        {
          expectedAddress: app.wallet.address,
          messageBase64: encodeBase64(new TextEncoder().encode(challenge.message)),
        },
        app.setConnection,
        async () => Date.parse(challenge.expiresAt) > Date.now(),
      );
    } catch (error) {
      if (error instanceof WalletRefused || error instanceof WalletAccountError) {
        setStep({ kind: "challenge", challenge, note: "refused" });
        return;
      }
      setStep(linkError(error));
      return;
    }
    if (result.kind !== "signed") {
      setStep(
        result.kind === "not_asked"
          ? linkError(new ApiError(409, "CHALLENGE_INVALID", "", null))
          : linkError(new ApiError(422, "BAD_SIGNATURE", "", null)),
      );
      return;
    }
    setStep({ kind: "challenge", challenge, note: "checking" });
    try {
      await app.walletLinks.complete(challenge.challengeId, result.signatureBase58);
      setStep({ kind: "linked" });
      signing.reload();
    } catch (error) {
      const recheck = !(error instanceof ApiError) || error.status >= 500;
      if (recheck && (await landed())) {
        setStep({ kind: "linked" });
        signing.reload();
        return;
      }
      setStep(linkError(error));
    }
  }

  const wallet = app.wallet;
  const connecting = step.kind === "connecting";
  const challengeStep = step.kind === "challenge" ? step : null;
  const expiresAt = challengeStep ? formatTimeOfDay(unixOf(challengeStep.challenge.expiresAt)) : "";
  const linkable = wallet && signing.link === "not_linked" && step.kind !== "linked";

  let footer = null;
  if (!wallet) {
    footer = (
      <Button
        label={connecting ? "Waiting for your wallet" : "Connect wallet"}
        disabled={connecting}
        onPress={() => void connect()}
      />
    );
  } else if (challengeStep) {
    const waiting = challengeStep.note === "signing" || challengeStep.note === "checking";
    footer = (
      <Button
        label={
          challengeStep.note === "signing"
            ? "Waiting for your wallet"
            : challengeStep.note === "checking"
              ? "Checking signature"
              : "Sign in your wallet"
        }
        disabled={waiting || !app.online}
        onPress={() => void signLink(challengeStep.challenge)}
      />
    );
  } else if (step.kind === "preparing") {
    footer = <Button label="Preparing message" disabled onPress={() => {}} />;
  } else if (step.kind === "link_error" && step.action === "new_message") {
    footer = (
      <Button label="Prepare a new message" disabled={!app.online} onPress={() => void prepare()} />
    );
  } else if (
    (step.kind === "link_error" && step.action === "another_wallet") ||
    signing.link === "linked_elsewhere" ||
    signing.link === "linked_other_org"
  ) {
    footer = (
      <Button label="Connect another wallet" onPress={() => void disconnect().then(connect)} />
    );
  } else if (linkable) {
    footer = (
      <>
        <Button label="Link this wallet" disabled={!app.online} onPress={() => void prepare()} />
        {!app.online ? (
          <Txt variant="small" tone="ink2">
            Linking needs a connection.
          </Txt>
        ) : null}
      </>
    );
  }

  const authority = signing.authority;

  return (
    <Frame
      organisation={org}
      onBack={app.back}
      footer={
        footer || wallet ? (
          <>
            {footer}
            {wallet ? (
              <Button label="Disconnect" kind="quiet" onPress={() => void disconnect()} />
            ) : null}
          </>
        ) : undefined
      }
    >
      <Head
        title={
          challengeStep || step.kind === "preparing" || step.kind === "link_error"
            ? "Link this wallet"
            : step.kind === "linked"
              ? "Wallet linked"
              : "Wallet"
        }
      >
        <Cert label={app.protocol.instanceLabel} />
      </Head>

      {!wallet ? (
        step.kind === "connecting" ? (
          <Note>Approve the connection in your wallet.</Note>
        ) : step.kind === "connect_refused" ? (
          <ErrorBlock>Your wallet did not connect. Nothing was linked.</ErrorBlock>
        ) : step.kind === "no_account" ? (
          <ErrorBlock>{NO_ACCOUNT}</ErrorBlock>
        ) : (
          <Txt
            style={{ fontSize: 14 }}
          >{`Connect the wallet you sign with for ${org}. Thetis never sees its keys.`}</Txt>
        )
      ) : (
        <Rows
          rows={[
            {
              label: "Connected",
              value: shortAddress(wallet.address),
              mono: true,
              sub: "through Mobile Wallet Adapter",
            },
            ...(signing.link
              ? [
                  {
                    label: "Link",
                    value: signing.link === "linked" ? "Linked to you" : "Not linked",
                  },
                ]
              : []),
          ]}
        />
      )}

      {wallet && !app.online ? (
        <Note>
          {signing.asOf
            ? `Offline. The link and authority below are as this phone last read them, at ${formatClock(unixOf(signing.asOf))}. They can't be checked until you are back online.`
            : "Offline. The link and authority can't be checked until you are back online."}
        </Note>
      ) : null}

      {wallet && signing.link === "linked_elsewhere" && !challengeStep ? (
        <ErrorBlock>{`This wallet is linked to another Thetis account in ${org}. Connect a different wallet.`}</ErrorBlock>
      ) : null}
      {wallet && signing.link === "linked_other_org" && !challengeStep ? (
        <ErrorBlock>
          {`You linked this wallet for ${otherOrgName}. A wallet has one active link, so connect a different wallet for ${org}.`}
        </ErrorBlock>
      ) : null}

      {challengeStep || step.kind === "preparing" ? (
        <>
          <SignedText
            text={challengeStep ? challengeStep.challenge.message : null}
            byteLine={
              challengeStep
                ? `${new TextEncoder().encode(challengeStep.challenge.message).length} bytes, UTF-8. Expires at ${expiresAt}.`
                : null
            }
          />
          {challengeStep?.note === "signing" ? (
            <Note>
              Approve the signature in your wallet. Check that it shows the same text as this
              screen.
            </Note>
          ) : challengeStep?.note === "refused" ? (
            <ErrorBlock>{`Your wallet closed without signing. Nothing was linked. This message stays valid until ${expiresAt}.`}</ErrorBlock>
          ) : (
            <Txt variant="small" tone="ink2">
              Signing proves this wallet is yours. The text cannot move anything or approve a
              transaction, and your wallet should show it unchanged.
            </Txt>
          )}
        </>
      ) : null}

      {step.kind === "link_error" ? <ErrorBlock>{step.message}</ErrorBlock> : null}

      {step.kind === "linked" && wallet ? (
        <Txt style={{ fontSize: 14 }}>
          {`Wallet ${wallet.address} is linked to you for ${org}. Signing for ${org} also needs a Thetis authority on chain, which an admin delegates.`}
        </Txt>
      ) : null}

      {wallet && (app.online || signing.asOf) && authority && !challengeStep ? (
        <Section title="Thetis authority">
          {authority.kind === "none" ? (
            <Txt style={{ fontSize: 14 }}>
              {`Thetis found no authority for this wallet in ${org}. Ask an admin of ${org} to check it. If this wallet already has an authority for another organisation, it can't get one for yours, and you need a different wallet.`}
            </Txt>
          ) : authority.kind === "other_org" ? (
            <>
              <Txt
                style={{ fontSize: 14 }}
              >{`Delegated for ${authority.otherOrg}, not ${org}`}</Txt>
              <Txt variant="small" tone="ink2">
                {`Ask an admin of ${org} to delegate a different wallet. Linking alone gives no signing authority.`}
              </Txt>
            </>
          ) : (
            <>
              <Rows
                rows={[
                  {
                    label: "Scopes",
                    value: signing.authorityRow ? scopeLine(signing.authorityRow.scopes) : "",
                    sub:
                      authority.kind === "ok"
                        ? `Expires ${authority.expires}`
                        : authority.kind === "revoked"
                          ? `Revoked ${authority.at}`
                          : authority.kind === "expired"
                            ? `Expired ${authority.at}`
                            : "Does not include Issue",
                  },
                ]}
              />
              {authority.kind === "revoked" || authority.kind === "expired" ? (
                <ErrorBlock>
                  {`This wallet can no longer sign for ${org}. A revoked wallet can't be delegated again; ask your admin to delegate a new one.`}
                </ErrorBlock>
              ) : null}
            </>
          )}
          {signing.asOf ? (
            <Txt variant="small" tone="ink2">
              {`As of ${formatClock(unixOf(signing.asOf))}, offline`}
            </Txt>
          ) : (
            <Freshness
              lastSuccessAt={app.protocol.lastSuccessAt}
              halted={app.protocol.indexStatus === "halted"}
            />
          )}
        </Section>
      ) : null}

      <View />
      <Picker
        visible={step.kind === "choose"}
        title="Which account?"
        options={
          step.kind === "choose"
            ? step.connection.accounts.map((a) => ({
                key: a.address,
                title: shortAddress(a.address),
                mono: true,
              }))
            : []
        }
        footnote={`Use the account your admin delegated for ${org}.`}
        onPick={(address) => {
          if (step.kind === "choose") void chooseAccount(step.connection, address);
        }}
        onClose={() => setStep({ kind: "idle" })}
      />
    </Frame>
  );
}
