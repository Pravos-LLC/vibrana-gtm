import { providerFetch } from "../demo-safety";

/** One call to the cockpit's Claude Code engage API (ENGAGE_AGENT_TOKEN bearer). Returns the JSON body, throws on failure. */
export async function agentCall(body: Record<string, unknown>, opts: { url?: string; token?: string; fetcher?: typeof fetch } = {}) {
  const base = opts.url ?? process.env.GTM_COCKPIT_URL;
  const token = opts.token ?? process.env.ENGAGE_AGENT_TOKEN;
  if (!base || !token) throw new Error("GTM_COCKPIT_URL and ENGAGE_AGENT_TOKEN are required for Claude Code engage");
  const res = await providerFetch(opts.fetcher)(`${base.replace(/\/$/, "")}/api/engage/agent`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) throw new Error(`engage ${body.verb} ${res.status}: ${String(data.error ?? "failed")}`);
  return data;
}
