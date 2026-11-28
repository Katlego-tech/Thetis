import { type ReactNode, useContext } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppContext } from "../context";
import { NAV_COPY } from "../copy";
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

/** The rail-dark bar: THETIS or Back, and the organisation, which is the switcher on a tab root. */
export function TopBar(props: {
  organisation?: string | null;
  onBack?: () => void;
  onSwitchOrganisation?: () => void;
}) {
  const palette = usePalette();
  // The gates draw the bar before the app's context exists; there nothing is ever busy.
  const busy = useContext(AppContext)?.busy ?? false;
  const organisation = props.organisation;
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
          accessibilityHint={busy ? NAV_COPY.busyHint : undefined}
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={props.onBack}
          style={{ minHeight: 48, justifyContent: "center" }}
        >
          <Txt
            tone="railInk"
            style={{
              fontSize: 14,
              color: busy ? "#6E777B" : "#FFFFFF",
              textDecorationLine: busy ? "none" : "underline",
            }}
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
      {organisation && props.onSwitchOrganisation ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={NAV_COPY.switchLabel.replace("{org}", () => organisation)}
          accessibilityHint={busy ? NAV_COPY.busyHint : undefined}
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={props.onSwitchOrganisation}
          style={{
            minHeight: 48,
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            flexShrink: 1,
            maxWidth: "62%",
          }}
        >
          <Txt
            tone="railInk"
            style={{ fontSize: 13, flexShrink: 1, color: busy ? "#6E777B" : undefined }}
          >
            {organisation}
          </Txt>
          <Txt tone="railInk" style={{ fontSize: 12, color: busy ? "#6E777B" : undefined }}>
            {"\u25BE"}
          </Txt>
        </Pressable>
      ) : organisation ? (
        <Txt tone="railInk" style={{ fontSize: 13, flexShrink: 1 }}>
          {organisation}
        </Txt>
      ) : null}
    </View>
  );
}

/**
 * Banner, top bar, a scrolling body, a fixed footer and, on a tab root, the tab bar, all above the
 * system navigation: the bottom safe area sits below the last of them.
 */
export function Frame(props: {
  children: ReactNode;
  footer?: ReactNode;
  organisation?: string | null;
  onBack?: () => void;
  onSwitchOrganisation?: () => void;
  tabBar?: ReactNode;
}) {
  const palette = usePalette();
  const footer = props.footer ? (
    <View
      style={{
        borderTopWidth: 1,
        borderTopColor: palette.rule,
        backgroundColor: palette.sheet,
        paddingTop: 12,
        paddingHorizontal: 16,
        paddingBottom: props.tabBar ? 12 : 16,
        gap: 8,
      }}
    >
      {props.footer}
    </View>
  ) : null;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.banner }} edges={["top"]}>
      <TestBanner />
      <TopBar
        organisation={props.organisation}
        onBack={props.onBack}
        onSwitchOrganisation={props.onSwitchOrganisation}
      />
      <ScrollView
        style={{ flex: 1, backgroundColor: palette.paper }}
        contentContainerStyle={{ padding: 16, gap: 16 }}
        keyboardShouldPersistTaps="handled"
      >
        {props.children}
      </ScrollView>
      {props.tabBar ? (
        <>
          {footer}
          <SafeAreaView edges={["bottom"]} style={{ backgroundColor: palette.sheet }}>
            {props.tabBar}
          </SafeAreaView>
        </>
      ) : footer ? (
        <SafeAreaView edges={["bottom"]} style={{ backgroundColor: palette.sheet }}>
          {footer}
        </SafeAreaView>
      ) : (
        <SafeAreaView edges={["bottom"]} style={{ backgroundColor: palette.paper }} />
      )}
    </SafeAreaView>
  );
}
