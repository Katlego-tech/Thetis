import type { ReactNode } from "react";
import { Text, type TextStyle } from "react-native";
import { type Palette, type, usePalette } from "../theme";

export type TxtVariant = keyof typeof type;

/** Every visible string goes through here, so type and colour come from the tokens. */
export function Txt(props: {
  children: ReactNode;
  variant?: Exclude<TxtVariant, "tabular">;
  tone?: keyof Pick<
    Palette,
    "ink" | "ink2" | "refuse" | "act" | "railInk" | "bannerInk" | "actInk"
  >;
  style?: TextStyle;
  selectable?: boolean;
  live?: boolean;
}) {
  const palette = usePalette();
  return (
    <Text
      selectable={props.selectable}
      accessibilityLiveRegion={props.live ? "polite" : undefined}
      style={[
        type[props.variant ?? "body"],
        type.tabular,
        { color: palette[props.tone ?? "ink"] },
        props.style,
      ]}
    >
      {props.children}
    </Text>
  );
}
