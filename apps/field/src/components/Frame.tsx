import type { ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { font, usePalette } from "../theme";
import { Txt } from "./Txt";

export function TestBanner() {
  const palette = usePalette();
  return (
    <View
      style={{
        height: 32,
        justifyContent: "center",
        paddingHorizontal: 16,
        backgroundColor: palette.banner,
      }}
    >
      <Txt variant="caption" tone="bannerInk">
        Test network only. Synthetic data.
      </Txt>
    </View>
  );
}

export function TopBar(props: { organisation?: string | null; onBack?: () => void }) {
  const palette = usePalette();
  return (
    <View
      style={{
        height: 56,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        paddingHorizontal: 16,
        backgroundColor: palette.rail,
      }}
    >
      {props.onBack ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={props.onBack}
          style={{ minHeight: 48, justifyContent: "center" }}
        >
          <Txt
            tone="railInk"
            style={{ fontSize: 14, color: "#FFFFFF", textDecorationLine: "underline" }}
          >
            Back
          </Txt>
        </Pressable>
      ) : (
        <Txt
          style={{
            fontFamily: font.semibold,
            fontSize: 18,
            lineHeight: 20,
            letterSpacing: 0.4,
            color: "#FFFFFF",
          }}
        >
          THETIS
        </Txt>
      )}
      {props.organisation ? (
        <Txt tone="railInk" style={{ fontSize: 13, flexShrink: 1 }}>
          {props.organisation}
        </Txt>
      ) : null}
    </View>
  );
}

/** Banner, top bar, a scrolling body and a fixed footer above the system navigation. */
export function Frame(props: {
  children: ReactNode;
  footer?: ReactNode;
  organisation?: string | null;
  onBack?: () => void;
}) {
  const palette = usePalette();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.banner }} edges={["top"]}>
      <TestBanner />
      <TopBar organisation={props.organisation} onBack={props.onBack} />
      <ScrollView
        style={{ flex: 1, backgroundColor: palette.paper }}
        contentContainerStyle={{ padding: 16, gap: 16 }}
        keyboardShouldPersistTaps="handled"
      >
        {props.children}
      </ScrollView>
      {props.footer ? (
        <SafeAreaView edges={["bottom"]} style={{ backgroundColor: palette.sheet }}>
          <View
            style={{
              borderTopWidth: 1,
              borderTopColor: palette.rule,
              paddingTop: 12,
              paddingHorizontal: 16,
              paddingBottom: 16,
              gap: 8,
            }}
          >
            {props.footer}
          </View>
        </SafeAreaView>
      ) : (
        <SafeAreaView edges={["bottom"]} style={{ backgroundColor: palette.paper }} />
      )}
    </SafeAreaView>
  );
}
