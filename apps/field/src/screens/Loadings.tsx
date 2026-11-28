import { useEffect, useState } from "react";
import type { LoadingIntent } from "../api/field";
import { Cert, Head, ListBox, ListItem, Skeleton, Tag } from "../components/Blocks";
import { Button } from "../components/Button";
import { Frame } from "../components/Frame";
import { ErrorBlock, Note } from "../components/Note";
import { Txt } from "../components/Txt";
import { useApp } from "../context";
import { formatTonnes } from "../format";

/** Loadings at your terminal (§7.7): the open loading intents the owner prepared on the web. */
export function Loadings() {
  const app = useApp();
  const [intents, setIntents] = useState<LoadingIntent[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const orgId = app.organisation.organisationId;
  const org = app.organisation.name;

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick forces a re-read
  useEffect(() => {
    if (!app.online) return;
    let live = true;
    setFailed(false);
    app.field
      .loadingIntents(orgId)
      .then((rows) => {
        if (live) setIntents(rows);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [app.field, orgId, app.online, tick]);

  return (
    <Frame organisation={org} onBack={app.back}>
      <Head title="Loadings at your terminal">
        <Cert label={app.protocol.instanceLabel} />
      </Head>
      {!app.online ? (
        <Note>Offline. Recording a loading needs a connection. Nothing was recorded.</Note>
      ) : null}
      {failed ? (
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
      ) : intents === null ? (
        app.online ? (
          <ListBox>
            <Skeleton width="60%" />
          </ListBox>
        ) : null
      ) : intents.length === 0 ? (
        <Txt variant="small" tone="ink2">
          {`No open loading intents at ${org}. The owner prepares one on the web with the bill of lading.`}
        </Txt>
      ) : (
        <ListBox>
          {intents.map((intent, index) => (
            <ListItem
              key={intent.intent}
              title={intent.lotId}
              titleMono
              lines={[
                `${formatTonnes(BigInt(intent.quantityKg))} for ${intent.ownerName}`,
                `Intent ${intent.nonce}, ${intent.acceptances.filter((a) => a.state === "accepted").length} of ${intent.acceptances.length} lenders accepted`,
              ]}
              right={<Tag label="Open" />}
              last={index === intents.length - 1}
              onPress={() => app.navigate({ name: "loading", intent: intent.intent })}
            />
          ))}
        </ListBox>
      )}
    </Frame>
  );
}
