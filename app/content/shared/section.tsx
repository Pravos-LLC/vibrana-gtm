import type { SupabaseClient } from "@supabase/supabase-js";
import { sessionDb } from "@/lib/supabase/server";
import { bounded, readPages, readChunks } from "@/lib/db-read";
import { loadPieceReview, pieceCandidates, sharedDeliveryInstalled, type SharedDeliveryState } from "@/lib/piece-review";
import { sharedMatches } from "@/lib/shared-filter";
import { NO_FILTERS, type Filters } from "@/lib/season-review";
import { SharedPiece } from "@/components/review/shared-piece";
import { playPath } from "@/lib/reviewer/shared";
import { signedUrls } from "@/lib/sign-urls";
import { BUCKET } from "@/lib/review";
import { PeopleProvider } from "@/components/review/mention-check";
import { loadPeople } from "@/lib/people";
import { addPerson } from "../people-actions";
import { ReviewLinks, type ReviewLinkRow } from "@/components/review/review-links";
import { shareForReview, revokeReviewLink } from "../reviewer-actions";
import { inviteState } from "@/lib/reviewer/invites";

export type SharedSection = { node: React.ReactNode; shown: number; total: number; delivery: SharedDeliveryState };

/**
 * The shared pieces (adopted only, for /content), or every video piece (for /content/shared, where one is adopted).
 * Under /content the same filters as the legacy cards apply and the counts join the toolbar's (review #147 B3).
 * One piece whose read fails shows a line in its place, never an error for the whole page (#147 B1, N1).
 */
export async function loadSharedSection(db: SupabaseClient, { adoptedOnly = false, filters = NO_FILTERS }: { adoptedOnly?: boolean; filters?: Filters } = {}): Promise<SharedSection> {
  const auth = await db.auth.getUser();
  if (auth.error || auth.data.user?.app_metadata?.gtm_owner !== true) throw new Error("Sign in as the cockpit owner.");
  const delivery = await sharedDeliveryInstalled(db);
  const adopted = (await readPages((from, to) => db.from("gtm_piece_reviews").select("story_id", { count: "exact" }).order("story_id").range(from, to), "shared pieces")) as { story_id: string }[];
  const shared = new Set(adopted.map((a) => a.story_id));
  // Adoption needs the dispatcher (#147 B2): without it /content/shared lists only what is already adopted.
  const videos = adoptedOnly || !delivery.ok ? new Set<string>() : new Set(((await readPages((from, to) => db.from("gtm_story_assets").select("id,story_id", { count: "exact" }).eq("kind", "video").order("id").range(from, to), "video pieces")) as { story_id: string }[]).map((a) => a.story_id));
  const wanted = [...new Set([...shared, ...videos])].filter((id) => !filters.piece || id === filters.piece).sort();
  const heads = wanted.length ? (await readChunks(wanted, (ids, from, to) => db.from("gtm_stories").select("id,title,series,third_party_who", { count: "exact" }).in("id", ids).order("id").range(from, to), "piece headings")) as Head[] : [];
  const pillars = shared.size ? (await readChunks([...shared], (ids, from, to) => db.from("gtm_content_items").select("id,story_id,pillar", { count: "exact" }).in("story_id", ids).order("id").range(from, to), "shared piece pillars")) as { story_id: string; pillar: string | null }[] : [];
  const loaded = await bounded(heads, 4, async (h) => {
    try { return { h, ...(await loadCard(db, h, shared.has(h.id))) }; }
    catch (e) { return { h, problem: e instanceof Error ? e.message : String(e) }; }
  });
  let total = 0, shown = 0;
  const cards: React.ReactNode[] = [];
  // The overview line and third-party links count the pieces on screen.
  const summary = { pieces: 0, textApproved: 0, videoApproved: 0, fixes: 0, ready: 0, notes: 0 };
  const parties = new Map<string, string[]>();
  for (const x of loaded) {
    if ("problem" in x) {
      // An unreadable piece is counted and named, so it is never silently missing from a filter.
      total++; shown++;
      cards.push(<p key={x.h.id} role="alert" className="mb-4 text-sm text-red-strong">{x.h.title}: shared review could not be loaded ({x.problem}). Refresh to retry.</p>);
      continue;
    }
    const { snapshot, card } = x;
    if (snapshot) {
      total++;
      const facts = { title: x.h.title, series: x.h.series, pillar: pillars.find((p) => p.story_id === x.h.id && p.pillar)?.pillar ?? null, notes: x.notes.map((n) => n.body), coverStatuses: card.covers.flatMap((c) => c.rows.map((r) => r.status)) };
      if (!sharedMatches(snapshot, filters, facts)) continue;
      shown++;
      summary.pieces++;
      summary.textApproved += Number(snapshot.text.status === "approved");
      summary.videoApproved += Number(snapshot.video.status === "approved");
      summary.fixes += snapshot.fixes.length;
      summary.ready += Number(snapshot.ready);
      summary.notes += new Set([...x.notes.map((n) => n.id), ...snapshot.legacyFixes.map((n) => n.id)]).size;
      const party = x.h.third_party_who?.trim();
      if (party) {
        const names = parties.get(party) ?? [];
        if (snapshot.video.status === "approved" && (snapshot.video.asset.stage ?? "final") === "final") names.push(x.h.title);
        parties.set(party, names);
      }
    }
    cards.push(<SharedPiece key={x.h.id} {...card} delivery={delivery} filters={filters} facts={{ title: x.h.title, series: x.h.series, pillar: pillars.find((p) => p.story_id === x.h.id && p.pillar)?.pillar ?? null, notes: x.notes.map((n) => n.body), coverStatuses: card.covers.flatMap((c) => c.rows.map((r) => r.status)) }} />);
  }
  const inviteRows = parties.size
    ? await readPages<{ id: string; party: string; expires_at: string; created_at: string; claimed_email: string | null; claimed_at: string | null; revoked_at: string | null }>((from, to) =>
        db.from("gtm_reviewer_invites").select("id,party,expires_at,created_at,claimed_email,claimed_at,revoked_at", { count: "exact" }).in("party", [...parties.keys()]).order("created_at", { ascending: false }).order("id").range(from, to), "shared reviewer links")
    : [];
  const links: ReviewLinkRow[] = inviteRows.map((i) => ({ id: i.id, party: i.party, state: inviteState(i), claimedEmail: i.claimed_email, expiresAt: i.expires_at, createdAt: i.created_at }));
  const people = cards.length ? await loadPeople(db).catch(() => []) : [];
  return {
    shown, total, delivery,
    node: (
      <PeopleProvider people={people} add={addPerson}>
      <div>
        {summary.pieces > 0 && (
          <section aria-label="Shared review overview" className="mb-5 rounded border border-line p-4">
            <h2 className="font-semibold">Shared review</h2>
            <p>
              {summary.pieces} pieces · Text approved {summary.textApproved}/{summary.pieces} · Video approved {summary.videoApproved}/{summary.pieces} · {summary.fixes} waiting for fix · {summary.notes} open notes · {summary.ready} ready for scheduling
            </p>
          </section>
        )}
        {parties.size > 0 && (
          <section aria-label="Shared third-party review" className="mb-5">
            <ReviewLinks parties={[...parties].map(([party, pieces]) => ({ party, pieces }))} links={links} share={shareForReview} revoke={revokeReviewLink} />
          </section>
        )}
        {!delivery.ok && (shared.size > 0 || !adoptedOnly) && (
          <p role="note" className="mb-4 rounded border border-dashed border-line p-3 text-sm text-ink-2" data-testid="shared-delivery-missing">
            Shared delivery is not installed: {delivery.reason}. {adoptedOnly ? "Shared pieces below cannot be scheduled yet." : "Pieces cannot be adopted until it is."}
          </p>
        )}
        {cards}
        {!cards.length && !adoptedOnly && <p>{delivery.ok ? "No video pieces found." : "No shared pieces yet."}</p>}
      </div>
      </PeopleProvider>
    ),
  };
}

type Head = { id: string; title: string; series: string | null; third_party_who: string | null };
async function loadCard(db: SupabaseClient, h: Head, adopted: boolean) {
  const snapshot = adopted ? await loadPieceReview(db, h.id) : null;
  const candidates = snapshot ? [] : await pieceCandidates(db, h.id);
  const path = snapshot ? playPath(snapshot.video.asset) : null;
  // A video that cannot be signed (missing object, Storage 429 after retries) shows "Video preview unavailable".
  const signed = path ? await signedUrls(db, [path], 21600, BUCKET).catch(() => null) : null;
  const videoUrl = signed?.data?.[0] && !signed.data[0].error ? signed.data[0].signedUrl ?? null : null;
  const notes = snapshot
    ? (await readPages((from, to) => db.from("gtm_story_feedback").select("id,asset_id,body", { count: "exact" }).in("asset_id", [snapshot.text.asset.id, snapshot.video.asset.id]).is("resolved_at", null).order("created_at").order("id").range(from, to), "shared review notes")) as { id: string; asset_id: string; body: string }[]
    : [];
  const legacyChannels = candidates.length
    ? (await readChunks(candidates.map((c) => c.asset.id), (ids, from, to) => db.from("gtm_story_asset_channels").select("asset_id,channel", { count: "exact" }).in("asset_id", ids).order("asset_id").order("channel").range(from, to), "selected channels")) as { channel: string }[]
    : [];
  const channels = snapshot?.channels ?? [...new Set(legacyChannels.map((c) => c.channel).filter((c) => ["linkedin", "instagram", "youtube"].includes(c)))];
  // Covers and other images of an adopted piece stay per-platform decisions (the website schema keeps them decidable);
  // they are decided here, on the piece's card, so nothing that goes out is left without a place (review #151 N2).
  const covers = snapshot ? await loadCovers(db, h.id, snapshot.channels) : [];
  return { snapshot, notes, card: { notes, storyId: h.id, title: h.title, initial: snapshot, candidates, videoUrl, channels, covers } };
}

async function loadCovers(db: SupabaseClient, storyId: string, channels: string[]) {
  const images = (await readPages((from, to) => db.from("gtm_story_assets").select("id,title,sha256,revision,storage_path,stage", { count: "exact" }).eq("story_id", storyId).eq("kind", "image").order("id").range(from, to), "piece covers")) as { id: string; title: string; sha256: string; revision: number; storage_path: string | null; stage: string | null }[];
  if (!images.length) return [];
  const rows = (await readChunks(images.map((i) => i.id), (ids, from, to) => db.from("gtm_story_asset_channels").select("asset_id,channel,status,approved_sha256", { count: "exact" }).in("asset_id", ids).in("channel", channels).order("asset_id").order("channel").range(from, to), "cover decisions")) as { asset_id: string; channel: string; status: string; approved_sha256: string | null }[];
  const shown = images.filter((i) => rows.some((r) => r.asset_id === i.id));
  const paths = shown.map((i) => i.storage_path).filter((p): p is string => !!p);
  const signed = paths.length ? await signedUrls(db, paths, 21600, BUCKET).catch(() => null) : null;
  const url = (p: string | null) => (p && signed?.data?.find((x) => x.path === p && !x.error)?.signedUrl) || null;
  return shown.map((i) => ({
    id: i.id, title: i.title, sha256: i.sha256, revision: i.revision, src: url(i.storage_path),
    rows: rows.filter((r) => r.asset_id === i.id).map((r) => ({ channel: r.channel, status: r.status === "approved" && r.approved_sha256 !== i.sha256 ? "pending" : r.status })),
  }));
}

/** /content/shared: every video piece, adoptable once shared delivery is installed. */
export async function SharedReviewSection({ storyId }: { storyId?: string }) {
  const db = await sessionDb();
  return (await loadSharedSection(db, { filters: { ...NO_FILTERS, piece: storyId ?? "" } })).node;
}
