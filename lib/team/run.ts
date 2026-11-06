// The team cron's work (app/api/cron/team, hourly): for each configured member, read their CRM activity into the cache
// the page shows, sync their mailbox if they connected one, write today's stock snapshot, and report any new API key
// name writing to Twenty. Every step is nonfatal: a failure is recorded for that step and the others still run.
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertLiveProvidersAllowed, providerFetch } from "../demo-safety";
import { must } from "../db";
import { TwentyReader } from "../twenty";
import { collectActivity, loadActivity, newApiWriters, recentApiWriters, saveActivity, saveApiWriters } from "./crm";
import { gmailConfig, syncMailbox, type MailboxRow, type SyncResult } from "./mailbox";
import { stock } from "./metrics";
import type { TeamMember } from "./members";
import { runEmailHealth, type HealthRun } from "../email/run";

export type TeamRun = Record<string, { activity?: string; mailbox?: SyncResult[] | string; stock?: string }> & { _keys?: { new: string[]; error?: string }; _health?: HealthRun | { error: string } };

export async function runTeam(db: SupabaseClient, members: TeamMember[], opts: { now?: Date; deadline: number; notify?: { to: string; from: string } }): Promise<TeamRun> {
  const now = opts.now ?? new Date();
  const reader = new TwentyReader({ deadline: opts.deadline - 5_000 });
  const out: TeamRun = {};
  // Keep the last part of the budget for the API key check.
  const membersEnd = opts.deadline - 20_000;
  for (const [i, m] of members.entries()) {
    const r: TeamRun[string] = (out[m.code] = {});
    // A fair share of what is left, so one member's long backfill cannot starve the next.
    const share = Math.max(0, (membersEnd - Date.now()) / (members.length - i));
    const memberDeadline = Date.now() + share;
    reader.setDeadline(memberDeadline);
    try {
      const a = await collectActivity(reader, m, now);
      const failed = Object.keys(a.errors);
      // A failed read never replaces a good one: the page keeps showing the last complete read, with its time.
      const previous = failed.length ? await loadActivity(db, m.code).catch(() => null) : null;
      if (failed.length && previous) {
        r.activity = `kept the read from ${previous.capturedAt}; could not read ${failed.join(", ")}`;
        r.stock = "skipped";
      } else {
        await saveActivity(db, a);
        r.activity = failed.length ? `partial: ${failed.join(", ")}` : "ok";
        const s = stock(a, now);
        must(await db.from("gtm_team_stock_daily").upsert({ member: m.code, date: now.toISOString().slice(0, 10), captured_at: now.toISOString(), metrics: {
          sendable: s.sendable, verified: s.verified, with_email: s.withEmail, people: s.total,
          open_tasks: s.openTasks, overdue_tasks: s.overdueTasks, companies_no_owner: s.companiesNoOwner,
        } }, { onConflict: "member,date" }), "stock snapshot");
        r.stock = failed.length ? "partial" : "ok";
      }
    } catch (e) { r.activity ??= `error: ${(e as Error).message.slice(0, 200)}`; r.stock ??= "skipped"; }

    try {
      const cfg = gmailConfig();
      const boxes = must(await db.from("gtm_team_mailboxes").select("member,address,token_ciphertext,history_id,backfill_done,last_sync_at,granted_scopes").eq("member", m.code), "mailboxes") as MailboxRow[];
      if (!boxes.length) r.mailbox = "not connected";
      else if (!cfg) r.mailbox = "TEAM_GMAIL_CLIENT_ID / TEAM_GMAIL_CLIENT_SECRET are not set";
      else {
        r.mailbox = [];
        for (const b of boxes) r.mailbox.push(await syncMailbox(db, m, b, reader, { cfg, now, deadline: memberDeadline - 5_000 }));
      }
    } catch (e) { r.mailbox = `error: ${(e as Error).message.slice(0, 200)}`; }
  }
  // Email health (VIB-511): bounce rate, collection problems, daily DNS. Its own failure never fails the run.
  if (opts.notify) {
    try { out._health = await runEmailHealth(db, members, { now, mail: opts.notify }); } catch (e) { out._health = { error: (e as Error).message.slice(0, 200) }; }
  }
  reader.setDeadline(opts.deadline - 5_000);
  try {
    const { fresh, all } = await newApiWriters(db, await recentApiWriters(reader, now));
    out._keys = { new: fresh };
    if (fresh.length && opts.notify) await alertNewKeys(fresh, opts.notify);
    await saveApiWriters(db, all, now);
  } catch (e) { out._keys = { new: out._keys?.new ?? [], error: (e as Error).message.slice(0, 200) }; }
  return out;
}

async function alertNewKeys(names: string[], mail: { to: string; from: string }) {
  assertLiveProvidersAllowed();
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("new API key alert: RESEND_API_KEY is not set");
  const text = `New API key writing to Twenty: ${names.join(", ")}.\n\nTeam performance attributes CRM rows by API key name (GTM_TEAM_MEMBERS apiKeyNames). If this key belongs to a team member, add it to their entry, or their work will not be counted.`;
  const res = await providerFetch()("https://api.resend.com/emails", {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": `team-keys/${names.join(",")}` },
    body: JSON.stringify({ from: mail.from, to: mail.to.split(",").map((s) => s.trim()).filter(Boolean), subject: `New Twenty API key: ${names.join(", ")}`.slice(0, 180), text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`new API key alert: Resend ${res.status}`);
}
