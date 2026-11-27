import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, getAddressDecoder } from "@solana/kit";
import * as client from "../src/index.ts";

export type IdlType = string | { [key: string]: unknown };
type IdlField = { name: string; type: IdlType };
export type Idl = {
  address: string;
  instructions: { name: string; discriminator: number[]; args: IdlField[] }[];
  accounts: { name: string; discriminator: number[] }[];
  types: {
    name: string;
    type: { kind: string; fields?: IdlField[]; variants?: { name: string }[] };
  }[];
};

export const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const idl = JSON.parse(readFileSync(join(packageDir, "idl/thetis.json"), "utf8")) as Idl;
export const exportsByName = client as unknown as Record<string, unknown>;

export const camel = (snake: string) =>
  snake.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
export const pascal = (snake: string) => {
  const c = camel(snake);
  return c.charAt(0).toUpperCase() + c.slice(1);
};

export function fn(name: string): (...args: unknown[]) => unknown {
  const found = exportsByName[name];
  if (typeof found !== "function") throw new Error(`generated client has no export ${name}`);
  return found as (...args: unknown[]) => unknown;
}

// Deterministic sample values. `input` goes to the encoder; `output` is what the decoder returns.
let counter = 0;
export function bytes(length: number): Uint8Array {
  const seed = ++counter;
  return Uint8Array.from({ length }, (_v, i) => (seed * 31 + i * 7 + 1) % 256);
}
export function sample(type: IdlType): { input: unknown; output: unknown } {
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
    if (element === "u8") {
      const value = bytes(length);
      return { input: value, output: value };
    }
    // A fixed array of fixed u8 arrays, such as a Merkle proof.
    if (
      typeof element === "object" &&
      "array" in element &&
      (element.array as [IdlType, number])[0] === "u8"
    ) {
      const items = Array.from({ length }, () => sample(element));
      return { input: items.map((i) => i.input), output: items.map((i) => i.output) };
    }
    throw new Error("sample(): only u8 arrays and arrays of u8 arrays are supported");
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
export function struct(fields: IdlField[]): {
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
