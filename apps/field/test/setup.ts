// Every test file: the voice SDK is a stand-in, so its LiveKit and WebRTC native peers never load.
import { vi } from "vitest";

vi.mock("@elevenlabs/react-native", async () => (await import("./voice-sdk")).elevenLabs);
