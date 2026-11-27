import { View } from "react-native";
import type { RegistryMark as Mark } from "../marks";
import { radius, usePalette } from "../theme";
import { Txt } from "./Txt";

/** A registry state, always as text; the border carries the weight, never colour alone. */
export function RegistryMark(props: { mark: Mark }) {
  const palette = usePalette();
  const refused = props.mark === "Failed" || props.mark === "Outcome unknown";
  const solid = props.mark === "Confirmed" || props.mark === "Finalized" || props.mark === "Failed";
  const strong = props.mark === "Finalized";
  const borderColor = refused
    ? palette.refuse
    : props.mark === "Draft" || props.mark === "Not on chain"
      ? palette.ink2
      : palette.ink;
  return (
    <View
      accessibilityLabel={props.mark}
      style={{
        alignSelf: "flex-start",
        borderWidth: 1,
        borderStyle: solid ? "solid" : "dashed",
        borderColor,
        borderRadius: radius,
        backgroundColor: palette.sheet,
        paddingHorizontal: 8,
        paddingVertical: 2,
      }}
    >
      <Txt
        variant={strong ? "label" : "caption"}
        tone={refused ? "refuse" : "ink"}
        style={{ fontSize: 12, lineHeight: 18 }}
      >
        {props.mark}
      </Txt>
    </View>
  );
}

/** Custody states keep their muted prefix ("Custody Stored"). */
export function CustodyMark(props: { state: string }) {
  const palette = usePalette();
  return (
    <View
      accessibilityLabel={`Custody ${props.state}`}
      style={{
        alignSelf: "flex-start",
        flexDirection: "row",
        gap: 6,
        borderWidth: 1,
        borderStyle: "dashed",
        borderColor: palette.ink2,
        borderRadius: radius,
        backgroundColor: palette.sheet,
        paddingHorizontal: 8,
        paddingVertical: 2,
      }}
    >
      <Txt variant="caption" tone="ink2" style={{ lineHeight: 18 }}>
        Custody
      </Txt>
      <Txt variant="caption" style={{ lineHeight: 18 }}>
        {props.state}
      </Txt>
    </View>
  );
}
