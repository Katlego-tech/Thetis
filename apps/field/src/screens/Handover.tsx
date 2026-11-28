import { useEffect, useRef, useState } from "react";
import type { CommandView, SignerRole } from "../api/commands";
import type { FieldBatch } from "../api/field";
import { Cert, Head, Rows, Section, Skeleton } from "../components/Blocks";
import { Button } from "../components/Button";
import { Frame } from "../components/Frame";
import { ErrorBlock, Note } from "../components/Note";
import { Outcome } from "../components/Outcome";
import { RegistryMark } from "../components/RegistryMark";
import { SignedText } from "../components/SignedText";
import { SigningNotes } from "../components/SigningNotes";
import { Txt } from "../components/Txt";
import { useApp } from "../context";
import { relayErrorCopy } from "../copy";
import {
  batchLine,
  checkHandoverText,
  expectedHandoverText,
  fieldValue,
  nextHolderOf,
  shortCode,
} from "../custody";
import { useCommandSigning } from "../data/useCommandSigning";
import { useSigning } from "../data/useSigning";
import { parseTonnes } from "../format";
import { textLine } from "../intake";
import { decodeBase64 } from "../lib/encoding";
import { markFor } from "../marks";
import { checkMessageText, type ExpectedText, type TextCheck } from "../text";

const OFFLINE =
  "Offline. A handover needs both phones online at the moment you sign. Nothing was recorded.";

const BATCH_FIELD = /^(\d+) of (\d+)$/;

/** The kilograms of a signed "5,000.000 t" quantity, or null when it is not one. */
function kilograms(quantity: string | null): bigint | null {
  if (quantity === null) return null;
  const parsed = parseTonnes(quantity.replace(/,/g, "").replace(/ t$/, ""));
  return typeof parsed === "bigint" ? parsed : null;
}

const UNREADABLE: TextCheck = {
  ok: false,
  mismatches: [
    { line: 0, label: "Text", expected: "a handover text for this batch", actual: null },
  ],
};

/** One handover command, as the holder who hands over or the next holder who takes custody. */
export function Handover(props: { commandId: string }) {
  const app = useApp();
  const facts = useSigning();
  const [batches, setBatches] = useState<FieldBatch[] | null>(null);
  const orgId = app.organisation.organisationId;
  const org = app.organisation.name;
  const chain = facts.chainOrganisation;
  const started = useRef(false);
  const read = useRef(false);

  const roleOf = (candidate: CommandView): SignerRole | null => {
    const mine = candidate.signers.find((s) => s.organisationId === orgId);
    return mine?.role === "holder" || mine?.role === "next_holder" ? mine.role : null;
  };

  /** What this phone expects the command's text to say, or null until it has what it needs. */
  function expectedFor(candidate: CommandView): ExpectedText | "unreadable" | null {
    if (!candidate.text || !chain || batches === null) return null;
    const role = roleOf(candidate);
    if (!role) return null;
    const batch = batches.find((b) => b.batch === candidate.args.batch) ?? null;
    // The holder holds the batch, so its own list must name it; the relay's fields are never trusted
    // for the holder (fold 66 covers only the next holder, who is not listed on the batch route).
    if (!batch && role === "holder") return "unreadable";
    let lotId: string;
    let index: number;
    let batchCount: number;
    let quantityKg: bigint | null;
    if (batch) {
      lotId = batch.lotId;
      index = batch.index;
      batchCount = batch.batchCount;
      quantityKg = BigInt(batch.quantityKg);
    } else {
      const position = BATCH_FIELD.exec(fieldValue(candidate, "Batch") ?? "");
      lotId = fieldValue(candidate, "Lot") ?? "";
      index = Number(position?.[1]);
      batchCount = Number(position?.[2]);
      quantityKg = position ? kilograms(fieldValue(candidate, "Quantity")) : null;
    }
    if (quantityKg === null || lotId === "") return "unreadable";
    const from =
      batch?.holderName ??
      (role === "holder" ? chain.displayName : (fieldValue(candidate, "From") ?? ""));
    const to =
      role === "next_holder"
        ? chain.displayName
        : batch
          ? (nextHolderOf(batch)?.name ?? "")
          : (fieldValue(candidate, "To") ?? "");
    return expectedHandoverText({
      program: app.config.program,
      protocolInstanceHex: app.protocol.instanceIdHex,
      validUntil: BigInt(candidate.text.validUntil),
      lotId,
      index,
      batchCount,
      quantityKg,
      from,
      to,
    });
  }

  const signing = useCommandSigning({
    role: roleOf,
    verify: (candidate) => {
      const expected = expectedFor(candidate);
      if (expected === null || !candidate.text) return null;
      return expected === "unreadable" ? UNREADABLE : checkHandoverText(candidate.text, expected);
    },
    relayVars: (detail) => ({ org, detail, kind: "handover" }),
    accepts: (candidate) => candidate.kind === "handover",
  });
  const { view, phase, problem } = signing;

  // The batch list gives the names and quantity the text is checked against; it is read once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one read per screen, when online
  useEffect(() => {
    if (!app.online || read.current) return;
    read.current = true;
    app.field
      .batches(orgId)
      .then(setBatches)
      // Without the list the next holder checks against the command's own fields; the holder cannot.
      .catch(() => setBatches([]));
  }, [app.online]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: opens once, when first online
  useEffect(() => {
    if (!app.online || started.current) return;
    started.current = true;
    void signing.open(props.commandId);
  }, [app.online]);

  const roleNow = view ? roleOf(view) : null;
  const usable = view !== null && !signing.foreign && !signing.otherInstance && roleNow !== null;
  const settled = view !== null && view.status !== "awaiting_signatures";
  const awaiting = view?.status === "awaiting_signatures";
  const mismatches = signing.check && !signing.check.ok ? signing.check.mismatches : [];

  let decoded: string | null = null;
  try {
    decoded = view?.text ? checkMessageText(view.text.messageBase64) : null;
  } catch {
    decoded = null;
  }
  const line = (label: string): string =>
    (decoded && textLine(decoded, label)) ?? (view ? fieldValue(view, label) : null) ?? "";
  const from = line("From");
  const to = line("To");
  const lot = line("Lot");
  const quantity = line("Quantity");
  const stage = line("Stage");
  const position = BATCH_FIELD.exec(line("Batch"));
  const load = position ? batchLine(Number(position[1]), Number(position[2])) : line("Batch");
  const holderSide = roleNow === "holder";
  const other = holderSide ? to : from;
  const iSigned = signing.mySigner?.signed != null;
  const otherUnsigned = signing.otherSigners.some((s) => s.signed === null);

  const title = !usable
    ? "Handover"
    : holderSide
      ? `Hand over to ${to}`
      : stage === "Arrival"
        ? `Arrival at ${to}`
        : "Take custody";

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
      footer =
        problem !== null ? (
          <Button
            label="Try again"
            disabled={!app.online}
            onPress={() => void signing.open(props.commandId)}
          />
        ) : undefined;
    } else if (!usable || mismatches.length > 0) {
      footer = <Button label="Back to home" onPress={() => app.navigate({ name: "home" })} />;
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
              {`${other} has not signed yet.`}
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
      <Head title={title}>
        {view && !settled && !signing.foreign ? (
          <RegistryMark mark={markFor(view.status, view.confirmedCommitment)} />
        ) : null}
        <Cert label={app.protocol.instanceLabel} />
      </Head>

      {!app.online ? <Note>{OFFLINE}</Note> : null}

      {view && usable && settled ? (
        <Outcome
          command={view}
          context={{
            kind: "handover",
            org,
            lotId: lot,
            batchLine: load,
            quantity,
            from,
            to,
            stage,
            signBefore: signing.signBefore,
            initiator: view.initiatorOrganisationId === orgId,
          }}
          labels={{ back_home: "Back to home" }}
          busy={phase.kind === "renewing"}
          onPrimary={(action) => {
            if (action === "renew") void signing.renew();
            else app.navigate({ name: "home" });
          }}
        />
      ) : null}

      {!view && phase.kind === "loading" ? <Skeleton width="60%" /> : null}

      {view && !signing.foreign && !signing.otherInstance && roleNow === null ? (
        <ErrorBlock>{relayErrorCopy("ROLE_INVALID", "get", { org }) ?? ""}</ErrorBlock>
      ) : null}

      <SigningNotes
        noun="handover"
        org={org}
        walletAddress={app.wallet?.address ?? null}
        problem={problem}
        phase={phase}
        signBefore={signing.signBefore}
        mismatches={mismatches}
        otherInstance={signing.otherInstance}
        needsWallet={!app.wallet && awaiting && usable}
      />

      {usable && awaiting ? (
        <>
          {iSigned && otherUnsigned ? (
            <Note>
              {`Waiting for 1 of 2 signatures. You signed; ${other} has not. Sign before ${signing.signBefore}.`}
            </Note>
          ) : null}

          <Rows
            rows={[
              {
                label: "From",
                value: (
                  <Txt
                    variant="strong"
                    style={{ fontSize: 18, lineHeight: 24, textAlign: "right" }}
                  >
                    {from}
                  </Txt>
                ),
              },
              {
                label: "To",
                value: (
                  <Txt
                    variant="strong"
                    style={{ fontSize: 18, lineHeight: 24, textAlign: "right" }}
                  >
                    {to}
                  </Txt>
                ),
              },
              { label: "Load", value: `${lot}, ${load}`, sub: quantity },
              { label: "Stage", value: stage, sub: `Manifest ${line("Manifest").slice(0, 8)}` },
            ]}
          />

          {holderSide && view.signers.every((s) => s.signed === null) ? (
            <Section title={`Show this to ${to}`}>
              <Txt variant="mono" style={{ fontSize: 24, lineHeight: 30 }}>
                {`Code ${shortCode(view.id)}`}
              </Txt>
              <Txt style={{ fontSize: 14 }}>
                {`${to} opens it from Waiting for you. Nothing is signed yet.`}
              </Txt>
              <Txt variant="small" tone="ink2">
                Check the name matches the driver and company in front of you.
              </Txt>
            </Section>
          ) : null}

          <Section title="What this signature confirms">
            <Txt style={{ fontSize: 14 }}>
              {`${to} takes custody of ${load} of ${lot}, ${quantity}, from ${from}. It does not record the load's condition.`}
            </Txt>
          </Section>

          <SignedText
            text={phase.kind === "loading" ? null : decoded}
            byteLine={
              view.text && decoded
                ? `${decodeBase64(view.text.messageBase64).length} bytes, UTF-8. SHA-256 ${view.text.messageSha256.slice(0, 8)}. Sign before ${signing.signBefore}.`
                : null
            }
            check={
              signing.check ? `Matches what you entered: ${signing.check.ok ? "yes" : "no"}` : null
            }
          />
        </>
      ) : null}
    </Frame>
  );
}
