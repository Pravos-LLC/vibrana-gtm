// The Substack card in /content (John, 2026-10-16: "add substack as a channel, and I'll copy paste to publish"). Pure, so
// the page and the Story page build the same export, and every rule here is unit tested.
import { substackEditorUrl } from "./publications";
import { referencedImages, substackExport, type SubstackExport } from "./substack";

/** An image as the export panel needs it: `url` goes into the pasted HTML, `copyUrl` feeds "Copy image". */
export type NewsletterImage = SubstackExport["images"][number] & { copyUrl: string };
export type NewsletterExport = { data: SubstackExport; images: NewsletterImage[]; editorUrl: string | null };

type Asset = { id: string; kind: string; source: string; body?: string | null; metadata?: Record<string, unknown> | null };
type Row = { asset_id: string; channel: string };

const fileOf = (source: string) => source.split("/").pop() ?? source;

/**
 * Each newsletter essay of a Story (a copy asset assigned to `newsletter`) with the newsletter images it shows: the ones its
 * body names, and any newsletter image no essay names (a header option kept beside the draft). A Story can carry two essays
 * (example-reference-38: the personal Substack and Regenera); each is its own card, decided on its own.
 *
 * Only the essay and the images it names are decided (`named`): they are what gets pasted into Substack. An image no essay
 * names is an alternative (`alternatives`, kb-tokenmaxxing's spare headers, 2026-10-17): still shown on the card, never a
 * gate, so unused options cannot keep an approved essay waiting. Naming one in the essay makes it part of the decision.
 */
export function newsletterParts<A extends Asset>(own: A[], rows: Row[]): Array<{ copy: A; media: A[]; named: A[]; alternatives: A[] }> {
  const on = (a: A) => rows.some((r) => r.asset_id === a.id && r.channel === "newsletter");
  const copies = own.filter((a) => a.kind === "copy" && on(a)).sort((x, y) => x.id.localeCompare(y.id));
  const images = own.filter((a) => a.kind === "image" && on(a)).sort((x, y) => x.id.localeCompare(y.id));
  const isNamed = (copy: A, image: A) => referencedImages(copy.body ?? "").includes(fileOf(image.source));
  const loose = images.filter((i) => !copies.some((c) => isNamed(c, i)));
  return copies.map((copy) => {
    const named = images.filter((i) => isNamed(copy, i));
    return { copy, media: images.filter((i) => named.includes(i) || loose.includes(i)), named, alternatives: loose };
  });
}

/**
 * The rows that decide something: newsletter rows on images no newsletter essay names are left out, so piece-level state
 * (the final, the badge, the home count) never waits on an unused option, and so are published essays (`withoutPublished`).
 * Every other row is kept.
 */
export function withoutAlternatives<R extends Row>(own: Asset[], rows: R[]): R[] {
  const on = (a: Asset) => rows.some((r) => r.asset_id === a.id && r.channel === "newsletter");
  const essays = own.filter((a) => a.kind === "copy" && on(a));
  const alt = new Set(own.filter((a) => a.kind === "image" && on(a) && !essays.some((c) => referencedImages(c.body ?? "").includes(fileOf(a.source)))).map((a) => a.id));
  return withoutPublished(own, rows).filter((r) => !(r.channel === "newsletter" && alt.has(r.asset_id)));
}

/**
 * The rows left once published essays are set aside: a published essay (`publishedUrl`) and the images only it names have no
 * newsletter row that decides anything, sent back or pending. An image an unpublished essay also names stays: it still has
 * to be approved for that essay.
 */
export function withoutPublished<R extends Row>(own: Asset[], rows: R[]): R[] {
  const on = (a: Asset) => rows.some((r) => r.asset_id === a.id && r.channel === "newsletter");
  const essays = own.filter((a) => a.kind === "copy" && on(a));
  const live = essays.filter((c) => publishedUrl(c));
  if (!live.length) return rows;
  const open = essays.filter((c) => !publishedUrl(c));
  const names = (c: Asset, i: Asset) => referencedImages(c.body ?? "").includes(fileOf(i.source));
  const done = new Set([
    ...live.map((c) => c.id),
    ...own.filter((a) => a.kind === "image" && on(a) && live.some((c) => names(c, a)) && !open.some((c) => names(c, a))).map((a) => a.id),
  ]);
  return rows.filter((r) => !(r.channel === "newsletter" && done.has(r.asset_id)));
}

/**
 * What "Copy for Substack" pastes, from the essay's saved body and the Story's stored images. A permanent public URL is
 * used when the image has one; otherwise the signed URL (flagged as expiring by the panel), so the copy still works
 * while the public bucket is not configured.
 */
export function newsletterExport(body: string, images: Array<{ source: string; signedUrl: string | null; publicUrl: string | null; alt: string }>): NewsletterExport {
  const stored = images.filter((i) => i.signedUrl).map((i) => ({ file: fileOf(i.source), signedUrl: i.signedUrl!, publicUrl: i.publicUrl }));
  const data = substackExport(body, stored.map((i) => ({ file: i.file, url: i.publicUrl ?? i.signedUrl, permanent: Boolean(i.publicUrl) })));
  return {
    data,
    images: data.images.map((image) => ({ ...image, copyUrl: stored.find((s) => s.file === image.file)?.signedUrl ?? image.url })),
    editorUrl: data.publication ? substackEditorUrl(data.publication) : null,
  };
}

/**
 * The live Substack URL once John has published the essay (`gtm story mark-published`, John 2026-10-18: "this piece is already
 * published on Substack... mark it as published and remove it from /content"). A published essay has nothing left to decide, so
 * its card leaves /content. Changed bytes start clean (lib/story.ts), so a rewritten essay comes back for review.
 */
export function publishedUrl(copy: { metadata?: Record<string, unknown> | null }): string | null {
  const url = copy.metadata?.published_url;
  return typeof url === "string" && /^https:\/\//.test(url) ? url : null;
}

/** Metadata without the published mark: an essay whose text changed is no longer the one that went live, so it returns to review. */
export function unpublished(metadata: Record<string, unknown>): Record<string, unknown> {
  const { published_url: _url, published_at: _at, ...rest } = metadata;
  return rest;
}
