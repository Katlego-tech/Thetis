import { View } from "react-native";
import type { CommandView } from "../api/commands";
import { type OutcomeContext, outcomeView } from "../outcome";
import { Button } from "./Button";
import { ErrorBlock } from "./Note";
import { RegistryMark } from "./RegistryMark";
import { TxLink } from "./TxLink";
import { Txt } from "./Txt";

const PRIMARY_LABEL = {
  back_home: "Back to home",
  edit: "Edit details",
  renew: "Prepare a new text",
} as const;

/** The only component that can render Confirmed or Finalized, and only from the relay's view. */
export function Outcome(props: {
  command: CommandView;
  context: OutcomeContext;
  onPrimary: (action: "back_home" | "edit" | "renew") => void;
  busy?: boolean;
}) {
  const view = outcomeView(props.command, props.context);
  const failed = props.command.status === "failed";
  const primary = view.primary;
  return (
    <View style={{ gap: 12 }} accessibilityLiveRegion="polite">
      <RegistryMark mark={view.mark} />
      {view.title ? <Txt variant="section">{view.title}</Txt> : null}
      {failed ? (
        <ErrorBlock why={view.refusal}>{view.lines.join(" ")}</ErrorBlock>
      ) : (
        view.lines.map((line) => (
          <Txt key={line} style={{ fontSize: 14 }}>
            {line}
          </Txt>
        ))
      )}
      {view.after ? (
        <Txt variant="small" tone="ink2">
          {view.after}
        </Txt>
      ) : null}
      {view.transaction ? <TxLink {...view.transaction} /> : null}
      {primary ? (
        <Button
          label={PRIMARY_LABEL[primary]}
          kind={primary === "back_home" ? "quiet" : "primary"}
          disabled={props.busy}
          onPress={() => props.onPrimary(primary)}
        />
      ) : null}
    </View>
  );
}
