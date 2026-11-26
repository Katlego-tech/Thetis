// Server-only: the one place a page obtains its reader, from the fixture or the indexed read model.

import { redirect } from "next/navigation";
import { cache } from "react";
import { supabaseServer } from "@/lib/supabase-server";
import { getReader } from "./get-reader";
import { liveEnv, loadLiveSnapshot, requireUser } from "./live/load";
import { liveReader } from "./live/map";
import { LiveDataError, type ScreenReader } from "./live/types";

export function dataSource(): "reference" | "live" {
  const source = process.env.THETIS_DATA_SOURCE;
  if (source === undefined || source === "" || source === "reference") return "reference";
  if (source === "live") return "live";
  throw new LiveDataError("CONFIG", "THETIS_DATA_SOURCE", "must be reference or live");
}

async function readLive(): Promise<ScreenReader> {
  try {
    const env = liveEnv();
    const supabase = await supabaseServer();
    await requireUser(supabase);
    const snapshot = await loadLiveSnapshot(supabase, env);
    return liveReader(snapshot, new Date());
  } catch (error) {
    if (error instanceof LiveDataError) throw error;
    throw new LiveDataError("READ_FAILED", "loadReader", String(error));
  }
}

/** One read per request. */
export const loadReader: () => Promise<ScreenReader> = cache(async () => {
  if (dataSource() === "reference") return getReader();
  return readLive();
});

/** loadReader, sending a caller without a session to sign in and come back to `next`. */
export async function requireReader(next: string): Promise<ScreenReader> {
  try {
    return await loadReader();
  } catch (error) {
    if (error instanceof LiveDataError && error.code === "NO_SESSION") {
      const expired = error.path === "auth.getUser:rejected" ? "&reason=expired" : "";
      redirect(`/login?next=${encodeURIComponent(next)}${expired}`);
    }
    throw error;
  }
}
