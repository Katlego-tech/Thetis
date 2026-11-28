import * as Crypto from "expo-crypto";
import * as ImagePicker from "expo-image-picker";
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import type { CommandView } from "../api/commands";
import type { FieldBatch } from "../api/field";
import { Cert, Head, Rows, Section, Skeleton } from "../components/Blocks";
import { Button } from "../components/Button";
import { Field, SelectField } from "../components/Field";
import { Frame } from "../components/Frame";
import { ErrorBlock, Note } from "../components/Note";
import { Outcome } from "../components/Outcome";
import { Picker } from "../components/Picker";
import { RegistryMark } from "../components/RegistryMark";
import { SignedText } from "../components/SignedText";
import { SigningNotes } from "../components/SigningNotes";
import { Txt } from "../components/Txt";
import { useApp } from "../context";
import {
  batchLine,
  expectedObservationText,
  fieldValue,
  LOCATION_CODE,
  locationError,
  normaliseLocation,
} from "../custody";
import { useCommandSigning } from "../data/useCommandSigning";
import { useSigning } from "../data/useSigning";
import { keepLocalCopy, removeDraftFiles, removeLocalCopy, sizeOfLocalCopy } from "../drafts/files";
import type { DraftCommand, ObservationDraft } from "../drafts/store";
import { captureEvidence } from "../evidence/capture";
import { uploadDeps } from "../evidence/deps";
import { advanceUpload, checkLocalFile, type EvidenceItem } from "../evidence/upload";
import { formatSize, formatTimeOfDay, formatTonnes, unixOf } from "../format";
import { decodeBase64 } from "../lib/encoding";
import { markFor } from "../marks";
import { checkMessageText, verifyCommandText } from "../text";
import { radius, usePalette } from "../theme";

const OFFLINE =
  "Offline. Your photo is saved on this phone. Nothing is recorded until you sign online.";

const BATCH_FIELD = /^(\d+) of (\d+)$/;

function commandOf(view: CommandView): DraftCommand {
  return {
    commandId: view.id,
    lastStatus: view.status,
    textVersion: view.text?.version ?? 0,
    transactionSignature: view.transaction?.signature ?? null,
    lot: view.lot,
    explorerUrl: view.transaction?.explorerUrl ?? null,
    commitment: view.confirmedCommitment,
  };
}

function photoLine(item: EvidenceItem | null, online: boolean): { text: string; bad: boolean } {
  if (!item) return { text: "Required. Not taken.", bad: false };
  const local = checkLocalFile(item.mime, item.sizeBytes);
  if (local?.kind === "too_large") {
    return {
      text: `Too large: ${formatSize(item.sizeBytes)} of 20 MB. Take a smaller photo.`,
      bad: true,
    };
  }
  if (local?.kind === "type")
    return { text: "This file type can't be stored. Take a photo.", bad: true };
  const taken = `Taken ${formatTimeOfDay(unixOf(item.capturedAt))}.`;
  switch (item.upload) {
    case "local":
      return {
        text: online ? `${taken} Uploading` : `${taken} On this phone, not uploaded.`,
        bad: false,
      };
    case "registering":
    case "uploading":
    case "finalizing":
      return { text: `${taken} Uploading`, bad: false };
    case "finalized":
      return { text: `${taken} Uploaded. SHA-256 ${item.sha256?.slice(0, 8) ?? ""}`, bad: false };
    case "failed":
      return { text: "Upload failed. Your photo is still on this phone.", bad: true };
    case "rejected":
      return {
        text: "The stored file did not match what was sent. Retry uploads a new version.",
        bad: true,
      };
  }
}

/** The border photo: its state in words, and the one action that fits it. */
function PhotoRow(props: {
  item: EvidenceItem | null;
  online: boolean;
  locked: boolean;
  onTake: () => void;
  onRetry: () => void;
}) {
  const palette = usePalette();
  const { item } = props;
  const line = photoLine(item, props.online);
  const tooBig = item !== null && checkLocalFile(item.mime, item.sizeBytes) !== null;
  const retry =
    item !== null && !tooBig && (item.upload === "failed" || item.upload === "rejected");
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: palette.rule,
        borderRadius: radius,
        backgroundColor: palette.sheet,
        paddingVertical: 10,
        paddingHorizontal: 12,
        minHeight: 56,
        gap: 8,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
        }}
      >
        <View style={{ flexShrink: 1 }}>
          <Txt variant="label">Border photo</Txt>
          <Txt variant="caption" tone={line.bad ? "refuse" : "ink2"} live>
            {line.text}
          </Txt>
        </View>
        {!props.locked && retry ? (
          <Button
            label="Retry"
            kind="quiet"
            inline
            disabled={!props.online}
            onPress={props.onRetry}
          />
        ) : null}
        {!props.locked && item !== null && !retry && (item.upload === "finalized" || tooBig) ? (
          <Button label="Retake" kind="quiet" inline onPress={props.onTake} />
        ) : null}
      </View>
      {!props.locked && item === null ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Button label="Take photo" kind="quiet" inline onPress={props.onTake} />
        </View>
      ) : null}
    </View>
  );
}

/** Record border crossing (§7.8): a held batch, a location code, a photo, then the text to sign. */
export function Observation() {
  const app = useApp();
  const facts = useSigning();
  const [draft, setDraft] = useState<ObservationDraft | null>(null);
  const [batches, setBatches] = useState<FieldBatch[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const [choosing, setChoosing] = useState(false);
  const [cameraDenied, setCameraDenied] = useState(false);
  const [unreadable, setUnreadable] = useState(false);
  const draftRef = useRef<ObservationDraft | null>(null);
  const uploading = useRef(false);
  const opened = useRef(false);
  const removed = useRef(false);
  const orgId = app.organisation.organisationId;
  const org = app.organisation.name;
  const chain = facts.chainOrganisation;

  const persist = useCallback(
    async (next: ObservationDraft) => {
      if (removed.current) return;
      draftRef.current = next;
      setDraft(next);
      await app.store.saveObservation(next);
    },
    [app.store],
  );

  /** Applies a change to the latest draft, so a slow save never overwrites a newer edit. */
  const change = useCallback(
    async (patch: Partial<ObservationDraft>) => {
      const current = draftRef.current;
      if (current) await persist({ ...current, ...patch, updatedAt: new Date().toISOString() });
    },
    [persist],
  );

  // The draft this phone holds for this organisation; one from another run is discarded.
  // biome-ignore lint/correctness/useExhaustiveDependencies: loads once per screen
  useEffect(() => {
    void (async () => {
      const stored = await app.store.observation(app.user.id, orgId);
      if (stored && stored.protocol === app.protocol.protocol) {
        draftRef.current = stored;
        setDraft(stored);
        return;
      }
      if (stored) {
        try {
          removeDraftFiles(stored.id);
        } catch {
          // The files of a discarded draft are left for the phone to clear.
        }
      }
      const fresh: ObservationDraft = {
        id: Crypto.randomUUID(),
        userId: app.user.id,
        organisationId: orgId,
        protocol: app.protocol.protocol,
        batch: null,
        locationCode: "",
        evidence: null,
        command: null,
        updatedAt: new Date().toISOString(),
      };
      await persist(fresh);
    })();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick forces a re-read
  useEffect(() => {
    if (!app.online) return;
    let live = true;
    setFailed(false);
    app.field
      .batches(orgId)
      .then((rows) => {
        if (live) setBatches(rows);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [app.field, orgId, app.online, tick]);

  const held = batches && chain ? batches.filter((b) => b.holder === chain.address) : [];
  const batch = draft?.batch ? (batches?.find((b) => b.batch === draft.batch) ?? null) : null;

  const signing = useCommandSigning({
    role: "observer",
    verify: (candidate) => {
      const current = draftRef.current;
      const chosen = current?.batch ? batches?.find((b) => b.batch === current.batch) : undefined;
      if (!candidate.text || !chain || !current?.evidence?.sha256 || !chosen) return null;
      return verifyCommandText(
        candidate.text,
        expectedObservationText({
          program: app.config.program,
          protocolInstanceHex: app.protocol.instanceIdHex,
          validUntil: BigInt(candidate.text.validUntil),
          lotId: chosen.lotId,
          index: chosen.index,
          batchCount: chosen.batchCount,
          holder: chain.displayName,
          observer: chain.displayName,
          locationCode: current.locationCode,
          evidenceSha256: current.evidence.sha256,
          observedAt: unixOf(current.evidence.capturedAt),
        }),
      );
    },
    relayVars: (detail) => ({ org, detail, kind: "record_observation" }),
    accepts: (candidate) => candidate.kind === "record_observation",
    onView: (candidate) => void change({ command: commandOf(candidate) }),
    onRelayError: (code, phaseName) => {
      const current = draftRef.current;
      if (!current) return;
      if (code === "EVIDENCE_INVALID" && phaseName === "create" && current.evidence) {
        // The relay does not hold the photo as sent: it is uploaded again as a new version.
        void change({
          evidence: { ...current.evidence, upload: "rejected", sha256: null, error: code },
        });
      } else if (code === "NOT_FOUND" && phaseName === "get" && current.command) {
        void change({ command: null });
      }
    },
  });
  const { view, phase, problem } = signing;

  // A draft that holds a command opens it; it never prepares a second.
  // biome-ignore lint/correctness/useExhaustiveDependencies: opens once, when online with a stored command
  useEffect(() => {
    if (opened.current || signing.view || !app.online || !draft?.command) return;
    opened.current = true;
    void signing.open(draft.command.commandId);
  }, [draft, app.online]);

  // The batch is chosen from what this organisation holds: the only one is taken, and a batch no
  // longer held is dropped with the photo filed under it.
  const heldKey = held.map((b) => b.batch).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: reads held through its key
  useEffect(() => {
    const current = draftRef.current;
    if (!current || batches === null || !chain || current.command) return;
    const stillHeld = current.batch !== null && held.some((b) => b.batch === current.batch);
    if (stillHeld) return;
    const only = held.length === 1 ? (held[0]?.batch ?? null) : null;
    if (only === current.batch) return;
    void change({ batch: only, evidence: null });
  }, [heldKey, batches, chain, draft?.command]);

  const runUploads = useCallback(
    async (retry: boolean) => {
      const start = draftRef.current;
      if (uploading.current || !app.online || !start?.batch || !start.evidence) return;
      const item = start.evidence;
      const waiting =
        item.upload !== "finalized" &&
        (retry || (item.upload !== "failed" && item.upload !== "rejected"));
      if (!waiting) return;
      uploading.current = true;
      try {
        const subject = {
          organisationId: orgId,
          userId: app.user.id,
          subjectKind: "batch" as const,
          subjectRef: start.batch,
        };
        // Each step's save waits for the one before it; the final save waits for them all.
        let saved: Promise<void> = Promise.resolve();
        const done = await advanceUpload(
          item,
          subject,
          uploadDeps(app.db, app.evidence),
          (stepped) => {
            saved = saved.then(() => change({ evidence: stepped }));
          },
        );
        await saved;
        await change({ evidence: done });
      } finally {
        uploading.current = false;
      }
    },
    [app.online, app.db, app.evidence, app.user.id, orgId, change],
  );

  // Uploads start when a photo is taken, a batch is chosen or the network returns; a failed one
  // waits for Retry.
  const photoState = draft?.evidence?.upload ?? null;
  const photoId = draft?.evidence?.localId ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on the facts it names
  useEffect(() => {
    void runUploads(false);
  }, [photoState, photoId, draft?.batch, app.online]);

  async function takePhoto() {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      setCameraDenied(true);
      return;
    }
    setCameraDenied(false);
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.8 });
    const asset = result.canceled ? null : result.assets[0];
    const current = draftRef.current;
    if (!asset || !current) return;
    const captured = captureEvidence(
      {
        draftId: current.id,
        purpose: "transport",
        sourceUri: asset.uri,
        mime: asset.mimeType ?? "image/jpeg",
        localId: Crypto.randomUUID(),
        capturedAt: new Date().toISOString(),
      },
      { keepLocalCopy, sizeOf: sizeOfLocalCopy, removeLocalCopy },
    );
    setUnreadable(captured.kind === "unreadable");
    if (captured.kind !== "kept") return;
    if (current.evidence) removeLocalCopy(current.evidence.localUri);
    await change({ evidence: captured.item });
  }

  async function prepare() {
    const current = draftRef.current;
    if (!current?.batch || !current.evidence?.versionId || !app.online) return;
    opened.current = true;
    await signing.create({
      kind: "record_observation",
      organisationId: orgId,
      args: {
        batch: current.batch,
        kind: "Border",
        locationCode: current.locationCode,
        evidenceVersionId: current.evidence.versionId,
        observedAt: String(unixOf(current.evidence.capturedAt)),
      },
    });
  }

  async function backHome() {
    const current = draftRef.current;
    removed.current = true;
    await app.store.removeObservation(app.user.id, orgId);
    if (current) {
      try {
        removeDraftFiles(current.id);
      } catch {
        // A file that is already gone needs nothing more.
      }
    }
    app.navigate({ name: "home" });
  }

  async function editAgain() {
    signing.forget();
    await change({ command: null });
  }

  if (!draft) {
    return (
      <Frame organisation={org} onBack={app.back}>
        <Skeleton width="60%" height={24} />
      </Frame>
    );
  }

  const settled = view !== null && view.status !== "awaiting_signatures";
  const awaiting = view?.status === "awaiting_signatures";
  const usable = view !== null && !signing.foreign && !signing.otherInstance;
  const mismatches = signing.check && !signing.check.ok ? signing.check.mismatches : [];
  const locked = draft.command !== null;
  const photo = draft.evidence;
  const photoReady = photo?.upload === "finalized" && photo.sha256 !== null;
  const locationBad = !LOCATION_CODE.test(draft.locationCode);
  const reason = !app.online
    ? "Needs a connection."
    : !batch
      ? "Choose a batch first."
      : locationBad
        ? "Fix Location code first."
        : !photoReady
          ? "Border photo not uploaded yet."
          : null;
  const holder = chain?.displayName ?? org;
  const observedAt = photo ? unixOf(photo.capturedAt) : null;
  const position = view ? BATCH_FIELD.exec(fieldValue(view, "Batch") ?? "") : null;
  const loadLine = batch
    ? batchLine(batch.index, batch.batchCount)
    : position
      ? batchLine(Number(position[1]), Number(position[2]))
      : "";

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
    } else if (!view && (phase.kind === "loading" || (locked && problem === null))) {
      footer = <Button label="Checking this command" disabled onPress={() => {}} />;
    } else if (!view) {
      footer = (
        <>
          <Button
            label={phase.kind === "preparing" ? "Preparing text" : "Prepare text"}
            disabled={reason !== null || phase.kind === "preparing"}
            onPress={() => void prepare()}
          />
          {reason ? (
            <Txt variant="small" tone="ink2" live>
              {reason}
            </Txt>
          ) : null}
        </>
      );
    } else if (!usable || mismatches.length > 0) {
      footer = <Button label="Back to home" onPress={() => app.navigate({ name: "home" })} />;
    } else if (awaiting && signing.mySigner && signing.mySigner.signed === null) {
      footer = (
        <>
          <Button
            label="Sign in your wallet"
            disabled={!signing.canSign}
            onPress={() => void signing.sign()}
          />
          {!app.online ? (
            <Txt variant="small" tone="ink2">
              Needs a connection.
            </Txt>
          ) : null}
        </>
      );
    }
  }

  const showConfirms = batch !== null && photo !== null && !locationBad && observedAt !== null;

  return (
    <Frame organisation={org} onBack={app.back} footer={footer ?? undefined}>
      <Head title="Border crossing">
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
            kind: "record_observation",
            org,
            holder,
            batchLine: loadLine,
            signBefore: signing.signBefore,
          }}
          busy={phase.kind === "renewing"}
          onPrimary={(action) => {
            if (action === "renew") void signing.renew();
            else if (action === "edit") void editAgain();
            else void backHome();
          }}
        />
      ) : null}

      <SigningNotes
        noun="observation"
        org={org}
        walletAddress={app.wallet?.address ?? null}
        problem={problem}
        phase={phase}
        signBefore={signing.signBefore}
        mismatches={mismatches}
        otherInstance={signing.otherInstance}
        needsWallet={!app.wallet && awaiting === true && usable}
      />

      {settled && usable ? null : (
        <>
          {failed ? (
            <>
              <ErrorBlock>Thetis could not load your batches. Nothing changed.</ErrorBlock>
              <Button
                label="Retry"
                kind="quiet"
                inline
                disabled={!app.online}
                onPress={() => setTick((t) => t + 1)}
              />
            </>
          ) : null}

          {batches !== null && chain && held.length === 0 && !batch ? (
            <Txt variant="small" tone="ink2">
              {`${org} holds no batch right now, so there is nothing to record a crossing for.`}
            </Txt>
          ) : null}

          {held.length > 1 && !locked ? (
            <SelectField
              label="Batch"
              value={batch ? `${batch.lotId}, ${batchLine(batch.index, batch.batchCount)}` : null}
              onPress={() => setChoosing(true)}
            />
          ) : null}

          {batch ? (
            <Rows
              rows={[
                {
                  label: "Load",
                  value: `${batch.lotId}, ${batchLine(batch.index, batch.batchCount)}`,
                  sub: `${formatTonnes(BigInt(batch.quantityKg))}, held by ${batch.holderName}`,
                },
              ]}
            />
          ) : null}

          <Field
            label="Location code"
            value={draft.locationCode}
            mono
            autoCapitalize="characters"
            locked={locked}
            onChangeText={(text) => void change({ locationCode: normaliseLocation(text) })}
            help="The code on the border post or your route sheet."
            error={locationError(draft.locationCode)}
          />

          {unreadable ? (
            <ErrorBlock>
              This phone could not read the size of that photo, so it can't be checked. Take it
              again.
            </ErrorBlock>
          ) : null}
          {cameraDenied ? (
            <ErrorBlock>
              An observation needs a photo. Allow the camera in Android settings to record a border
              crossing.
            </ErrorBlock>
          ) : null}
          <PhotoRow
            item={photo}
            online={app.online}
            locked={locked}
            onTake={() => void takePhoto()}
            onRetry={() => void runUploads(true)}
          />

          {batch ? (
            <Note>{`This records where the load was. ${holder} still holds it afterwards; no one else signs.`}</Note>
          ) : null}

          {showConfirms && batch && observedAt !== null ? (
            <Section title="What this signature confirms">
              <Txt style={{ fontSize: 14 }}>
                {`${holder} reports that ${batchLine(batch.index, batch.batchCount)} of ${batch.lotId} was at ${draft.locationCode} at ${formatTimeOfDay(observedAt)}. It does not hand over custody or record the load's condition.`}
              </Txt>
            </Section>
          ) : null}

          {view && usable ? (
            <SignedText
              text={decoded}
              byteLine={
                view.text && decoded
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
      )}

      <Picker
        visible={choosing}
        title="Which batch did you cross with?"
        options={held.map((b) => ({
          key: b.batch,
          title: b.lotId,
          mono: true,
          lines: [`${batchLine(b.index, b.batchCount)}, ${formatTonnes(BigInt(b.quantityKg))}`],
        }))}
        onPick={(key) => {
          setChoosing(false);
          const current = draftRef.current;
          // A photo is filed under its batch, so another batch needs its own photo.
          if (current && current.batch !== key) void change({ batch: key, evidence: null });
        }}
        onClose={() => setChoosing(false)}
      />
    </Frame>
  );
}
