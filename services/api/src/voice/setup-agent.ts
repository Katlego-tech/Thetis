// Create or update the Thetis navigator agent, then prove a WebRTC conversation token can be
// issued for it. Run: pnpm --filter @thetis/api voice:agent
// Prints the agent id (not a secret); the key is read from ELEVENLABS_API_KEY and never printed.
import { elevenLabsClient } from "../elevenlabs.ts";
import { AGENT_NAME, agentConfig } from "./agent.ts";

const VOICE_ID = process.env.THETIS_VOICE_ID ?? "onwK4e9ZLuTAKqWW03F9"; // a stock ElevenLabs voice
const ALLOWED_HOST = process.env.THETIS_VOICE_HOST ?? "localhost:3100";

async function main() {
  const client = elevenLabsClient();
  const voice = await client.voices.get(VOICE_ID);
  console.log(`voice: ${voice.name} (${VOICE_ID})`);

  const config = agentConfig(VOICE_ID, ALLOWED_HOST);
  const existing = (
    await client.conversationalAi.agents.list({ search: AGENT_NAME, pageSize: 100 })
  ).agents.filter((agent) => agent.name === AGENT_NAME);
  if (existing.length > 1) {
    throw new Error(`${existing.length} agents are named "${AGENT_NAME}"; delete the extras first`);
  }

  let agentId: string;
  if (existing[0]) {
    agentId = existing[0].agentId;
    await client.conversationalAi.agents.update(agentId, config);
    console.log(`updated agent ${agentId}`);
  } else {
    agentId = (await client.conversationalAi.agents.create(config)).agentId;
    console.log(`created agent ${agentId}`);
  }

  const agent = await client.conversationalAi.agents.get(agentId);
  const tools = agent.conversationConfig.agent?.prompt?.tools ?? [];
  console.log(`tools: ${tools.map((tool) => ("name" in tool ? tool.name : tool.type)).join(", ")}`);
  console.log(`private: ${agent.platformSettings?.auth?.enableAuth === true}`);

  const token = await client.conversationalAi.conversations.getWebrtcToken({ agentId });
  console.log(
    `conversation token issued: ${token.token.length > 0} (conversation ${token.conversationId})`,
  );
  console.log(`\nELEVENLABS_AGENT_ID=${agentId}`);
  console.log("Add that line to .env yourself.");
}

main().catch((error: unknown) => {
  const status = (error as { statusCode?: number }).statusCode;
  const body = (error as { body?: unknown }).body;
  console.error(
    `failed${status ? ` (${status})` : ""}:`,
    JSON.stringify(body ?? String(error)).slice(0, 400),
  );
  process.exitCode = 1;
});
