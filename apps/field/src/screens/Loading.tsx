import { useEffect, useRef, useState } from "react";
import type { LoadingIntent } from "../api/field";
import { Cert, Head, ListBox, ListItem, Rows, Skeleton } from "../components/Blocks";
import { Button } from "../components/Button";
import { Frame } from "../components/Frame";
import { ErrorBlock, Note } from "../components/Note";
import { Outcome } from "../components/Outcome";
import { RegistryMark } from "../components/RegistryMark";
import { SignedText } from "../components/SignedText";
import { SigningNotes } from "../components/SigningNotes";
import { Txt } from "../components/Txt";
import { useApp } from "../context";
import {
  acceptanceLabel,
  acceptanceWarnings,
  expectedLoadingText,
  formatSastMinute,
  intentExpired,
} from "../custody";
import { readOpenLoadingCommand } from "../data/reads";
import { useCommandSigning } from "../data/useCommandSigning";
import { useSigning } from "../data/useSigning";
import { formatTonnes } from "../format";
import { decodeBase64 } from "../lib/encoding";
import { markFor } from "../marks";
import { checkMessageText, verifyCommandText } from "../text";

const OFFLINE = "Offline. Recording a loading needs a connection. Nothing was recorded.";

/** The loan address a relay refusal names in its detail ("loan: <address>"). */
const LOAN_DETAIL = /^loan:\s*(\S+)/;

/** One loading intent: its detail, preparing the terminal's text, and signing it. */
export function Loading(props: { intent: string }) {
  const app = useApp();
  const facts = useSigning();
  const [intents, setIntents] = useState<LoadingIntent[] | null>(null);
  // The intent leaves the open list once the loading is recorded; the screen keeps what it read.
  const [kept, setKept] = useState<LoadingIntent | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  // The SHA-256 of the text the intent was re-read for: a lender may accept between the first read
  // and the relay building the text, so the text is checked against a read taken after it exists.
  const [readFor, setReadFor] = useState<string | null>(null);
  const [rereading, setRereading] = useState(false);
  const rereadSeq = useRef(0);
  const orgId = app.organisation.organisationId;
  const org = app.organisation.name;
  const chain = facts.chainOrganisation;
  const intent = kept;

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick forces a re-read
  useEffect(() => {
    if (!app.online) return;
    let live = true;
    setFailed(false);
    app.field
      .loadingIntents(orgId)
      .then((rows) => {
        if (!live) return;
        setIntents(rows);
        const found = rows.find((row) => row.intent === props.intent);
        if (found) setKept(found);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [app.field, orgId, props.intent, app.online, tick]);

  /** Reads the intent again and keeps it, then marks the check as run for `sha`. */
  async function rereadIntent(sha: string) {
    const seq = ++rereadSeq.current;
    setRereading(true);
    try {
      const rows = await app.field.loadingIntents(orgId);
      const found = rows.find((row) => row.intent === props.intent);
      if (seq === rereadSeq.current && found) setKept(found);
    } catch {
      // The earlier read stays; a failing check offers Check again.
    } finally {
      if (seq === rereadSeq.current) {
        setReadFor(sha);
        setRereading(false);
      }
    }
  }

  const signing = useCommandSigning({
    role: "terminal",
    verify: (candidate) => {
      if (!intent || !chain || !candidate.text) return null;
      if (candidate.text.messageSha256 !== readFor) return null;
      return verifyCommandText(
        candidate.text,
        expectedLoadingText({
          program: app.config.program,
          protocolInstanceHex: app.protocol.instanceIdHex,
          validUntil: BigInt(candidate.text.validUntil),
          intent,
          terminalName: chain.displayName,
        }),
      );
    },
    relayVars: (detail) => {
      const loan = detail ? LOAN_DETAIL.exec(detail)?.[1] : undefined;
      return {
        org,
        detail,
        kind: "record_loading",
        lender: intent?.acceptances.find((a) => a.loan === loan)?.lenderName,
      };
    },
    accepts: (candidate) =>
      candidate.kind === "record_loading" && candidate.intent === props.intent,
  });
  const { view, phase, problem } = signing;
  const viewSha =
    view?.status === "awaiting_signatures" ? (view.text?.messageSha256 ?? null) : null;

  // Each prepared or opened text is checked against an intent read after the text was built.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one re-read per text
  useEffect(() => {
    if (!viewSha || viewSha === readFor || !app.online) return;
    void rereadIntent(viewSha);
  }, [viewSha, app.online]);

  async function prepare() {
    if (!app.online || busy) return;
    setCheckFailed(false);
    setBusy(true);
    try {
      let existing: string | null;
      try {
        existing = await readOpenLoadingCommand(app.db, app.protocol.protocol, props.intent);
      } catch {
        // Never prepares while it could not be seen whether a text is already open.
        setCheckFailed(true);
        return;
      }
      if (existing) await signing.open(existing);
      else
        await signing.create({
          kind: "record_loading",
          organisationId: orgId,
          args: { intent: props.intent },
        });
    } finally {
      setBusy(false);
    }
  }

  const missing = view === null && intent === null && (intents !== null || failed);
  const expired = intent !== null && intentExpired(intent, BigInt(Math.floor(Date.now() / 1_000)));
  const settled = view !== null && view.status !== "awaiting_signatures";
  const awaiting = view?.status === "awaiting_signatures";
  const usable = view !== null && !signing.foreign && !signing.otherInstance;
  const mismatches = signing.check && !signing.check.ok ? signing.check.mismatches : [];
  const iSigned = signing.mySigner?.signed != null;
  const otherUnsigned = signing.otherSigners.some((s) => s.signed === null);
  const owner = intent?.ownerName ?? "";

  let decoded: string | null = null;
  try {
    decoded = view?.text ? checkMessageText(view.text.messageBase64) : null;
  } catch {
    decoded = null;
  }

  let footer = null;
  if (!settled) {
    if (phase.kind === "wallet")
      footer = <Button label="Waiting for your wallet" disabled onPress={() => {}} />;
    else if (phase.kind === "sending")
      footer = <Button label="Sending signature" disabled onPress={() => {}} />;
    else if (phase.kind === "not_sent") {
      const held = phase.held;
      footer = (
        <Button
          label="Send signature"
          disabled={!app.online}
          onPress={() => void signing.send(held)}
        />
      );
    } else if (!view) {
      if (intent && !expired) {
        footer = (
          <>
            <Button
              label={busy || phase.kind === "preparing" ? "Preparing text" : "Prepare loading text"}
              disabled={busy || phase.kind === "preparing" || !app.online}
              onPress={() => void prepare()}
            />
            {!app.online ? (
              <Txt variant="small" tone="ink2">
                Needs a connection.
              </Txt>
            ) : null}
          </>
        );
      }
    } else if (!usable) {
      footer = <Button label="Back to home" onPress={() => app.navigate({ name: "home" })} />;
    } else if (mismatches.length > 0) {
      const sha = viewSha;
      footer = (
        <>
          <Button
            label={rereading ? "Checking again" : "Check again"}
            disabled={rereading || !app.online || sha === null}
            onPress={() => {
              if (sha) void rereadIntent(sha);
            }}
          />
          <Button
            label="Back to home"
            kind="quiet"
            onPress={() => app.navigate({ name: "home" })}
          />
        </>
      );
    } else if (awaiting && signing.mySigner && !iSigned) {
      footer = (
        <>
          <Button
            label="Sign in your wallet"
            disabled={!signing.canSign}
            onPress={() => void signing.sign()}
          />
          {otherUnsigned ? (
            <Txt variant="small" tone="ink2">
              {`${owner} signs the same text on the web.`}
            </Txt>
          ) : null}
          {!app.online ? (
            <Txt variant="small" tone="ink2">
              Needs a connection.
            </Txt>
          ) : null}
        </>
      );
    }
  }

  return (
    <Frame organisation={org} onBack={app.back} footer={footer ?? undefined}>
      <Head title="Record loading">
        {view && !settled && !signing.foreign ? (
          <RegistryMark mark={markFor(view.status, view.confirmedCommitment)} />
        ) : null}
        <Cert label={app.protocol.instanceLabel} />
      </Head>

      {!app.online ? <Note>{OFFLINE}</Note> : null}

      {failed && !intent ? (
        <>
          <ErrorBlock>
            Thetis could not load the loadings at your terminal. Nothing changed.
          </ErrorBlock>
          <Button
            label="Retry"
            kind="quiet"
            inline
            disabled={!app.online}
            onPress={() => setTick((t) => t + 1)}
          />
        </>
      ) : null}
      {missing && !failed ? <ErrorBlock>This loading intent is no longer open.</ErrorBlock> : null}
      {!intent && !missing && !failed && app.online ? <Skeleton width="60%" /> : null}

      {view && usable && settled ? (
        <Outcome
          command={view}
          context={{
            kind: "record_loading",
            org,
            owner,
            signBefore: signing.signBefore,
            initiator: view.initiatorOrganisationId === orgId,
          }}
          busy={phase.kind === "renewing"}
          onPrimary={(action) => {
            if (action === "renew") void signing.renew();
            else app.navigate({ name: "home" });
          }}
        />
      ) : null}

      {expired && !view ? (
        <ErrorBlock>
          {`This loading intent expired at ${formatSastMinute(BigInt(intent?.expiresAt ?? "0"))}. The owner prepares a new one on the web.`}
        </ErrorBlock>
      ) : null}
      {checkFailed ? (
        <ErrorBlock>
          Thetis could not check for a loading text already prepared. Nothing was sent. Try again.
        </ErrorBlock>
      ) : null}

      <SigningNotes
        noun="loading"
        org={org}
        walletAddress={app.wallet?.address ?? null}
        problem={problem}
        phase={phase}
        signBefore={signing.signBefore}
        mismatches={mismatches}
        otherInstance={signing.otherInstance}
        needsWallet={!app.wallet && awaiting === true && usable}
      />

      {intent && !settled && !signing.otherInstance ? (
        <>
          {awaiting && usable && iSigned && otherUnsigned ? (
            <Note>
              {`Waiting for 1 of 2 signatures. You signed; ${owner} signs on the web before ${signing.signBefore}.`}
            </Note>
          ) : null}
          {acceptanceWarnings(intent).map((warning) => (
            <Note key={warning}>{warning}</Note>
          ))}

          <Rows
            rows={[
              { label: "Lot", value: intent.lotId, mono: true, sub: `${owner}' position` },
              { label: "Quantity", value: formatTonnes(BigInt(intent.quantityKg)) },
              {
                label: "Loading document",
                value: intent.documentSha256.slice(0, 8),
                mono: true,
                sub: `Intent ${intent.nonce}, expires ${formatSastMinute(BigInt(intent.expiresAt))}`,
              },
              { label: "Locked", value: formatTonnes(BigInt(intent.lockedKg)) },
            ]}
          />

          {intent.acceptances.length === 0 ? (
            <Note>No lender holds a lock on this position, so no acceptance is needed.</Note>
          ) : (
            <ListBox>
              {intent.acceptances.map((acceptance, index) => (
                <ListItem
                  key={acceptance.loan}
                  title={acceptance.lenderName}
                  lines={[`Lock ${formatTonnes(BigInt(acceptance.lockKg))}`]}
                  right={<Txt variant="caption">{acceptanceLabel(acceptance.state)}</Txt>}
                  last={index === intent.acceptances.length - 1}
                />
              ))}
            </ListBox>
          )}

          {usable ? (
            <SignedText
              text={decoded}
              byteLine={
                view?.text && decoded
                  ? `${decodeBase64(view.text.messageBase64).length} bytes, UTF-8. SHA-256 ${view.text.messageSha256.slice(0, 8)}. Sign before ${signing.signBefore}.`
                  : null
              }
              check={
                signing.check
                  ? `Matches what you entered: ${signing.check.ok ? "yes" : "no"}`
                  : null
              }
            />
          ) : null}
        </>
      ) : null}
    </Frame>
  );
}
