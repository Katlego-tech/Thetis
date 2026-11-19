import { checkIntentRole, parseCheck, parseIntent, parseOutcome, type Role } from "./lib/relay";

const BASE_URL = "http://127.0.0.1:8787";
const REQUEST_TIMEOUT_MS = 8_000;

export class RelayUnreachable extends Error {}

export interface SignatureSubmission {
  role: Role;
  address: string;
  messageSha256: string;
  signatureBase58: string;
}

async function request<T>(
  path: string,
  parse: (body: unknown, status: number) => T,
  init?: RequestInit,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
    }).catch((error: unknown) => {
      throw new RelayUnreachable(undefined, { cause: error });
    });
    if (path === "/outcome" && !response.ok) throw new Error(`/outcome HTTP ${response.status}`);
    // The relay can return a typed refusal in an HTTP error response.
    return parse(await response.json(), response.status);
  } finally {
    clearTimeout(timeout);
  }
}

export async function getIntent(role: Role) {
  const result = await request(`/intent?role=${role}`, parseIntent);
  if ("messageText" in result) checkIntentRole(result, role);
  return result;
}

export async function postSignature(body: SignatureSubmission) {
  return request("/signature", parseCheck, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function getOutcome() {
  return request("/outcome", parseOutcome);
}
