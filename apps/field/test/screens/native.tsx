// Stand-ins for the native modules, so a whole screen renders under jsdom with React DOM. Each
// primitive becomes the closest DOM element and keeps the props a test reads: accessibility
// labels, disabled state and the press, change, blur and submit handlers.
import type { ReactNode } from "react";
import { vi } from "vitest";

type Props = Record<string, unknown> & { children?: ReactNode };

const appStateListeners = new Set<(state: string) => void>();

/** Fires an AppState change, as Android does when the app returns to the foreground. */
export function emitAppState(state: "active" | "background"): void {
  for (const listener of [...appStateListeners]) listener(state);
}

function Box(props: Props) {
  const label = props.accessibilityLabel as string | undefined;
  return label ? (
    <section aria-label={label}>{props.children}</section>
  ) : (
    <div>{props.children}</div>
  );
}

export const reactNative = {
  View: Box,
  ScrollView: Box,
  Text: (props: Props) => <span>{props.children}</span>,
  Pressable: (props: Props) => (
    <button
      type="button"
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
  BackHandler: { addEventListener: () => ({ remove: () => {} }) },
  Linking: { openURL: vi.fn(async () => true) },
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
