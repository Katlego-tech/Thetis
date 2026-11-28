import * as Crypto from "expo-crypto";
import { useCallback, useEffect, useState } from "react";
import { Linking, View } from "react-native";
import { Cert, ListBox, ListItem, Panel, Rows, Section, Skeleton, Tag } from "../components/Blocks";
import { Button, TextLink } from "../components/Button";
import { Frame } from "../components/Frame";
import { Freshness } from "../components/Freshness";
import { ErrorBlock, Note } from "../components/Note";
import { CustodyMark, RegistryMark } from "../components/RegistryMark";
import { Txt } from "../components/Txt";
import { useApp, useRootChrome } from "../context";
import { shortCode } from "../custody";
import {
  type LotRow,
  ReadError,
  readLotsAtSites,
  readSites,
  readWaiting,
  type WaitingCommand,
} from "../data/reads";
import { useSigning } from "../data/useSigning";
import { removeDraftFiles } from "../drafts/files";
import { type IntakeDraft, isEarlierRun, newDraft } from "../drafts/store";
import { formatClock, formatTonnes, parseTonnes, shortAddress, unixOf } from "../format";
import { requiredPurposes } from "../intake";
import { type RegistryMark as Mark, markFor } from "../marks";
import { readinessLines } from "../readiness";

/** The value of a labelled line in a waiting command's fields, or null. */
function fieldOf(row: WaitingCommand, label: string): string | null {
  return row.fields.find((f) => f.label === label)?.value ?? null;
}

function draftMark(draft: IntakeDraft): Mark {
  if (draft.command && draft.status !== "editing")
    return markFor(draft.command.lastStatus, draft.command.commitment);
  return "Draft";
}

function quantityLine(draft: IntakeDraft): string {
  const kg = parseTonnes(draft.quantityText);
  const quantity = typeof kg === "bigint" ? formatTonnes(kg) : "No quantity yet";
  return draft.siteCode ? `${quantity} at ${draft.siteCode}` : quantity;
}

function filesLine(draft: IntakeDraft, online: boolean): string {
  const required = requiredPurposes(false);
  const files = draft.evidence.length;
  const uploaded = draft.evidence.filter((item) => item.upload === "finalized").length;
  if (files === 0) return `0 of ${required.length} files added`;
  if (!online && uploaded < files) return "Files upload when online";
  return `${uploaded} of ${Math.max(files, required.length)} files uploaded`;
}

export function Home() {
  const app = useApp();
  const signing = useSigning();
  const chrome = useRootChrome();
  const [drafts, setDrafts] = useState<IntakeDraft[]>([]);
  const [lots, setLots] = useState<LotRow[] | null>(null);
  const [lotsError, setLotsError] = useState<ReadError | null>(null);
  const [tick, setTick] = useState(0);
  const [waiting, setWaiting] = useState<WaitingCommand[] | null>(null);
  const [waitingFailed, setWaitingFailed] = useState(false);
  const [waitingTick, setWaitingTick] = useState(0);
  const orgId = app.organisation.organisationId;
  const orgName = app.organisation.name;

  const loadDrafts = useCallback(async () => {
    setDrafts(await app.store.list(app.user.id, orgId));
  }, [app.store, app.user.id, orgId]);

  useEffect(() => {
    void loadDrafts();
  }, [loadDrafts]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick forces a re-read
  useEffect(() => {
    if (!app.online) return;
    let live = true;
    setLots(null);
    setLotsError(null);
    (async () => {
      const sites = await readSites(app.db, app.protocol.protocol, orgId);
      const rows = await readLotsAtSites(app.db, app.protocol.protocol, orgId, sites);
      if (live) setLots(rows);
    })().catch((error: unknown) => {
      if (live)
        setLotsError(error instanceof ReadError ? error : new ReadError(false, String(error)));
    });
    return () => {
      live = false;
    };
  }, [app.db, app.protocol.protocol, orgId, app.online, tick]);

  // Read on mount and on Retry only: what is waiting for this organisation's signature.
  // biome-ignore lint/correctness/useExhaustiveDependencies: waitingTick forces a re-read
  useEffect(() => {
    if (!app.online) return;
    let live = true;
    setWaitingFailed(false);
    readWaiting(app.db, app.protocol.protocol, orgId)
      .then((rows) => {
        if (live) setWaiting(rows);
      })
      .catch(() => {
        if (live) setWaitingFailed(true);
      });
    return () => {
      live = false;
    };
  }, [app.db, app.protocol.protocol, orgId, app.online, waitingTick]);

  async function startIntake() {
    const draft = newDraft({
      id: Crypto.randomUUID(),
      userId: app.user.id,
      organisationId: orgId,
      protocol: app.protocol.protocol,
      now: new Date().toISOString(),
    });
    await app.store.save(draft);
    app.navigate({ name: "intake", draftId: draft.id });
  }

  async function discard(draft: IntakeDraft) {
    removeDraftFiles(draft.id);
    await app.store.remove(draft);
    await loadDrafts();
  }

  const chain = signing.chainOrganisation;
  const current = drafts.filter(
    (d) => !isEarlierRun(d, app.protocol.protocol) && d.status !== "issued",
  );
  const earlier = drafts.filter((d) => isEarlierRun(d, app.protocol.protocol));
  const issued = drafts.filter(
    (d) => !isEarlierRun(d, app.protocol.protocol) && d.status === "issued",
  );
  const halted = app.protocol.indexStatus === "halted";
  const notAccredited = app.online && !signing.loading && !signing.error && chain === null;
  const custodian = chain?.role === "Custodian";
  const transporter = chain?.role === "Transporter";
  const terminal = chain?.role === "Terminal";
  // A record_loading without an intent cannot be opened, so it is not listed.
  const waitingRows = (waiting ?? []).filter((w) => w.kind === "handover" || w.intent !== null);
  const lines = readinessLines({
    org: orgName,
    chainOrganisation: chain,
    wallet: app.wallet?.address ?? null,
    link: signing.link,
    authority: signing.authority,
  });

  const walletValue = app.wallet ? (
    <View style={{ alignItems: "flex-end" }}>
      <Txt variant="mono">{shortAddress(app.wallet.address)}</Txt>
      <Txt variant="caption" tone="ink2">
        {signing.link === "linked"
          ? "Linked to you"
          : signing.link === null
            ? " "
            : "Not linked to you"}
      </Txt>
    </View>
  ) : (
    "None connected"
  );

  const authority = signing.authority;
  const authorityValue =
    !app.wallet || !authority
      ? null
      : authority.kind === "ok"
        ? { value: authority.words, sub: `Expires ${authority.expires}` }
        : authority.kind === "none"
          ? { value: "None for this wallet", sub: null }
          : authority.kind === "no_issue"
            ? { value: authority.words, sub: "Does not include Issue" }
            : authority.kind === "other_org"
              ? { value: `Delegated for ${authority.otherOrg}`, sub: null }
              : {
                  value:
                    authority.kind === "revoked"
                      ? `Revoked ${authority.at}`
                      : `Expired ${authority.at}`,
                  sub: null,
                };

  return (
    <Frame
      organisation={orgName}
      {...chrome}
      footer={
        custodian ? (
          <>
            <Button label="New intake" onPress={() => void startIntake()} />
            <Button
              label="Batches you hold"
              kind="quiet"
              onPress={() => app.navigate({ name: "batches" })}
            />
          </>
        ) : transporter ? (
          <>
            <Button label="Batches you hold" onPress={() => app.navigate({ name: "batches" })} />
            <Button
              label="Record border crossing"
              kind="quiet"
              onPress={() => app.navigate({ name: "observation" })}
            />
          </>
        ) : terminal ? (
          <Button
            label="Arrivals and loadings"
            onPress={() => app.navigate({ name: "loadings" })}
          />
        ) : undefined
      }
    >
      {!app.online ? (
        <Note>
          Offline. Your drafts are on this phone and you can keep working on them. Lots and
          handovers load when you are back online.
        </Note>
      ) : null}

      <Panel>
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
          }}
        >
          <Txt variant="section" style={{ flexShrink: 1 }}>
            {orgName}
          </Txt>
          {app.organisation.synthetic ? <Tag label="Synthetic" /> : null}
        </View>
        {notAccredited ? (
          <Txt style={{ fontSize: 14 }}>
            {`${orgName} is not accredited on this Thetis instance yet. Intakes can be recorded once the accreditor adds it.`}
          </Txt>
        ) : signing.loading && app.online ? (
          <View style={{ gap: 8 }}>
            <Skeleton width="60%" />
            <Skeleton width="80%" />
          </View>
        ) : (
          <>
            <Rows
              rows={[
                {
                  label: "Role on chain",
                  value: chain?.role ?? (app.online ? "Unknown" : "Offline"),
                },
                { label: "Wallet", value: walletValue },
                ...(authorityValue
                  ? [
                      {
                        label: "Thetis authority",
                        value: authorityValue.value,
                        sub: authorityValue.sub,
                      },
                    ]
                  : []),
              ]}
            />
            {lines.map((line) =>
              line === "Link this wallet" ? (
                <TextLink
                  key={line}
                  label={line}
                  onPress={() => app.navigate({ name: "account" })}
                />
              ) : (
                <Txt key={line} variant="small" tone="ink2">
                  {line}
                </Txt>
              ),
            )}
            {!app.wallet ? (
              <TextLink
                label="Connect a wallet"
                onPress={() => app.navigate({ name: "account" })}
              />
            ) : null}
            {signing.asOf ? (
              <Txt variant="small" tone="ink2">
                {`As of ${formatClock(unixOf(signing.asOf))}, offline`}
              </Txt>
            ) : null}
          </>
        )}
        {signing.error ? (
          <ErrorBlock>
            Thetis could not load this organisation's signing details. Nothing changed.
          </ErrorBlock>
        ) : null}
        {signing.error ? (
          <Button label="Retry" kind="quiet" inline onPress={signing.reload} />
        ) : null}
        {app.wallet ? (
          <TextLink
            label="Wallet and authority"
            onPress={() => app.navigate({ name: "account" })}
          />
        ) : null}
        <Cert label={app.protocol.instanceLabel} />
      </Panel>

      <Section title="Drafts on this phone">
        {current.length === 0 ? (
          <Txt variant="small" tone="ink2">
            No drafts. Start one with New intake; it is saved on this phone as you type.
          </Txt>
        ) : (
          <ListBox>
            {current.map((draft, index) => (
              <ListItem
                key={draft.id}
                title={draft.lotId || "No lot ID yet"}
                titleMono={draft.lotId !== ""}
                lines={[quantityLine(draft), filesLine(draft, app.online)]}
                right={<RegistryMark mark={draftMark(draft)} />}
                last={index === current.length - 1}
                onPress={() =>
                  app.navigate(
                    draft.status === "editing"
                      ? { name: "intake", draftId: draft.id }
                      : { name: "issue", draftId: draft.id },
                  )
                }
              />
            ))}
          </ListBox>
        )}
      </Section>

      <Section title="Waiting for you">
        {!app.online ? (
          <Txt variant="small" tone="ink2">
            Offline. Handovers waiting for you load when you are back online.
          </Txt>
        ) : waitingFailed ? (
          <>
            <ErrorBlock>Thetis could not load what is waiting for you. Nothing changed.</ErrorBlock>
            <Button
              label="Retry"
              kind="quiet"
              inline
              onPress={() => setWaitingTick((t) => t + 1)}
            />
          </>
        ) : waiting === null ? (
          <ListBox>
            <View style={{ padding: 12, gap: 8 }}>
              <Skeleton width="40%" />
              <Skeleton width="60%" />
            </View>
          </ListBox>
        ) : waitingRows.length === 0 ? (
          <Txt variant="small" tone="ink2">
            Nothing is waiting for your signature.
          </Txt>
        ) : (
          <ListBox>
            {waitingRows.map((row, index) => {
              const code = shortCode(row.id);
              const lot = fieldOf(row, "Lot");
              const handover = row.kind === "handover";
              const party = handover ? fieldOf(row, "From") : fieldOf(row, "Owner");
              return (
                <ListItem
                  key={row.id}
                  title={lot ?? `Command ${code}`}
                  titleMono
                  lines={[
                    `${handover ? "Hand over custody" : "Record loading"}, code ${code}`,
                    ...(party ? [`${handover ? "From" : "Owner"} ${party}`] : []),
                  ]}
                  right={<RegistryMark mark="Awaiting signatures" />}
                  last={index === waitingRows.length - 1}
                  onPress={() =>
                    app.navigate(
                      handover
                        ? { name: "handover", commandId: row.id }
                        : { name: "loading", intent: row.intent ?? "" },
                    )
                  }
                />
              );
            })}
          </ListBox>
        )}
      </Section>

      {earlier.length > 0 ? (
        <Section title="From an earlier run">
          <ListBox>
            {earlier.map((draft, index) => (
              <ListItem
                key={draft.id}
                title={draft.lotId || "No lot ID yet"}
                titleMono={draft.lotId !== ""}
                lines={[quantityLine(draft), "Read-only: made for another Thetis instance"]}
                right={
                  <Button label="Discard" kind="quiet" inline onPress={() => void discard(draft)} />
                }
                last={index === earlier.length - 1}
              />
            ))}
          </ListBox>
        </Section>
      ) : null}

      <Section title="Lots at your sites">
        {!app.online ? (
          <Txt variant="small" tone="ink2">
            Offline. Lots load when you are back online.
          </Txt>
        ) : lotsError ? (
          <>
            <ErrorBlock>Thetis could not load the lots at your sites. Nothing changed.</ErrorBlock>
            <Button label="Retry" kind="quiet" inline onPress={() => setTick((t) => t + 1)} />
          </>
        ) : lots === null ? (
          <ListBox>
            <View style={{ padding: 12, gap: 8 }}>
              <Skeleton width="40%" />
              <Skeleton width="60%" />
            </View>
          </ListBox>
        ) : (
          <>
            {lots.length === 0 ? (
              <Txt variant="small" tone="ink2">
                No lots at your sites on this Thetis instance yet.
              </Txt>
            ) : (
              <ListBox>
                {lots.map((lot, index) => (
                  <ListItem
                    key={lot.address}
                    title={lot.lotId}
                    titleMono
                    lines={[
                      [formatTonnes(lot.supplyKg), `grade ${lot.grade}`, lot.siteCode]
                        .filter(Boolean)
                        .join(", "),
                    ]}
                    right={<CustodyMark state={lot.state} />}
                    last={index === lots.length - 1}
                  />
                ))}
              </ListBox>
            )}
            <Freshness lastSuccessAt={app.protocol.lastSuccessAt} halted={halted} />
          </>
        )}
      </Section>

      {issued.length > 0 ? (
        <Section title="Issued from this phone">
          <ListBox>
            {issued.map((draft, index) => (
              <View key={draft.id}>
                <ListItem
                  title={draft.lotId}
                  titleMono
                  lines={[
                    `${quantityLine(draft).split(" at ")[0]} for ${draft.ownerName ?? ""}`,
                    draft.command?.transactionSignature
                      ? `${draft.command.transactionSignature.slice(0, 8)}…${draft.command.transactionSignature.slice(-8)}`
                      : "",
                  ].filter(Boolean)}
                  right={<RegistryMark mark={draftMark(draft)} />}
                  last={index === issued.length - 1}
                  onPress={() => app.navigate({ name: "issue", draftId: draft.id })}
                />
                {draft.command?.explorerUrl ? (
                  <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
                    <TextLink
                      label="View on Solana Explorer (devnet)"
                      onPress={() => {
                        const url = draft.command?.explorerUrl;
                        if (url) void Linking.openURL(url);
                      }}
                    />
                  </View>
                ) : null}
              </View>
            ))}
          </ListBox>
        </Section>
      ) : null}
    </Frame>
  );
}
