// Strict readers for JSON from the API: exact keys, exact types, no extras.

export class ShapeError extends Error {
  constructor(path: string, problem: string) {
    super(`${path}: ${problem}`);
    this.name = "ShapeError";
  }
}

export type Json = Record<string, unknown>;

export function record(value: unknown, path: string, keys: readonly string[]): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ShapeError(path, "not an object");
  }
  const actual = Object.keys(value);
  for (const key of actual)
    if (!keys.includes(key)) throw new ShapeError(path, `unknown field ${key}`);
  for (const key of keys) if (!(key in value)) throw new ShapeError(path, `missing ${key}`);
  return value as Json;
}

export function string(value: unknown, path: string, pattern?: RegExp): string {
  if (typeof value !== "string") throw new ShapeError(path, "not a string");
  if (pattern && !pattern.test(value)) throw new ShapeError(path, "wrong shape");
  return value;
}

export function nullable<T>(value: unknown, read: (v: unknown) => T): T | null {
  return value === null ? null : read(value);
}

export function oneOf<T extends string>(value: unknown, path: string, options: readonly T[]): T {
  if (typeof value !== "string" || !options.includes(value as T)) {
    throw new ShapeError(path, "not an allowed value");
  }
  return value as T;
}

export function array<T>(value: unknown, path: string, read: (v: unknown, p: string) => T): T[] {
  if (!Array.isArray(value)) throw new ShapeError(path, "not an array");
  return value.map((item, index) => read(item, `${path}[${index}]`));
}

export const DECIMAL = /^(0|[1-9][0-9]*)$/;
export const HEX64 = /^[0-9a-f]{64}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
