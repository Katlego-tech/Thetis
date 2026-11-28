// voice.md §5.1, field: one voice session, held inside the app's context. Talk asks for the
// microphone, then a fresh conversation token from the Thetis API, then starts the ElevenLabs
// session over WebRTC. Every start has a generation; a callback or tool call from an older one is
// dropped. The session ends when a pushed screen opens, the app leaves the foreground, or the
// provider unmounts (SignedIn keys it by organisation, so a switch or sign-out ends it).
import { ConversationProvider, useConversation } from "@elevenlabs/react-native";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
// biome-ignore lint/correctness/useReactNativePlatformComponents: the field app builds for Android only (app.json platforms)
import { AppState, PermissionsAndroid } from "react-native";
import { ApiError, TIMEOUTS } from "../api/client";
import { useApp } from "../context";
import { VOICE_COPY } from "../copy";
import { record, string } from "../lib/shape";
import { normaliseId, resolveNavigate } from "./navigate";

export type VoiceState =
  | { phase: "idle" }
  | { phase: "connecting"; attempt: 1 | 2 }
  | { phase: "live"; speaking: boolean; notice: string | null }
  | { phase: "unavailable"; cause: "service" | "dropped" | "microphone" };

interface VoiceValue {
  state: VoiceState;
  talk: () => void;
  end: () => void;
}

const outside: VoiceValue = {
  state: { phase: "unavailable", cause: "service" },
  talk: () => {},
  end: () => {},
};

const VoiceContext = createContext<VoiceValue>(outside);

/** Outside a VoiceProvider: unavailable/service with no-op functions. */
export function useVoice(): VoiceValue {
  return useContext(VoiceContext);
}

/** A tool call's parameters; anything that is not a plain object reads as {} and is refused. */
function argumentsOf(parameters: unknown): Record<string, unknown> {
  return typeof parameters === "object" && parameters !== null && !Array.isArray(parameters)
    ? (parameters as Record<string, unknown>)
    : {};
}

async function microphoneGranted(): Promise<boolean> {
  try {
    const answer = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
    return answer === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
  }
}

function VoiceSession(props: { onTabRoot: boolean; children: ReactNode }) {
  const app = useApp();
  const conversation = useConversation();
  const [state, setStateValue] = useState<VoiceState>({ phase: "idle" });
  const stateRef = useRef<VoiceState>(state);
  const generation = useRef(0);
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const appRef = useRef(app);
  appRef.current = app;

  const setState = useCallback((next: VoiceState) => {
    stateRef.current = next;
    setStateValue(next);
  }, []);

  /** Ends the current generation: every later callback or tool result of it is dropped. */
  const retire = useCallback(() => {
    generation.current += 1;
  }, []);

  /** Ends a live or starting session by the platform rules: back to idle. */
  const stop = useCallback(() => {
    const now = stateRef.current.phase;
    if (now !== "live" && now !== "connecting") return;
    retire();
    conversationRef.current.endSession();
    setState({ phase: "idle" });
  }, [retire, setState]);

  const start = useCallback(
    async (id: number, attempt: 1 | 2) => {
      const current = () => id === generation.current;
      setState({ phase: "connecting", attempt });
      // A fresh token on every attempt: one is never reused (§5.1).
      const token = await appRef.current.client
        .request("POST", "/v1/conversations/session", {
          timeoutMs: TIMEOUTS.voice,
          parse: (data) => {
            const s = record(data, "session", ["conversationToken", "conversationId", "agentId"]);
            return { conversationToken: string(s.conversationToken, "conversationToken") };
          },
        })
        .catch(() => null);
      if (!current()) return;
      if (!token) {
        retire();
        setState({ phase: "unavailable", cause: "service" });
        return;
      }

      const showNotice = (notice: string | null) => {
        const now = stateRef.current;
        if (now.phase === "live") setState({ ...now, notice });
      };

      const navigate_to = (parameters?: unknown) => {
        if (!current() || stateRef.current.phase !== "live") return undefined;
        const { result, tab } = resolveNavigate(argumentsOf(parameters), appRef.current.busy);
        showNotice(result.ok ? null : result.message);
        // Nothing is queued: a refusal never navigates later (busy rule, §5.1).
        if (result.ok && tab) appRef.current.openTab(tab);
        return JSON.stringify(result);
      };

      const get_lot_evidence = async (parameters?: unknown) => {
        if (!current() || stateRef.current.phase !== "live") return undefined;
        const lotId = normaliseId(argumentsOf(parameters).lot_id);
        if (lotId === null) {
          showNotice(VOICE_COPY.refusals.BAD_ID);
          return JSON.stringify({
            ok: false,
            reason: "BAD_ID",
            message: VOICE_COPY.refusals.BAD_ID,
          });
        }
        showNotice(null);
        const answer = await appRef.current.client
          .request("GET", `/v1/voice/lots/${encodeURIComponent(lotId)}/evidence`, {
            timeoutMs: TIMEOUTS.voice,
            parse: (data) => data,
          })
          .then(
            (data) => data,
            (error: unknown) => ({
              ok: false,
              reason: error instanceof ApiError ? error.code : "NETWORK",
            }),
          );
        // A result that arrives after its session ended is dropped (§5.1).
        if (!current()) return undefined;
        return JSON.stringify(answer);
      };

      // The SDK's own connection status, so an error ends only a closed connection (review fold 2).
      let closed = false;
      conversationRef.current.startSession({
        conversationToken: token.conversationToken,
        connectionType: "webrtc",
        clientTools: { navigate_to, get_lot_evidence },
        onConnect: () => {
          if (!current()) return;
          setState({ phase: "live", speaking: false, notice: null });
        },
        onModeChange: ({ mode }) => {
          const now = stateRef.current;
          if (!current() || now.phase !== "live") return;
          setState({ ...now, speaking: mode === "speaking" });
        },
        onStatusChange: ({ status }) => {
          closed = status === "disconnected" || status === "disconnecting";
        },
        onError: () => {
          if (!current()) return;
          const now = stateRef.current;
          if (now.phase === "connecting" && now.attempt === 1) {
            // startSession rejected the first token: exactly one re-fetch.
            void start(id, 2);
            return;
          }
          // An error on an open connection leaves a live session live.
          if (now.phase === "live" && !closed) return;
          retire();
          conversationRef.current.endSession();
          setState({ phase: "unavailable", cause: now.phase === "live" ? "dropped" : "service" });
        },
        onDisconnect: (details) => {
          if (!current()) return;
          if (stateRef.current.phase === "connecting") return; // onError decides a failed start
          retire();
          setState(
            details.reason === "error"
              ? { phase: "unavailable", cause: "dropped" }
              : { phase: "idle" },
          );
        },
      });
    },
    [retire, setState],
  );

  const talk = useCallback(() => {
    const now = stateRef.current.phase;
    if (now !== "idle" && now !== "unavailable") return;
    // While a wallet is signing, no microphone prompt or WebRTC start competes with it.
    if (appRef.current.busy) return;
    retire();
    const id = generation.current;
    setState({ phase: "connecting", attempt: 1 });
    void (async () => {
      const granted = await microphoneGranted();
      if (id !== generation.current) return;
      if (!granted) {
        retire();
        setState({ phase: "unavailable", cause: "microphone" });
        return;
      }
      await start(id, 1);
    })();
  }, [retire, setState, start]);

  // A pushed screen has no End control, so opening one ends the session.
  useEffect(() => {
    if (!props.onTabRoot) stop();
  }, [props.onTabRoot, stop]);

  // Leaving the foreground ends it too: a live microphone only ever sits behind a visible End.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next !== "active") stop();
    });
    return () => subscription.remove();
  }, [stop]);

  // The session ends with the provider: organisation switch or sign-out.
  useEffect(
    () => () => {
      generation.current += 1;
      const now = stateRef.current.phase;
      if (now === "live" || now === "connecting") conversationRef.current.endSession();
    },
    [],
  );

  const value = useMemo(() => ({ state, talk, end: stop }), [state, talk, stop]);
  return <VoiceContext.Provider value={value}>{props.children}</VoiceContext.Provider>;
}

export function VoiceProvider(props: { onTabRoot: boolean; children: ReactNode }) {
  return (
    <ConversationProvider>
      <VoiceSession onTabRoot={props.onTabRoot}>{props.children}</VoiceSession>
    </ConversationProvider>
  );
}
