// The cockpit's one write to Twenty: a desk email that went out (or a network LinkedIn note) sets the person's lastContactedAt, which vibrana-crm
// decision D14 reserves for real outbound. Without it the CRM's "Contacted" step stayed at zero however many emails
// left the desk. The date only ever moves forward, and only people the desk wrote to are touched.
import type { SupabaseClient } from "@supabase/supabase-js";
import { must } from "../db";
import type { TwentyReader } from "../twenty";
import { selectAll } from "../team/mailbox";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const WRITEBACK_KEY = "pipeline.contacted";

export type SentDraft = {
  email_sent_at: string | null; email_bounced_at?: string | null; prospect: { twenty_person_id?: string | null } | null;
  /** The network stream (VIB-522) counts a LinkedIn note as contact too; client and guest LinkedIn notes do not. */
  track?: string | null; linkedin_sent_at?: string | null;
};

/** Latest send per Twenty person, from drafts sent at or after `since`. */
export function latestSends(drafts: SentDraft[], since: string): Map<string, string> {
  const out = new Map<string, string>();
  const add = (id: string, at: string) => { if (!out.has(id) || out.get(id)! < at) out.set(id, at); };
  for (const d of drafts) {
    const id = d.prospect?.twenty_person_id;
    if (!id || !UUID.test(id)) continue;
    // A bounced email never reached them: not contact.
    if (d.email_sent_at && d.email_sent_at >= since && !d.email_bounced_at) add(id, d.email_sent_at);
    if (d.track === "network" && d.linkedin_sent_at && d.linkedin_sent_at >= since) add(id, d.linkedin_sent_at);
  }
  return out;
}

export type WritebackRun = { checked: number; updated: number; skipped?: string };

export async function writeContacted(db: SupabaseClient, reader: TwentyReader, now: Date): Promise<WritebackRun> {
  const { data: state } = await db.from("gtm_sync_state").select("value").eq("key", WRITEBACK_KEY).maybeSingle();
  // A day of overlap: a send marked late (a desk click hours after the email) is still picked up.
  const since = new Date(Date.parse((state?.value as { at?: string } | null)?.at ?? "2026-10-01T00:00:00Z") - 86_400_000).toISOString();
  // Every sent draft in the window, 1000 at a time: a single read stopped at 1000 without a word (VIB-516).
  const drafts = await selectAll<SentDraft>((from, to) => db.from("gtm_outreach_drafts").select("email_sent_at,email_bounced_at,prospect")
    .gte("email_sent_at", since).not("email_sent_at", "is", null).order("id").range(from, to), "sent drafts");
  // Network LinkedIn notes are contact too (VIB-522: the CRM exporter's 90-day rule reads lastContactedAt).
  const notes = await selectAll<SentDraft>((from, to) => db.from("gtm_outreach_drafts").select("email_sent_at,email_bounced_at,prospect,track,linkedin_sent_at")
    .eq("track", "network").gte("linkedin_sent_at", since).not("linkedin_sent_at", "is", null).order("id").range(from, to), "sent network notes");
  drafts.push(...notes);
  const sends = latestSends(drafts, since);
  const run: WritebackRun = { checked: sends.size, updated: 0 };
  const ids = [...sends.keys()];
  for (let i = 0; i < ids.length; i += 25) {
    const batch = ids.slice(i, i + 25);
    const people = await reader.all<{ id: string; lastContactedAt: string | null }>("people", "id lastContactedAt", { id: { in: batch } }, "PersonFilterInput", 100, 100);
    for (const p of people) {
      const at = sends.get(p.id)!;
      if (p.lastContactedAt && Date.parse(p.lastContactedAt) >= Date.parse(at)) continue;
      await reader.read("mutation($id:UUID!,$t:DateTime){ updatePerson(id:$id, data:{ lastContactedAt:$t }) { id } }", { id: p.id, t: at });
      run.updated++;
    }
  }
  must(await db.from("gtm_sync_state").upsert({ key: WRITEBACK_KEY, value: { at: now.toISOString(), updated: run.updated }, updated_at: now.toISOString() }, { onConflict: "key" }), "save write-back cursor");
  return run;
}
