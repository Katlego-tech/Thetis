// voice.md §5.1, field placement: Talk is the last item of the bottom bar, after the tabs, and the
// strip above the tab bar says what voice is doing. Neither uses the oxide "you are here" edge.
import { Pressable, View } from "react-native";
import { Txt } from "../components/Txt";
import { useApp } from "../context";
import { NAV_COPY, VOICE_COPY } from "../copy";
import { usePalette } from "../theme";
import { useVoice } from "./VoiceProvider";

export function TalkButton() {
  const palette = usePalette();
  const { busy } = useApp();
  const { state, talk, end } = useVoice();
  const live = state.phase === "live";
  const connecting = state.phase === "connecting";
  // End stays enabled while busy: ending voice never touches the wallet.
  const blocked = busy && (state.phase === "idle" || state.phase === "unavailable");
  const disabled = connecting || blocked;
  const label = live ? VOICE_COPY.end : connecting ? VOICE_COPY.connecting : VOICE_COPY.talk;
  const name = live
    ? VOICE_COPY.names.end
    : connecting
      ? VOICE_COPY.names.connecting
      : state.phase === "unavailable"
        ? VOICE_COPY.names.retry
        : VOICE_COPY.names.talk;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={name}
      accessibilityHint={blocked ? NAV_COPY.busyHint : undefined}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={live ? end : talk}
      style={{
        flex: 1,
        minHeight: 56,
        alignItems: "center",
        justifyContent: "center",
        borderLeftWidth: 1,
        borderLeftColor: palette.rule,
      }}
    >
      <Txt
        variant="label"
        style={{ color: disabled ? palette.rule : live ? palette.ink : palette.ink2 }}
      >
        {label}
      </Txt>
    </Pressable>
  );
}

function statusLines(state: ReturnType<typeof useVoice>["state"]): string[] {
  switch (state.phase) {
    case "idle":
      return [];
    case "connecting":
      return [state.attempt === 1 ? VOICE_COPY.status.starting : VOICE_COPY.status.newSession];
    case "live":
      return [
        state.notice ?? (state.speaking ? VOICE_COPY.status.speaking : VOICE_COPY.status.listening),
      ];
    case "unavailable":
      return state.cause === "microphone"
        ? [VOICE_COPY.status.unavailable, VOICE_COPY.status.microphone]
        : [VOICE_COPY.status.unavailable];
  }
}

export function VoiceStrip() {
  const palette = usePalette();
  const { state } = useVoice();
  const lines = statusLines(state);
  if (lines.length === 0) return null;
  return (
    <View
      style={{
        backgroundColor: palette.sheet,
        borderTopWidth: 1,
        borderTopColor: palette.rule,
        paddingVertical: 12,
        paddingHorizontal: 16,
      }}
    >
      <View
        style={{
          borderLeftWidth: 2,
          borderLeftColor: state.phase === "unavailable" ? palette.refuse : palette.ink,
          paddingLeft: 12,
          gap: 4,
        }}
      >
        {lines.map((line) => (
          <Txt key={line} live>
            {line}
          </Txt>
        ))}
      </View>
    </View>
  );
}
