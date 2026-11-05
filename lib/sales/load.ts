// What the /pipeline tabs read, in one place: settings, deals (live from Twenty), milestones, stage history, desk rows,
// LinkedIn metadata, meetings and site days. Every source reports its own failure; one broken read never blanks the page.
import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAll } from "../team/mailbox";
import { teamMembers } from "../team/members";
import { salesDeals, type DealRead, type Owner } from "./deals";
import type { Milestone } from "./economics";
import { salesMeetings, type MeetingRead } from "./meetings";
import type { DeskRow, LinkedInConnection, LinkedInThread, PeriodKey, WebDay } from "./metrics";
import { loadSalesSettings } from "./settings";
import { loadStageHistory, type StageRow } from "./stages";

export type Loaded<T> = { data: T; error: null } | { data: null; error: string };
const settle = async <T>(p: Promise<T>): Promise<Loaded<T>> => {
  try { return { data: await p, error: null }; } catch (e) { return { data: null, error: (e as Error).message.slice(0, 240) }; }
};

export const parseOwner = (v: string | undefined): Owner | null => (v === "JOHN" || v === "ABE" ? v : null);
export const parsePeriod = (v: string | undefined): PeriodKey => (v === "90" || v === "qtd" ? v : "30");

/** Desk sends are marked by a login or sent from a mailbox; a team member's address means them, anything else is John. */
export function ownerOfSender(): (by: string | null) => Owner {
  let members: ReturnType<typeof teamMembers> = [];
  try { members = teamMembers(); } catch { members = []; }
  const map = new Map<string, Owner>();
  for (const m of members) if (m.code === "ABE" || m.code === "JOHN") for (const a of [m.authEmail, ...m.mailboxes]) map.set(a.toLowerCase(), m.code);
  return (by) => (by ? map.get(by.toLowerCase()) ?? "JOHN" : "JOHN");
}

export const loadDeals = (timeoutMs = 8_000): Promise<Loaded<DealRead>> => settle(salesDeals({ timeoutMs }));
export const loadMeetings = (since: Date): Promise<Loaded<MeetingRead>> => settle(salesMeetings(since));
export const loadSettings = (db: SupabaseClient) => loadSalesSettings(db);
export const loadMilestones = (db: SupabaseClient): Promise<Loaded<Milestone[]>> =>
  settle(selectAll<Milestone>((from, to) => db.from("gtm_deal_milestones").select("*").order("id").range(from, to), "milestones")
    .then((rows) => rows.map((m) => ({ ...m, amount: Number(m.amount), paid_amount: m.paid_amount == null ? null : Number(m.paid_amount) }))));
export const loadHistory = (db: SupabaseClient): Promise<Loaded<StageRow[]>> => settle(loadStageHistory(db));
export const loadDesk = (db: SupabaseClient, since: Date): Promise<Loaded<DeskRow[]>> =>
  settle(selectAll<DeskRow>((from, to) => db.from("gtm_outreach_drafts")
    .select("track,route,email_sent_at,email_sent_by,follow_up_sent_at,email_replied_at,email_bounced_at,reply_sentiment,linkedin_sent_at,linkedin_sent_by,linkedin_status")
    .or(`email_sent_at.gte.${since.toISOString()},linkedin_sent_at.gte.${since.toISOString()},email_replied_at.gte.${since.toISOString()},follow_up_sent_at.gte.${since.toISOString()}`)
    .order("id").range(from, to), "desk sends"));
export const loadLinkedIn = (db: SupabaseClient, since: Date) => settle(Promise.all([
  selectAll<LinkedInConnection>((from, to) => db.from("gtm_linkedin_connections").select("owner,connected_on,icp,person_id").gte("connected_on", since.toISOString().slice(0, 10)).order("owner").order("profile_hash").range(from, to), "LinkedIn connections"),
  selectAll<LinkedInThread>((from, to) => db.from("gtm_linkedin_threads").select("owner,first_at,last_at,started_by_owner,two_way,icp,person_id").gte("first_at", since.toISOString()).order("owner").order("thread_hash").range(from, to), "LinkedIn threads"),
  db.from("gtm_sync_state").select("value,updated_at").like("key", "linkedin.import.%").then((r) => (r.data ?? []) as { value: { exported_at?: string; imported_at?: string }; updated_at: string }[]),
]).then(([connections, threads, imports]) => ({ connections, threads, lastImport: imports.map((i) => i.value?.imported_at ?? i.updated_at).sort().at(-1) ?? null })));
export const loadWeb = (db: SupabaseClient, since: Date): Promise<Loaded<WebDay[]>> =>
  settle(selectAll<WebDay>((from, to) => db.from("gtm_web_daily").select("site,day,visitors,pageviews,high_intent,paths,referrers,utm").gte("day", since.toISOString().slice(0, 10)).order("site").order("day").range(from, to), "site days"));

/** Inbound inquiries from the website (sprint and enterprise forms), counted per week; read with the secret key. */
export const loadInquiries = (admin: SupabaseClient, since: Date): Promise<Loaded<{ created_at: string }[]>> =>
  settle(selectAll<{ created_at: string }>((from, to) => admin.from("engagement_inquiries").select("created_at").gte("created_at", since.toISOString()).order("created_at").order("id").range(from, to), "inquiries"));
