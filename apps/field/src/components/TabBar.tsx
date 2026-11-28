// The bottom tab bar on tab roots (navigation.md §4.2): text labels of equal width, the current
// tab marked by a 2 dp oxide top edge. Disabled while a wallet or relay call is in flight.
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { NAV_COPY } from "../copy";
import { type Tab, tabLabels } from "../nav";
import { usePalette } from "../theme";
import { Txt } from "./Txt";

export function TabBar(props: {
  tabs: Tab[];
  current: Tab;
  disabled: boolean;
  onSelect: (tab: Tab) => void;
  /** After the tablist, the same width as a tab: Talk on the phone (voice.md §5.1). */
  trailing?: ReactNode;
}) {
  const palette = usePalette();
  return (
    <View
      style={{
        flexDirection: "row",
        backgroundColor: palette.sheet,
        borderTopWidth: 1,
        borderTopColor: palette.rule,
      }}
    >
      <View accessibilityRole="tablist" style={{ flex: props.tabs.length, flexDirection: "row" }}>
        {props.tabs.map((tab) => {
          const selected = tab === props.current;
          return (
            <Pressable
              key={tab}
              accessibilityRole="tab"
              accessibilityLabel={tabLabels[tab]}
              accessibilityHint={props.disabled ? NAV_COPY.busyHint : undefined}
              accessibilityState={{ selected, disabled: props.disabled }}
              disabled={props.disabled}
              onPress={() => props.onSelect(tab)}
              style={{
                flex: 1,
                minHeight: 56,
                alignItems: "center",
                justifyContent: "center",
                borderTopWidth: 2,
                borderTopColor: selected ? palette.act : "transparent",
                marginTop: -1,
              }}
            >
              <Txt
                variant="label"
                style={{
                  color: props.disabled
                    ? selected
                      ? palette.ink2
                      : palette.rule
                    : selected
                      ? palette.ink
                      : palette.ink2,
                }}
              >
                {tabLabels[tab]}
              </Txt>
            </Pressable>
          );
        })}
      </View>
      {props.trailing}
    </View>
  );
}
