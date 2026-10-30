import Link from "next/link";
import { Shell } from "@/components/shell";
import { Card } from "@/components/ui/card";
import { BatchPicker } from "@/components/outreach/batch-picker";
import { OutreachList, type ProspectCardData } from "@/components/outreach/outreach-review";
import { DRAFT_COLUMNS, groupByProspect, OUTREACH_STATUSES, STATUS_LABEL, type Draft, type DraftVersion } from "@/lib/outreach/model";
import { draftVersions, listBatches } from "@/lib/outreach/store";
import { sessionDb } from "@/lib/supabase/server";
import { acceptOutreach, rejectOutreach, reopenOutreach, saveOutreachEdit, sendBackOutreach } from "./actions";

export const dynamic = "force-dynamic";

const actions = { save: saveOutreachEdit, accept: acceptOutreach, reject: rejectOutreach, sendBack: sendBackOutreach, reopen: reopenOutreach };

export const metadata = { title: "Outreach" };

/**
 * Outreach review: personalized cold emails from the vibrana-crm pipeline (`gtm outreach import`), reviewed like posts in
 * /content. Edit in place, Accept (no second confirmation), Reject, or Send back with a note (`gtm outreach notes` hands
 * it to the pipeline). Findings are advisory and never block Accept.
 */
export default async function OutreachPage({ searchParams }: { searchParams: Promise<{ batch?: string; status?: string }> }) {
  const raw = await searchParams;
  const db = await sessionDb(); // RLS: only the owner reads gtm_outreach_drafts
  let batches: string[] = [];
  try { batches = await listBatches(db); } catch (e) {
    return <Shell title="Outreach" active="/outreach" wide><p className="text-sm text-red-strong">Outreach could not load: {e instanceof Error ? e.message : String(e)}</p></Shell>;
  }
  const batch = raw.batch && batches.includes(raw.batch) ? raw.batch : batches[0] ?? "";
  const status = (OUTREACH_STATUSES as readonly string[]).includes(raw.status ?? "") ? raw.status! : "";
  const { data, error } = batch ? await db.from("gtm_outreach_drafts").select(DRAFT_COLUMNS).eq("batch", batch).limit(2000) : { data: [], error: null };
  const drafts = (data ?? []) as unknown as Draft[];
  const groups = groupByProspect(drafts);
  // A prospect shows when any of its variants has the status; its other variants stay beside it for comparison.
  const shown = status ? groups.filter((g) => g.drafts.some((d) => d.status === status)) : groups;
  const history = await draftVersions(db, shown.flatMap((g) => g.drafts.map((d) => d.id))).catch(() => [] as DraftVersion[]);
  const cards: ProspectCardData[] = shown.map((g) => ({
    key: g.key, drafts: g.drafts,
    history: Object.fromEntries(g.drafts.map((d) => [d.id, history.filter((v) => v.draft_id === d.id)])),
  }));
  const count = (s: string) => groups.filter((g) => g.drafts.some((d) => d.status === s)).length;
  const href = (s: string) => `/outreach?${new URLSearchParams({ ...(batch ? { batch } : {}), ...(s ? { status: s } : {}) })}`;
  const chip = (active: boolean) => `rounded-full border px-3 py-1 text-xs ${active ? "border-violet bg-violet/10 text-ink" : "border-line text-ink-2 hover:text-ink"}`;

  return (
    <Shell title="Outreach" active="/outreach" wide>
      <div className="mx-auto max-w-7xl space-y-5">
        <p className="text-sm"><Link href="/outreach/inbox" className="underline">Open outreach inbox</Link></p>
        <p className="text-sm text-ink-2">
          Personalized cold emails to review. Edit the email in place, then Accept, Reject, or Send back with a note for the agent to rewrite.
          Findings are advice, never a block. <span className="text-ink-3">J/K next and previous · A accept · R reject · N note · E edit · Cmd+S save</span>
          {" "}<Link href="/outreach/write" className="font-medium text-ink underline underline-offset-4">Write your own at the writing desk</Link>
        </p>
        {batches.length > 0 && (
          <nav className="flex flex-wrap items-center gap-2" aria-label="Filters">
            <BatchPicker batches={batches} batch={batch} status={status} />
            <span className="mx-2 h-4 w-px bg-line" />
            <Link href={href("")} className={chip(!status)}>All <span className="font-mono">{groups.length}</span></Link>
            {OUTREACH_STATUSES.map((s) => <Link key={s} href={href(s)} className={chip(status === s)}>{STATUS_LABEL[s]} <span className="font-mono">{count(s)}</span></Link>)}
          </nav>
        )}
        {error && <p className="text-sm text-red-strong">Drafts could not load: {error.message}</p>}
        {!batches.length && !error && <Card glow={false} className="p-8 text-center text-ink-2">No outreach drafts yet. The pipeline loads them with <code>gtm outreach import drafts.json</code>.</Card>}
        {batches.length > 0 && !cards.length && !error && <Card glow={false} className="p-8 text-center text-ink-2">Nothing {status ? `${STATUS_LABEL[status as keyof typeof STATUS_LABEL].toLowerCase()} ` : ""}in {batch}. <Link href={href("")} className="font-medium text-ink underline underline-offset-4">Show all</Link></Card>}
        {/* Keyed on the query so a new batch or filter starts from fresh server data. */}
        <OutreachList key={`${batch}|${status}`} cards={cards} actions={actions} />
      </div>
    </Shell>
  );
}
