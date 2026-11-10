// Origami API v3 (https://origami.chat/api/v3), the reads the opt-out work needs and the one write: stopping a sequence
// (VIB-521). Requests are serial and paced, because Origami's org bucket (100 a minute) is shared with everyone using the
// account; a 429 waits for Retry-After, a 5xx or network failure backs off, and nothing runs past the caller's deadline.
// Errors carry the HTTP status and Origami's machine code only, never a query string (a search names a person) or a body.
import { assertLiveProvidersAllowed } from "../demo-safety";

export const ORIGAMI_BASE = "https://origami.chat/api/v3";

export type Campaign = { id: string; status: string; channels?: string[] };
export type PersonRow = { sequence_id: string; status: string; stop_reason: string | null; recipient?: string | null; identity?: { linkedin_url?: string | null } | null };
export type Step = { step_index?: number; channel?: string; status: string };
export type Reply = { id: string; from: string; channel: string; campaign_id: string | null; sequence_id: string; body: string; received_at: string };
export type PersonDetail = {
  sequence_id: string; status: string; stop_reason: string | null;
  identity?: { email?: string | null; linkedin_url?: string | null } | null;
  steps?: Step[]; replies?: Reply[];
};
type List<T> = { items: T[]; next_cursor: string | null };

export class OrigamiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) { super(message); }
}

/** The run's time is up. Not a failure of the item being worked on: callers defer it without counting an attempt. */
export class DeadlineError extends Error {}

/** Whether an error only means the run ran out of time (Origami's or Twenty's reader). */
export const isDeadline = (e: unknown) => e instanceof DeadlineError || (e instanceof Error && /stopped at the run deadline/.test(e.message));

export type ClientOpts = {
  key?: string; pauseMs?: number; retries?: number; deadline?: number; timeoutMs?: number; maxWaitMs?: number;
  fetcher?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number;
};

/** Seconds or an HTTP date, as milliseconds from now; null when absent or unreadable. */
export function retryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export class OrigamiClient {
  private chain: Promise<unknown> = Promise.resolve();
  private last = 0;
  readonly requests = { count: 0, writes: 0 };
  constructor(private opts: ClientOpts = {}) {}

  setDeadline(deadline: number | undefined) { this.opts.deadline = deadline; }

  private request<T>(method: "GET" | "POST", path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const run = this.chain.then(() => this.send<T>(method, path, body, idempotencyKey));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async send<T>(method: "GET" | "POST", path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    assertLiveProvidersAllowed();
    const key = this.opts.key ?? process.env.ORIGAMI_API_KEY;
    if (!key) throw new Error("ORIGAMI_API_KEY is not set");
    const now = this.opts.now ?? Date.now, sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const pause = this.opts.pauseMs ?? 1000, retries = this.opts.retries ?? 4, maxWait = this.opts.maxWaitMs ?? 60_000;
    const what = `${method} ${path.split("?")[0]}`;
    for (let attempt = 0; ; attempt++) {
      const wait = this.last + pause - now();
      if (wait > 0) await sleep(wait);
      if (this.opts.deadline && now() > this.opts.deadline) throw new DeadlineError(`Origami: stopped at the run deadline (${what})`);
      this.requests.count++;
      if (method === "POST") this.requests.writes++;
      let res: Response | null = null, failure = "";
      try {
        res = await (this.opts.fetcher ?? globalThis.fetch)(`${ORIGAMI_BASE}${path}`, {
          method, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
          headers: { authorization: `Bearer ${key}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (e) { failure = (e as Error).message.slice(0, 80); }
      this.last = now();
      if (res && res.ok) return (await res.json().catch(() => ({}))) as T;
      const status = res?.status ?? 0;
      const json = res ? await res.json().catch(() => null) as { code?: string } | null : null;
      const code = typeof json?.code === "string" ? json.code.slice(0, 60) : null;
      const transient = !status || status === 429 || status === 408 || status >= 500 || code === "IDEMPOTENCY_PENDING";
      if (!transient || attempt >= retries) throw new OrigamiError(`Origami ${what}: ${status || failure || "no response"}${code ? ` ${code}` : ""}`, status, code);
      const hinted = retryAfterMs(res?.headers.get("retry-after") ?? null, now());
      const delay = Math.min(maxWait, hinted ?? 2_000 * 2 ** attempt);
      if (this.opts.deadline && now() + delay > this.opts.deadline) throw new DeadlineError(`Origami ${what}: ${status}; stopped at the run deadline rather than wait to retry`);
      await sleep(delay);
    }
  }

  /** Every item of a list, following next_cursor. Refuses to return a silently truncated list. */
  async all<T>(path: string, params: Record<string, string | undefined> = {}, maxPages = 100): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | null = null;
    for (let page = 0; ; page++) {
      if (page >= maxPages) throw new Error(`Origami ${path.split("?")[0]}: more than ${maxPages} pages; refusing to return a truncated list`);
      const q = new URLSearchParams(Object.entries({ ...params, limit: "100", cursor: cursor ?? undefined }).filter((e): e is [string, string] => e[1] != null));
      const r: List<T> = await this.request<List<T>>("GET", `${path}?${q}`);
      out.push(...(r.items ?? []));
      if (!r.next_cursor || r.next_cursor === cursor) return out;
      cursor = r.next_cursor;
    }
  }

  campaigns() { return this.all<Campaign>("/send/campaigns"); }
  people(campaignId: string, filter: { search?: string; status?: string } = {}) { return this.all<PersonRow>(`/send/campaigns/${enc(campaignId)}/people`, filter); }
  person(campaignId: string, sequenceId: string) { return this.request<PersonDetail>("GET", `/send/campaigns/${enc(campaignId)}/people/${enc(sequenceId)}`); }
  /** Lead replies, newest first (keyset on received_at, id). `since` is an ISO timestamp. */
  replies(since?: string) { return this.all<Reply>("/send/replies", { from: "lead", since }); }
  /** One page for the resumable poll. The caller persists a checkpoint only after recording the page. */
  repliesPage(since?: string, cursor?: string | null) {
    const q = new URLSearchParams({ from: "lead", limit: "100" });
    if (since) q.set("since", since);
    if (cursor) q.set("cursor", cursor);
    return this.request<List<Reply>>("GET", `/send/replies?${q}`);
  }
  /** POST .../people/{sequence_id}/stop: no further steps, history kept (docs: send-campaigns-people-stop). */
  stop(campaignId: string, sequenceId: string, idempotencyKey: string) {
    return this.request<Record<string, unknown>>("POST", `/send/campaigns/${enc(campaignId)}/people/${enc(sequenceId)}/stop`, {}, idempotencyKey);
  }
}

const enc = (id: string) => {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Origami: an id is not a UUID");
  return id.toLowerCase();
};

export const origamiConfigured = (env: Record<string, string | undefined> = process.env) => !!env.ORIGAMI_API_KEY;
export const origamiApplyEnabled = (env: Record<string, string | undefined> = process.env) => env.ORIGAMI_OPTOUT_APPLY === "1";

/** The LinkedIn profile slug of a URL or a bare slug, lowercase; null when there is none. */
export function linkedinSlug(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim();
  const m = s.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  let slug = m ? m[1] : /^[A-Za-z0-9%_.-]{2,100}$/.test(s) && !s.includes("@") ? s : null;
  if (!slug) return null;
  try { slug = decodeURIComponent(slug); } catch { /* keep as typed */ }
  return slug.toLowerCase().replace(/\/+$/, "") || null;
}

// A sequence that will send nothing more: a terminal status, or any stop_reason (Origami stopped it: "replied",
// "unsubscribed", "manual", "bounced", "linkedin_prior_contact", ... as read on production 2026-11-10), or a non-empty step
// list with every step done. Steps still waiting (draft, scheduled, not_connected, ...), and an empty or missing step list
// (a draft whose copy is not rendered yet sends once launched), keep a sequence with no stop reason live: it is stopped.
const TERMINAL = new Set(["stopped", "unsubscribed", "bounced", "completed", "cancelled", "canceled", "removed"]);
const STEP_DONE = new Set(["sent", "accepted", "stopped", "skipped", "failed", "bounced", "cancelled", "canceled", "replied", "delivered", "removed"]);

/** Whether a sequence can still send. Pure. */
export function settled(p: { status: string; stop_reason?: string | null; steps?: Step[] | null }): boolean {
  if (TERMINAL.has(p.status) || (typeof p.stop_reason === "string" && p.stop_reason.length > 0)) return true;
  if (!Array.isArray(p.steps) || !p.steps.length) return false;
  return p.steps.every((s) => STEP_DONE.has(s.status));
}

/** A list row that is already settled by its status or stop reason needs no detail read. */
export const settledRow = (p: { status: string; stop_reason?: string | null }) => settled({ ...p, steps: null });
