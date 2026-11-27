import { Pressable } from "react-native";
import { radius, usePalette } from "../theme";
import { Txt } from "./Txt";

/** Primary (oxide), quiet (outlined) or off. Primary actions are full width and 52 high. */
export function Button(props: {
  label: string;
  onPress: () => void;
  kind?: "primary" | "quiet";
  disabled?: boolean;
  inline?: boolean;
  accessibilityHint?: string;
}) {
  const palette = usePalette();
  const quiet = props.kind === "quiet";
  const off = props.disabled === true;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{ disabled: off }}
      disabled={off}
      onPress={props.onPress}
      style={{
        alignSelf: props.inline ? "flex-start" : "stretch",
        minHeight: props.inline ? 48 : 52,
        justifyContent: "center",
        alignItems: "center",
        paddingHorizontal: 14,
        borderRadius: radius,
        borderWidth: quiet && !off ? 1 : 0,
        borderColor: palette.rule,
        backgroundColor: off ? palette.hair : quiet ? palette.sheet : palette.act,
      }}
    >
      <Txt
        variant="strong"
        tone={off ? "ink2" : quiet ? "ink" : "actInk"}
        style={props.inline ? { fontSize: 14 } : undefined}
      >
        {props.label}
      </Txt>
    </Pressable>
  );
}

export function TextLink(props: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      style={{ minHeight: 48, justifyContent: "center", alignSelf: "flex-start" }}
    >
      <Txt
        variant="body"
        tone={props.disabled ? "ink2" : "act"}
        style={{ fontSize: 14, textDecorationLine: props.disabled ? "none" : "underline" }}
      >
        {props.label}
      </Txt>
    </Pressable>
  );
}
