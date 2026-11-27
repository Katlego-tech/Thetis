import { Pressable, TextInput, type TextInputProps, View } from "react-native";
import { font, radius, usePalette } from "../theme";
import { Txt } from "./Txt";

/** A labelled input: help under it, or the field error in refuse red. */
export function Field(
  props: {
    label: string;
    value: string;
    onChangeText: (text: string) => void;
    help?: string | null;
    error?: string | null;
    note?: string | null;
    mono?: boolean;
    locked?: boolean;
  } & Pick<
    TextInputProps,
    | "keyboardType"
    | "autoCapitalize"
    | "autoComplete"
    | "textContentType"
    | "inputMode"
    | "maxLength"
    | "onBlur"
  >,
) {
  const palette = usePalette();
  const { label, help, error, note, mono, locked, ...input } = props;
  return (
    <View style={{ gap: 6 }}>
      <Txt variant="label">{label}</Txt>
      <TextInput
        {...input}
        accessibilityLabel={label}
        editable={!locked}
        autoCorrect={false}
        placeholderTextColor={palette.ink2}
        style={{
          minHeight: 48,
          borderWidth: 1,
          borderRadius: radius,
          borderColor: error ? palette.refuse : locked ? palette.rule : palette.ink2,
          backgroundColor: locked ? palette.paper : palette.sheet,
          color: locked ? palette.ink2 : palette.ink,
          paddingHorizontal: 12,
          paddingVertical: 12,
          fontFamily: mono ? font.mono : font.regular,
          fontSize: 15,
        }}
      />
      {error ? (
        <Txt variant="small" tone="refuse" live>
          {error}
        </Txt>
      ) : help ? (
        <Txt variant="small" tone="ink2">
          {help}
        </Txt>
      ) : null}
      {note ? (
        <Txt variant="small" tone="ink2" live>
          {note}
        </Txt>
      ) : null}
    </View>
  );
}

/** A labelled control that opens the Picker sheet. */
export function SelectField(props: {
  label: string;
  value: string | null;
  detail?: string | null;
  help?: string | null;
  error?: string | null;
  mono?: boolean;
  onPress?: () => void;
  locked?: boolean;
  trailing?: string | null;
}) {
  const palette = usePalette();
  return (
    <View style={{ gap: 6 }}>
      <Txt variant="label">{props.label}</Txt>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.label}: ${props.value ?? "Choose"}`}
        onPress={props.onPress}
        disabled={props.locked || !props.onPress}
        style={{
          minHeight: 48,
          borderWidth: 1,
          borderRadius: radius,
          borderColor: props.error ? palette.refuse : props.locked ? palette.rule : palette.ink2,
          backgroundColor: props.locked ? palette.paper : palette.sheet,
          paddingHorizontal: 12,
          paddingVertical: 12,
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Txt
          variant={props.mono ? "mono" : "body"}
          tone={props.value ? "ink" : "ink2"}
          style={props.mono ? { fontSize: 15 } : undefined}
        >
          {props.value ?? "Choose"}
        </Txt>
        {props.trailing ? (
          <Txt variant="small" tone="ink2">
            {props.trailing}
          </Txt>
        ) : null}
      </Pressable>
      {props.error ? (
        <Txt variant="small" tone="refuse" live>
          {props.error}
        </Txt>
      ) : props.help ? (
        <Txt variant="small" tone="ink2">
          {props.help}
        </Txt>
      ) : null}
    </View>
  );
}
