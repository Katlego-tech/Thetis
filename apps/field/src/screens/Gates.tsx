import { Head, ListBox, ListItem, Panel } from "../components/Blocks";
import { Button } from "../components/Button";
import { Frame } from "../components/Frame";
import { Txt } from "../components/Txt";
import type { Membership } from "../data/reads";

export function ConfigError(props: { errors: string[] }) {
  return (
    <Frame>
      <Head title="This build is not configured" />
      <Txt style={{ fontSize: 14 }}>{`Missing or invalid: ${props.errors.join(", ")}.`}</Txt>
      <Txt style={{ fontSize: 14 }}>
        Rebuild the app with the EXPO_PUBLIC_ values for this build. Nothing else on this phone
        works until then.
      </Txt>
    </Frame>
  );
}

export function NoOrganisation(props: { onSignOut: () => void }) {
  return (
    <Frame footer={<Button label="Sign out" kind="quiet" onPress={props.onSignOut} />}>
      <Head title="No organisation yet" />
      <Txt style={{ fontSize: 14 }}>
        You are not a member of any organisation yet. Open your invitation on the web first, then
        sign in here again.
      </Txt>
    </Frame>
  );
}

export function ChooseOrganisation(props: {
  memberships: Membership[];
  onChoose: (organisationId: string) => void;
}) {
  return (
    <Frame>
      <Head title="Which organisation are you working for?" />
      <ListBox>
        {props.memberships.map((m, index) => (
          <ListItem
            key={m.organisationId}
            title={m.name}
            lines={[m.synthetic ? `${m.kind}, synthetic` : m.kind]}
            right={
              <Button
                label="Choose"
                kind="quiet"
                inline
                onPress={() => props.onChoose(m.organisationId)}
              />
            }
            last={index === props.memberships.length - 1}
          />
        ))}
      </ListBox>
      <Txt variant="small" tone="ink2">
        Drafts and wallets are kept per organisation. You can switch later from this screen.
      </Txt>
    </Frame>
  );
}

export function NoInstance(props: { onRetry: () => void; organisation: string | null }) {
  return (
    <Frame
      organisation={props.organisation}
      footer={<Button label="Check again" kind="quiet" onPress={props.onRetry} />}
    >
      <Head title="No Thetis instance" />
      <Txt style={{ fontSize: 14 }}>
        This phone can't find which Thetis instance to use. Ask the operator to start the index for
        this demo run.
      </Txt>
    </Frame>
  );
}

export function LoadFailed(props: { onRetry: () => void; offline: boolean; what: string }) {
  return (
    <Frame footer={<Button label="Retry" kind="quiet" onPress={props.onRetry} />}>
      <Panel>
        <Txt style={{ fontSize: 14 }}>
          {props.offline
            ? `Offline. ${props.what} load when you are back online. Your drafts are still on this phone.`
            : `Thetis could not load ${props.what.toLowerCase()}. Nothing changed.`}
        </Txt>
      </Panel>
    </Frame>
  );
}

export function Loading() {
  return <Frame>{null}</Frame>;
}
