import { createClient } from "@supabase/supabase-js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function createAccessClients() {
  const url = requiredEnv("SUPABASE_URL");
  const anonKey = requiredEnv("SUPABASE_ANON_KEY");
  const serviceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const siteUrl = requiredEnv("SITE_URL");
  const corsOrigin = requiredEnv("CORS_ORIGIN");
  if (corsOrigin !== siteUrl) throw new Error("CORS_ORIGIN must equal SITE_URL");

  const options = {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    db: { retry: false },
  };

  return {
    siteUrl,
    corsOrigin,
    service: createClient(url, serviceKey, options),
    caller(token: string) {
      return createClient(url, anonKey, {
        ...options,
        global: { headers: { Authorization: `Bearer ${token}` } },
      });
    },
  };
}

export type AccessClients = ReturnType<typeof createAccessClients>;
