// Supabase browser client — used ONLY for auth (managed sign-up / sign-in /
// session). All database access goes through our FastAPI backend, not from here.
//
// The URL + anon key are public and fetched at runtime from /api/config (like the
// PostHog key), so they aren't baked into the build and login can be toggled
// entirely from the backend env. If they aren't configured, getSupabase() resolves
// to null and the app hides every account feature (anonymous practice is unaffected).

import type { SupabaseClient } from "@supabase/supabase-js";

let clientPromise: Promise<SupabaseClient | null> | null = null;

async function create(): Promise<SupabaseClient | null> {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) return null;
    const cfg = (await res.json()) as { supabase_url?: string; supabase_anon_key?: string };
    if (!cfg.supabase_url || !cfg.supabase_anon_key) return null;
    const { createClient } = await import("@supabase/supabase-js");
    return createClient(cfg.supabase_url, cfg.supabase_anon_key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Required by the Google sign-in flow: the provider bounces the browser
        // back to us with the session in the URL, and this is what reads it out
        // (and then scrubs the URL). It's a no-op on an ordinary page load.
        //
        // Deliberately left on the default implicit flow rather than PKCE. PKCE
        // stores its verifier in the localStorage of the browser that started
        // the flow, which would break the common case of a student signing up on
        // a laptop and opening the confirmation email on their phone.
        detectSessionInUrl: true,
      },
    });
  } catch {
    return null; // login simply stays disabled if config can't be read
  }
}

/** Memoized Supabase client (or null if login isn't configured). */
export function getSupabase(): Promise<SupabaseClient | null> {
  if (!clientPromise) clientPromise = create();
  return clientPromise;
}

/**
 * A fresh access token (JWT) for the signed-in user, or null when logged out.
 * Reads from getSession() each call so the token is always current (supabase-js
 * auto-refreshes it) — api.ts uses this to authorize backend calls.
 */
export async function getAccessToken(): Promise<string | null> {
  const sb = await getSupabase();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session?.access_token ?? null;
}
