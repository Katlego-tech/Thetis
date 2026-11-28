// The Account tab's sections after the wallet (navigation.md §4.5): the organisation, with the
// switch when the person has more than one, and who is signed in, with Sign out.
import { useApp } from "../context";
import { NAV_COPY } from "../copy";
import { useSigning } from "../data/useSigning";
import { Rows, Section } from "./Blocks";
import { Button } from "./Button";
import { Txt } from "./Txt";

export function OrganisationSection() {
  const app = useApp();
  const signing = useSigning();
  const role = signing.chainOrganisation?.role ?? (app.online ? "Unknown" : "Offline");
  return (
    <Section title={NAV_COPY.organisationTitle}>
      <Rows
        rows={[
          {
            label: "Organisation",
            value: app.organisation.name,
            sub: app.organisation.synthetic ? "Synthetic" : null,
          },
          // Read from the chain row; nothing is shown while it loads.
          { label: "Role on chain", value: signing.loading && app.online ? " " : role },
        ]}
      />
      {app.memberships.length > 1 ? (
        <Button
          label={NAV_COPY.switchOrganisation}
          kind="quiet"
          inline
          disabled={app.busy}
          accessibilityHint={app.busy ? NAV_COPY.busyHint : undefined}
          onPress={app.switchOrganisation}
        />
      ) : null}
    </Section>
  );
}

export function SignedInSection() {
  const app = useApp();
  return (
    <Section title={NAV_COPY.signedInTitle}>
      <Rows rows={[{ label: "Email", value: app.user.email }]} />
      <Button
        label={NAV_COPY.signOut}
        kind="quiet"
        inline
        disabled={app.busy}
        accessibilityHint={app.busy ? NAV_COPY.busyHint : undefined}
        onPress={app.signOut}
      />
      <Txt variant="small" tone="ink2">
        {NAV_COPY.signOutHelp}
      </Txt>
    </Section>
  );
}
