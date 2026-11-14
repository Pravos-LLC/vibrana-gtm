import Link from "next/link";
import { StatTile } from "@/components/stat-tile";
import { Pending, Source } from "@/components/performance/team-parts";
import { Bar, Section, Shell, Table, fmt } from "@/components/shell";
import { Card } from "@/components/ui/card";
import { TrendChart } from "@/components/performance/trend-chart";
import { TwentyLink } from "@/components/crm/people";
import { sessionDb } from "@/lib/supabase/server";
import { loadActivity } from "@/lib/team/crm";
import { canReadBodies, selectAll } from "@/lib/team/mailbox";
import { loadOutcomes, outcomesV2 } from "@/lib/email/load";
import { BOUNCE_ALERT } from "@/lib/email/metrics";
import { memberByCode, teamMembers, type TeamMember } from "@/lib/team/members";
import { REPLY_MATURE_DAYS, REPLY_MIN_N, teamReport, type DeskSend, type MailEvent, type Period, type StockRow } from "@/lib/team/metrics";
import { cn } from "@/lib/ui/cn";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
export const metadata = { title: "Team" };

const PERIODS = [7, 30, 90] as const;
const pct = (x: number | null | undefined) => (x == null ? null : `${Math.round(x * 100)}%`);
const plural = (n: number, one: string, many: string) => `${fmt(n)} ${n === 1 ? one : many}`;
const delta = (cur: number | null, prev: number | null, days: number, goodWhen: "up" | "down" = "up") =>
  cur == null || prev == null ? null : { value: cur - prev, label: `vs previous ${days} days`, goodWhen };
const ago = (iso: string | null | undefined) => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 90 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

type MailboxStatus = { address: string; connected_at: string; last_sync_at: string | null; last_error: string | null; backfill_done: boolean; granted_scopes: string[] | null };
export default async function TeamPage({ searchParams }: { searchParams: Promise<{ member?: string; days?: string }> }) {
  const sp = await searchParams;
  let members: TeamMember[] = [], configError: string | null = null;
  try { members = teamMembers(); } catch (e) { configError = (e as Error).message; }
  const member = memberByCode(members, sp.member) ?? members[0] ?? null;
  const days = (PERIODS as readonly number[]).includes(Number(sp.days)) ? Number(sp.days) : 30;

  if (!member) {
    return (
      <Shell title="Team" active="/performance/team">
        <Card glow={false} className="p-5 text-sm text-ink-2">
          {configError ?? "No team members are configured. Set GTM_TEAM_MEMBERS (see .env.example) to measure a teammate's GTM work."}
        </Card>
      </Shell>
    );
  }

  const db = await sessionDb();
  const [activity, boxes, mail, desk, stock] = await Promise.all([
    loadActivity(db, member.code).catch(() => null),
    db.from("gtm_team_mailboxes").select("address,connected_at,last_sync_at,last_error,backfill_done,granted_scopes").eq("member", member.code),
    // PostgREST returns at most 1000 rows a request: read every page, or past 1000 events the newest would be dropped.
    selectAll<MailEvent>((from, to) => db.from("gtm_team_mail_events").select("kind,at,thread_id,person_ids,message_key,mailbox").eq("member", member.code).order("id").range(from, to), "mail events")
      .then((data) => ({ data, error: null }), (e: Error) => ({ data: null, error: e })),
    // Every page: a single read stops at PostgREST's 1000 rows without a word (VIB-516).
    selectAll<DeskSend>((from, to) => db.from("gtm_outreach_drafts").select("person,email_sent_at,linkedin_sent_at,email_sent_by,linkedin_sent_by")
      .or(`email_sent_by.eq."${member.authEmail}",linkedin_sent_by.eq."${member.authEmail}"`).order("id").range(from, to), "desk sends")
      .then((data) => ({ data, error: null }), (e: Error) => ({ data: null, error: e })),
    db.from("gtm_team_stock_daily").select("date,metrics").eq("member", member.code).order("date", { ascending: false }).limit(60),
  ]);
  const mailboxes = (boxes.data ?? []) as MailboxStatus[];
  const connected = mailboxes.length > 0;
  // Email contract v1 (VIB-512): efforts and attempts replace threads once EMAIL_OUTCOMES_V2=1, after reconciliation.
  const outcomes = connected && outcomesV2() ? await loadOutcomes(db, member.code).catch(() => "unavailable" as const) : null;
  const r = teamReport({
    outcomes,
    activity, mail: connected && !mail.error ? (mail.data ?? []) as MailEvent[] : null, desk: desk.error ? null : (desk.data ?? []) as DeskSend[],
    memberEmail: member.authEmail, stock: (stock.data ?? []) as StockRow[], periodDays: days, now: new Date(),
  });
  const c = r.cur, p = r.prev, s = r.stock, e = c.email;
  const mailMissing = !connected ? "Not measured: mailbox not connected" : outcomes === "unavailable" ? "Not measured: email outcomes could not be read" : "Not measured: mail could not be read";
  const crmMissing = activity ? "Not measured: Twenty read failed" : "Not measured: no CRM read yet (the team cron runs hourly)";
  // People come from the CRM mirror (VIB-516): say why they are missing (still copying, stale), not just that they are.
  const peopleMissing = activity?.errors.people ? `Not measured: ${activity.errors.people}` : crmMissing;
  const spark = (k: keyof (typeof r.weekly)[number]) => r.weekly.map((w) => w[k] as number | null);
  const href = (q: Record<string, string | number>) => `/performance/team?${new URLSearchParams({ member: member.code, days: String(days), ...Object.fromEntries(Object.entries(q).map(([k, v]) => [k, String(v)])) })}`;

  // Why a rate is not shown: short on the tile, the detail behind the "i".
  const gaps = outcomes && outcomes !== "unavailable" && !outcomes.collection.complete ? outcomes.collection.gaps : [];
  const withheldWhy = e && !e.complete ? (gaps.length ? `Collection is incomplete: ${gaps.join("; ")}.` : `${e.coverage.withoutAttempts} messages in this period are not reconciled yet (run gtm team replay).`) : null;
  const rateMissing = (have: number) => !c.reply ? mailMissing : withheldWhy ? "Withheld while email data is incomplete"
    : <Pending have={have} need={REPLY_MIN_N} readyAt={e?.replyRateReadyAt ?? null} hint={days <= REPLY_MATURE_DAYS ? `Pick 30 or 90 days: a first touch counts after ${REPLY_MATURE_DAYS} days` : undefined} />;
  const bounceRate = e?.bounce.rate ?? null;
  // Observed failures alert even while the rate is withheld (lib/email/metrics.ts bounceCheck).
  const bounceAlert = !!e && e.bounce.n > 0 && e.bounce.num / e.bounce.n > BOUNCE_ALERT;
  const crmErrors = activity ? Object.keys(activity.errors) : [];
  const coverageRows: [string, number, string][] = e ? [
    ["Cold recipients", e.attempts, "Counted"],
    ["Recipients without a verified email", e.coverage.unverified, "Counted"],
    ["Sent against a CRM restriction", e.coverage.policyFlagged, "Counted and flagged"],
    ["Address shared by two CRM people", e.coverage.ambiguous, "Not attributed"],
    ["Recipients not in the CRM", e.coverage.unmatched, "Not attributed"],
    ["Messages from the older sync", e.coverage.legacyRows, "Not in rates"],
    ["Messages not reconciled yet", e.coverage.withoutAttempts, "Rates withheld"],
  ] : [];
  const issues = coverageRows.slice(1).filter(([, n]) => n > 0).length;

  return (
    <Shell title={`Team: ${member.label}`} active="/performance/team" updated={activity?.capturedAt}>
      <div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
        {members.length > 1 && (
          <nav aria-label="Team member" className="flex gap-2">
            {members.map((m) => <Link key={m.code} href={href({ member: m.code })} aria-current={m.code === member.code ? "page" : undefined}
              className={cn("rounded-md border px-3 py-1", m.code === member.code ? "border-[color:var(--border-strong)] text-ink" : "border-line text-ink-3")}>{m.label}</Link>)}
          </nav>
        )}
        <nav aria-label="Period" className="flex gap-2">
          {PERIODS.map((d) => <Link key={d} href={href({ days: d })} aria-current={d === days ? "page" : undefined}
            className={cn("rounded-md border px-3 py-1", d === days ? "border-[color:var(--border-strong)] text-ink" : "border-line text-ink-3")}>{d} days</Link>)}
        </nav>
      </div>

      <Card glow={false} className="relative z-10 mb-8 grid gap-4 p-4 text-sm md:grid-cols-3">
        <Source name="CRM (Twenty)" health={!activity ? "off" : crmErrors.length ? "warn" : "ok"}
          info="Counts records they created in Twenty, in the app or through their API key. Read by the team cron every hour.">
          {activity ? `Read ${ago(activity.capturedAt)}` : "Not read yet"}{crmErrors.length ? `; could not read ${crmErrors.join(", ")}` : ""}
        </Source>
        <Source name="Mailbox" health={!connected ? "off" : mailboxes.some((b) => b.last_error) ? "bad" : mailboxes.some((b) => !b.backfill_done || !canReadBodies(b.granted_scopes)) || withheldWhy ? "warn" : "ok"}
          info={<>Only the connected team mailbox counts. Mail from a personal Gmail or a sequencer is not counted.{mailboxes.some((b) => !canReadBodies(b.granted_scopes)) ? " Metadata only: reply text is not read until the mailbox is reconnected." : ""}{withheldWhy ? ` ${withheldWhy}` : ""}</>}>
          {connected ? mailboxes.map((b) => (
            <p key={b.address} className={b.last_error ? "text-red-strong" : undefined}>
              {b.address}: {b.last_error ? b.last_error : `synced ${ago(b.last_sync_at)}${b.backfill_done ? "" : ", still reading back to Oct 1"}`}
            </p>
          )) : <p>Not connected. <Link href="/team/mailbox" className="text-violet-strong underline-offset-2 hover:underline">{member.label} connects it here</Link>.</p>}
        </Source>
        <Source name="Writing desk" health={desk.error ? "bad" : "ok"}
          info="Sends marked on the writing desk from their own login. Counted only when the mailbox has not already counted the same email (same person, within 36 hours).">
          {desk.error ? "Could not be read" : `${plural(r.cur.deskSent ?? 0, "extra send", "extra sends")} this period`}
        </Source>
      </Card>

      <div className="mb-12 grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatTile label="GTM emails sent" value={c.emailsSent == null ? null : fmt(c.emailsSent)} missing={mailMissing}
          delta={delta(c.emailsSent, p.emailsSent, days)} spark={connected ? spark("emailed") : undefined}
          info="Outreach messages from the team mailbox, each counted once however many recipients or mailboxes it had. A first touch is the first email of a new outreach effort to one person; the rest are follow-ups."
          note={e ? `${plural(e.newEfforts, "first touch", "first touches")} to ${plural(e.people, "person", "people")}`
            : c.newThreads != null ? plural(c.newThreads, "first touch", "first touches") + ", " + plural((c.emailsSent ?? 0) - c.newThreads, "follow-up", "follow-ups") : undefined} />
        <StatTile label="Reply rate" value={c.reply ? pct(c.reply.rate) : null} missing={rateMissing(c.reply?.n ?? 0)}
          info={<>Share of first touches that got any reply. Counts first touches in this period that are at least {REPLY_MATURE_DAYS} days old, so late replies have time to arrive, and shows once there are {REPLY_MIN_N}. Bounced first touches are left out.{c.reply && !withheldWhy ? ` So far: ${c.reply.replied} replied of ${c.reply.n} old enough.` : ""}{withheldWhy ? ` ${withheldWhy}` : ""}</>}
          note={c.reply?.rate != null ? `${c.reply.replied} of ${c.reply.n} first touches` : undefined} />
        <StatTile label="Meetings" value={c.meetings == null ? null : fmt(c.meetings)} missing={crmMissing} delta={delta(c.meetings, p.meetings, days)} spark={spark("meetings")}
          info="Meeting capture proposals tagged to them in this period." />
        <StatTile label="Sendable contacts" value={s.sendable == null ? null : fmt(s.sendable)} missing={peopleMissing}
          info="Contacts they added that have a verified email and are not marked unsendable. Current state, not limited to the period."
          note={s.total != null ? `of ${fmt(s.total)} they added` : undefined}
          tone={s.total && s.sendable === 0 ? "warn" : undefined} spark={r.stockSeries("sendable")} />
      </div>

      <Section title="Cold email" note={e ? "replies classified by Jev; a person's label overrides it" : undefined}>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {e && (
            <StatTile label="Positive reply rate" value={pct(e.positiveRate.rate)} missing={rateMissing(e.positiveRate.n)}
              info={`Share of first touches whose reply was marked interested, by Jev (the reply classifier) or by a person. Same ${REPLY_MATURE_DAYS}-day and ${REPLY_MIN_N}-first-touch rules as the reply rate.`}
              note={e.positiveRate.rate != null ? `${e.positiveRate.num} interested of ${e.positiveRate.n}` : undefined} />
          )}
          {e && (
            <StatTile label="Bounce rate" value={bounceRate != null ? `${(bounceRate * 100).toFixed(1)}%` : withheldWhy && e.bounce.num ? fmt(e.bounce.num) : null}
              missing={withheldWhy ? "Withheld while email data is incomplete" : "No cold email sent this period"}
              tone={bounceAlert ? "bad" : undefined}
              info={`Failed deliveries over cold recipients sent in this period. Above ${Math.round(BOUNCE_ALERT * 100)}% is a sender-health alert: check the list before sending more. While email data is incomplete the rate is withheld, but observed bounces still show and still alert.`}
              note={!e.bounce.n ? undefined : bounceRate == null ? `bounced of ${e.bounce.n} recipients; rate withheld` : `${e.bounce.num} of ${e.bounce.n} recipients`} />
          )}
          <StatTile label="Replies received" value={c.replies == null ? null : fmt(c.replies)} missing={mailMissing} delta={delta(c.replies, p.replies, days)}
            info="Replies that arrived in this period, whenever the email they answer was sent." />
          <StatTile label="Follow-up rate" value={c.followUp ? pct(c.followUp.rate) : null} missing={c.followUp ? "No unanswered first touch is 7 days old yet" : mailMissing}
            info="Share of unanswered first touches that got a second email 3 to 7 days later. Counts first touches at least 7 days old."
            note={c.followUp?.rate != null ? `of ${plural(c.followUp.n, "unanswered first touch", "unanswered first touches")}` : undefined} />
        </div>
        {e && (
          <details className="group mt-4 rounded-xl border border-line text-sm">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-ink-2 marker:hidden [&::-webkit-details-marker]:hidden">
              <span>Data quality this period: {issues ? plural(issues, "thing to check", "things to check") : "nothing to check"}</span>
              <span aria-hidden className="text-ink-3 transition-transform group-open:rotate-90">›</span>
            </summary>
            <div className="border-t border-line px-4 pb-2">
              <Table head={["Recipients and messages", "Count", "How it is treated"]} align={["l", "r", "l"]}
                rows={[...coverageRows, ["Other CRM mail (not outreach)", c.otherCrmMail ?? 0, "Not counted as outreach"] as [string, number, string]].map(([k, n, how]) => [k, fmt(n), how])} />
            </div>
          </details>
        )}
      </Section>

      <Section title="CRM work">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
          {([["Contacts added", "contactsAdded", peopleMissing], ["Companies added", "companiesAdded", crmMissing], ["Research notes", "notes", crmMissing]] as [string, keyof Period, string][]).map(([label, k, miss]) => (
            <StatTile key={k} label={label} value={c[k] == null ? null : fmt(c[k] as number)} missing={miss} delta={delta(c[k] as number | null, p[k] as number | null, days)} />
          ))}
          <StatTile label="Active days" value={c.activeDays == null ? null : `${c.activeDays} / ${days}`} missing="Not measured: no source connected"
            delta={delta(c.activeDays, p.activeDays, days)} spark={spark("activeDays")} info="Days with a CRM addition, a GTM email or a desk send." />
          <StatTile label="Days from added to first email" value={r.daysToFirstTouch == null ? null : String(r.daysToFirstTouch)} missing={connected ? "None of their contacts emailed yet" : mailMissing}
            info="Median days between adding a person to the CRM and the first outreach email to them, over people they added and then emailed." />
          <StatTile label="Pipeline touched" value={r.pipeline == null ? null : r.pipeline.length ? r.pipeline.map((x) => `${x.currency} ${fmt(Math.round(x.amount))}`).join(" + ") : "0"}
            missing={crmMissing} info="Open opportunities they created, or on a company or contact they added. Lost deals are left out." />
        </div>
      </Section>

      <Section title="From added to opportunity" note="all of their records, as they stand now">
        {r.funnel.map((f) => <Bar key={f.label} label={f.label} value={f.value ?? 0} max={Math.max(1, r.funnel[0].value ?? 1)} display={f.value == null ? "not measured" : fmt(f.value)} />)}
      </Section>

      <Section title="Weekly activity" note="last 8 weeks">
        <div className="grid gap-6 md:grid-cols-3">
          {([["Contacts added", "added"], ["GTM emails sent", "emailed"], ["Replies", "replied"]] as const).map(([title, k]) => (
            <TrendChart key={k} title={title} unit="per week" summary={`${title} per week: ${r.weekly.map((w) => w[k] ?? "n/a").join(", ")}`}
              data={r.weekly.map((w) => ({ x: w.week.slice(5), value: w[k] }))} valueLabel={title} compact />
          ))}
        </div>
      </Section>

      <Section title="Hygiene">
        <Table head={["Check", "Count"]} align={["l", "r"]} rows={[
          ["Contacts they added without a verified email", fmt(s.unverified)],
          ["Companies they added with no account owner", fmt(s.companiesNoOwner)],
          ["Open tasks assigned to them", fmt(s.openTasks)],
          ["Overdue tasks", fmt(s.overdueTasks)],
        ]} />
      </Section>

      <Section title="What was counted" note="latest 25, by day">
        {r.timeline.length ? (
          <Table head={["Day", "What", "Record"]} align={["l", "l", "l"]} rows={r.timeline.map((x) => [x.day, x.kind,
            x.personId ? <TwentyLink key="p" path={`/object/person/${x.personId}`} label="person" /> : x.companyId ? <TwentyLink key="c" path={`/object/company/${x.companyId}`} label="company" /> : "-"])} />
        ) : <p className="text-sm text-ink-3">Nothing counted yet.</p>}
      </Section>
    </Shell>
  );
}
