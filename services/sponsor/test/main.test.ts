// The sponsor key read from Secrets Manager is not cached when the read fails (T064b.1 review
// S2). The key is a throwaway generated here.
import { randomBytes } from "node:crypto";
import { createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ answers: [] as ("fail" | string)[] }));

vi.mock("@aws-sdk/client-secrets-manager", () => ({
  GetSecretValueCommand: class {
    readonly input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  SecretsManagerClient: class {
    async send() {
      const next = state.answers.shift();
      if (next === undefined) throw new Error("the test queued no Secrets Manager answer");
      if (next === "fail") throw new Error("Secrets Manager did not answer");
      return { SecretString: next };
    }
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sponsor key", () => {
  it("a failed Secrets Manager read is read again on the next invocation, then kept", async () => {
    vi.stubEnv("SPONSOR_KEY_SECRET_ARN", "arn:aws:secretsmanager:af-south-1:000000000000:secret:test");
    const seed = new Uint8Array(randomBytes(32));
    const key = await createKeyPairSignerFromPrivateKeyBytes(seed, true);
    state.answers = ["fail", JSON.stringify([...seed, ...getAddressEncoder().encode(key.address)])];
    const { handler } = await import("../src/main.ts");
    await expect(handler({ op: "address" })).rejects.toThrow();
    await expect(handler({ op: "address" })).resolves.toEqual({ address: key.address });
    await expect(handler({ op: "address" })).resolves.toEqual({ address: key.address });
    expect(state.answers).toHaveLength(0);
  });
});
