import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { LiveDataError } from "@/data/live/types";

/** A Supabase client for this request, signed in as the caller through their session cookies. */
export async function supabaseServer(): Promise<SupabaseClient> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new LiveDataError("CONFIG", "NEXT_PUBLIC_SUPABASE_URL", "is not set");
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!anonKey) throw new LiveDataError("CONFIG", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "is not set");

  const store = await cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) store.set(name, value, options);
        } catch {
          // Server Components cannot set cookies; the proxy refreshes the session before the page renders.
        }
      },
    },
  });
}
