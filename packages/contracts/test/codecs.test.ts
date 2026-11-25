import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, getAddressDecoder } from "@solana/kit";
import { afterAll, describe, expect, it } from "vitest";
import * as client from "../src/index.ts";

type IdlType = string | { [key: string]: unknown };
type IdlField = { name: string; type: IdlType };
type Idl = {
  address: string;
  instructions: { name: string; discriminator: number[]; args: IdlField[] }[];
  accounts: { name: string; discriminator: number[] }[];
  types: {
    name: string;
    type: { kind: string; fields?: IdlField[]; variants?: { name: string }[] };
  }[];
};

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const idl = JSON.parse(readFileSync(join(packageDir, "idl/thetis.json"), "utf8")) as Idl;
const exportsByName = client as unknown as Record<string, unknown>;

const camel = (snake: string) => snake.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
const pascal = (snake: string) => {
  const c = camel(snake);
  return c.charAt(0).toUpperCase() + c.slice(1);
};

function fn(name: string): (...args: unknown[]) => unknown {
  const found = exportsByName[name];
  if (typeof found !== "function") throw new Error(`generated client has no export ${name}`);
  return found as (...args: unknown[]) => unknown;
}

// Deterministic sample values. `input` goes to the encoder; `output` is what the decoder returns.
let counter = 0;
function bytes(length: number): Uint8Array {
  const seed = ++counter;
  return Uint8Array.from({ length }, (_v, i) => (seed * 31 + i * 7 + 1) % 256);
}
function sample(type: IdlType): { input: unknown; output: unknown } {
  if (typeof type === "string") {
    switch (type) {
      case "bool": {
        const value = ++counter % 2 === 0;
        return { input: value, output: value };
      }
      case "u8":
        return { input: 255, output: 255 };
      case "u16":
        return { input: 65535, output: 65535 };
      case "u32":
        return { input: 4294967295, output: 4294967295 };
      case "u64": {
        const value = 2n ** 64n - 1n - BigInt(++counter);
        return { input: value, output: value };
      }
      case "i64": {
        const value = -(2n ** 63n) + BigInt(++counter);
        return { input: value, output: value };
      }
      case "string": {
        const value = `sample-${++counter}`;
        return { input: value, output: value };
      }
      case "pubkey": {
        const value = getAddressDecoder().decode(bytes(32)) as Address;
        return { input: value, output: value };
      }
      default:
        throw new Error(`sample(): unsupported IDL primitive ${type}`);
    }
  }
  if ("array" in type) {
    const [element, length] = type.array as [IdlType, number];
    if (element !== "u8") throw new Error("sample(): only u8 arrays are supported");
    const value = bytes(length);
    return { input: value, output: value };
  }
  if ("vec" in type) {
    const items = [sample(type.vec as IdlType), sample(type.vec as IdlType)];
    return { input: items.map((i) => i.input), output: items.map((i) => i.output) };
  }
  if ("option" in type) {
    // Alternate Some / None so both encodings are exercised across the IDL.
    if (++counter % 2 === 0) {
      const inner = sample(type.option as IdlType);
      return { input: inner.input, output: { __option: "Some", value: inner.output } };
    }
    return { input: null, output: { __option: "None" } };
  }
  if ("defined" in type) {
    const name = (type.defined as { name: string }).name;
    const def = idl.types.find((t) => t.name === name);
    if (def?.type.kind === "enum" && def.type.variants) {
      const index = def.type.variants.length - 1;
      return { input: index, output: index };
    }
    if (def?.type.kind === "struct" && def.type.fields) return struct(def.type.fields);
    throw new Error(`sample(): unsupported defined type ${name}`);
  }
  throw new Error(`sample(): unsupported IDL type ${JSON.stringify(type)}`);
}
function struct(fields: IdlField[]): {
  input: Record<string, unknown>;
  output: Record<string, unknown>;
} {
  const input: Record<string, unknown> = {};
  const output: Record<string, unknown> = {};
  for (const field of fields) {
    const value = sample(field.type);
    input[camel(field.name)] = value.input;
    output[camel(field.name)] = value.output;
  }
  return { input, output };
}

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
  it("lists the Phase 1 instructions and accounts", () => {
    expect(idl.instructions.length).toBe(15);
    expect(idl.accounts.length).toBe(10);
    expect(idl.instructions.map((i) => i.name)).toContain("redeem");
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
