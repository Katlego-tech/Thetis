import { useEffect, useRef, useState } from "react";
import { BackHandler } from "react-native";
import { ApiError, ApiShapeError, ApiTimeout, ApiUnreachable } from "../api/client";
import type { FieldBatch } from "../api/field";
import { Cert, Head, ListBox, ListItem, Rows, Skeleton } from "../components/Blocks";
import { Button } from "../components/Button";
import { Frame } from "../components/Frame";
import { ErrorBlock, Note } from "../components/Note";
import { CustodyMark } from "../components/RegistryMark";
import { Txt } from "../components/Txt";
import { useApp, useBusy, useRootChrome } from "../context";
import { RELAY_TIMEOUT, relayErrorCopy } from "../copy";
import { nextHolderOf } from "../custody";
import { readOrganisationAt } from "../data/reads";
import { useSigning } from "../data/useSigning";
import { formatTonnes } from "../format";

const STAGE_WORDS = { AtSource: "At source", InTransit: "In transit", Arrived: "Arrived" } as const;

const OFFLINE =
  "Offline. A handover needs both phones online at the moment you sign. Nothing was recorded.";

/**
 * Batches you hold (holder side), the Batches tab's root: the list, one batch's detail, and Start
 * handover. A transporter also starts a border crossing here (navigation.html).
 */
export function Batches() {
  const app = useApp();
  const chrome = useRootChrome();
  const signing = useSigning();
  const [batches, setBatches] = useState<FieldBatch[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const [chosen, setChosen] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set in the same tap that starts the call, so a second tap before the re-render sends nothing.
  const inFlight = useRef(false);
  const orgId = app.organisation.organisationId;
  const org = app.organisation.name;

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

  const chain = signing.chainOrganisation;
  // The route also returns batches arriving at a terminal; only the ones held here are listed.
  const held = batches && chain ? batches.filter((b) => b.holder === chain.address) : [];
  const batch = chosen ? (held.find((b) => b.batch === chosen) ?? null) : null;
  const next = batch ? nextHolderOf(batch) : null;
  const transporter = chain?.role === "Transporter";

  // The relay call can land while the person isn't looking: the tabs and Back wait for it.
  useBusy(preparing);

  // Android Back on a batch returns to the list before the tabs see it.
  const detailOpen = chosen !== null;
  useEffect(() => {
    if (!detailOpen) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!inFlight.current) setChosen(null);
      return true;
    });
    return () => subscription.remove();
  }, [detailOpen]);

  async function startHandover() {
    if (!batch || !next || !app.online || inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setPreparing(true);
    const vars = { org, detail: null, kind: "handover" };
    try {
      const to = await readOrganisationAt(app.db, app.protocol.protocol, next.address);
      if (!to) {
        setError(
          `${next.name} is not set up as an organisation on this Thetis instance. Nothing was sent.`,
        );
        return;
      }
      const created = await app.commands.create({
        kind: "handover",
        organisationId: orgId,
        args: { batch: batch.batch, to: to.orgId },
      });
      app.navigate({ name: "handover", commandId: created.id });
    } catch (thrown) {
      if (thrown instanceof ApiError && thrown.code === "NOT_AUTHENTICATED") app.sessionExpired();
      else if (thrown instanceof ApiError) {
        setError(relayErrorCopy(thrown.code, "create", { ...vars, detail: thrown.detail }));
      } else if (thrown instanceof ApiTimeout || thrown instanceof ApiUnreachable) {
        setError(RELAY_TIMEOUT);
      } else {
        const code = thrown instanceof ApiShapeError ? "UNEXPECTED_ANSWER" : "INTERNAL";
        setError(relayErrorCopy(code, "create", vars));
      }
    } finally {
      inFlight.current = false;
      setPreparing(false);
    }
  }

  const footer =
    batch && next ? (
      <>
        <Button
          label={preparing ? "Preparing text" : "Start handover"}
          disabled={preparing || !app.online}
          onPress={() => void startHandover()}
        />
        {!app.online ? (
          <Txt variant="small" tone="ink2">
            Needs a connection.
          </Txt>
        ) : null}
      </>
    ) : undefined;

  if (batch) {
    return (
      <Frame
        organisation={org}
        onBack={() => setChosen(null)}
        footer={footer}
        tabBar={chrome.tabBar}
      >
        <Head title={`${batch.lotId}, batch ${batch.index} of ${batch.batchCount}`}>
          <CustodyMark state={STAGE_WORDS[batch.stage]} />
          <Cert label={app.protocol.instanceLabel} />
        </Head>
        {!app.online ? <Note>{OFFLINE}</Note> : null}
        {error ? <ErrorBlock>{error}</ErrorBlock> : null}
        <Rows
          rows={[
            { label: "Quantity", value: formatTonnes(BigInt(batch.quantityKg)) },
            ...(next ? [{ label: "Hand over to", value: next.name, sub: next.why }] : []),
            { label: "Destination", value: batch.destinationName },
          ]}
        />
      </Frame>
    );
  }

  return (
    <Frame
      organisation={org}
      {...chrome}
      footer={
        transporter ? (
          <Button
            label="Record border crossing"
            kind="quiet"
            onPress={() => app.navigate({ name: "observation" })}
          />
        ) : undefined
      }
    >
      <Head title="Batches you hold">
        <Cert label={app.protocol.instanceLabel} />
      </Head>
      {!app.online ? <Note>{OFFLINE}</Note> : null}
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
      ) : batches === null || signing.loading ? (
        app.online ? (
          <ListBox>
            <Skeleton width="60%" />
          </ListBox>
        ) : null
      ) : held.length === 0 ? (
        <Txt variant="small" tone="ink2">
          {`${org} holds no registered batches right now. Shipments are prepared by the owner on the web.`}
        </Txt>
      ) : (
        <ListBox>
          {held.map((b, index) => (
            <ListItem
              key={b.batch}
              title={b.lotId}
              titleMono
              lines={[
                `Batch ${b.index} of ${b.batchCount}, ${formatTonnes(BigInt(b.quantityKg))}`,
                `Carrier on the manifest: ${b.carrierName}`,
              ]}
              right={<CustodyMark state={STAGE_WORDS[b.stage]} />}
              last={index === held.length - 1}
              onPress={() => setChosen(b.batch)}
            />
          ))}
        </ListBox>
      )}
    </Frame>
  );
}
