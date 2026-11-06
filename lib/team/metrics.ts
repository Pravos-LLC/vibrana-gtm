// Every number on /performance/team, computed from what the cron collected. Pure, so each rule is unit tested.
//
// Ground rules (adversarial review, 2026-11-04):
// - A source that is not connected or could not be read is null ("not measured"), never 0.
// - Quality leads: sendable contacts and meetings sit next to emails and replies; raw adds are secondary.
// - Keep/Maybe/Pass review labels are not measured: they are triage only, not an outreach input (VIB-481, 2026-11-04).
// - Stock fields (verified email, sendable) describe the member's records as they stand now, whoever enriched them.
// - Reply rate: replied threads over first-touch threads at least 7 days old, bounces excluded; hidden below 10.
import type { Activity } from "./crm";
import { conversations } from "./conversations";

export type MailEvent = { kind: "outreach" | "other_crm" | "reply" | "bounce"; at: string; thread_id: string; person_ids: string[]; message_key?: string | null; mailbox?: string | null };

/**
 * One logical conversation per send, whatever mailboxes saw it. A send observed in two of the member's mailboxes (a
 * send-as alias, a delegated mailbox: same keyed Message-ID) keeps its earliest observation; the other observation's
 * thread is merged into that one, so its replies, bounces and later sends join the same conversation, also across
 * chains of mailboxes (lib/team/conversations.ts). Threads are keyed by mailbox, since Gmail thread ids are per mailbox. Every reader calculation runs on this (review of #30, C2).
 */
export function logicalMail(mail: MailEvent[]): MailEvent[] {
  const convo = conversations(mail);
  const canon = new Map<string, MailEvent>();
  for (const e of mail) {
    if (e.kind !== "outreach" || !e.message_key) continue;
    const c = canon.get(e.message_key);
    if (!c || t(e.at) < t(c.at) || (t(e.at) === t(c.at) && (e.mailbox ?? "") < (c.mailbox ?? ""))) canon.set(e.message_key, e);
  }
  // Every event moves onto its conversation (threads linked by shared sends, transitively: review of #30, D2); a send's
  // other observations are dropped.
  return mail.flatMap((e) => (e.kind === "outreach" && e.message_key && canon.get(e.message_key) !== e ? [] : [{ ...e, thread_id: convo(e) }]));
}
export type DeskSend = { person: string; email_sent_at: string | null; linkedin_sent_at: string | null; email_sent_by: string | null; linkedin_sent_by: string | null };
export type StockRow = { date: string; metrics: Record<string, number> };

export const DAY = 86_400_000;
export const REPLY_MIN_N = 10;
export const REPLY_MATURE_DAYS = 7;

const t = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
const inRange = (iso: string | null | undefined, from: number, to: number) => { const v = t(iso); return v >= from && v < to; };
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export type Inputs = {
  activity: Activity | null;
  /** null when no mailbox is connected: email numbers are then not measured. */
  mail: MailEvent[] | null;
  /** Desk rows the member marked sent (email_sent_by or linkedin_sent_by is them). */
  desk: DeskSend[] | null;
  memberEmail: string;
  stock: StockRow[];
  periodDays: number;
  now: Date;
};

export type ReplyRate = { rate: number | null; replied: number; n: number };

/** Threads whose first outreach send is in [from, to) and at least 7 days before `now`; bounced threads are left out. */
export function replyRate(mail: MailEvent[], from: number, to: number, now: number): ReplyRate {
  const byThread = new Map<string, { first: number; replied: boolean; bounced: boolean }>();
  for (const e of mail) {
    const x = byThread.get(e.thread_id) ?? { first: Infinity, replied: false, bounced: false };
    if (e.kind === "outreach") x.first = Math.min(x.first, t(e.at));
    if (e.kind === "reply") x.replied = true;
    if (e.kind === "bounce") x.bounced = true;
    byThread.set(e.thread_id, x);
  }
  const mature = [...byThread.values()].filter((x) => x.first >= from && x.first < to && x.first <= now - REPLY_MATURE_DAYS * DAY && !x.bounced);
  const replied = mature.filter((x) => x.replied).length;
  return { rate: mature.length >= REPLY_MIN_N ? replied / mature.length : null, replied, n: mature.length };
}

/** Share of unanswered first touches that got a second send in the same thread 3 to 7 days later. */
export function followUpRate(mail: MailEvent[], from: number, to: number, now: number): { rate: number | null; n: number } {
  const threads = new Map<string, { sends: number[]; replyAt: number }>();
  for (const e of mail) {
    const x = threads.get(e.thread_id) ?? { sends: [], replyAt: Infinity };
    if (e.kind === "outreach") x.sends.push(t(e.at));
    if (e.kind === "reply" || e.kind === "bounce") x.replyAt = Math.min(x.replyAt, t(e.at));
    threads.set(e.thread_id, x);
  }
  let n = 0, followed = 0;
  for (const x of threads.values()) {
    if (!x.sends.length) continue;
    const first = Math.min(...x.sends);
    if (first < from || first >= to || first > now - 7 * DAY || x.replyAt < first + 3 * DAY) continue;
    n++;
    if (x.sends.some((s) => s >= first + 3 * DAY && s <= first + 7 * DAY)) followed++;
  }
  return { rate: n ? followed / n : null, n };
}

export type Window = { from: number; to: number };
export const windows = (now: Date, days: number): { cur: Window; prev: Window } => {
  const to = now.getTime(), from = to - days * DAY;
  return { cur: { from, to }, prev: { from: from - days * DAY, to: from } };
};

/** How far apart a desk mark and the mailbox's record of the same email can be (marked later, other time zone). */
export const DESK_MATCH_MS = 36 * 3_600_000;

/** Desk sends that are not already counted from the mailbox (same person, within 36 hours either way). */
export function deskOnly(desk: DeskSend[], mail: MailEvent[] | null, memberEmail: string): { at: string; channel: "email" | "linkedin"; person: string }[] {
  const me = memberEmail.toLowerCase();
  const sentTo = new Map<string, number[]>();
  for (const e of mail ?? []) if (e.kind === "outreach") for (const p of e.person_ids) sentTo.set(p, [...(sentTo.get(p) ?? []), t(e.at)]);
  const inMailbox = (person: string, at: string) => (sentTo.get(person) ?? []).some((x) => Math.abs(x - t(at)) <= DESK_MATCH_MS);
  return desk.flatMap((d) => [
    ...(d.email_sent_at && d.email_sent_by?.toLowerCase() === me && !inMailbox(d.person, d.email_sent_at) ? [{ at: d.email_sent_at, channel: "email" as const, person: d.person }] : []),
    ...(d.linkedin_sent_at && d.linkedin_sent_by?.toLowerCase() === me ? [{ at: d.linkedin_sent_at, channel: "linkedin" as const, person: d.person }] : []),
  ]);
}

export type Period = {
  contactsAdded: number | null; companiesAdded: number | null; notes: number | null;
  emailsSent: number | null; newThreads: number | null; otherCrmMail: number | null; replies: number | null; reply: ReplyRate | null;
  deskSent: number | null; meetings: number | null; activeDays: number | null; followUp: { rate: number | null; n: number } | null;
};

function period(i: Inputs, w: Window): Period {
  const a = i.activity, mail = i.mail;
  const count = <T>(rows: T[] | undefined, at: (r: T) => string | null, err?: string) => (a && !err && rows ? rows.filter((r) => inRange(at(r), w.from, w.to)).length : null);
  const outreach = mail?.filter((e) => e.kind === "outreach" && inRange(e.at, w.from, w.to)) ?? null;
  const firstSends = mail ? new Map<string, number>() : null;
  if (mail && firstSends) for (const e of mail) if (e.kind === "outreach") firstSends.set(e.thread_id, Math.min(firstSends.get(e.thread_id) ?? Infinity, t(e.at)));
  const desk = i.desk ? deskOnly(i.desk, mail, i.memberEmail).filter((d) => inRange(d.at, w.from, w.to)) : null;
  const days = new Set<string>();
  if (a) {
    for (const r of [...a.people, ...a.companies, ...a.notes, ...a.meetings]) if (inRange(r.createdAt, w.from, w.to)) days.add(r.createdAt.slice(0, 10));
  }
  for (const e of outreach ?? []) days.add(e.at.slice(0, 10));
  for (const d of desk ?? []) days.add(d.at.slice(0, 10));
  return {
    contactsAdded: count(a?.people, (r) => r.createdAt, a?.errors.people),
    companiesAdded: count(a?.companies, (r) => r.createdAt, a?.errors.companies),
    notes: count(a?.notes, (r) => r.createdAt, a?.errors.notes),
    // One message once, however many of the member's mailboxes saw it: teamReport projects copies away (logicalMail).
    emailsSent: outreach ? outreach.length : null,
    newThreads: firstSends ? [...firstSends.values()].filter((v) => v >= w.from && v < w.to).length : null,
    otherCrmMail: mail ? mail.filter((e) => e.kind === "other_crm" && inRange(e.at, w.from, w.to)).length : null,
    replies: mail ? mail.filter((e) => e.kind === "reply" && inRange(e.at, w.from, w.to)).length : null,
    reply: mail ? replyRate(mail, w.from, w.to, i.now.getTime()) : null,
    deskSent: desk ? desk.length : null,
    meetings: count(a?.meetings, (r) => r.createdAt, a?.errors.meetings),
    activeDays: a || mail || desk ? days.size : null,
    followUp: mail ? followUpRate(mail, w.from, w.to, i.now.getTime()) : null,
  };
}

export type Stock = {
  sendable: number | null; verified: number | null; withEmail: number | null; total: number | null;
  openTasks: number | null; overdueTasks: number | null; companiesNoOwner: number | null; unverified: number | null;
};

export function stock(a: Activity | null, now: Date): Stock {
  const p = a && !a.errors.people ? a.people : null, c = a && !a.errors.companies ? a.companies : null, tk = a && !a.errors.tasks ? a.tasks : null;
  return {
    total: p ? p.length : null,
    withEmail: p ? p.filter((x) => x.hasEmail).length : null,
    verified: p ? p.filter((x) => x.hasEmail && x.verification === "VERIFIED").length : null,
    sendable: p ? p.filter((x) => x.hasEmail && x.verification === "VERIFIED" && !x.notSendable).length : null,
    unverified: p ? p.filter((x) => x.verification !== "VERIFIED").length : null,
    openTasks: tk ? tk.filter((x) => x.status !== "DONE").length : null,
    overdueTasks: tk ? tk.filter((x) => x.status !== "DONE" && x.dueAt && t(x.dueAt) < now.getTime()).length : null,
    companiesNoOwner: c ? c.filter((x) => !x.hasOwner).length : null,
  };
}

/** Eight weekly buckets ending now, oldest first. */
export function weekly(i: Inputs, weeks = 8) {
  const end = i.now.getTime();
  return Array.from({ length: weeks }, (_, k) => {
    const to = end - (weeks - 1 - k) * 7 * DAY, from = to - 7 * DAY;
    const p = period(i, { from, to });
    return { week: dayOf(from), added: p.contactsAdded, emailed: p.emailsSent, replied: p.replies, meetings: p.meetings, activeDays: p.activeDays };
  });
}

export type Funnel = { label: string; value: number | null }[];

/** Over all of the member's records: added, has email, verified, emailed, replied, meetings, opportunities touched. */
export function funnel(i: Inputs): Funnel {
  const a = i.activity, s = stock(a, i.now);
  const mine = new Set(a?.people.map((p) => p.id) ?? []);
  const emailedThreads = new Map<string, string[]>();
  for (const e of i.mail ?? []) if (e.kind === "outreach") emailedThreads.set(e.thread_id, [...(emailedThreads.get(e.thread_id) ?? []), ...e.person_ids]);
  const repliedThreads = new Set((i.mail ?? []).filter((e) => e.kind === "reply").map((e) => e.thread_id));
  const emailed = new Set([...emailedThreads.values()].flat());
  const replied = new Set([...emailedThreads].filter(([th]) => repliedThreads.has(th)).flatMap(([, ps]) => ps));
  return [
    { label: "Contacts added", value: s.total },
    { label: "With an email", value: s.withEmail },
    { label: "Email verified", value: s.verified },
    { label: "Emailed (any CRM person)", value: i.mail ? emailed.size : null },
    { label: "Of those, added by them", value: i.mail && a ? [...emailed].filter((p) => mine.has(p)).length : null },
    { label: "Replied", value: i.mail ? replied.size : null },
    { label: "Meetings", value: a && !a.errors.meetings ? a.meetings.length : null },
    { label: "Opportunities touched", value: a && !a.errors.opportunities ? a.opportunities.length : null },
  ];
}

/** Median days from a person being added to the first outreach email to them (people the member added and emailed). */
export function daysToFirstTouch(i: Inputs): number | null {
  if (!i.activity || !i.mail) return null;
  const first = new Map<string, number>();
  for (const e of i.mail) if (e.kind === "outreach") for (const p of e.person_ids) first.set(p, Math.min(first.get(p) ?? Infinity, t(e.at)));
  const gaps = i.activity.people.flatMap((p) => (first.has(p.id) ? [Math.max(0, (first.get(p.id)! - t(p.createdAt)) / DAY)] : []));
  const m = median(gaps);
  return m == null ? null : Math.round(m * 10) / 10;
}

/** Pipeline value on opportunities the member's work touches, by currency, excluding LOST. */
export function pipelineValue(a: Activity | null): { currency: string; amount: number; count: number }[] | null {
  if (!a || a.errors.opportunities) return null;
  const by = new Map<string, { amount: number; count: number }>();
  for (const o of a.opportunities) {
    if (o.stage === "LOST") continue;
    const k = o.currency ?? "n/a", x = by.get(k) ?? { amount: 0, count: 0 };
    x.amount += o.amount ?? 0; x.count++;
    by.set(k, x);
  }
  return [...by].map(([currency, x]) => ({ currency, ...x }));
}

export type TimelineItem = { day: string; kind: string; personId: string | null; companyId: string | null };

/** The last counted things, by day only (never the hour), newest first. */
export function timeline(i: Inputs, limit = 25): TimelineItem[] {
  const items: (TimelineItem & { at: number })[] = [];
  for (const e of i.mail ?? []) items.push({ at: t(e.at), day: e.at.slice(0, 10), kind: { outreach: "Outreach email", other_crm: "Other CRM mail", reply: "Reply received", bounce: "Bounce" }[e.kind], personId: e.person_ids[0] ?? null, companyId: null });
  for (const d of i.desk ? deskOnly(i.desk, i.mail, i.memberEmail) : []) items.push({ at: t(d.at), day: d.at.slice(0, 10), kind: d.channel === "email" ? "Desk email marked sent" : "LinkedIn invite marked sent", personId: d.person, companyId: null });
  for (const p of i.activity?.people ?? []) items.push({ at: t(p.createdAt), day: p.createdAt.slice(0, 10), kind: "Contact added", personId: p.id, companyId: null });
  for (const c of i.activity?.companies ?? []) items.push({ at: t(c.createdAt), day: c.createdAt.slice(0, 10), kind: "Company added", personId: null, companyId: c.id });
  for (const m of i.activity?.meetings ?? []) items.push({ at: t(m.createdAt), day: m.createdAt.slice(0, 10), kind: "Meeting captured", personId: null, companyId: null });
  return items.filter((x) => Number.isFinite(x.at)).sort((x, y) => y.at - x.at).slice(0, limit).map(({ at: _at, ...x }) => x);
}

export function teamReport(input: Inputs) {
  const i: Inputs = { ...input, mail: input.mail ? logicalMail(input.mail) : null };
  const { cur, prev } = windows(i.now, i.periodDays);
  const last = [...i.stock].sort((a, b) => a.date.localeCompare(b.date));
  return {
    cur: period(i, cur), prev: period(i, prev), stock: stock(i.activity, i.now), weekly: weekly(i), funnel: funnel(i),
    daysToFirstTouch: daysToFirstTouch(i), pipeline: pipelineValue(i.activity), timeline: timeline(i),
    stockSeries: (k: string) => last.slice(-8).map((s) => s.metrics[k] ?? null),
  };
}
