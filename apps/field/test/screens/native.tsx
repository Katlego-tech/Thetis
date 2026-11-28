// Stand-ins for the native modules, so a whole screen renders under jsdom with React DOM. Each
// primitive becomes the closest DOM element and keeps the props a test reads: accessibility
// labels, disabled state and the press, change, blur and submit handlers.
import type { ReactNode } from "react";
import { vi } from "vitest";

type Props = Record<string, unknown> & { children?: ReactNode };

const appStateListeners = new Set<(state: string) => void>();
const backListeners: (() => boolean)[] = [];

/** What the microphone permission prompt answers; a test sets it before Talk. */
export const microphone = { answer: "granted" as "granted" | "denied" | "never_ask_again" };

/** Presses Android Back: the newest listener first, as React Native does. True when consumed. */
export function pressBack(): boolean {
  for (const listener of [...backListeners].reverse()) if (listener()) return true;
  return false;
}

/** Fires an AppState change, as Android does when the app returns to the foreground. */
export function emitAppState(state: "active" | "background"): void {
  for (const listener of [...appStateListeners]) listener(state);
}

function Box(props: Props) {
  const label = props.accessibilityLabel as string | undefined;
  if (props.accessibilityRole === "tablist")
    return (
      <div role="tablist" aria-label={label}>
        {props.children}
      </div>
    );
  return label ? (
    <section aria-label={label}>{props.children}</section>
  ) : (
    <div>{props.children}</div>
  );
}

/** A pressable tab keeps its role and selected state, so a test can find it as a tab. */
function tabRole(props: Props): Record<string, unknown> {
  if (props.accessibilityRole !== "tab") return {};
  const state = props.accessibilityState as { selected?: boolean } | undefined;
  return { role: "tab", "aria-selected": state?.selected === true };
}

export const reactNative = {
  View: Box,
  ScrollView: Box,
  Text: (props: Props) => <span>{props.children}</span>,
  Pressable: (props: Props) => (
    <button
      type="button"
      {...tabRole(props)}
      aria-description={props.accessibilityHint as string | undefined}
      aria-label={props.accessibilityLabel as string | undefined}
      disabled={props.disabled === true}
      onClick={props.onPress as (() => void) | undefined}
    >
      {props.children}
    </button>
  ),
  TextInput: (props: Props) => (
    <input
      aria-label={props.accessibilityLabel as string | undefined}
      value={props.value as string}
      readOnly={props.editable === false}
      onChange={(event) => (props.onChangeText as (t: string) => void)?.(event.target.value)}
      onBlur={props.onBlur as (() => void) | undefined}
      onKeyDown={(event) => {
        if (event.key === "Enter") (props.onSubmitEditing as (() => void) | undefined)?.();
      }}
    />
  ),
  Modal: (props: Props) => (props.visible ? <div>{props.children}</div> : null),
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  useColorScheme: () => "light",
  AppState: {
    currentState: "active",
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appStateListeners.add(listener);
      return { remove: () => appStateListeners.delete(listener) };
    },
  },
  BackHandler: {
    addEventListener: (_event: string, listener: () => boolean) => {
      backListeners.push(listener);
      return {
        remove: () => {
          const at = backListeners.indexOf(listener);
          if (at >= 0) backListeners.splice(at, 1);
        },
      };
    },
  },
  Linking: { openURL: vi.fn(async () => true) },
  PermissionsAndroid: {
    PERMISSIONS: { RECORD_AUDIO: "android.permission.RECORD_AUDIO" },
    RESULTS: { GRANTED: "granted", DENIED: "denied", NEVER_ASK_AGAIN: "never_ask_again" },
    request: async () => microphone.answer,
  },
  Platform: { OS: "android", select: (options: Record<string, unknown>) => options.android },
};

export const safeArea = {
  SafeAreaView: Box,
  SafeAreaProvider: Box,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
};

/** An in-memory AsyncStorage. */
export function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => void values.set(key, value),
    removeItem: async (key: string) => void values.delete(key),
  };
}
