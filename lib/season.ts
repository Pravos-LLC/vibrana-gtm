// The Season review screen: every piece of a content season on one page, in slot order. A piece is one
// Story whose id starts with the season prefix (`s1-`) and whose title is "<slot> | <name>".
import { parseDocument, Scalar } from "yaml";
import { frontmatterData, splitFrontmatter } from "./frontmatter";
import type { StoryAsset, StoryChannel } from "./story";

export { isSeasonStory, onSeasonBoard } from "./season-id";
/** Frontmatter keys the screen lets the owner edit next to the caption. Everything else is preserved untouched. */
export const EDITABLE_FIELDS = ["first_comment", "youtube_title"] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];


/** "W2 Thu Oct 15 | The Wave" -> slot and name. A title without a separator is all name. */
export function parsePieceTitle(title: string): { slot: string; name: string } {
  const at = title.indexOf(" | ");
  return at < 0 ? { slot: "", name: title.trim() } : { slot: title.slice(0, at).trim(), name: title.slice(at + 3).trim() };
}

/** Stories sort by id (`s1-01-...`), which is slot order by construction. */
export const bySlot = <T extends { id: string }>(stories: T[]) => [...stories].sort((a, b) => a.id.localeCompare(b.id));

export function readFields(frontmatter: string): Partial<Record<EditableField, string>> {
  const data = frontmatterData(frontmatter);
  const out: Partial<Record<EditableField, string>> = {};
  for (const key of EDITABLE_FIELDS) if (typeof data[key] === "string") out[key] = (data[key] as string).trim();
  return out;
}

/**
 * Quotes a top-level one-line plain value that strict YAML rejects because it holds ": " (a URL after a label). Block scalars, flow collections, quoted values and indented lines are left exactly as they are.
 */
export function quoteLooseScalars(frontmatter: string): string {
  return frontmatter.split("\n").map((line) => {
    const m = /^([A-Za-z_][\w-]*):[ \t]+(.+?)[ \t]*$/.exec(line);
    if (!m) return line;
    const value = m[2];
    if (/^["'|>[{&*!]/.test(value) || !/: /.test(value)) return line;
    return `${m[1]}: ${JSON.stringify(value)}`;
  }).join("\n");
}

/** Rebuilds a copy file with new prose and edited frontmatter fields; every other key is left as it was. */
export function writeCopy(body: string, prose: string, fields: Partial<Record<EditableField, string>>): string {
  const raw = splitFrontmatter(body).frontmatter;
  // failsafe: every value stays the text it was written as (`slot: 07` is not rewritten to `slot: 7`).
  let doc = parseDocument(raw, { schema: "failsafe" });
  // Hand-written copy files are not always strict YAML (`first_comment: Full case study: https://...`). Quote just those
  // one-line values, keeping every other key, comment and value as written (2026-10-16: the refused save sent John to an
  // error page and lost his LinkedIn text). Anything still invalid is refused; the screen keeps the edit.
  if (doc.errors.length) doc = parseDocument(quoteLooseScalars(raw), { schema: "failsafe" });
  if (doc.errors.length) throw new Error(`the copy file's frontmatter is not valid YAML (${doc.errors[0].message}); fix the file before editing here`);
  for (const key of EDITABLE_FIELDS) {
    if (!(key in fields)) continue;
    const value = (fields[key] ?? "").trim();
    // Always quoted: under the failsafe write a plain `2026`, `true` or `007` would read back as a number or boolean.
    if (value) { const node = new Scalar(value); node.type = Scalar.QUOTE_DOUBLE; doc.set(key, node); } else if (doc.contents) doc.delete(key);
  }
  const frontmatter = doc.contents ? doc.toString().trim() : "";
  const text = prose.trim();
  return frontmatter ? `---\n${frontmatter}\n---\n\n${text}\n` : `${text}\n`;
}

export type Role = "linkedin" | "instagram" | "youtube";
/**
 * A card in /content: a Zernio platform (Role), or the Substack newsletter, which John approves there and publishes by
 * hand (lib/hand-published.ts). Code that posts or groups platform media takes Role, never this.
 */
export type ReviewChannel = Role | "newsletter";
export type Piece = {
  copy: Partial<Record<Role, StoryAsset>>;
  media: StoryAsset[];
  other: StoryAsset[];
};

/** Splits a Story's assets into the three channel texts and the media shown beside them. */
export function groupPiece(assets: StoryAsset[], reviews: StoryChannel[]): Piece {
  const piece: Piece = { copy: {}, media: [], other: [] };
  for (const asset of assets) {
    if (asset.kind === "video" || asset.kind === "image") { piece.media.push(asset); continue; }
    if (asset.kind !== "copy") continue;
    const channels = reviews.filter((r) => r.asset_id === asset.id).map((r) => r.channel);
    const role = (["linkedin", "instagram", "youtube"] as Role[]).find((r) => channels.includes(r) || asset.id.endsWith(`-${r}`));
    if (role) piece.copy[role] = asset; else piece.other.push(asset);
  }
  piece.media.sort((a, b) => a.id.localeCompare(b.id));
  return piece;
}

export const pieceStatus = (reviews: StoryChannel[]): "approved" | "changes" | "pending" =>
  reviews.length && reviews.every((r) => r.status === "approved") ? "approved"
    : reviews.some((r) => r.status === "rejected") ? "changes" : "pending";

/** Em and en dashes are banned in John's copy (`gtm check` enforces the same rule). */
export const hasBannedDash = (text: string) => /[–—]/.test(text);

/** An unfilled `[JOHN: ...]` placeholder means the text is not ready to approve. */
export const hasPlaceholder = (text: string) => /\[JOHN\b/i.test(text);

export const ROLES: Role[] = ["linkedin", "instagram", "youtube"];
/** Every card /content shows, in tab order: the platforms, then the newsletter. */
export const REVIEW_CHANNELS: ReviewChannel[] = [...ROLES, "newsletter"];
export const isRole = (channel: string): channel is Role => (ROLES as string[]).includes(channel);

/** Width over height of a media asset, from the aspect tag in its file name. Carousel slides are 4:5. */
export function ratioOf(source: string): number {
  return /9x16/.test(source) ? 9 / 16 : 4 / 5;
}

export type Part = "text" | "asset";
export type PartStatus = "approved" | "pending" | "rejected" | "none";

/** Approval state of one part of one platform card: every row for that channel must be approved. */
export function partStatus(reviews: { asset_id: string; channel: string; status: string }[], assetIds: string[], channel: string): PartStatus {
  const rows = reviews.filter((r) => r.channel === channel && assetIds.includes(r.asset_id));
  if (!rows.length) return "none";
  if (rows.some((r) => r.status === "rejected")) return "rejected";
  return rows.every((r) => r.status === "approved") ? "approved" : "pending";
}

/** v1, v1.1, ...: the label stored on each version row. */
export const versionLabel = (v: { label: string }) => v.label;
