"use client";

import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useRouter } from "next/navigation";
import {
  createContext,
  type JSX,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAccessSession } from "@/components/access/use-access-session";
import { apiGet, apiPost } from "@/lib/api";
import { normaliseId, resolveNavigate, VOICE_COPY, type VoiceTargets } from "@/lib/voice";

// voice.md §5.1: one voice session per organisation workspace. Talk asks for the microphone, then a
// fresh conversation token from the Thetis API, then starts the ElevenLabs session. Every session
// start has a generation; a callback or tool call from an older generation is dropped.

export type VoiceState =
  | { phase: "idle" }
  | { phase: "connecting"; attempt: 1 | 2 }
  | { phase: "live"; speaking: boolean; notice: string | null }
  | { phase: "unavailable"; cause: "service" | "dropped" | "microphone" };

export interface VoiceValue {
  state: VoiceState;
  talk: () => void;
  end: () => void;
  setTargets: (targets: VoiceTargets) => void;
}

const outside: VoiceValue = {
  state: { phase: "unavailable", cause: "service" },
  talk: () => {},
  end: () => {},
  setTargets: () => {},
};

const VoiceContext = createContext<VoiceValue>(outside);

/** Outside a VoiceProvider: { state: { phase: "unavailable", cause: "service" }, no-op functions }. */
export function useVoice(): VoiceValue {
  return useContext(VoiceContext);
}

type SessionData = { conversationToken: string; conversationId: string; agentId: string };

/** A tool call's parameters; anything that is not an object reads as {} and is refused. */
function argumentsOf(parameters: unknown): Record<string, unknown> {
  return typeof parameters === "object" && parameters !== null
    ? (parameters as Record<string, unknown>)
    : {};
}

async function microphoneGranted(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return true;
  } catch {
    return false;
  }
}

function VoiceSession({
  organisationId,
  children,
}: {
  organisationId: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const session = useAccessSession();
  const conversation = useConversation();
  const [state, setStateValue] = useState<VoiceState>({ phase: "idle" });
  const stateRef = useRef<VoiceState>(state);
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = session?.access_token ?? null;
  const targetsRef = useRef<VoiceTargets>({ organisationId, lots: [], releases: [] });
  const generation = useRef(0);
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const routerRef = useRef(router);
  routerRef.current = router;

  const setState = useCallback((next: VoiceState) => {
    stateRef.current = next;
    setStateValue(next);
  }, []);

  /** Ends the current generation: every later callback or tool result of it is dropped. */
  const retire = useCallback(() => {
    generation.current += 1;
  }, []);

  const start = useCallback(
    async (id: number, attempt: 1 | 2) => {
      const current = () => id === generation.current;
      setState({ phase: "connecting", attempt });
      const token = tokenRef.current;
      if (!token) {
        retire();
        setState({ phase: "unavailable", cause: "service" });
        return;
      }
      // A fresh token on every attempt: one is never reused (§5.1).
      const issued = await apiPost<SessionData>(
        "/v1/conversations/session",
        undefined,
        token,
      ).catch(() => null);
      if (!current()) return;
      if (!issued?.ok) {
        retire();
        setState({ phase: "unavailable", cause: "service" });
        return;
      }

      const navigate_to = (parameters?: Record<string, unknown>) => {
        const now = stateRef.current;
        if (!current() || now.phase !== "live") return undefined;
        const { result, href } = resolveNavigate(argumentsOf(parameters), targetsRef.current);
        setState({ ...now, notice: result.ok ? null : result.message });
        if (result.ok && href) routerRef.current.push(href);
        return JSON.stringify(result);
      };
      const get_lot_evidence = async (parameters?: Record<string, unknown>) => {
        const now = stateRef.current;
        if (!current() || now.phase !== "live") return undefined;
        setState({ ...now, notice: null });
        const lotId = normaliseId(argumentsOf(parameters).lot_id);
        if (lotId === null)
          return JSON.stringify({
            ok: false,
            reason: "BAD_ID",
            message: VOICE_COPY.refusals.BAD_ID,
          });
        const bearer = tokenRef.current;
        const found = bearer
          ? await apiGet(`/v1/voice/lots/${encodeURIComponent(lotId)}/evidence`, bearer).catch(
              () => ({ ok: false as const, code: "NETWORK" as const, status: 0 }),
            )
          : { ok: false as const, code: "NOT_AUTHENTICATED" as const, status: 401 };
        // A result that arrives after its session ended is dropped (§5.1).
        if (!current()) return undefined;
        return JSON.stringify(found.ok ? found.data : { ok: false, reason: found.code });
      };

      // The SDK's own connection status, so an error ends only a closed connection (review fold 2).
      let closed = false;
      conversationRef.current.startSession({
        conversationToken: issued.data.conversationToken,
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
          const now = stateRef.current;
          if (now.phase === "connecting") return; // onError decides a failed start
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

  const end = useCallback(() => {
    const now = stateRef.current.phase;
    if (now !== "live" && now !== "connecting") return;
    retire();
    conversationRef.current.endSession();
    setState({ phase: "idle" });
  }, [retire, setState]);

  const setTargets = useCallback((targets: VoiceTargets) => {
    targetsRef.current = targets;
  }, []);

  // The session ends with the provider: switching organisation, /account or signing out (§5.1).
  useEffect(
    () => () => {
      generation.current += 1;
      const now = stateRef.current.phase;
      if (now === "live" || now === "connecting") conversationRef.current.endSession();
    },
    [],
  );

  const value = useMemo(() => ({ state, talk, end, setTargets }), [state, talk, end, setTargets]);
  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}

export function VoiceProvider(props: { organisationId: string; children: ReactNode }): JSX.Element {
  return (
    <ConversationProvider>
      <VoiceSession organisationId={props.organisationId}>{props.children}</VoiceSession>
    </ConversationProvider>
  );
}
