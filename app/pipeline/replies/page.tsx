// Pipeline > Replies (VIB-496): every email reply the mailbox sync found in both sending mailboxes, with the rule's and the
// reply classifier's (Jev) decisions, the owner's label (which outranks both), the stop-list items waiting for approval,
// open email alerts, and a live classifier test. Owners only. No reply text is stored, so none is shown here.
import { Section, Shell, Table } from "@/components/shell";
import { SalesNav } from "@/components/sales/nav";
import { SourceNote } from "@/components/sales/parts";
import { TwentyLink } from "@/components/crm/people";
import { adminDb } from "@/lib/db";
import { classifierEnabled } from "@/lib/email/classifier";
import { loadReview, type LabelRow } from "@/lib/email/review";
import { parseOwner, parsePeriod } from "@/lib/sales/load";
import { sessionDb } from "@/lib/supabase/server";
import { ApproveForm, LabelForm, TryClassifier } from "./forms";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const metadata = { title: "Replies" };

const INTENT: Record<string, string> = { interested: "Interested", not_interested: "Not interested", not_now: "Not now", referral: "Referral",
  neutral: "Neutral", auto_reply: "Auto-reply", uncertain: "Unsure" };
const STOP: Record<string, string> = { none: "", person: "stop: person", address: "stop: address", uncertain: "possible stop" };
const REASON: Record<string, string> = { UNSUBSCRIBED: "Opt out (person)", ADDRESS_OPT_OUT: "Opt out (this address)", EMAIL_BOUNCED: "Bounced address", OPT_OUT_REVIEW: "Possible opt-out: label the reply" };
const day = (iso: string) => iso.slice(0, 16).replace("T", " ");

function decision(l: LabelRow | null, kind: "rule" | "model") {
  if (!l) return <span className="text-ink-3">{kind === "model" ? "not yet" : "-"}</span>;
  if (kind === "model" && (l.model ?? "").startsWith("none:")) return <span className="text-ink-3">nothing to send</span>;
  const stop = STOP[l.opt_out] ?? "";
  return <span>{kind === "rule" && l.intent === "uncertain" ? "-" : INTENT[l.intent] ?? l.intent}{stop && <span className="ml-1 text-red-strong">· {stop}</span>}</span>;
}

export default async function Replies({ searchParams }: { searchParams: Promise<{ owner?: string; period?: string }> }) {
  const sp = await searchParams;
  const db = await sessionDb();
  const { data: claims } = await db.auth.getClaims();
  const isOwner = (claims?.claims?.app_metadata as { gtm_owner?: boolean } | undefined)?.gtm_owner === true;
  const owner = parseOwner(sp.owner), period = parsePeriod(sp.period);
  if (!isOwner) {
    return <Shell title="Replies" active="/pipeline"><SalesNav active="/pipeline/replies" owner={owner} period={period} showPeriod={false} /><SourceNote tone="bad">Replies are for the cockpit owners.</SourceNote></Shell>;
  }
  const data = await loadReview(adminDb(), new Date()).catch((e: Error) => ({ error: e.message.split(":")[0] }));
  if ("error" in data) {
    return <Shell title="Replies" active="/pipeline"><SalesNav active="/pipeline/replies" owner={owner} period={period} showPeriod={false} /><SourceNote tone="bad">Replies could not be read ({data.error}).</SourceNote></Shell>;
  }
  const replies = owner ? data.replies.filter((r) => r.member === owner) : data.replies;
  const waiting = replies.filter((r) => r.needsReview).length;
  const pending = data.ops.filter((o) => o.state === "pending_review" && o.reason !== "OPT_OUT_REVIEW");
  const reviews = data.ops.filter((o) => o.state === "pending_review" && o.reason === "OPT_OUT_REVIEW");
  const inFlight = data.ops.filter((o) => o.state !== "pending_review");

  return (
    <Shell title="Replies" active="/pipeline">
      <SalesNav active="/pipeline/replies" owner={owner} period={period} showPeriod={false} />
      {data.incidents.length > 0 && (
        <Section title="Email alerts" note="open now; both of you get these by email">
          <Table head={["Since", "Alert"]} rows={data.incidents.map((i) => [day(i.opened_at), <span key="s" className={i.severity === "critical" ? "text-red-strong" : undefined}>{i.summary}</span>])} />
        </Section>
      )}

      <Section title="Replies" note={`last 90 days · both sending mailboxes · ${waiting} need your label`}>
        {replies.length === 0
          ? <p className="text-sm text-ink-3">No email replies yet. Replies to cold outreach from either sending mailbox appear here within the hour; auto-replies and replies from partner, client or personal contacts are not counted. LinkedIn replies stay in Origami.</p>
          : <Table head={["Received", "Mailbox", "Person", "Rule", "Jev", "Your label"]} rows={replies.map((r) => [
              <span key="d" className={r.needsReview ? "font-medium text-ink" : undefined}>{day(r.at)}{r.needsReview && <span className="ml-1 text-red-strong">●</span>}</span>,
              r.member === "JOHN" ? "John" : r.member === "ABE" ? "Abe" : r.member,
              r.personId ? <TwentyLink key="p" path={`/object/person/${r.personId}`} label="person" /> : "-",
              decision(r.rule, "rule"), decision(r.model, "model"),
              <LabelForm key="f" eventId={r.eventId} intent={r.human?.intent} optOut={r.human?.opt_out} />,
            ])} />}
        <p className="mt-3 text-xs text-ink-3">Read the reply in your own inbox; the cockpit keeps only these labels. Your label outranks the rule and Jev. A &ldquo;stop&rdquo; label becomes a stop-list item below for approval; Jev alone never stops anyone.</p>
      </Section>

      <Section title="Stop list" note="Twenty changes wait for an owner's approval, then the hourly writer applies and confirms them">
        {pending.length + reviews.length + inFlight.length === 0
          ? <p className="text-sm text-ink-3">Nothing waiting. Bounced addresses and confirmed opt-outs show up here.</p>
          : <Table head={["Seen", "What", "Person", "State", ""]} rows={[...reviews, ...pending, ...inFlight].map((o) => [
              day(o.observed_at), REASON[o.reason] ?? o.reason,
              <TwentyLink key="p" path={`/object/person/${o.person_id}`} label="person" />,
              o.state.replace("_", " ") + (o.last_error ? ` (${o.last_error.slice(0, 80)})` : ""),
              o.state === "pending_review" && o.reason !== "OPT_OUT_REVIEW" ? <ApproveForm key="a" opId={o.id} /> : "",
            ])} />}
      </Section>

      <Section title="Try the classifier" note={classifierEnabled() ? "Jev 1.13 · free model first, then paid · nothing stored" : "off"}>
        <TryClassifier />
      </Section>
    </Shell>
  );
}
