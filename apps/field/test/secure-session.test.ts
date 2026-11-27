import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEncryptedStorage, SESSION_KEY_ITEM } from "../src/secure-session";

function memory() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => void values.set(key, value),
    removeItem: async (key: string) => void values.delete(key),
  };
}

function setup() {
  const plain = memory();
  const secure = new Map<string, string>();
  const storage = createEncryptedStorage({
    storage: plain,
    secureStore: {
      getItemAsync: async (key) => secure.get(key) ?? null,
      setItemAsync: async (key, value) => void secure.set(key, value),
    },
    randomBytes: (n) => new Uint8Array(randomBytes(n)),
  });
  return { plain, secure, storage };
}

const SESSION = JSON.stringify({ access_token: "eyJhbGciOi.secret.token", refresh_token: "r-123" });

describe("encrypted session storage", () => {
  it("writes a value that is not plain in AsyncStorage and reads it back equal", async () => {
    const { plain, secure, storage } = setup();
    await storage.setItem("sb-session", SESSION);
    const stored = plain.values.get("sb-session") ?? "";
    expect(stored).not.toContain("secret");
    expect(stored).not.toContain("r-123");
    expect(secure.has(SESSION_KEY_ITEM)).toBe(true);
    expect(SESSION_KEY_ITEM).toBe("thetis.field.session-key");
    expect(await storage.getItem("sb-session")).toBe(SESSION);
  });

  it("uses a fresh nonce per write", async () => {
    const { plain, storage } = setup();
    await storage.setItem("k", SESSION);
    const first = plain.values.get("k");
    await storage.setItem("k", SESSION);
    expect(plain.values.get("k")).not.toBe(first);
  });

  it("deletes a tampered value and reads it as null", async () => {
    const { plain, storage } = setup();
    await storage.setItem("k", SESSION);
    const stored = plain.values.get("k") ?? "";
    const flipped = `${stored.slice(0, -2)}${stored.at(-2) === "A" ? "B" : "A"}${stored.at(-1)}`;
    plain.values.set("k", flipped);
    expect(await storage.getItem("k")).toBeNull();
    expect(plain.values.has("k")).toBe(false);
  });

  it("a missing key with a stored value reads as null and deletes it", async () => {
    const { plain, secure, storage } = setup();
    await storage.setItem("k", SESSION);
    secure.clear();
    expect(await storage.getItem("k")).toBeNull();
    expect(plain.values.has("k")).toBe(false);
  });

  it("removes", async () => {
    const { plain, storage } = setup();
    await storage.setItem("k", SESSION);
    await storage.removeItem("k");
    expect(plain.values.has("k")).toBe(false);
  });
});
