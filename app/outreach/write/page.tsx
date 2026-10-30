import { Shell } from "@/components/shell";
import { WritingDesk } from "@/components/outreach/writing-desk";
import { deskPerson, deskQueue, deskTracks, type DeskPerson } from "@/lib/outreach/desk-store";
import { isPersonId, isTrack, senderFor, senderProfile, type QueueItem, type Track } from "@/lib/outreach/desk";
import { REPORT_TZ } from "@/lib/reports/week";
import { sessionDb } from "@/lib/supabase/server";
import { loadDeskPerson, markFollowUp, markInviteSent, markSent, saveDeskDraft, setDeskTarget, skipDeskPerson, undoFollowUp, undoSent, unskipDeskPerson } from "./actions";

export const dynamic = "force-dynamic";
// The learning run after a send (next/server after) reads John's edit with one model call.
export const maxDuration = 90;

const actions = {
  load: loadDeskPerson, save: saveDeskDraft, markSent, undoSent, markInvite: markInviteSent,
  markFollowUp, undoFollowUp, skip: skipDeskPerson, unskip: unskipDeskPerson, setTarget: setDeskTarget,
};

export const metadata = { title: "Writing desk" };

/**
 * The writing desk: John writes each cold email himself (VIB-437), to client prospects and to podcast guests (VIB-463: two
 * streams, one screen, each with its own sender and daily target). The queue of people with a dossier from vibrana-crm
 * (`gtm outreach import-dossiers`), a composer autosaved to his desk draft, and the dossier beside it. He sends from Gmail
 * (clients as user-045d73df3c9a@example.com, guests as user-8dd8662c2f5a@example.com) and marks it sent here, which counts toward that stream's
 * daily target. `?t=guest|client` picks the stream (clients by default), `?p=` the person.
 */
export default async function WritingDeskPage({ searchParams }: { searchParams: Promise<{ p?: string; t?: string }> }) {
  const { p, t } = await searchParams;
  const db = await sessionDb(); // RLS: only the owner reads the desk tables
  let queues: Record<Track, QueueItem[]>;
  let tracks;
  try {
    const [client, guest, settings] = await Promise.all([deskQueue(db, "client"), deskQueue(db, "guest"), deskTracks(db)]);
    queues = { client, guest };
    // The sender and the signature follow the signed-in person (app_metadata.gtm_sender / gtm_signature), so Abe composes as himself.
    const { data: claims } = await db.auth.getClaims();
    tracks = { client: { ...settings.client, from_address: senderFor("client", settings.client.from_address, claims?.claims), profile: senderProfile("client", settings.client.profile, claims?.claims) }, guest: settings.guest };
  } catch (e) {
    return <Shell title="Writing desk" active="/outreach/write" wide><p className="text-sm text-red-strong">The desk could not load: {e instanceof Error ? e.message : String(e)}</p></Shell>;
  }
  const linked = p && isPersonId(p) ? (["client", "guest"] as const).find((k) => queues[k].some((q) => q.twenty_person_id === p)) : undefined;
  // The stream in the link, else the one the linked person is in, else clients.
  const track: Track = isTrack(t) ? t : linked ?? "client";
  const queue = queues[track];
  // The person in the link, else the highest-scored one still to write, else the first.
  const pick = (p && isPersonId(p) && queue.some((q) => q.twenty_person_id === p) ? p : null)
    ?? queue.find((q) => q.state === "to_write")?.twenty_person_id ?? queue[0]?.twenty_person_id ?? null;
  let person: DeskPerson | null = null;
  let error: string | null = null;
  if (pick) {
    try { person = await deskPerson(db, pick, tracks[track].profile, track); } catch (e) { error = e instanceof Error ? e.message : String(e); }
  }
  return (
    <Shell title="Writing desk" active="/outreach/write" wide>
      {error && <p className="mb-3 text-sm text-red-strong">{error}</p>}
      <WritingDesk initialQueues={queues} initialTrack={track} initialPerson={person} tracks={tracks} tz={REPORT_TZ()} actions={actions} />
    </Shell>
  );
}
