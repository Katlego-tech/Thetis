import { type CookieOptions, createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/data/live/load";
import { LiveDataError } from "@/data/live/types";
import { dataSource } from "@/data/load-reader";

type Cookie = { name: string; value: string; options: CookieOptions };

/** Paths that never need a session: the reference screens, sign-in, invitations, the account
 * page and the public run page. */
const PUBLIC_PATH = /^\/(run|reference|login|invite|account)(\/|$)/;

/**
 * In live mode, refreshes the Supabase session cookies before a page renders and sends a caller
 * without a session to sign in. Reference mode, an invalid data source and a missing Supabase URL
 * or key pass straight through (the page reports the configuration error). The other live
 * variables are the page's to check: without them a signed-out visitor is still sent to sign in,
 * and never sees a read failure.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  // The hosted judge site serves the public run page only, and reads no session at all.
  if (process.env.THETIS_SITE_MODE === "judge") {
    if (pathname === "/run") return NextResponse.next();
    return NextResponse.redirect(new URL("/run", request.url), 307);
  }
  if (PUBLIC_PATH.test(pathname)) return NextResponse.next();
  try {
    if (dataSource() !== "live") return NextResponse.next();
  } catch (error) {
    if (error instanceof LiveDataError) return NextResponse.next();
    throw error;
  }
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return NextResponse.next();

  const written = new Map<string, Cookie>();
  const headers = new Map<string, string>();
  const carry = (response: NextResponse) => {
    for (const { name, value, options } of written.values())
      response.cookies.set(name, value, options);
    for (const [name, value] of headers) response.headers.set(name, value);
    return response;
  };
  let response = NextResponse.next({ request });
  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet, cacheHeaders) {
        for (const cookie of cookiesToSet) {
          written.set(cookie.name, cookie);
          request.cookies.set(cookie.name, cookie.value);
        }
        for (const [name, value] of Object.entries(cacheHeaders ?? {})) headers.set(name, value);
        response = carry(NextResponse.next({ request }));
      },
    },
  });

  try {
    await requireUser(supabase);
  } catch (error) {
    if (error instanceof LiveDataError && error.code === "NO_SESSION") {
      const { search } = request.nextUrl;
      const expired = error.path === "auth.getUser:rejected" ? "&reason=expired" : "";
      const login = new URL(
        `/login?next=${encodeURIComponent(pathname + search)}${expired}`,
        request.url,
      );
      return carry(NextResponse.redirect(login));
    }
    // READ_FAILED: the page makes its own auth read and reports the failure if it fails again.
    if (!(error instanceof LiveDataError)) throw error;
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/|favicon\\.ico$|.*\\..*).*)"],
};
