// Supabase's session, kept AES-256-GCM-encrypted in AsyncStorage under a random 256-bit key that
// lives only in expo-secure-store (a session is larger than secure-store's recommended value).
import { gcm } from "@noble/ciphers/aes.js";
import { decodeBase64, encodeBase64 } from "./lib/encoding";

export const SESSION_KEY_ITEM = "thetis.field.session-key";

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface SecureStoreLike {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
}

export interface EncryptedStorageDeps {
  storage: KeyValueStorage;
  secureStore: SecureStoreLike;
  randomBytes: (length: number) => Uint8Array;
}

const NONCE_BYTES = 12;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function createEncryptedStorage(deps: EncryptedStorageDeps): KeyValueStorage {
  async function readKey(): Promise<Uint8Array | null> {
    const stored = await deps.secureStore.getItemAsync(SESSION_KEY_ITEM);
    if (!stored) return null;
    const key = decodeBase64(stored) as Uint8Array;
    return key.length === 32 ? key : null;
  }

  async function key(): Promise<Uint8Array> {
    const existing = await readKey();
    if (existing) return existing;
    const fresh = deps.randomBytes(32);
    await deps.secureStore.setItemAsync(SESSION_KEY_ITEM, encodeBase64(fresh));
    return fresh;
  }

  return {
    async getItem(name) {
      const stored = await deps.storage.getItem(name);
      if (stored === null) return null;
      try {
        const secret = await readKey();
        if (!secret) throw new Error("no key");
        const bytes = decodeBase64(stored) as Uint8Array;
        const nonce = bytes.subarray(0, NONCE_BYTES);
        const sealed = bytes.subarray(NONCE_BYTES);
        return decoder.decode(gcm(secret, nonce).decrypt(sealed));
      } catch {
        await deps.storage.removeItem(name);
        return null;
      }
    },
    async setItem(name, value) {
      const secret = await key();
      const nonce = deps.randomBytes(NONCE_BYTES);
      const sealed = gcm(secret, nonce).encrypt(encoder.encode(value));
      const out = new Uint8Array(NONCE_BYTES + sealed.length);
      out.set(nonce);
      out.set(sealed, NONCE_BYTES);
      await deps.storage.setItem(name, encodeBase64(out));
    },
    async removeItem(name) {
      await deps.storage.removeItem(name);
    },
  };
}
