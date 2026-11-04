// The team cron's work (app/api/cron/team, hourly): for each configured member, read their CRM activity into the cache
// the page shows, sync their mailbox if they connected one, write today's stock snapshot, and report any new API key
// name writing to Twenty. Every step is nonfatal: a failure is recorded for that step and the others still run.
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertLiveProvidersAllowed, providerFetch } from "../demo-safety";
import { must } from "../db";
import { TwentyReader } from "../twenty";
import { collectActivity, newApiWriters, recentApiWriters, saveActivity } from "./crm";
import { gmailConfig, syncMailbox, type MailboxRow, type SyncResult } from "./mailbox";
import { stock } from "./metrics";
import type { TeamMember } from "./members";

export type TeamRun = Record<string, { activity?: string; mailbox?: SyncResult[] | string; stock?: string }> & { _keys?: { new: string[]; error?: string } };

export async function runTeam(db: SupabaseClient, members: TeamMember[], opts: { now?: Date; deadline: number; notify?: { to: string; from: string } }): Promise<TeamRun> {
  const now = opts.now ?? new Date();
  const reader = new TwentyReader({ deadline: opts.deadline - 5_000 });
  const out: TeamRun = {};
  for (const m of members) {
    const r: TeamRun[string] = (out[m.code] = {});
    try {
      const a = await collectActivity(reader, m, now);
      await saveActivity(db, a);
      r.activity = Object.keys(a.errors).length ? `partial: ${Object.keys(a.errors).join(", ")}` : "ok";
      const s = stock(a, now);
      must(await db.from("gtm_team_stock_daily").upsert({ member: m.code, date: now.toISOString().slice(0, 10), captured_at: now.toISOString(), metrics: {
        sendable: s.sendable, verified: s.verified, with_email: s.withEmail, people: s.total, reviewed: s.reviewed, keep: s.keep, unreviewed: s.unreviewed,
        unreviewed_over_14: s.unreviewedOver14, open_tasks: s.openTasks, overdue_tasks: s.overdueTasks, companies_no_owner: s.companiesNoOwner,
        stage_mix: s.stageMix,
      } }, { onConflict: "member,date" }), "stock snapshot");
      r.stock = "ok";
    } catch (e) { r.activity ??= `error: ${(e as Error).message.slice(0, 200)}`; r.stock ??= "skipped"; }

    const cfg = gmailConfig();
    const boxes = must(await db.from("gtm_team_mailboxes").select("member,address,token_ciphertext,history_id,backfill_done,last_sync_at").eq("member", m.code), "mailboxes") as MailboxRow[];
    if (!boxes.length) r.mailbox = "not connected";
    else if (!cfg) r.mailbox = "TEAM_GMAIL_CLIENT_ID / TEAM_GMAIL_CLIENT_SECRET are not set";
    else {
      r.mailbox = [];
      for (const b of boxes) r.mailbox.push(await syncMailbox(db, m, b, reader, { cfg, now, deadline: opts.deadline - 10_000 }));
    }
  }
  try {
    const fresh = await newApiWriters(db, await recentApiWriters(reader, now), now);
    out._keys = { new: fresh };
    if (fresh.length && opts.notify) await alertNewKeys(fresh, opts.notify);
  } catch (e) { out._keys = { new: [], error: (e as Error).message.slice(0, 200) }; }
  return out;
}

async function alertNewKeys(names: string[], mail: { to: string; from: string }) {
  assertLiveProvidersAllowed();
  const key = process.env.RESEND_API_KEY;
  if (!key) return;
  const text = `New API key writing to Twenty: ${names.join(", ")}.\n\nTeam performance attributes CRM rows by API key name (GTM_TEAM_MEMBERS apiKeyNames). If this key belongs to a team member, add it to their entry, or their work will not be counted.`;
  await providerFetch()("https://api.resend.com/emails", {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": `team-keys/${names.join(",")}` },
    body: JSON.stringify({ from: mail.from, to: mail.to.split(",").map((s) => s.trim()).filter(Boolean), subject: `New Twenty API key: ${names.join(", ")}`.slice(0, 180), text }),
    signal: AbortSignal.timeout(20_000),
  });
}
