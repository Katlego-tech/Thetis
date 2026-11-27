import type { ReactNode } from "react";
import { View } from "react-native";
import { usePalette } from "../theme";
import { Txt } from "./Txt";

/** A plain note with an ink edge. */
export function Note(props: { children: ReactNode; title?: string }) {
  const palette = usePalette();
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        borderLeftWidth: 2,
        borderLeftColor: palette.ink,
        paddingVertical: 6,
        paddingLeft: 12,
        gap: 4,
      }}
    >
      {props.title ? <Txt variant="label">{props.title}</Txt> : null}
      {typeof props.children === "string" ? (
        <Txt style={{ fontSize: 14 }}>{props.children}</Txt>
      ) : (
        props.children
      )}
    </View>
  );
}

/** A refusal or error, with an optional mono reason line beneath. */
export function ErrorBlock(props: { children: ReactNode; why?: string | null }) {
  const palette = usePalette();
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        borderLeftWidth: 2,
        borderLeftColor: palette.refuse,
        paddingVertical: 6,
        paddingLeft: 12,
        gap: 4,
      }}
    >
      {typeof props.children === "string" ? (
        <Txt tone="refuse" style={{ fontSize: 14 }}>
          {props.children}
        </Txt>
      ) : (
        props.children
      )}
      {props.why ? (
        <Txt variant="mono" tone="refuse">
          {props.why}
        </Txt>
      ) : null}
    </View>
  );
}
