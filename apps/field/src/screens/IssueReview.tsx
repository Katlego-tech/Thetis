import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, View } from "react-native";
import { ApiError, ApiShapeError, ApiTimeout, ApiUnreachable } from "../api/client";
import type { CommandView } from "../api/commands";
import { Cert, Head, Rows, Section } from "../components/Blocks";
import { Button } from "../components/Button";
import { Frame } from "../components/Frame";
import { ErrorBlock, Note } from "../components/Note";
import { Outcome } from "../components/Outcome";
import { RegistryMark } from "../components/RegistryMark";
import { SignedText } from "../components/SignedText";
import { Txt } from "../components/Txt";
import { useApp } from "../context";
import { REFETCH_CODES, RELAY_TIMEOUT, type RelayPhase, relayErrorCopy } from "../copy";
import { type Owner, readOwners, readSites, type Site } from "../data/reads";
import { useSigning } from "../data/useSigning";
import {
  applyCommand,
  backToEditing,
  CommandMismatch,
  checkBelongs,
  type IntakeDraft,
  resumeDraft,
} from "../drafts/store";
import { formatKg, formatTimeOfDay, formatTonnes, parseTonnes, shortAddress } from "../format";
import { expectedIssueText, issueArgs, textLine } from "../intake";
import { intakeDigest, normaliseTicket } from "../intake-digest";
import { decodeBase64 } from "../lib/encoding";
import { markFor } from "../marks";
import type { OutcomeContext } from "../outcome";
import { isSameProtocol, OTHER_INSTANCE } from "../protocol";
import { isReadyToIssue, readinessLines } from "../readiness";
import { checkMessageText, type TextMismatch, verifyCommandText } from "../text";
import { sessionConnection, signText, WalletAccountError, WalletRefused } from "../wallet";
import { duplicateCopy, useDuplicateCheck } from "./Intake";

/** A wallet signature held in memory with the SHA-256 of the exact text it was made over. */
interface HeldSignature {
  signatureBase58: string;
  messageSha256: string;
}

type Phase =
  | { kind: "loading" }
  | { kind: "checking" }
  | { kind: "preparing" }
  | { kind: "ready" }
  | { kind: "wallet" }
  | { kind: "sending" }
  | { kind: "not_sent"; held: HeldSignature }
  | { kind: "renewing" };

type Problem =
  | { kind: "relay"; text: string }
  | { kind: "timeout" }
  | { kind: "offline_before" }
  | { kind: "offline_checking" }
  | { kind: "offline_waiting" }
  | { kind: "signature_stale" }
  | { kind: "wallet_refused" }
  | { kind: "wrong_account" }
  | { kind: "text_changed" }
  | { kind: "payload"; bytes: number | null }
  | null;

const POLL_MS = 3_000;

export function IssueReview(props: { draftId: string }) {
  const app = useApp();
  const signing = useSigning();
  const [draft, setDraft] = useState<IntakeDraft | null>(null);
  const [view, setView] = useState<CommandView | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [problem, setProblem] = useState<Problem>(null);
  const [site, setSite] = useState<Site | null>(null);
  const [owner, setOwner] = useState<Owner | null>(null);
  const draftRef = useRef<IntakeDraft | null>(null);
  const viewRef = useRef<CommandView | null>(null);
  const started = useRef(false);
  const checking = useRef(false);
  const orgId = app.organisation.organisationId;
  const org = app.organisation.name;
  const duplicate = useDuplicateCheck(draft);

  const save = useCallback(
    async (next: IntakeDraft) => {
      draftRef.current = next;
      setDraft(next);
      await app.store.save(next);
    },
    [app.store],
  );

  /** Shows a relay answer and maps it onto the draft; throws CommandMismatch for another draft's. */
  const show = useCallback(
    async (next: CommandView) => {
      const current = draftRef.current;
      if (current) checkBelongs(current, next);
      viewRef.current = next;
      setView(next);
      if (current) await save(applyCommand(current, next));
    },
    [save],
  );

  const vars = useCallback(
    (detail: string | null = null) => ({
      org,
      kind: "issue_lot",
      detail,
      signBefore: viewRef.current?.text
        ? formatTimeOfDay(BigInt(viewRef.current.text.validUntil) - 30n)
        : "",
      siteCode: draftRef.current?.siteCode ?? "",
      classLabel: draftRef.current?.classLabel ?? "",
      ownerName: draftRef.current?.ownerName ?? "",
    }),
    [org],
  );

  /** Every relay error goes through here: re-fetch codes map the status; others show copy. */
  const relayFailed = useCallback(
    async (error: unknown, phaseName: RelayPhase): Promise<void> => {
      if (error instanceof ApiTimeout) return setProblem({ kind: "timeout" });
      if (error instanceof ApiUnreachable) {
        return setProblem(
          viewRef.current ? { kind: "offline_waiting" } : { kind: "offline_before" },
        );
      }
      if (error instanceof ApiError) {
        if (error.code === "NOT_AUTHENTICATED") return app.sessionExpired();
        if (REFETCH_CODES.has(error.code) || error.code === "TEXT_EXPIRED") {
          const id = viewRef.current?.id;
          if (id) {
            try {
              await show(await app.commands.get(id));
              setProblem(
                error.code === "TEXT_EXPIRED"
                  ? { kind: "relay", text: relayErrorCopy("TEXT_EXPIRED", phaseName, vars()) ?? "" }
                  : null,
              );
            } catch (again) {
              await relayFailed(again, "get");
            }
          }
          return;
        }
        return setProblem({
          kind: "relay",
          text: relayErrorCopy(error.code, phaseName, vars(error.detail)) ?? "",
        });
      }
      const unreadable = error instanceof ApiShapeError || error instanceof CommandMismatch;
      const code = unreadable ? "UNEXPECTED_ANSWER" : "INTERNAL";
      setProblem({ kind: "relay", text: relayErrorCopy(code, phaseName, vars()) ?? "" });
    },
    [app, show, vars],
  );

  // Load the draft, the site and owner it names, then resume or create the command.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per screen
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      const stored = await app.store.get(app.user.id, orgId, props.draftId);
      if (!stored) return app.navigate({ name: "home" });
      draftRef.current = stored;
      setDraft(stored);
      if (app.online) {
        try {
          const [sites, owners] = await Promise.all([
            readSites(app.db, app.protocol.protocol, orgId),
            readOwners(app.db, app.protocol.protocol),
          ]);
          setSite(sites.find((s) => s.address === stored.custodianClass) ?? null);
          setOwner(owners.find((o) => o.orgId === stored.ownerOrgId) ?? null);
        } catch {
          // The review still works from the draft; the relay reads the chain itself.
        }
      }
      if (stored.command) return checkCommand();
      if (stored.status === "preparing") {
        // Killed during the create: back to editing; any command made then expires unsigned.
        const resumed = await resumeDraft(stored, app.commands.get);
        await save(resumed.draft);
        return app.navigate({ name: "intake", draftId: stored.id });
      }
      await prepare();
    })();
  }, []);

  /**
   * Reads the command this draft already holds. Until a view loads, the screen stays in "Checking
   * this command": Prepare is never offered, so no second issue_lot is created. Only a 404 sends
   * the draft back to editing.
   */
  async function checkCommand() {
    const stored = draftRef.current;
    if (!stored?.command || viewRef.current || checking.current) return;
    checking.current = true;
    setProblem(null);
    setPhase({ kind: "checking" });
    const resumed = await resumeDraft(stored, app.commands.get);
    checking.current = false;
    if (resumed.view) {
      await save(resumed.draft);
      viewRef.current = resumed.view;
      setView(resumed.view);
      setPhase({ kind: "ready" });
      return;
    }
    if (resumed.error === null) {
      await save(resumed.draft);
      return app.navigate({ name: "intake", draftId: stored.id });
    }
    setPhase({ kind: "ready" });
    const error = resumed.error;
    if (error instanceof ApiUnreachable) return setProblem({ kind: "offline_checking" });
    await relayFailed(error, "get");
  }

  // Check again on reconnect and on return to the foreground, while no view has loaded.
  const wasOnline = useRef(app.online);
  // biome-ignore lint/correctness/useExhaustiveDependencies: check reads refs; runs on the network edge
  useEffect(() => {
    if (app.online && !wasOnline.current) void checkCommand();
    wasOnline.current = app.online;
  }, [app.online]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: check reads refs; one listener per screen
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void checkCommand();
    });
    return () => subscription.remove();
  }, []);

  async function prepare() {
    const current = draftRef.current;
    // A draft that holds a command is checked, never prepared again (§5.1, fold 9).
    if (!current?.ownerOrgId || current.command) return;
    if (!app.online) {
      setProblem({ kind: "offline_before" });
      setPhase({ kind: "ready" });
      return;
    }
    setProblem(null);
    setPhase({ kind: "preparing" });
    await save({ ...current, status: "preparing" });
    try {
      const created = await app.commands.create({
        kind: "issue_lot",
        organisationId: orgId,
        args: issueArgs(current, current.ownerOrgId),
      });
      await show(created);
    } catch (error) {
      const latest = draftRef.current;
      if (latest) await save({ ...latest, status: "editing" });
      await relayFailed(error, "create");
    }
    setPhase({ kind: "ready" });
  }

  // Poll 3 s after the last answer while the relay has not settled it.
  const status = view?.status;
  useEffect(() => {
    if (
      !view ||
      (status !== "awaiting_signatures" && status !== "submitted" && status !== "outcome_unknown")
    )
      return;
    if (phase.kind === "wallet" || phase.kind === "sending") return;
    let live = true;
    const timer = setTimeout(() => {
      app.commands
        .get(view.id)
        .then((next) => {
          if (!live) return;
          if (problem?.kind === "offline_waiting") setProblem(null);
          show(next).catch((error: unknown) => relayFailed(error, "get"));
        })
        .catch((error: unknown) => {
          if (!live) return;
          if (error instanceof ApiUnreachable || error instanceof ApiTimeout)
            setProblem({ kind: "offline_waiting" });
          else if (error instanceof ApiError && error.code === "NOT_AUTHENTICATED")
            app.sessionExpired();
          else {
            void relayFailed(error, "get");
            setView({ ...view });
          }
        });
    }, POLL_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [view, status, phase.kind, app, show, problem?.kind, relayFailed]);

  if (!draft) {
    return (
      <Frame organisation={org} onBack={app.back}>
        {null}
      </Frame>
    );
  }

  const kg = parseTonnes(draft.quantityText);
  const ticket = normaliseTicket(draft.weighbridgeTicket);
  const quantity = typeof kg === "bigint" ? formatTonnes(kg) : "";
  const digest = ticket && draft.siteCode ? intakeDigest(draft.siteCode, ticket) : "";
  const chain = signing.chainOrganisation;
  const text = view?.text ?? null;
  let decoded: string | null = null;
  try {
    decoded = text ? checkMessageText(text.messageBase64) : null;
  } catch {
    decoded = null;
  }
  const otherInstance = view !== null && !isSameProtocol(view, app.protocol);
  const check =
    view && text && chain && !otherInstance
      ? verifyCommandText(
          text,
          expectedIssueText(
            draft,
            {
              program: app.config.program,
              protocolInstanceHex: app.protocol.instanceIdHex,
              classLabel: draft.classLabel ?? "",
              custodianName: chain.displayName,
              originRequired: site?.originRequired ?? false,
            },
            BigInt(text.validUntil),
          ),
        )
      : null;
  const mismatches: TextMismatch[] = check && !check.ok ? check.mismatches : [];
  const signBefore = text ? formatTimeOfDay(BigInt(text.validUntil) - 30n) : "";
  const awaiting = view?.status === "awaiting_signatures";
  const custodianSigned = view?.signers.find((s) => s.role === "custodian")?.signed ?? null;
  const canSign =
    awaiting &&
    check?.ok === true &&
    !otherInstance &&
    custodianSigned === null &&
    app.wallet !== null;
  const readinessInput = {
    org,
    chainOrganisation: chain,
    wallet: app.wallet?.address ?? null,
    link: signing.link,
    authority: signing.authority,
  };
  const mayNotBeReady =
    !signing.loading &&
    app.wallet !== null &&
    signing.link === "linked" &&
    !isReadyToIssue(readinessInput);

  /**
   * Every check that decides whether a view may be signed, run on the view itself rather than on
   * what was last rendered: this instance, this draft's issue, and the §6.4 text check.
   */
  function signable(candidate: CommandView): boolean {
    const current = draftRef.current;
    if (!current || !candidate.text || !chain) return false;
    if (!isSameProtocol(candidate, app.protocol)) return false;
    try {
      checkBelongs(current, candidate);
      return verifyCommandText(
        candidate.text,
        expectedIssueText(
          current,
          {
            program: app.config.program,
            protocolInstanceHex: app.protocol.instanceIdHex,
            classLabel: current.classLabel ?? "",
            custodianName: chain.displayName,
            originRequired: site?.originRequired ?? false,
          },
          BigInt(candidate.text.validUntil),
        ),
      ).ok;
    } catch {
      return false;
    }
  }

  async function stillSame(): Promise<boolean> {
    const current = viewRef.current;
    if (!current?.text) return false;
    try {
      const fresh = await app.commands.get(current.id);
      const same =
        fresh.id === current.id &&
        fresh.status === "awaiting_signatures" &&
        fresh.text?.messageSha256 === current.text.messageSha256 &&
        signable(fresh);
      if (!same) await show(fresh);
      return same;
    } catch {
      return false;
    }
  }

  async function sign() {
    const current = viewRef.current;
    if (!current?.text || !app.wallet) return;
    setProblem(null);
    if (!signable(current)) {
      // The view changed after the screen drew it: draw it again, with its mismatch, and stop.
      setView({ ...current });
      return;
    }
    const text = current.text;
    setPhase({ kind: "wallet" });
    let result: Awaited<ReturnType<typeof signText>>;
    try {
      result = await signText(
        sessionConnection(app.wallet, app.connection),
        { expectedAddress: app.wallet.address, messageBase64: text.messageBase64 },
        app.setConnection,
        stillSame,
      );
    } catch (error) {
      setPhase({ kind: "ready" });
      if (error instanceof WalletAccountError) return setProblem({ kind: "wrong_account" });
      if (error instanceof WalletRefused) return setProblem({ kind: "wallet_refused" });
      return setProblem({
        kind: "relay",
        text: relayErrorCopy("INTERNAL", "signatures", vars()) ?? "",
      });
    }
    if (result.kind === "not_asked") {
      setPhase({ kind: "ready" });
      setProblem({ kind: "text_changed" });
      return;
    }
    if (result.kind === "payload_mismatch") {
      setPhase({ kind: "ready" });
      setProblem({ kind: "payload", bytes: result.receivedBytes });
      return;
    }
    await send({ signatureBase58: result.signatureBase58, messageSha256: text.messageSha256 });
  }

  async function send(held: HeldSignature) {
    const current = viewRef.current;
    if (!current?.text || !app.wallet) return;
    setProblem(null);
    if (current.text.messageSha256 !== held.messageSha256 || !signable(current)) {
      // An old signature never matches a new text: it is dropped, not sent.
      setPhase({ kind: "ready" });
      setProblem({ kind: "signature_stale" });
      return;
    }
    setPhase({ kind: "sending" });
    try {
      const answer = await app.commands.sign(current.id, {
        role: "custodian",
        wallet: app.wallet.address,
        messageSha256: held.messageSha256,
        signature: held.signatureBase58,
      });
      await show(answer);
      setPhase({ kind: "ready" });
    } catch (error) {
      if (error instanceof ApiTimeout || error instanceof ApiUnreachable) {
        // The signature may have landed: read before offering to send it again.
        try {
          const fresh = await app.commands.get(current.id);
          const unsigned =
            fresh.status === "awaiting_signatures" &&
            !fresh.signers.find((s) => s.role === "custodian")?.signed;
          await show(fresh);
          setPhase(unsigned ? { kind: "not_sent", held } : { kind: "ready" });
        } catch {
          setPhase({ kind: "not_sent", held });
        }
        return;
      }
      setPhase({ kind: "ready" });
      await relayFailed(error, "signatures");
    }
  }

  async function renew() {
    const current = viewRef.current;
    if (!current) return;
    setProblem(null);
    setPhase({ kind: "renewing" });
    try {
      await show(await app.commands.renew(current.id));
    } catch (error) {
      await relayFailed(error, "renew");
    }
    setPhase({ kind: "ready" });
  }

  async function editDetails() {
    const current = viewRef.current;
    const stored = draftRef.current;
    if (!stored) return;
    if (!current) {
      // A draft that holds a command goes back to editing only after the relay answers.
      if (stored.command) return;
      await save(backToEditing(stored, new Date().toISOString()));
      return app.navigate({ name: "intake", draftId: stored.id });
    }
    try {
      const fresh = await app.commands.get(current.id);
      checkBelongs(stored, fresh);
      const abandoned =
        (fresh.status === "awaiting_signatures" && fresh.signers.every((s) => s.signed === null)) ||
        fresh.status === "failed" ||
        fresh.status === "expired";
      if (!abandoned) return void (await show(fresh));
      await save(backToEditing(stored, new Date().toISOString()));
      app.navigate({ name: "intake", draftId: stored.id });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        await save(backToEditing(stored, new Date().toISOString()));
        return app.navigate({ name: "intake", draftId: stored.id });
      }
      await relayFailed(error, "get");
    }
  }

  const outcomeContext: OutcomeContext = {
    lotId: draft.lotId,
    ownerName: draft.ownerName ?? "",
    ownerOrgAddress: owner?.address ?? null,
    org,
    signed: {
      quantity: (decoded && textLine(decoded, "Quantity")) ?? quantity,
      owner: (decoded && textLine(decoded, "Owner")) ?? draft.ownerName ?? "",
      site: (decoded && textLine(decoded, "Site")) ?? draft.siteCode ?? "",
    },
    signBefore,
  };

  const settled = view !== null && view.status !== "awaiting_signatures";
  const classCode = (draft.classLabel ?? "").replace(/ v\d+$/, "");
  const files = draft.evidence.filter((e) => e.upload === "finalized");

  let footer = null;
  if (!settled) {
    if (phase.kind === "checking")
      footer = <Button label="Checking this command" disabled onPress={() => {}} />;
    else if (phase.kind === "preparing")
      footer = <Button label="Preparing text" disabled onPress={() => {}} />;
    else if (phase.kind === "wallet")
      footer = <Button label="Waiting for your wallet" disabled onPress={() => {}} />;
    else if (phase.kind === "sending")
      footer = <Button label="Sending signature" disabled onPress={() => {}} />;
    else if (phase.kind === "not_sent") {
      const pending = phase.held;
      footer = (
        <Button label="Send signature" disabled={!app.online} onPress={() => void send(pending)} />
      );
    } else if (!view && draft.command) {
      footer = (
        <>
          <Button label="Check again" disabled={!app.online} onPress={() => void checkCommand()} />
          {!app.online ? (
            <Txt variant="small" tone="ink2">
              Needs a connection.
            </Txt>
          ) : null}
        </>
      );
    } else if (!view) {
      footer = (
        <>
          <Button
            label={
              problem?.kind === "timeout" || problem?.kind === "relay"
                ? "Try again"
                : "Prepare text"
            }
            disabled={!app.online}
            onPress={() => void prepare()}
          />
          {!app.online ? (
            <Txt variant="small" tone="ink2">
              Needs a connection.
            </Txt>
          ) : null}
        </>
      );
    } else if (otherInstance) {
      footer = <Button label="Back to home" onPress={() => app.navigate({ name: "home" })} />;
    } else if (mismatches.length > 0) {
      footer = <Button label="Edit details" onPress={() => void editDetails()} />;
    } else {
      footer = (
        <>
          <Button
            label="Sign in your wallet"
            disabled={!canSign || !app.online}
            onPress={() => void sign()}
          />
          <Button label="Edit details" kind="quiet" onPress={() => void editDetails()} />
        </>
      );
    }
  }

  const duplicateLine = duplicate.kind === "intake" ? duplicateCopy(duplicate, draft) : null;

  return (
    <Frame organisation={org} onBack={app.back} footer={footer ?? undefined}>
      <Head title={`Issue lot ${draft.lotId}`}>
        {settled ? null : (
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            <RegistryMark
              mark={
                view
                  ? markFor(view.status, view.confirmedCommitment)
                  : draft.command
                    ? markFor(draft.command.lastStatus, draft.command.commitment)
                    : "Not on chain"
              }
            />
          </View>
        )}
        <Cert label={app.protocol.instanceLabel} />
      </Head>

      {settled && view ? (
        <Outcome
          command={view}
          context={outcomeContext}
          busy={phase.kind === "renewing"}
          onPrimary={(action) => {
            if (action === "back_home") app.navigate({ name: "home" });
            else if (action === "renew") void renew();
            else void editDetails();
          }}
        />
      ) : null}

      {problem?.kind === "offline_waiting" ? (
        <Note>
          Offline. This phone can't see the outcome. Thetis keeps checking devnet; the result shows
          here when you are back online.
        </Note>
      ) : null}

      {!settled ? (
        <>
          {duplicateLine ? <ErrorBlock>{duplicateLine}</ErrorBlock> : null}

          {phase.kind === "checking" ? (
            <Note>Checking this command with Thetis. Nothing new is prepared meanwhile.</Note>
          ) : null}
          {problem?.kind === "offline_checking" ? (
            <Note>
              {draft.status === "awaiting_signature"
                ? "Offline. Thetis already prepared a text for this draft. This phone checks it again when you are back online."
                : "Offline. The mark above is the last status Thetis reported for this draft. This phone checks it again when you are back online."}
            </Note>
          ) : null}
          {problem?.kind === "signature_stale" ? (
            <Note>
              The text changed after you signed it. Your signature was not sent. Sign the new text.
            </Note>
          ) : null}
          {problem?.kind === "offline_before" ? (
            <Note>
              Offline. Your draft is saved on this phone. Preparing the text needs a connection,
              because Thetis builds it from devnet.
            </Note>
          ) : null}
          {problem?.kind === "timeout" ? <ErrorBlock>{RELAY_TIMEOUT}</ErrorBlock> : null}
          {problem?.kind === "relay" ? <ErrorBlock>{problem.text}</ErrorBlock> : null}

          {otherInstance ? (
            <ErrorBlock>{`${OTHER_INSTANCE} Your wallet was not opened.`}</ErrorBlock>
          ) : mismatches.length > 0 ? (
            <ErrorBlock>
              <Txt tone="refuse" style={{ fontSize: 14 }}>
                The text from Thetis does not match what you entered. Your wallet was not opened.
              </Txt>
              {mismatches.map((m) => (
                <View key={`${m.line}-${m.label}`} style={{ gap: 2 }}>
                  <Txt variant="mono" tone="refuse">{`Line ${m.line}, ${m.label}`}</Txt>
                  <Txt variant="mono" tone="refuse">{`Expected ${m.expected}`}</Txt>
                  <Txt variant="mono" tone="refuse">{`Received ${m.actual ?? "nothing"}`}</Txt>
                </View>
              ))}
              <Txt tone="refuse" style={{ fontSize: 14 }}>
                Report this and edit the draft. Do not sign a text you did not enter.
              </Txt>
            </ErrorBlock>
          ) : null}

          {awaiting && mayNotBeReady && !otherInstance && mismatches.length === 0 ? (
            <Note>
              <Txt style={{ fontSize: 14 }}>
                The Thetis index shows this wallet may not be able to issue, so Thetis will probably
                refuse it. If an admin delegated it in the last minute, you can still sign.
              </Txt>
              {readinessLines(readinessInput).map((line) => (
                <Txt key={line} variant="small" tone="ink2">
                  {line}
                </Txt>
              ))}
            </Note>
          ) : null}

          {phase.kind === "wallet" ? (
            <Note>
              Approve the signature in your wallet. Check that it shows the same text as this
              screen.
            </Note>
          ) : null}
          {phase.kind === "sending" ? (
            <Note>Thetis is checking your signature and sending the issue to devnet.</Note>
          ) : null}
          {phase.kind === "not_sent" ? (
            <ErrorBlock>{`Your signature was not sent. Send it again before ${signBefore}. If you leave this screen, you will need to sign again.`}</ErrorBlock>
          ) : null}
          {problem?.kind === "wallet_refused" ? (
            <ErrorBlock>{`Your wallet closed without signing. Nothing was signed or sent. You can sign this text until ${signBefore}.`}</ErrorBlock>
          ) : null}
          {problem?.kind === "wrong_account" && app.wallet ? (
            <ErrorBlock>
              {`Your wallet did not offer ${shortAddress(app.wallet.address)}, the wallet linked for ${org}. Choose that account in the wallet and try again.`}
            </ErrorBlock>
          ) : null}
          {problem?.kind === "text_changed" ? (
            <Note>
              The text changed before your wallet opened. Nothing was signed. Check the new text
              below.
            </Note>
          ) : null}
          {problem?.kind === "payload" ? (
            <ErrorBlock>
              {`Your wallet returned something other than a signature of this text (${problem.bytes ?? 0} bytes). Nothing was sent. Try another wallet and report the wallet name with this message.`}
            </ErrorBlock>
          ) : null}
          {!app.wallet && awaiting ? <Note>Connect a wallet first.</Note> : null}

          <Rows
            rows={[
              {
                label: "Quantity",
                value: quantity,
                sub: typeof kg === "bigint" ? `${formatKg(kg)}, weighbridge net mass` : null,
              },
              { label: "Owner", value: draft.ownerName ?? "" },
              { label: "Custodian", value: chain?.displayName ?? org },
              {
                label: "Site",
                value: draft.siteCode ?? "",
                sub: `${draft.classLabel ?? ""}, grade ${draft.grade ?? ""}`,
              },
              { label: "Intake", value: ticket ?? "", sub: digest.slice(0, 8) },
              {
                label: "Files",
                value: (
                  <View style={{ alignItems: "flex-end" }}>
                    {files.map((f) => (
                      <Txt key={f.localId} variant="caption" tone="ink2">
                        {`${f.purpose === "weighbridge" ? "Weighbridge" : f.purpose === "assay" ? "Assay" : "Origin"} ${f.sha256?.slice(0, 8) ?? ""}`}
                      </Txt>
                    ))}
                  </View>
                ),
              },
            ]}
          />
          <Section title="What this signature confirms">
            <Txt style={{ fontSize: 14 }}>
              {`${chain?.displayName ?? org} holds ${quantity} of ${classCode} ${draft.grade ?? ""} at ${draft.siteCode ?? ""} for ${draft.ownerName ?? ""}, and asks Thetis to issue receipts for it. It does not prove the ore's origin or grade.`}
            </Txt>
          </Section>
          {!otherInstance ? (
            <SignedText
              text={phase.kind === "preparing" ? null : decoded}
              byteLine={
                text && decoded
                  ? `${decodeBase64(text.messageBase64).length} bytes, UTF-8. SHA-256 ${text.messageSha256.slice(0, 8)}. Sign before ${signBefore}.`
                  : null
              }
              check={check ? `Matches what you entered: ${check.ok ? "yes" : "no"}` : null}
            />
          ) : null}
        </>
      ) : null}
    </Frame>
  );
}
