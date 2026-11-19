import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

// Server only: the API key never reaches a browser or a phone. The SDK reads ELEVENLABS_API_KEY
// from the environment; locally, start Node with `--env-file=.env`, deployed it comes from
// Secrets Manager (docs/contracts.md §3, POST /v1/conversations/session).
export function elevenLabsClient(): ElevenLabsClient {
  if (!process.env.ELEVENLABS_API_KEY) {
    throw new Error("ELEVENLABS_API_KEY is not set (start Node with --env-file=.env)");
  }
  return new ElevenLabsClient();
}
