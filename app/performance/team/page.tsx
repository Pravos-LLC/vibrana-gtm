import Link from "next/link";
import { StatTile } from "@/components/stat-tile";
import { Bar, Section, Shell, Table, fmt } from "@/components/shell";
import { Card } from "@/components/ui/card";
import { TrendChart } from "@/components/performance/trend-chart";
import { TwentyLink } from "@/components/crm/people";
import { sessionDb } from "@/lib/supabase/server";
import { loadActivity } from "@/lib/team/crm";
import { canReadBodies, selectAll } from "@/lib/team/mailbox";
import { loadOutcomes, outcomesV2 } from "@/lib/email/load";
import { memberByCode, teamMembers, type TeamMember } from "@/lib/team/members";
import { REPLY_MIN_N, teamReport, type DeskSend, type MailEvent, type Period, type StockRow } from "@/lib/team/metrics";
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
    selectAll<MailEvent>((from, to) => db.from("gtm_team_mail_events").select("kind,at,thread_id,person_ids").eq("member", member.code).order("id").range(from, to), "mail events")
      .then((data) => ({ data, error: null }), (e: Error) => ({ data: null, error: e })),
    db.from("gtm_outreach_drafts").select("person,email_sent_at,linkedin_sent_at,email_sent_by,linkedin_sent_by")
      .or(`email_sent_by.eq."${member.authEmail}",linkedin_sent_by.eq."${member.authEmail}"`),
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
  const c = r.cur, p = r.prev, s = r.stock;
  const mailMissing = !connected ? "not measured: mailbox not connected" : outcomes === "unavailable" ? "not measured: email outcomes could not be read" : "not measured: mail events could not be read";
  const crmMissing = activity ? "not measured: Twenty read failed" : "not measured: no CRM read yet (the team cron runs hourly)";
  const spark = (k: keyof (typeof r.weekly)[number]) => r.weekly.map((w) => w[k] as number | null);
  const href = (q: Record<string, string | number>) => `/performance/team?${new URLSearchParams({ member: member.code, days: String(days), ...Object.fromEntries(Object.entries(q).map(([k, v]) => [k, String(v)])) })}`;

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

      <Card glow={false} className="mb-10 grid gap-3 p-4 text-sm text-ink-2 md:grid-cols-3">
        <div>
          <p className="font-medium text-ink">CRM (Twenty)</p>
          <p>{activity ? `Read ${ago(activity.capturedAt)}` : "Not read yet"}{activity && Object.keys(activity.errors).length ? `; could not read ${Object.keys(activity.errors).join(", ")}` : ""}.</p>
          <p className="text-ink-3">Counts rows created in the app by them, or through their API key.</p>
        </div>
        <div>
          <p className="font-medium text-ink">Mailbox</p>
          {connected ? mailboxes.map((b) => (
            <p key={b.address} className={b.last_error ? "text-red-strong" : undefined}>
              {b.address}: {b.last_error ? b.last_error : `synced ${ago(b.last_sync_at)}${b.backfill_done ? "" : ", still reading back to Oct 1"}`}
              {!b.last_error && !canReadBodies(b.granted_scopes) ? ". Metadata only: reply text is not read until it is reconnected." : ""}
            </p>
          )) : <p>Not connected. <Link href="/team/mailbox" className="text-violet-strong underline-offset-2 hover:underline">{member.label} connects it here</Link>.</p>}
          <p className="text-ink-3">Mail from any other mailbox (personal Gmail, a sequencer) is not counted.</p>
          {c.email && (
            <p className="text-ink-3">
              Coverage this period: {c.email.attempts} cold recipients, {c.email.coverage.unverified} not verified (counted), {c.email.coverage.policyFlagged} sent against a CRM restriction (counted, flagged),
              {" "}{c.email.coverage.ambiguous} on an address two CRM people share and {c.email.coverage.unmatched} not in the CRM (not attributed), {c.email.coverage.legacyRows} messages from the older sync.
              {" "}Bounces {c.email.bounce.num} of {c.email.bounce.n}{c.email.complete ? "" : " (partial: rates withheld until every message is reconciled)"}.
            </p>
          )}
        </div>
        <div>
          <p className="font-medium text-ink">Writing desk</p>
          <p>{desk.error ? "Could not be read." : `${fmt(r.cur.deskSent)} sends marked in this period, beyond those the mailbox already counts.`}</p>
          <p className="text-ink-3">Counts only sends marked from their own login.</p>
        </div>
      </Card>

      <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-3">
        <StatTile label="GTM emails sent" value={c.emailsSent == null ? null : fmt(c.emailsSent)} missing={mailMissing}
          delta={delta(c.emailsSent, p.emailsSent, days)} spark={connected ? spark("emailed") : undefined}
          note={c.email ? plural(c.email.newEfforts, "new outreach effort", "new outreach efforts") + `, ${c.email.attempts} cold recipients`
            : c.newThreads != null ? plural(c.newThreads, "first touch", "first touches") + ", " + plural((c.emailsSent ?? 0) - c.newThreads, "follow-up", "follow-ups") : undefined} />
        <StatTile label="Reply rate" value={c.reply ? pct(c.reply.rate) : null}
          missing={c.email && !c.email.complete ? `withheld: ${c.email.coverage.withoutAttempts} messages in the period are not reconciled yet (gtm team replay)` : c.reply ? `needs ${REPLY_MIN_N} first touches at least 7 days old (${c.reply.n} so far, ${c.reply.replied} replied)` : mailMissing}
          note={c.reply?.rate != null ? `${c.reply.replied} of ${c.reply.n} first touches, bounces excluded` : undefined} />
        <StatTile label="Meetings" value={c.meetings == null ? null : fmt(c.meetings)} missing={crmMissing} delta={delta(c.meetings, p.meetings, days)} spark={spark("meetings")}
          note="meeting capture proposals tagged to them" />
        <StatTile label="Sendable contacts" value={s.sendable == null ? null : fmt(s.sendable)} missing={crmMissing}
          note={s.total != null ? `of ${fmt(s.total)} they added: verified email, not marked unsendable (current state)` : undefined}
          tone={s.total && s.sendable === 0 ? "warn" : undefined} spark={r.stockSeries("sendable")} />
        <StatTile label="Active days" value={c.activeDays == null ? null : `${c.activeDays} / ${days}`} missing="not measured: no source connected"
          delta={delta(c.activeDays, p.activeDays, days)} spark={spark("activeDays")} note="days with a CRM addition, a GTM email or a desk send" />
      </div>
      <div className="mb-12 grid grid-cols-2 gap-4 md:grid-cols-5">
        {([["Contacts added", "contactsAdded", crmMissing], ["Companies added", "companiesAdded", crmMissing], ["Research notes", "notes", crmMissing],
          ["Other CRM mail", "otherCrmMail", mailMissing], ["Replies received", "replies", mailMissing]] as [string, keyof Period, string][]).map(([label, k, miss]) => (
          <StatTile key={k} label={label} value={c[k] == null ? null : fmt(c[k] as number)} missing={miss} delta={delta(c[k] as number | null, p[k] as number | null, days)} />
        ))}
      </div>

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

      <Section title="Discipline">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
          <StatTile label="Days from added to first email" value={r.daysToFirstTouch == null ? null : String(r.daysToFirstTouch)} missing={connected ? "none of their contacts emailed yet" : mailMissing} note="median, people they added and then emailed" />
          <StatTile label="Follow-up rate" value={c.followUp ? pct(c.followUp.rate) : null} missing={c.followUp ? "no unanswered first touch is 7 days old yet" : mailMissing}
            note={c.followUp ? `${c.followUp.n} unanswered first touches; a second email on day 3 to 7 counts` : undefined} />
          <StatTile label="Pipeline touched" value={r.pipeline == null ? null : r.pipeline.length ? r.pipeline.map((x) => `${x.currency} ${fmt(Math.round(x.amount))}`).join(" + ") : "0"}
            missing={crmMissing} note="open opportunities they created, or on a company or contact they added" />
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
