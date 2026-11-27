// A failed first read is never cached (T064b.1 review S2): the sponsor key, the sponsor's address
// and the relay configuration each retry on the next call. Every key here is a throwaway.
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder } from "@solana/kit";
import { THETIS_PROGRAM_ADDRESS } from "@thetis/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  genesis: [] as ("fail" | string)[],
  lambda: [] as ("fail" | Record<string, unknown>)[],
}));

vi.mock("../src/commands/chain.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/commands/chain.ts")>();
  return {
    ...original,
    rpcChain: () => ({
      async genesisHash() {
        const next = state.genesis.shift();
        if (next === undefined) throw new Error("the test queued no genesis answer");
        if (next === "fail") throw new original.ChainUnavailableError(new Error("ECONNRESET"));
        return next;
      },
    }),
  };
});

vi.mock("@aws-sdk/client-lambda", () => ({
  InvokeCommand: class {
    readonly input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  LambdaClient: class {
    async send() {
      const next = state.lambda.shift();
      if (next === undefined) throw new Error("the test queued no Lambda answer");
      if (next === "fail") throw new Error("the Lambda endpoint did not answer");
      return { Payload: new TextEncoder().encode(JSON.stringify(next)) };
    }
  },
}));

const DEVNET = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const PROTOCOL = "G9GNDdbYKQY14xv1xgNw1D6EY8SFnZxgHrDBdEbHsoo3";

async function throwaway() {
  const seed = new Uint8Array(randomBytes(32));
  const key = await createKeyPairSignerFromPrivateKeyBytes(seed, true);
  return { bytes: [...seed, ...getAddressEncoder().encode(key.address)], address: key.address };
}

function relayEnv() {
  vi.stubEnv("THETIS_NETWORK", "devnet");
  vi.stubEnv("THETIS_PROGRAM_ID", THETIS_PROGRAM_ADDRESS);
  vi.stubEnv("THETIS_PROTOCOL", PROTOCOL);
  vi.stubEnv("THETIS_RPC_URL", "https://rpc.invalid");
  vi.stubEnv("THETIS_SPONSOR", "lambda:thetis-test-sponsor");
}

beforeEach(() => {
  vi.resetModules();
  state.genesis = [];
  state.lambda = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("no cached failure", () => {
  it("a key-file sponsor whose key could not be read reads it again on the next call", async () => {
    const { keyFileSponsor } = await import("../src/commands/sponsor.ts");
    const directory = await mkdtemp(join(tmpdir(), "thetis-sponsor-"));
    const path = join(directory, "sponsor.json");
    const sponsor = keyFileSponsor(path, {
      programId: THETIS_PROGRAM_ADDRESS,
      protocol: PROTOCOL as never,
    });
    await expect(sponsor.address()).rejects.toThrow();
    const key = await throwaway();
    await writeFile(path, JSON.stringify(key.bytes), { mode: 0o600 });
    await expect(sponsor.address()).resolves.toBe(key.address);
  });

  it("a Lambda sponsor that did not answer its address is asked again on the next call", async () => {
    const { lambdaSponsor } = await import("../src/commands/sponsor.ts");
    const key = await throwaway();
    state.lambda = ["fail", { address: key.address }];
    const sponsor = lambdaSponsor("thetis-test-sponsor");
    await expect(sponsor.address()).rejects.toMatchObject({ name: "SponsorUnavailableError" });
    await expect(sponsor.address()).resolves.toBe(key.address);
    // Answered once, then cached.
    await expect(sponsor.address()).resolves.toBe(key.address);
    expect(state.lambda).toHaveLength(0);
  });

  it("a genesis-hash read that fails in transit is CHAIN_UNAVAILABLE, not CONFIG_INVALID, and the next request reads it again", async () => {
    relayEnv();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { defaultDependencies } = await import("../src/commands/routes.ts");
    state.genesis = ["fail", DEVNET];
    await expect(defaultDependencies()).rejects.toMatchObject({ code: "CHAIN_UNAVAILABLE" });
    expect(logged.mock.calls.flat().join(" ")).not.toContain("CONFIG_INVALID");
    const relay = await defaultDependencies();
    expect(relay.protocol).toBe(PROTOCOL);
    expect(state.genesis).toHaveLength(0);
  });

  it("a genesis hash that is not devnet's is CONFIG_INVALID and stays refused until restart", async () => {
    relayEnv();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { defaultDependencies } = await import("../src/commands/routes.ts");
    state.genesis = ["5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d", DEVNET];
    await expect(defaultDependencies()).rejects.toMatchObject({ code: "COMMANDS_UNAVAILABLE" });
    expect(logged.mock.calls.flat().join(" ")).toContain(
      '{"level":"error","code":"CONFIG_INVALID","variable":"THETIS_RPC_URL"}',
    );
    await expect(defaultDependencies()).rejects.toMatchObject({ code: "COMMANDS_UNAVAILABLE" });
    expect(state.genesis).toEqual([DEVNET]);
  });
});
