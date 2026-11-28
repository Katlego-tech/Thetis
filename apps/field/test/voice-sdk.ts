// A stand-in for @elevenlabs/react-native, installed for every test file by test/setup.ts, so no
// LiveKit or WebRTC native module is ever loaded. Nothing connects, speaks or costs credits: a test
// drives the session by calling the options the provider passed to startSession.
import type { ReactNode } from "react";

export interface StartOptions {
  conversationToken?: string;
  connectionType?: string;
  clientTools?: Record<string, (parameters?: unknown) => unknown>;
  onConnect?: (props: { conversationId: string }) => void;
  onDisconnect?: (details: { reason: string; message?: string }) => void;
  onError?: (message: string, context?: unknown) => void;
  onModeChange?: (props: { mode: "speaking" | "listening" }) => void;
  onStatusChange?: (props: { status: string }) => void;
}

export const voiceSdk = {
  starts: [] as StartOptions[],
  ends: 0,
  reset() {
    this.starts = [];
    this.ends = 0;
  },
  /** The options of the latest startSession call. */
  last(): StartOptions {
    const options = this.starts[this.starts.length - 1];
    if (!options) throw new Error("startSession was not called");
    return options;
  },
};

export const elevenLabs = {
  ConversationProvider: (props: { children?: ReactNode }) => props.children,
  useConversation: () => ({
    startSession: (options: StartOptions) => {
      voiceSdk.starts.push(options);
    },
    endSession: () => {
      voiceSdk.ends += 1;
    },
  }),
};
