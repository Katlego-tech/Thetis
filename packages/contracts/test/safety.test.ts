import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type Address, getAddressDecoder, lamports } from "@solana/kit";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertThetisAccount,
  getTransferInstructionDataDecoder,
  getTransferInstructionDataEncoder,
  THETIS_PROGRAM_ADDRESS,
  ThetisAccount,
  ThetisAccountError,
  thetisProgram,
} from "../src/index.ts";
import { bytes, exportsByName, fn, idl, packageDir, struct } from "./samples.ts";

const throwaway = getAddressDecoder().decode(bytes(32)) as Address;
const subject = getAddressDecoder().decode(bytes(32)) as Address;

function encodedAccount(data: Uint8Array, programAddress: Address) {
  return {
    address: subject,
    data,
    executable: false,
    lamports: lamports(1_000_000n),
    programAddress,
    space: BigInt(data.length),
  };
}

function accountData(name: string): Uint8Array {
  const def = idl.types.find((t) => t.name === name);
  if (!def?.type.fields) throw new Error(`IDL has no struct type for account ${name}`);
  const encoder = fn(`get${name}Encoder`)() as { encode(value: unknown): Uint8Array };
  return encoder.encode(struct(def.type.fields).input);
}

function respond(data: Uint8Array, owner: Address) {
  return {
    data: [Buffer.from(data).toString("base64"), "base64"],
    executable: false,
    lamports: 1_000_000n,
    owner,
    space: BigInt(data.length),
  };
}

function rpcFor(value: ReturnType<typeof respond>) {
  return {
    getAccountInfo: () => ({ send: async () => ({ context: { slot: 1n }, value }) }),
    getMultipleAccounts: () => ({
      send: async () => ({ context: { slot: 1n }, value: [value] }),
    }),
  };
}

const lowerFirst = (name: string) => name.charAt(0).toLowerCase() + name.slice(1);

describe("generated account decoders refuse foreign accounts", () => {
  it("uses a throwaway address that is not the thetis program", () => {
    expect(throwaway).not.toBe(THETIS_PROGRAM_ADDRESS);
  });

  idl.accounts.forEach((account, index) => {
    const other = idl.accounts[(index + 1) % idl.accounts.length];
    if (!other) throw new Error("the IDL has no accounts");
    const decode = fn(`decode${account.name}`);

    it(`${account.name}: decodes an account the thetis program owns`, () => {
      const data = accountData(account.name);
      const decoded = decode(encodedAccount(data, THETIS_PROGRAM_ADDRESS)) as {
        address: Address;
        data: { discriminator: Uint8Array };
      };
      expect(decoded.address).toBe(subject);
      expect(Array.from(decoded.data.discriminator)).toEqual(account.discriminator);
    });

    it(`${account.name}: refuses an account another program owns`, () => {
      const data = accountData(account.name);
      expect.assertions(3);
      try {
        decode(encodedAccount(data, throwaway));
      } catch (error) {
        expect(error).toBeInstanceOf(ThetisAccountError);
        expect((error as ThetisAccountError).reason).toBe("OWNER");
        expect((error as ThetisAccountError).address).toBe(subject);
      }
    });

    it(`${account.name}: refuses another account kind's discriminator`, () => {
      const data = accountData(account.name);
      data.set(other.discriminator, 0);
      expect.assertions(2);
      try {
        decode(encodedAccount(data, THETIS_PROGRAM_ADDRESS));
      } catch (error) {
        expect(error).toBeInstanceOf(ThetisAccountError);
        expect((error as ThetisAccountError).reason).toBe("DISCRIMINATOR");
      }
    });

    it(`${account.name}: refuses a discriminator no account has, and data shorter than one`, () => {
      const data = accountData(account.name);
      data.fill(0, 0, 8);
      for (const bad of [data, data.slice(0, 3)]) {
        expect(() => decode(encodedAccount(bad, THETIS_PROGRAM_ADDRESS))).toThrow(
          ThetisAccountError,
        );
      }
    });

    it(`${account.name}: leaves a non-existent account non-existent`, () => {
      const missing = { address: subject, exists: false as const };
      expect(decode(missing)).toEqual(missing);
    });

    it(`${account.name}: fetch, fetchMaybe, fetchAll and fetchAllMaybe go through the same checks`, async () => {
      const data = accountData(account.name);
      const good = rpcFor(respond(data, THETIS_PROGRAM_ADDRESS));
      const foreign = rpcFor(respond(data, throwaway));
      const name = account.name;
      await expect(fn(`fetch${name}`)(good, subject)).resolves.toBeDefined();
      await expect(fn(`fetchMaybe${name}`)(good, subject)).resolves.toBeDefined();
      await expect(fn(`fetchAll${name}`)(good, [subject])).resolves.toHaveLength(1);
      await expect(fn(`fetchAllMaybe${name}`)(good, [subject])).resolves.toHaveLength(1);
      for (const call of [
        () => fn(`fetch${name}`)(foreign, subject),
        () => fn(`fetchMaybe${name}`)(foreign, subject),
        () => fn(`fetchAll${name}`)(foreign, [subject]),
        () => fn(`fetchAllMaybe${name}`)(foreign, [subject]),
      ]) {
        await expect(call()).rejects.toBeInstanceOf(ThetisAccountError);
      }
    });
  });

  idl.accounts.forEach((account, index) => {
    const other = idl.accounts[(index + 1) % idl.accounts.length];
    if (!other) throw new Error("the IDL has no accounts");

    it(`${account.name}: client.thetis.accounts fetches refuse foreign owners and wrong discriminators`, async () => {
      const wrongKind = accountData(account.name);
      wrongKind.set(other.discriminator, 0);
      const data = accountData(account.name);
      const plugin = (value: ReturnType<typeof respond>) =>
        (
          thetisProgram()({ rpc: rpcFor(value) } as never) as unknown as {
            thetis: {
              accounts: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;
            };
          }
        ).thetis.accounts[lowerFirst(account.name)] as Record<
          string,
          (...args: unknown[]) => Promise<unknown>
        >;
      const calls = (accounts: ReturnType<typeof plugin>) => [
        () => accounts.fetch?.(subject),
        () => accounts.fetchMaybe?.(subject),
        () => accounts.fetchAll?.([subject]),
        () => accounts.fetchAllMaybe?.([subject]),
      ];

      for (const call of calls(plugin(respond(data, THETIS_PROGRAM_ADDRESS)))) {
        await expect(call()).resolves.toBeDefined();
      }
      for (const [value, reason] of [
        [respond(data, throwaway), "OWNER"],
        [respond(wrongKind, THETIS_PROGRAM_ADDRESS), "DISCRIMINATOR"],
      ] as const) {
        for (const call of calls(plugin(value))) {
          await expect(call()).rejects.toMatchObject({ name: "ThetisAccountError", reason });
        }
      }
    });
  });

  it("assertThetisAccount returns the very account it was given", () => {
    const lot = idl.accounts.find((a) => a.name === "Lot");
    if (!lot) throw new Error("the IDL has no Lot account");
    const account = encodedAccount(accountData("Lot"), THETIS_PROGRAM_ADDRESS);
    expect(assertThetisAccount(account, ThetisAccount.Lot)).toBe(account);
    expect(() => assertThetisAccount(account, ThetisAccount.Position)).toThrow(ThetisAccountError);
  });

  it("covers every account the IDL declares", () => {
    for (const account of idl.accounts) {
      expect(typeof exportsByName[`decode${account.name}`]).toBe("function");
    }
  });
});

describe("64-bit inputs are bigint only", () => {
  const above2Pow53 = 2n ** 53n + 1n;

  it("does not type a number as a u64 argument", () => {
    // Never called: the point is that this file stops typechecking if a number is accepted again.
    const rejected = () =>
      getTransferInstructionDataEncoder().encode({
        // @ts-expect-error a u64 argument takes a bigint, not a number
        quantityKg: 1,
        expectedRevision: 1n,
        validUntil: 1n,
      });
    expect(typeof rejected).toBe("function");
  });

  it("round-trips a bigint above 2^53 exactly", () => {
    const bytesOut = getTransferInstructionDataEncoder().encode({
      quantityKg: above2Pow53,
      expectedRevision: 2n ** 64n - 1n,
      validUntil: -(2n ** 63n),
    });
    const decoded = getTransferInstructionDataDecoder().decode(bytesOut);
    expect(decoded.quantityKg).toBe(above2Pow53);
    expect(decoded.expectedRevision).toBe(2n ** 64n - 1n);
    expect(decoded.validUntil).toBe(-(2n ** 63n));
  });
});

describe("generating into a custom directory", () => {
  const scratch = mkdtempSync(join(packageDir, ".tmp-generated-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it("writes a self-contained tree that typechecks and still refuses foreign accounts", async () => {
    const out = join(scratch, "client");
    execFileSync(process.execPath, [join(packageDir, "scripts/generate.mjs"), out], {
      stdio: "pipe",
    });

    // No file in the tree imports something outside the tree.
    for (const entry of readdirSync(out, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const file = join(entry.parentPath, entry.name);
      const specifiers = readFileSync(file, "utf8").matchAll(/from '(\.[^']*)'/g);
      for (const [, specifier] of specifiers) {
        const target = resolve(dirname(file), specifier ?? "");
        expect(target.startsWith(`${out}/`), `${file} imports ${specifier}`).toBe(true);
      }
    }

    writeFileSync(
      join(scratch, "tsconfig.json"),
      JSON.stringify({
        extends: "../tsconfig.json",
        compilerOptions: { rootDir: "..", noEmit: true },
        include: ["client"],
      }),
    );
    execFileSync(
      resolve(packageDir, "../../node_modules/.bin/tsc"),
      ["-p", join(scratch, "tsconfig.json")],
      { stdio: "pipe" },
    );

    const generated = (await import(join(out, "index.ts"))) as Record<string, unknown>;
    const decode = generated.decodeLot as (account: unknown) => unknown;
    const data = accountData("Lot");
    expect(() => decode(encodedAccount(data, throwaway))).toThrow(
      expect.objectContaining({ name: "ThetisAccountError", reason: "OWNER" }),
    );
    expect(decode(encodedAccount(data, THETIS_PROGRAM_ADDRESS))).toBeDefined();
  }, 120_000);
});
