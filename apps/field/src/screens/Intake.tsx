import * as Crypto from "expo-crypto";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, View } from "react-native";
import { Head, Section, Skeleton } from "../components/Blocks";
import { Button } from "../components/Button";
import { Field, SelectField } from "../components/Field";
import { FileRow } from "../components/FileRow";
import { Frame } from "../components/Frame";
import { ErrorBlock, Note } from "../components/Note";
import { ConfirmSheet, Picker } from "../components/Picker";
import { RegistryMark } from "../components/RegistryMark";
import { Txt } from "../components/Txt";
import { useApp } from "../context";
import {
  type Owner,
  ReadError,
  readIssuedIntake,
  readLotIdUsed,
  readOwners,
  readSites,
  type Site,
} from "../data/reads";
import { useSigning } from "../data/useSigning";
import { keepLocalCopy, removeDraftFiles, removeLocalCopy } from "../drafts/files";
import { type DraftEdit, editDraft, type IntakeDraft, withEvidence } from "../drafts/store";
import { uploadDeps } from "../evidence/deps";
import { advanceUpload, type EvidenceItem, type Purpose } from "../evidence/upload";
import { formatClock, formatKg, formatTonnes, parseTonnes, unixOf } from "../format";
import {
  FIELD_LABELS,
  FILE_LABELS,
  footerReason,
  LOT_ID,
  latestFile,
  lotIdError,
  quantityError,
  ticketError,
} from "../intake";
import { intakeDigest, normaliseTicket } from "../intake-digest";

type Duplicate =
  | { kind: "none" }
  | { kind: "intake"; lotId: string | null }
  | { kind: "lot_id" }
  | { kind: "unavailable" };

const EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

export function duplicateCopy(duplicate: Duplicate, draft: IntakeDraft): string | null {
  switch (duplicate.kind) {
    case "none":
      return null;
    case "intake":
      return `This weighbridge ticket was already issued at ${draft.siteCode} as lot ${duplicate.lotId ?? "an existing lot"}. Thetis will refuse a second lot for the same intake.`;
    case "lot_id":
      return draft.lotIdLocked
        ? `Lot ID ${draft.lotId} is already used. Discard this draft and start again with another lot ID.`
        : `Lot ID ${draft.lotId} is already used on this Thetis instance. Thetis will refuse it. Choose another.`;
    case "unavailable":
      return "Thetis could not check this lot ID and ticket against its index. The program still checks both when you sign.";
  }
}

export function useDuplicateCheck(draft: IntakeDraft | null): Duplicate {
  const app = useApp();
  const [duplicate, setDuplicate] = useState<Duplicate>({ kind: "none" });
  const site = draft?.siteCode ?? null;
  const lotId = draft?.lotId ?? "";
  const ticket = draft ? normaliseTicket(draft.weighbridgeTicket) : null;
  const orgId = app.organisation.organisationId;
  const halted = app.protocol.indexStatus === "halted";
  useEffect(() => {
    if (!app.online) return;
    let live = true;
    const timer = setTimeout(() => {
      (async () => {
        if (halted) return setDuplicate({ kind: "unavailable" });
        if (site && ticket) {
          const issued = await readIssuedIntake(
            app.db,
            app.protocol.protocol,
            orgId,
            intakeDigest(site, ticket),
          );
          if (issued) return live && setDuplicate({ kind: "intake", lotId: issued.lotId });
        }
        if (LOT_ID.test(lotId) && (await readLotIdUsed(app.db, app.protocol.protocol, lotId))) {
          return live && setDuplicate({ kind: "lot_id" });
        }
        if (live) setDuplicate({ kind: "none" });
      })().catch(() => {
        if (live) setDuplicate({ kind: "unavailable" });
      });
    }, 800);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [app.db, app.protocol.protocol, app.online, orgId, site, lotId, ticket, halted]);
  return duplicate;
}

export function Intake(props: { draftId: string }) {
  const app = useApp();
  const signing = useSigning();
  const [draft, setDraft] = useState<IntakeDraft | null>(null);
  const [sites, setSites] = useState<Site[] | null>(null);
  const [owners, setOwners] = useState<Owner[]>([]);
  const [readError, setReadError] = useState<ReadError | null>(null);
  const [picker, setPicker] = useState<"site" | "owner" | "grade" | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [cameraDenied, setCameraDenied] = useState(false);
  const [quantityTouched, setQuantityTouched] = useState(false);
  const [tick, setTick] = useState(0);
  const draftRef = useRef<IntakeDraft | null>(null);
  const uploading = useRef(false);
  const orgId = app.organisation.organisationId;
  const org = app.organisation.name;
  const duplicate = useDuplicateCheck(draft);

  const persist = useCallback(
    async (next: IntakeDraft) => {
      draftRef.current = next;
      setDraft(next);
      await app.store.save(next);
    },
    [app.store],
  );

  useEffect(() => {
    void app.store.get(app.user.id, orgId, props.draftId).then((stored) => {
      draftRef.current = stored;
      setDraft(stored);
    });
  }, [app.store, app.user.id, orgId, props.draftId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick forces a re-read
  useEffect(() => {
    if (!app.online) return;
    let live = true;
    setReadError(null);
    (async () => {
      const [siteRows, ownerRows] = await Promise.all([
        readSites(app.db, app.protocol.protocol, orgId),
        readOwners(app.db, app.protocol.protocol),
      ]);
      if (!live) return;
      setSites(siteRows);
      setOwners(ownerRows);
      const current = draftRef.current;
      const only = siteRows[0];
      if (
        current &&
        current.custodianClass === null &&
        siteRows.length === 1 &&
        only &&
        current.status === "editing"
      ) {
        await persist(
          editDraft(
            current,
            {
              custodianClass: only.address,
              siteCode: only.siteCode,
              classLabel: `${only.classCode} v${only.classVersion}`,
              grade: only.grades.length === 1 ? (only.grades[0] ?? null) : current.grade,
            },
            new Date().toISOString(),
          ),
        );
      }
    })().catch((error: unknown) => {
      if (live)
        setReadError(error instanceof ReadError ? error : new ReadError(false, String(error)));
    });
    return () => {
      live = false;
    };
  }, [app.db, app.protocol.protocol, orgId, app.online, tick, persist]);

  const runUploads = useCallback(
    async (retryFailed: boolean) => {
      if (uploading.current || !app.online) return;
      const start = draftRef.current;
      if (!start || !LOT_ID.test(start.lotId)) return;
      uploading.current = true;
      try {
        const deps = uploadDeps(app.db, app.evidence);
        const subject = {
          organisationId: orgId,
          userId: app.user.id,
          subjectKind: "lot" as const,
          subjectRef: start.lotId,
        };
        const waiting = start.evidence.filter(
          (item) =>
            item.upload === "local" ||
            (retryFailed && (item.upload === "failed" || item.upload === "rejected")),
        );
        for (const pending of waiting) {
          const done = await advanceUpload(pending, subject, deps, (item) => {
            const current = draftRef.current;
            if (!current) return;
            const evidence = current.evidence.map((e) => (e.localId === item.localId ? item : e));
            void persist(withEvidence(current, evidence, new Date().toISOString()));
          });
          const current = draftRef.current;
          if (current) {
            const evidence = current.evidence.map((e) => (e.localId === done.localId ? done : e));
            await persist(withEvidence(current, evidence, new Date().toISOString()));
          }
        }
      } finally {
        uploading.current = false;
      }
    },
    [app.online, app.db, app.evidence, app.user.id, orgId, persist],
  );

  useEffect(() => {
    if (draft && app.online && draft.evidence.some((item) => item.upload === "local"))
      void runUploads(false);
  }, [draft, app.online, runUploads]);

  const wasOnline = useRef(app.online);
  useEffect(() => {
    if (app.online && !wasOnline.current) void runUploads(true);
    wasOnline.current = app.online;
  }, [app.online, runUploads]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void runUploads(true);
    });
    return () => subscription.remove();
  }, [runUploads]);

  if (!draft) {
    return (
      <Frame organisation={org} onBack={app.back}>
        <Skeleton width="60%" height={24} />
      </Frame>
    );
  }

  const readOnly = draft.status === "submitted" || draft.status === "unknown";
  const editable = draft.status === "editing" || draft.status === "failed";
  const site = sites?.find((s) => s.address === draft.custodianClass) ?? null;
  const originRequired = site?.originRequired ?? false;
  const kg = parseTonnes(draft.quantityText);
  const ticket = normaliseTicket(draft.weighbridgeTicket);
  const now = () => new Date().toISOString();

  async function edit(patch: DraftEdit) {
    const current = draftRef.current;
    if (!current) return;
    await persist(editDraft(current, patch, now()));
  }

  async function addFile(purpose: Purpose, uri: string, mime: string, size: number) {
    const current = draftRef.current;
    if (!current) return;
    const localId = Crypto.randomUUID();
    const localUri = keepLocalCopy(current.id, uri, localId, EXTENSIONS[mime] ?? "bin");
    const item: EvidenceItem = {
      localId,
      purpose,
      localUri,
      mime,
      sizeBytes: size,
      capturedAt: now(),
      objectId: null,
      versionId: null,
      version: null,
      supersedesId: null,
      storagePath: null,
      upload: "local",
      sha256: null,
      error: null,
    };
    await edit({ evidence: [...current.evidence, item] });
  }

  async function takePhoto(purpose: Purpose) {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      setCameraDenied(true);
      return;
    }
    setCameraDenied(false);
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.8 });
    const asset = result.canceled ? null : result.assets[0];
    if (asset)
      await addFile(purpose, asset.uri, asset.mimeType ?? "image/jpeg", asset.fileSize ?? 0);
  }

  async function chooseFile(purpose: Purpose) {
    const result = await DocumentPicker.getDocumentAsync({
      type: ["application/pdf", "image/jpeg", "image/png"],
      copyToCacheDirectory: true,
    });
    const asset = result.canceled ? null : result.assets[0];
    if (asset)
      await addFile(
        purpose,
        asset.uri,
        asset.mimeType ?? "application/octet-stream",
        asset.size ?? 0,
      );
  }

  async function removeFile(item: EvidenceItem) {
    const current = draftRef.current;
    if (!current) return;
    removeLocalCopy(item.localUri);
    await edit({ evidence: current.evidence.filter((e) => e.localId !== item.localId) });
  }

  async function discard() {
    const current = draftRef.current;
    if (!current) return;
    removeDraftFiles(current.id);
    await app.store.remove(current);
    app.navigate({ name: "home" });
  }

  const reason = footerReason({
    online: app.online,
    walletLinked: app.wallet !== null && signing.link === "linked",
    draft,
    originRequired,
  });
  const duplicateLine = duplicateCopy(duplicate, draft);
  const fileCount = draft.evidence.length;
  const purposes: Exclude<Purpose, "transport">[] = ["weighbridge", "assay", "origin"];

  return (
    <Frame
      organisation={org}
      onBack={app.back}
      footer={
        readOnly ? (
          <Button
            label="See the outcome"
            onPress={() => app.navigate({ name: "issue", draftId: draft.id })}
          />
        ) : (
          <>
            <Button
              label="Review and sign"
              disabled={reason !== null}
              onPress={() => app.navigate({ name: "issue", draftId: draft.id })}
            />
            {reason ? (
              <Txt variant="small" tone="ink2" live>
                {reason}
              </Txt>
            ) : null}
          </>
        )
      }
    >
      <Head title="New intake">
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <RegistryMark mark="Draft" />
          <Txt
            variant="small"
            tone="ink2"
          >{`Saved on this phone at ${formatClock(unixOf(draft.updatedAt))}`}</Txt>
        </View>
      </Head>

      {readOnly ? (
        <Note>
          This intake was sent to devnet. It can't be changed until Thetis knows the outcome.
        </Note>
      ) : null}
      {!app.online ? (
        <Note>
          Offline. Your draft is saved on this phone. Files upload when you are back online.
        </Note>
      ) : null}
      {readError ? (
        <>
          <ErrorBlock>
            Thetis could not load the sites and owners for this intake. Nothing changed.
          </ErrorBlock>
          <Button label="Retry" kind="quiet" inline onPress={() => setTick((t) => t + 1)} />
        </>
      ) : null}

      {sites !== null && sites.length === 0 ? (
        <Txt style={{ fontSize: 14 }}>
          {`${org} has no accredited site on this Thetis instance, so there is nowhere to record an intake. Ask the accreditor to accredit one.`}
        </Txt>
      ) : sites === null && app.online && !readError ? (
        <View style={{ gap: 6 }}>
          <Txt variant="label">{FIELD_LABELS.site}</Txt>
          <Skeleton width="100%" height={48} />
        </View>
      ) : (
        <SelectField
          label={FIELD_LABELS.site}
          value={draft.siteCode}
          mono
          trailing={draft.classLabel}
          locked={!editable}
          onPress={sites && sites.length > 1 ? () => setPicker("site") : undefined}
          help={
            site
              ? `Room for ${formatTonnes(site.roomKg)}. ${freshness(app.protocol.lastSuccessAt)}`
              : null
          }
        />
      )}

      <Field
        label={FIELD_LABELS.lotId}
        value={draft.lotId}
        mono
        autoCapitalize="characters"
        maxLength={16}
        locked={!editable || draft.lotIdLocked}
        onChangeText={(text) => void edit({ lotId: text.toUpperCase() })}
        error={lotIdError(draft.lotId)}
        help={
          draft.lotIdLocked
            ? "Fixed once a file is uploaded, because the files are filed under it."
            : null
        }
      />
      {duplicate.kind === "lot_id" && duplicateLine ? (
        <ErrorBlock>
          {draft.lotIdLocked
            ? `${duplicateLine} Your photos stay on this phone until you discard the draft.`
            : duplicateLine}
        </ErrorBlock>
      ) : null}

      <SelectField
        label={FIELD_LABELS.owner}
        value={draft.ownerName}
        trailing={owners.find((o) => o.orgId === draft.ownerOrgId)?.synthetic ? "Synthetic" : null}
        locked={!editable}
        onPress={editable ? () => setPicker("owner") : undefined}
      />

      <SelectField
        label={FIELD_LABELS.grade}
        value={draft.grade}
        trailing={
          site && site.grades.length === 1
            ? `only grade in ${site.classCode} v${site.classVersion}`
            : null
        }
        locked={!editable}
        onPress={editable && site && site.grades.length > 1 ? () => setPicker("grade") : undefined}
      />

      <Field
        label={FIELD_LABELS.quantity}
        value={draft.quantityText}
        keyboardType="decimal-pad"
        locked={!editable}
        onChangeText={(text) => void edit({ quantityText: text })}
        onBlur={() => setQuantityTouched(true)}
        error={quantityError(draft.quantityText, quantityTouched)}
        help={
          typeof kg === "bigint"
            ? `= ${formatKg(kg)}. Weighbridge net mass, as on the ticket.`
            : null
        }
        note={
          typeof kg === "bigint" && site && kg > site.roomKg
            ? `More than the room shown for ${site.siteCode} (${formatTonnes(site.roomKg)}). Thetis will refuse it if the site is still full when you sign.`
            : null
        }
      />

      <Field
        label={FIELD_LABELS.ticket}
        value={draft.weighbridgeTicket}
        autoCapitalize="characters"
        locked={!editable}
        onChangeText={(text) => void edit({ weighbridgeTicket: text })}
        error={ticketError(draft.weighbridgeTicket)}
        help={
          ticket && draft.siteCode
            ? `Recorded as ${ticket}. Intake ${intakeDigest(draft.siteCode, ticket).slice(0, 8)}, from site and ticket.`
            : null
        }
      />

      {duplicate.kind === "intake" && duplicateLine ? (
        <ErrorBlock>
          {`${duplicateLine} Check the ticket number. If this is a new delivery, it has its own ticket.`}
        </ErrorBlock>
      ) : null}
      {duplicate.kind === "unavailable" && duplicateLine ? <Note>{duplicateLine}</Note> : null}

      <Section title="Files">
        {cameraDenied ? (
          <ErrorBlock>
            Thetis can't use the camera because permission was refused. Allow it in Android
            settings, or choose a file instead.
          </ErrorBlock>
        ) : null}
        {purposes.map((purpose) => {
          const item = latestFile(draft, purpose);
          const required = purpose !== "origin" || originRequired;
          return (
            <FileRow
              key={purpose}
              label={FILE_LABELS[purpose]}
              requirement={
                purpose === "origin"
                  ? originRequired
                    ? "Required by this class version."
                    : `Optional: ${site ? `${site.classCode} v${site.classVersion}` : "this class"} does not require origin.`
                  : required
                    ? "Required."
                    : "Optional."
              }
              item={item}
              online={app.online}
              readOnly={!editable}
              onTakePhoto={() => void takePhoto(purpose)}
              onChooseFile={() => void chooseFile(purpose)}
              onRetry={() => void runUploads(true)}
              onRemove={() => item && void removeFile(item)}
            />
          );
        })}
        <Txt variant="small" tone="ink2">
          {`Files are stored privately for ${org}${draft.lotId ? ` under lot ${draft.lotId}` : ""}. Thetis records each file's SHA-256 when it is stored.`}
        </Txt>
      </Section>

      {editable ? (
        <Button label="Discard draft" kind="quiet" onPress={() => setDiscarding(true)} />
      ) : null}

      <Picker
        visible={picker === "site"}
        title="Site"
        options={(sites ?? []).map((s) => ({
          key: s.address,
          title: s.siteCode,
          mono: true,
          lines: [`${s.classCode} v${s.classVersion}`, `Room for ${formatTonnes(s.roomKg)}`],
        }))}
        footnote={freshness(app.protocol.lastSuccessAt)}
        onPick={(key) => {
          setPicker(null);
          const chosen = sites?.find((s) => s.address === key);
          if (chosen) {
            void edit({
              custodianClass: chosen.address,
              siteCode: chosen.siteCode,
              classLabel: `${chosen.classCode} v${chosen.classVersion}`,
              grade: chosen.grades.length === 1 ? (chosen.grades[0] ?? null) : null,
            });
          }
        }}
        onClose={() => setPicker(null)}
      />
      <Picker
        visible={picker === "owner"}
        title="Owner"
        options={owners.map((o) => ({
          key: o.orgId,
          title: o.displayName,
          tag: o.synthetic ? "Synthetic" : null,
        }))}
        onPick={(key) => {
          setPicker(null);
          const owner = owners.find((o) => o.orgId === key);
          if (owner) void edit({ ownerOrgId: owner.orgId, ownerName: owner.displayName });
        }}
        onClose={() => setPicker(null)}
      />
      <Picker
        visible={picker === "grade"}
        title="Grade"
        options={(site?.grades ?? []).map((g) => ({ key: g, title: g, mono: true }))}
        onPick={(key) => {
          setPicker(null);
          void edit({ grade: key });
        }}
        onClose={() => setPicker(null)}
      />
      <ConfirmSheet
        visible={discarding}
        title="Discard this draft?"
        body={`Draft ${draft.lotId || "with no lot ID"} and its ${fileCount} ${fileCount === 1 ? "file" : "files"} are removed from this phone. Files already uploaded stay stored for ${org}; they can't be deleted.`}
        confirm="Discard draft"
        cancel="Keep draft"
        onConfirm={() => void discard()}
        onCancel={() => setDiscarding(false)}
      />
    </Frame>
  );
}

function freshness(lastSuccessAt: string | null): string {
  return lastSuccessAt
    ? `From the Thetis index, as of ${formatClock(unixOf(lastSuccessAt))}.`
    : "From the Thetis index.";
}
