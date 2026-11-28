"use client";

import type { Session } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { accessAuth } from "./access-auth";

/** The browser session: null until known, and when signed out or unconfigured (navigation.md §5.3). */
export function useAccessSession(): Session | null {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    const auth = accessAuth();
    if (!auth) return;

    let active = true;
    let receivedAuthEvent = false;

    try {
      const sessionLookup = auth.getSession();
      const {
        data: { subscription },
      } = auth.onAuthStateChange((_event, newSession) => {
        receivedAuthEvent = true;
        if (active) setSession(newSession);
      });

      void sessionLookup.then(
        ({ data, error }) => {
          if (active && !receivedAuthEvent) setSession(error ? null : data.session);
        },
        () => {
          if (active && !receivedAuthEvent) setSession(null);
        },
      );

      return () => {
        active = false;
        subscription.unsubscribe();
      };
    } catch {
      setSession(null);
    }
  }, []);

  return session;
}
