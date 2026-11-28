import type { ElevenLabs } from "@elevenlabs/elevenlabs-js";

type CreateAgent = ElevenLabs.conversationalAi.BodyCreateAgentV1ConvaiAgentsCreatePost;
type Prompt = NonNullable<NonNullable<CreateAgent["conversationConfig"]["agent"]>["prompt"]>;
type Tool = NonNullable<Prompt["tools"]>[number];

// The Thetis navigator agent, as code (docs/design/voice.md §3). Created or updated by
// `pnpm --filter @thetis/api voice:agent`; nothing here is a secret.

export const AGENT_NAME = "Thetis navigator";
export const SCREENS = ["queue", "exceptions", "lot", "release", "account"] as const;
// The tool schema can only describe this to the model; the web and Android clients enforce it
// and answer BAD_ID (docs/design/voice.md §3).
export const ID_PATTERN = "^[A-Z0-9-]{1,16}$";

const PROMPT = `# Personality
You are the Thetis navigator: brief, exact and plain-spoken.

# Environment
You help lenders, exporters, custodians and terminal staff inside Thetis, a system that tracks
custody, collateral locks and payment-confirmed releases of mineral lots. The person is signed in;
you see only what your tools return for them.

# Goal
1. Open the screen the person asks for with navigate_to.
2. Tell them which evidence is recorded for a lot with get_lot_evidence, then offer to open the lot.

# Rules
- You cannot sign, approve, attest, release, pledge or change anything. When asked to, say that
  this happens on the screen and offer to open it. This step is important.
- Report only what a tool returned. Never invent quantities, money, parties, dates or chain state.
  If a tool returns nothing or fails, say so plainly.
- If a lookup is refused, say you can't see that lot's evidence and offer to open the lot screen.
- If navigate_to returns ok false, say its message.
- Lot and release identifiers look like CR-0001. Ask the person to spell one if you are unsure.
- Keep answers to one or two sentences.`;

const idProperty = (description: string) => ({
  type: "string" as const,
  description: `${description} Uppercase letters, digits and hyphens, like CR-0001.`,
});

export const clientTools: Tool[] = [
  {
    type: "client",
    name: "navigate_to",
    description: "Open a Thetis screen for the person. Only these screens exist.",
    expectsResponse: true,
    responseTimeoutSecs: 10,
    parameters: {
      type: "object",
      required: ["screen"],
      properties: {
        screen: {
          type: "string",
          description: "Which screen to open.",
          enum: [...SCREENS],
        },
        id: idProperty("The lot or release identifier; required for lot and release."),
      },
    },
  },
  {
    type: "client",
    name: "get_lot_evidence",
    description:
      "Which evidence is recorded for one lot, as the signed-in person is allowed to see it.",
    expectsResponse: true,
    responseTimeoutSecs: 10,
    parameters: {
      type: "object",
      required: ["lot_id"],
      properties: { lot_id: idProperty("The lot identifier.") },
    },
  },
];

export function agentConfig(voiceId: string, allowedHost: string): CreateAgent {
  return {
    name: AGENT_NAME,
    conversationConfig: {
      agent: {
        firstMessage:
          "I can open screens and tell you what evidence is recorded for a lot. What do you need?",
        language: "en",
        prompt: {
          prompt: PROMPT,
          llm: "gemini-3.5-flash",
          temperature: 0.2,
          tools: clientTools,
          builtInTools: {
            endCall: { type: "system", name: "end_call", params: { systemToolType: "end_call" } },
          },
        },
      },
      tts: { voiceId },
    },
    platformSettings: {
      auth: { enableAuth: true, allowlist: [{ hostname: allowedHost }] },
      guardrails: {
        version: "1",
        focus: { isEnabled: true },
        promptInjection: { isEnabled: true },
      },
    },
  };
}
