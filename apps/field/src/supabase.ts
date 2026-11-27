// The Supabase client: the person's session (encrypted at rest), RLS reads, Storage uploads.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getRandomBytes } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import type { FieldConfig } from "./config";
import { createEncryptedStorage } from "./secure-session";

export const SUPABASE_TIMEOUT_MS = 8_000;
export const STORAGE_TIMEOUT_MS = 120_000;

/** Thrown in place of the fetch's own abort error, so the screens can say "did not answer". */
export class SupabaseTimeout extends Error {
  constructor() {
    super("The request did not answer in time.");
    this.name = "SupabaseTimeout";
  }
}

export function timeoutFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = url.replace(/^https?:\/\/[^/]+/, "");
  const limit = path.startsWith("/storage/v1/object/") ? STORAGE_TIMEOUT_MS : SUPABASE_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, limit);
  init?.signal?.addEventListener("abort", () => controller.abort());
  return fetch(input, { ...init, signal: controller.signal })
    .catch((error: unknown) => {
      throw timedOut ? new SupabaseTimeout() : error;
    })
    .finally(() => clearTimeout(timer));
}

export const sessionStorage = createEncryptedStorage({
  storage: AsyncStorage,
  secureStore: SecureStore,
  randomBytes: (length) => getRandomBytes(length),
});

export function createSupabase(config: FieldConfig): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      storage: sessionStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
    global: { fetch: timeoutFetch },
  });
}
