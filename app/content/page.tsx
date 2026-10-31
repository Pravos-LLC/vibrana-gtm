import { packagingBrandOptions } from "@/lib/packaging/server-catalog";
import { Suspense } from "react";
import { loadSharedSection, type SharedSection } from "./shared/section";
import { ReleasedNotice } from "@/components/review/released-notice";
import { TemplateReview } from "@/components/review/template-review";
import { loadTemplateReview } from "@/lib/packaging/load-review";
import { Shell, requestWorkCounts } from "@/components/shell";
import { Card } from "@/components/ui/card";
import { PieceList } from "@/components/review/season-piece";
import { ReviewProvider } from "@/components/review/review-store";
import { OverviewStrip } from "@/components/review/overview-strip";
import { ContentToolbar } from "@/components/review/content-toolbar";
import { SeriesSection } from "@/components/review/series-section";
import { seriesOptions } from "@/lib/season-review";
import { dateRange, filterPieces, filtersToQuery, hasFilters } from "@/lib/season-review";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { sessionDb } from "@/lib/supabase/server";
import { REVIEW_CHANNELS } from "@/lib/season";
import { SeasonPanel } from "@/components/review/season-panel";
import { loadSeason } from "@/lib/seasons";
import { PILLARS } from "@/lib/guide/content";
import { updateSeason } from "@/app/season-actions";
import { todayIn } from "@/lib/posts-db";
import { ReviewLinks, type ReviewLinkRow } from "@/components/review/review-links";
import { inviteState, type Invite } from "@/lib/reviewer/invites";
import { revokeReviewLink, shareForReview } from "./reviewer-actions";
import { addPerson } from "./people-actions";
import { PeopleProvider } from "@/components/review/mention-check";
import { loadPeople } from "@/lib/people";
import { restoreFilters } from "@/lib/filter-memory-server";
import { CONTENT_REMEMBERED } from "@/lib/filter-memory";
import { contentFilters } from "@/lib/content-filters";
import type { ReviewChannel } from "@/lib/season";
import { loadContentBoard } from "@/lib/content-board";
import { contentStrip } from "@/lib/work/model";

export const dynamic = "force-dynamic";
// An approval schedules after the response (lib/schedule-approved.ts); an episode final streams its multi-GB master
// from storage to Zernio in that run, so the function gets the Pro plan's full duration.
export const maxDuration = 800;

async function ContentReviewBody({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  if (params.view === "templates") {
    const db = await sessionDb(), story = typeof params.story === "string" ? params.story : undefined;
    return <Shell title="Content review" active="/content" wide><div className="mb-6 flex gap-5 text-sm"><Link href="/content" className="underline">Publishing review</Link><span>Thumbnail templates</span></div><TemplateReview assets={await loadTemplateReview(db, story)} brands={packagingBrandOptions()}/></Shell>;
  }
  await restoreFilters("/content", params, CONTENT_REMEMBERED);
  const filters = contentFilters(params);
  // A finding's link: /content?piece=<story>&channel=<platform> opens that platform's tab.
  const channelParam = Array.isArray(params.channel) ? params.channel[0] : params.channel;
  const openChannel = filters.piece && (REVIEW_CHANNELS as string[]).includes(channelParam ?? "") ? { storyId: filters.piece, channel: channelParam as ReviewChannel } : null;
  const db = await sessionDb();
  // The board, who is on file for @mentions (the check under each text says whether a tag will work, lib/mentions.ts)
  // and the work-board line read side by side.
  const sharedPromise = loadSharedSection(db, { adoptedOnly: true, filters }).then(
    (section) => ({ section, problem: null }),
    (error: unknown) => { unstable_rethrow(error); return { section: null, problem: error instanceof Error ? error.message : String(error) }; },
  );
  const [board, peopleRows, work] = await Promise.all([loadContentBoard(db, filters), loadPeople(db).catch(() => []), requestWorkCounts()]);
  if (board.error !== null) return <Shell title="Content review" active="/content" wide><p className="text-red-strong">Could not load the content: {board.error}</p></Shell>;
  const { storyRows, stories, all, directed, hiddenPieces, holds, summary, stages, initial, pieceOptions } = board;
  let sharedProblem = board.sharedProblem;
  const people = peopleRows.map(({ name, linkedin_name, linkedin_urn, linkedin_error, instagram_handle, auto_tag }) => ({ name, linkedin_name, linkedin_urn, linkedin_error, instagram_handle, auto_tag }));
  const visible = filterPieces(directed, filters);
  const linkedHidden = filters.piece ? hiddenPieces.find((h) => h.storyId === filters.piece) : undefined;
  const shownCards = visible.reduce((n, p) => n + p.cards.length, 0);
  // The season these pieces belong to (the most common season_id), analyzed the same way as `gtm season`.
  // A failure here must not take the review screen down: it shows a line instead of the panel.
  const seasonIds = stories.map((s) => (s as { season_id?: string | null }).season_id).filter((x): x is string => !!x);
  const seasonId = seasonIds.sort((a, b) => seasonIds.filter((x) => x === b).length - seasonIds.filter((x) => x === a).length)[0];
  const analysis = seasonId && !filters.piece
    ? <Suspense fallback={<p role="status" className="text-xs text-ink-3">Loading season analysis…</p>}><SeasonAnalysisPanel seasonId={seasonId} /></Suspense>
    : null;
  const pillars = [...new Set(all.map((p) => p.pillar).filter((x): x is string => !!x))].sort();
  // Third parties named on any piece, and their review links (owner-readable through RLS).
  // Only parties with a gate still open: once a third party has approved every final, the banner goes away.
  const openGates = new Set(holds.filter((h) => h.kind === "third_party").map((h) => h.storyId));
  const parties = [...new Set((storyRows ?? []).filter((s) => openGates.has((s as { id: string }).id)).map((s) => (s as { third_party_who?: string | null }).third_party_who?.trim()).filter((x): x is string => !!x))].sort();
  const { data: inviteRows } = parties.length
    ? await db.from("gtm_reviewer_invites").select("id,party,expires_at,created_at,claimed_email,claimed_at,revoked_at").order("created_at", { ascending: false })
    : { data: [] };
  const links: ReviewLinkRow[] = ((inviteRows ?? []) as Array<Pick<Invite, "id" | "party" | "expires_at" | "created_at" | "claimed_email" | "claimed_at" | "revoked_at">>)
    .map((i) => ({ id: i.id, party: i.party, state: inviteState(i), claimedEmail: i.claimed_email, expiresAt: i.expires_at, createdAt: i.created_at }));
  // Shared pieces obey the same filters and join the toolbar's counts; any failure is one line, never the page (#147 B1, B3).
  // "Leave shared review" lands here with which approvals survived (?released=<text><video>, 1 kept, 0 to decide).
  const releasedParam = Array.isArray(params.released) ? params.released[0] : params.released;
  const released = filters.piece && /^[01]{2}$/.test(releasedParam ?? "") ? releasedParam! : null;
  const sharedResult = await sharedPromise;
  const sharedSection: SharedSection | null = sharedProblem ? null : sharedResult.section;
  sharedProblem ??= sharedResult.problem;
  return (
    <Shell title="Content review" active="/content" wide>
      <p className="mb-5 text-sm">{sharedSection?.delivery.ok && <><Link href="/content/shared" className="underline">Choose shared assets for video pieces</Link> · </>}<Link href="/content/delivery" className="underline">Delivery report</Link></p>
      {released && <ReleasedNotice released={released} />}
      {sharedProblem
        ? <p role="alert" className="mb-5 text-sm text-red-strong" data-testid="shared-unavailable">Shared pieces could not be loaded ({sharedProblem}). Pieces below are unaffected; refresh to retry.</p>
        : sharedSection?.node}
      {/* Keyed on the query so a new filter starts from fresh server data. */}
      <ReviewProvider key={filtersToQuery(filters)} initial={initial} summary={summary} stages={stages}>
        <div className="space-y-5">
          {work && (
            <Link href="/work" data-testid="work-strip" className="flex items-center gap-2 text-sm text-ink-2 hover:text-ink">
              <span className={`size-2 rounded-full ${work.waiting ? "bg-amber-strong" : work.inProgress ? "bg-violet" : "bg-line"}`} aria-hidden />
              <span>{contentStrip(work.inProgress, work.waiting)}</span>
              <span className="text-ink-3 underline underline-offset-4">Work board</span>
            </Link>
          )}
          {/* On a one-piece link only that piece is read, so the numbers describe it, without the season analysis. */}
          <OverviewStrip range={dateRange(all.map((p) => p.date))} analysis={analysis} />
          {parties.length > 0 && <ReviewLinks parties={parties.map((party) => ({ party, pieces: all.filter((p) => p.pipeline?.thirdParty?.who?.trim() === party && p.pipeline.final.staged).map((p) => p.name) }))} links={links} share={shareForReview} revoke={revokeReviewLink} />}
          <ContentToolbar path="/content" filters={filters} pieces={pieceOptions} pillars={pillars}
            shown={shownCards + (sharedSection?.shown ?? 0)} total={summary.length + (sharedSection?.total ?? 0)} {...seriesOptions(all)} />
          <SeriesSection all={directed} filters={filters} path="/content" />
          <PeopleProvider people={people} add={addPerson}><PieceList pieces={visible} focus={filters.focus} status={filters.status} platform={filters.platform} open={openChannel} /></PeopleProvider>
          {linkedHidden && (
            <Card glow={false} className="p-6 text-sm text-ink-2">
              {all.find((p) => p.storyId === linkedHidden.storyId)?.name ?? linkedHidden.storyId} is not shown: {linkedHidden.detail}.
            </Card>
          )}
          {hiddenPieces.length > 0 && !filters.piece && (
            <p className="text-xs text-ink-3">
              Not shown until a new version is staged: {hiddenPieces.map((h) => all.find((p) => p.storyId === h.storyId)?.name ?? h.storyId).join(", ")}.
            </p>
          )}
          {!visible.length && !linkedHidden && !sharedSection?.shown && (
            <Card glow={false} className="p-8 text-center text-ink-2">
              {all.length === 0 ? "No season pieces staged yet." : "No platform cards match these filters."}
              {hasFilters(filters) && <> <Link href="/content?status=all" className="font-medium text-ink underline underline-offset-4">Clear filters</Link></>}
            </Card>
          )}
        </div>
      </ReviewProvider>
    </Shell>
  );
}

export const metadata = { title: "Content" };

/** Any required read failing leaves an explicit error, never a misleading empty approval queue. */
export default async function ContentReviewPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  try { return await ContentReviewBody(props); }
  catch (error) { unstable_rethrow(error); return <Shell title="Content review" active="/content" wide><p role="alert" className="text-red-strong">Content review could not be loaded completely. Refresh to retry. Approval and publishing status are unavailable.</p></Shell>; }
}

async function SeasonAnalysisPanel({ seasonId }: { seasonId: string }) {
  try {
    const { input, analysis } = await loadSeason(await sessionDb(), seasonId, todayIn());
    return <SeasonPanel season={input.season} analysis={analysis} pillarOptions={PILLARS.map((p) => ({ slug: p.slug, name: p.name }))} save={updateSeason} />;
  } catch (error) {
    unstable_rethrow(error);
    return <p className="text-xs text-red-strong">Could not load the season analysis. Refresh to retry.</p>;
  }
}
