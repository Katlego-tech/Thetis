// Build-time configuration. Expo inlines each EXPO_PUBLIC_ value where it is named, so they are
// read one by one here and nowhere else.
import { decodeBase58 } from "./lib/encoding";

export interface FieldConfig {
  apiUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  program: string;
  network: "devnet";
}

export type ConfigResult = { ok: true; config: FieldConfig } | { ok: false; errors: string[] };

export interface ConfigEnv {
  EXPO_PUBLIC_API_URL?: string;
  EXPO_PUBLIC_SUPABASE_URL?: string;
  EXPO_PUBLIC_SUPABASE_ANON_KEY?: string;
  EXPO_PUBLIC_THETIS_PROGRAM?: string;
  EXPO_PUBLIC_NETWORK?: string;
}

export function buildEnv(): ConfigEnv {
  return {
    EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL,
    EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
    EXPO_PUBLIC_SUPABASE_ANON_KEY: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    EXPO_PUBLIC_THETIS_PROGRAM: process.env.EXPO_PUBLIC_THETIS_PROGRAM,
    EXPO_PUBLIC_NETWORK: process.env.EXPO_PUBLIC_NETWORK,
  };
}

function isUrl(value: string | undefined): value is string {
  if (!value) return false;
  return /^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(value);
}

function isAddress(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return decodeBase58(value).length === 32;
  } catch {
    return false;
  }
}

export function readConfig(env: ConfigEnv = buildEnv()): ConfigResult {
  const errors: string[] = [];
  const api = env.EXPO_PUBLIC_API_URL;
  if (!isUrl(api) || api.endsWith("/")) errors.push("EXPO_PUBLIC_API_URL");
  if (!isUrl(env.EXPO_PUBLIC_SUPABASE_URL)) errors.push("EXPO_PUBLIC_SUPABASE_URL");
  if (!env.EXPO_PUBLIC_SUPABASE_ANON_KEY) errors.push("EXPO_PUBLIC_SUPABASE_ANON_KEY");
  if (!isAddress(env.EXPO_PUBLIC_THETIS_PROGRAM)) errors.push("EXPO_PUBLIC_THETIS_PROGRAM");
  if (env.EXPO_PUBLIC_NETWORK !== "devnet") errors.push("EXPO_PUBLIC_NETWORK");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    config: {
      apiUrl: api as string,
      supabaseUrl: env.EXPO_PUBLIC_SUPABASE_URL as string,
      supabaseAnonKey: env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string,
      program: env.EXPO_PUBLIC_THETIS_PROGRAM as string,
      network: "devnet",
    },
  };
}
