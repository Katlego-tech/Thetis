import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { exportsByName, fn, idl, packageDir, pascal, struct } from "./samples.ts";

function codecRoundTrip(
  encoder: { encode(value: unknown): Uint8Array },
  decoder: { decode(data: Uint8Array): Record<string, unknown> },
  discriminator: number[],
  value: { input: unknown; output: Record<string, unknown> },
) {
  const encoded = encoder.encode(value.input);
  expect(Array.from(encoded.slice(0, 8))).toEqual(discriminator);
  const decoded = decoder.decode(encoded);
  expect(Array.from(decoded.discriminator as Uint8Array)).toEqual(discriminator);
  const { discriminator: _discriminator, ...arguments_ } = decoded;
  expect(arguments_).toEqual(value.output);
  // Re-encoding the decoded value must reproduce the same bytes.
  expect(Array.from(encoder.encode(decoded))).toEqual(Array.from(encoded));
}

describe("IDL sanity", () => {
  it("lists the Phase 1 instructions and accounts and the lending setup ones", () => {
    expect(idl.instructions.length).toBe(21);
    expect(idl.accounts.length).toBe(16);
    const instructions = idl.instructions.map((i) => i.name);
    expect(instructions).toContain("redeem");
    expect(instructions).toContain("open_facility");
    expect(instructions).toContain("set_valuation");
    const accounts = idl.accounts.map((a) => a.name);
    for (const name of ["Facility", "Valuation", "SimulationPool"]) {
      expect(accounts).toContain(name);
    }
  });

  it("takes the program address from the IDL", () => {
    expect(exportsByName.THETIS_PROGRAM_ADDRESS).toBe(idl.address);
  });
});

describe("generated instruction codecs", () => {
  for (const instruction of idl.instructions) {
    it(`${instruction.name}: encodes with the IDL discriminator and decodes back`, () => {
      const name = pascal(instruction.name);
      const encoder = fn(`get${name}InstructionDataEncoder`)() as Parameters<
        typeof codecRoundTrip
      >[0];
      const decoder = fn(`get${name}InstructionDataDecoder`)() as Parameters<
        typeof codecRoundTrip
      >[1];
      expect(typeof fn(`get${name}Instruction`)).toBe("function");
      const args = struct(instruction.args);
      codecRoundTrip(encoder, decoder, instruction.discriminator, args);
    });
  }
});

describe("generated account codecs", () => {
  for (const account of idl.accounts) {
    it(`${account.name}: encodes with the IDL discriminator and decodes back`, () => {
      const def = idl.types.find((t) => t.name === account.name);
      if (!def?.type.fields) throw new Error(`IDL has no struct type for account ${account.name}`);
      const encoder = fn(`get${account.name}Encoder`)() as Parameters<typeof codecRoundTrip>[0];
      const decoder = fn(`get${account.name}Decoder`)() as Parameters<typeof codecRoundTrip>[1];
      expect(typeof fn(`decode${account.name}`)).toBe("function");
      const upper = account.name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
      expect(Array.from(exportsByName[`${upper}_DISCRIMINATOR`] as Uint8Array)).toEqual(
        account.discriminator,
      );
      codecRoundTrip(encoder, decoder, account.discriminator, struct(def.type.fields));
    });
  }
});

describe("committed client", () => {
  const scratch = mkdtempSync(join(tmpdir(), "thetis-contracts-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  function listFiles(root: string): string[] {
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(root, join(entry.parentPath, entry.name)))
      .sort();
  }

  it("is identical to what scripts/generate.mjs produces from idl/thetis.json", () => {
    const out = join(scratch, "generated");
    execFileSync(process.execPath, [join(packageDir, "scripts/generate.mjs"), out], {
      stdio: "pipe",
    });
    const committed = join(packageDir, "src/generated");
    const files = listFiles(committed);
    expect(listFiles(out)).toEqual(files);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(readFileSync(join(out, file), "utf8"), file).toBe(
        readFileSync(join(committed, file), "utf8"),
      );
    }
  }, 60_000);
});
