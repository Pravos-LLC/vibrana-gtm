/** Server provider boundary. Keep this independent of demo fixtures and private content. */
export function assertLiveProvidersAllowed(): void {
  if (process.env.DEMO_MODE === "1") throw new Error("Demo mode: live providers are disabled");
}

/** Wrap the selected transport, including injected fetchers, without changing global fetch. */
export function providerFetch(fetcher: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    assertLiveProvidersAllowed();
    return fetcher(input, init);
  };
}

/** The demo uses the dedicated local stack created by scripts/demo.mjs only. */
export function assertDemoDatabase(url: string | undefined): void {
  if (process.env.DEMO_MODE !== "1") return;
  let parsed: URL;
  try { parsed = new URL(url ?? ""); } catch { throw new Error("Demo mode: requires the local Supabase stack"); }
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
    || parsed.port !== "61321" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Demo mode: requires loopback Supabase on port 61321");
  }
}

/** Recheck at request time too, and refuse redirects away from the checked local URL. */
export function demoDatabaseFetch(fetcher: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    if (process.env.DEMO_MODE === "1") {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      assertDemoDatabase(url.origin);
      return fetcher(input, { ...init, redirect: "error" });
    }
    return fetcher(input, init);
  };
}
