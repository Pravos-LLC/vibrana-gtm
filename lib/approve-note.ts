// "Approve with note" in /content (John, 2026-10-13): "I want to be able to 'Approve with note' and assume the agent will
// fix that small issue and then get that finished version to scheduling."
//
// John approves the part (a platform's text, or final media shared by its platforms) and leaves a note in the same click.
// The note is stored as ordinary Story feedback whose first line marks it as "fix before scheduling" and names the part
// it covers, so no schema change is needed and every reader of gtm_story_feedback still sees a plain note:
//
//   [approved with note: fix before scheduling] part=text channels=linkedin assets=s1-07-foo-linkedin
//   Swap "colour" for "color" in the second line.
//
// While the note is open the piece is held: auto-schedule never queues it (lib/auto-schedule.ts). The agent applies the
// fix, restages, then `gtm story resolve <note-id> "<reply>"`, which refuses until a newer version of the part has been
// staged, re-records John's approval on the fixed bytes under his owner session (he approved it, with this note), and
// runs auto-schedule. The piece never comes back to John for another review.

export const FIX_MARKER = "[approved with note: fix before scheduling]";
/** gtm_story_feedback.body is limited to 5000 characters; the header takes the rest. */
export const FIX_NOTE_MAX = 4000;

export type FixPart = "text" | "media";
export type FixNoteHead = { part: FixPart; channels: string[]; assets: string[] };
export type ParsedFixNote = FixNoteHead & { note: string };

const SLUG = /^[a-z0-9][a-z0-9._-]*$/i;

/** The feedback body for an approve-with-note: the marker line, then John's note as he typed it. */
export function encodeFixNote(head: FixNoteHead, note: string): string {
  const text = note.trim();
  if (!text) throw new Error("Write the note first.");
  if (text.length > FIX_NOTE_MAX) throw new Error(`Keep the note under ${FIX_NOTE_MAX} characters.`);
  if (!head.channels.length || !head.assets.length) throw new Error("Nothing to approve here.");
  for (const x of [...head.channels, ...head.assets]) if (!SLUG.test(x)) throw new Error(`invalid id ${x}`);
  return `${FIX_MARKER} part=${head.part} channels=${head.channels.join(",")} assets=${head.assets.join(",")}\n${text}`;
}

/** The approve-with-note a feedback body carries, or null for an ordinary note. */
export function parseFixNote(body: string | null | undefined): ParsedFixNote | null {
  if (!body || !body.startsWith(FIX_MARKER)) return null;
  const nl = body.indexOf("\n");
  const head = (nl < 0 ? body : body.slice(0, nl)).slice(FIX_MARKER.length).trim();
  const fields = Object.fromEntries(head.split(/\s+/).filter(Boolean).map((kv) => { const i = kv.indexOf("="); return i < 0 ? [kv, ""] : [kv.slice(0, i), kv.slice(i + 1)]; }));
  const part = fields.part === "text" || fields.part === "media" ? fields.part : null;
  const channels = (fields.channels ?? "").split(",").filter(Boolean);
  const assets = (fields.assets ?? "").split(",").filter(Boolean);
  if (!part || !channels.length || !assets.length) return null;
  return { part, channels, assets, note: nl < 0 ? "" : body.slice(nl + 1) };
}

/** What John sees of a note: his words, with the marker line taken off an approve-with-note. */
export function noteText(body: string): { text: string; approvedWithNote: boolean } {
  const fix = parseFixNote(body);
  if (fix) return { text: fix.note, approvedWithNote: true };
  const formats = parseFormatsNote(body);
  return { text: formats ? formats.note : body, approvedWithNote: false };
}

export type FixNote = ParsedFixNote & { id: string; storyId: string; assetId: string; channel: string | null; createdAt: string };

/** True when an open approve-with-note covers this asset on this platform (John approved it; the agent is fixing it). */
export function coveredByFixNote(notes: Array<Pick<FixNote, "assets" | "channels">>, assetId: string, channel: string): boolean {
  return notes.some((n) => n.assets.includes(assetId) && n.channels.includes(channel));
}

/**
 * The fix has landed when any asset of the part has a version staged after John's note (a restage, or an edit saved in
 * the cockpit). Pure over the version rows.
 */
export function fixLanded(note: Pick<FixNote, "assets" | "createdAt"> & { part?: FixPart }, versions: Array<{ asset_id: string; created_at: string }>): boolean {
  const newer = (id: string) => versions.some((v) => v.asset_id === id && v.created_at > note.createdAt);
  // One text for every platform (2026-10-16): a text note covers each platform's copy file, and every one of them must
  // carry the fix, or the others would be re-approved at the old words.
  return note.part === "text" ? [...new Set(note.assets)].every(newer) : note.assets.some(newer);
}

// One note for every format of a video (John, 2026-10-13: he wrote a note on the LinkedIn 4:5 cut, then had to type "Same
// feedback as LinkedIn" on the Instagram and YouTube 9:16 cuts). A note or "Request changes" on any format covers every
// format of that video unless he ticks "Only this format". It is stored ONCE (on the first asset, so `gtm story resolve`
// closes it once) with a marker line naming every asset it covers, like the approve-with-note header above, so no schema
// change is needed: the page shows it on each format and `gtm story feedback` lists the formats it covers.
//
//   [note for all formats] assets=s1-24-example-record-26-video-4x5,s1-24-example-record-26-video-9x16,...
//   The opening title should be "70 to 80 questions in one email."

export const FORMATS_MARKER = "[note for all formats]";
export type ParsedFormatsNote = { assets: string[]; note: string };

/** The feedback body for a note that covers several formats (or files) at once; a single asset gets the plain note. */
export function encodeFormatsNote(assets: string[], note: string): string {
  const text = note.trim();
  if (!text) throw new Error("Write the note first.");
  const ids = [...new Set(assets)].sort();
  for (const x of ids) if (!SLUG.test(x)) throw new Error(`invalid id ${x}`);
  if (ids.length < 2) return text;
  if (text.length > FIX_NOTE_MAX) throw new Error(`Keep the note under ${FIX_NOTE_MAX} characters.`);
  return `${FORMATS_MARKER} assets=${ids.join(",")}\n${text}`;
}

export function parseFormatsNote(body: string | null | undefined): ParsedFormatsNote | null {
  if (!body || !body.startsWith(FORMATS_MARKER)) return null;
  const nl = body.indexOf("\n");
  const head = (nl < 0 ? body : body.slice(0, nl)).slice(FORMATS_MARKER.length).trim();
  const assets = (/(?:^|\s)assets=(\S+)/.exec(head)?.[1] ?? "").split(",").filter(Boolean);
  return assets.length ? { assets, note: nl < 0 ? "" : body.slice(nl + 1) } : null;
}

/** Every asset a note covers: the assets its header names (a note for all formats, an approve-with-note), else its own. */
export function noteAssets(note: { asset_id: string; body: string }): string[] {
  const head = parseFormatsNote(note.body)?.assets ?? parseFixNote(note.body)?.assets;
  return head?.length ? [...new Set([note.asset_id, ...head])] : [note.asset_id];
}

/** True when the note is about this asset (stored on it, or naming it in its header). */
export const noteCovers = (note: { asset_id: string; body: string }, assetId: string) => noteAssets(note).includes(assetId);

/**
 * The formats of one video in a Story: its video assets named `<base>-video[-<format>]` (s1-24-example-record-26-video-4x5,
 * -video-9x16, -video-9x16-youtube; s1-14-...-video-clean-open and -video-cover-open; coherence-c1a-...-video). Null for
 * anything that is not a video, or a video named another way (it stands alone).
 */
export function videoBase(asset: { id: string; kind: string }): string | null {
  if (asset.kind !== "video") return null;
  return /^(.+)-video(?:-[a-z0-9][a-z0-9-]*)?$/i.exec(asset.id)?.[1] ?? null;
}
