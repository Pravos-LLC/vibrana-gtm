import { assertDemoDatabase, demoDatabaseFetch } from "./lib/demo-safety";
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { teamMayOpen } from "@/lib/signals/access";
import { isReviewer, publicPath, reviewerMayOpen } from "@/lib/reviewer/access";
import { applyEmudhraTrustGuard } from "@/lib/security/emudhra-trust-guard";

// The proxy can run as its own function, so it applies the eMudhra trust guard itself.
applyEmudhraTrustGuard();

// Refreshes the Supabase session and gates every page on the gtm_owner app_metadata claim
// (gtm_team members reach /signals only; a third-party reviewer reaches /shared only; signed out, /login and a
// review link /invite/<token>).
export async function proxy(request: NextRequest) {
  // Visual-check fixtures (never compiled into a production build, see next.config.ts) skip login.
  if (process.env.NODE_ENV !== "production" && process.env.CONTENT_FIXTURES === "1" && request.nextUrl.pathname.startsWith("/dev-fixtures/")) return NextResponse.next();
  assertDemoDatabase(process.env.NEXT_PUBLIC_SUPABASE_URL);
  let response = NextResponse.next({ request });
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    global: { fetch: demoDatabaseFetch() },
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        list.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });
  // A malformed or tampered token (e.g. alg "none") makes getClaims throw: treat it as signed out.
  const { data } = await supabase.auth.getClaims().catch(() => ({ data: null }));
  const owner = (data?.claims?.app_metadata as { gtm_owner?: boolean } | undefined)?.gtm_owner === true;
  // A gtm_team member (not the owner) may use the Signal Desk and nothing else.
  const team = !owner && (data?.claims?.app_metadata as { gtm_team?: boolean } | undefined)?.gtm_team === true;
  // A third-party reviewer (an accepted review link) may open /shared and nothing else.
  const reviewer = !owner && !team && isReviewer(data?.claims?.app_metadata);
  const path = request.nextUrl.pathname;
  if (team) return teamMayOpen(path) ? response : NextResponse.redirect(new URL("/signals", request.url));
  if (reviewer) return reviewerMayOpen(path) ? response : NextResponse.redirect(new URL("/shared", request.url));
  if (!owner && !publicPath(path)) return NextResponse.redirect(new URL("/login", request.url));
  if (owner && path === "/login") return NextResponse.redirect(new URL("/", request.url));
  return response;
}

export const config = {
  // API routes authenticate themselves (cron secret / webhook signature).
  matcher: ["/((?!api/|_next/static|_next/image|favicon\\.|.*\\.(?:png|webp|svg|jpg|ico)$).*)"],
};
