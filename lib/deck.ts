// Post text follows the asset (John, 2026-10-05). A list carousel's slides.json is the source of
// truth for the list: the post text must name every item on the slides, its numbered lines must
// match the slide numbers, and it must have been synced since the slides last changed. The sync
// stamp is `deck_sha256` in the copy file's frontmatter (other frontmatter keys are kept).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseDocument } from "yaml";

export type DeckSlide = { type: string; n?: number; title?: string; body?: string; name?: string; line?: string };
export type Deck = { template?: string; slides: DeckSlide[] };
export type DeckEntry = { n: number | null; name: string; line: string };

export const deckDigest = (raw: string) => createHash("sha256").update(raw).digest("hex");

// Closing fence at a line start; an empty block (---\n---) is allowed. A UTF-8 BOM is ignored.
const fmPattern = /^\uFEFF?---\n(?:([\s\S]*?)\n)?---(?:\n|$)/;

/** Prose without frontmatter, so a name in `first_comment` does not count as being in the post. */
/** Only list decks (template "listicle") hold a list the post must follow; framework and case-study decks do not. */
export const isListDeck = (deck: Deck) => deck.template === "listicle";

export function proseOf(text: string): string {
  return text.replace(fmPattern, "");
}

export function stampOf(text: string): string | null {
  const m = text.match(fmPattern);
  if (!m) return null;
  const data = parseDocument(m[1] ?? "").toJS() as Record<string, unknown> | null;
  return typeof data?.deck_sha256 === "string" ? data.deck_sha256 : null;
}

/** Sets `deck_sha256` in the frontmatter by editing that one line, so every other key keeps its exact bytes. */
export function withStamp(text: string, digest: string): string {
  const line = `deck_sha256: ${digest}`;
  const m = text.match(fmPattern);
  if (!m) return `---\n${line}\n---\n\n${text.replace(/^\uFEFF/, "").trimStart()}`;
  const body = m[1] ?? "";
  const fm = /^deck_sha256:.*$/m.test(body) ? body.replace(/^deck_sha256:.*$/m, line) : body ? `${body}\n${line}` : line;
  return `---\n${fm}\n---\n${text.slice(m[0].length).replace(/^(?!\n)/, "\n")}`;
}

const firstSentence = (s: string) => s.replace(/\s*Source:.*$/s, "").trim().split(/(?<=[.!?])\s+(?=[A-Z0-9])/)[0] ?? "";

/** The list a post must carry: every numbered item, plus any slide that names a bonus (`name`). */
export function deckEntries(deck: Deck): DeckEntry[] {
  const out: DeckEntry[] = [];
  if (!isListDeck(deck)) return out;
  for (const s of deck.slides ?? []) {
    if (s.type === "item" && s.title) out.push({ n: typeof s.n === "number" ? s.n : null, name: s.title, line: s.line ?? `${s.title}. ${firstSentence(s.body ?? "")}`.trim() });
    else if (s.name) out.push({ n: null, name: s.name, line: s.line ?? s.name });
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().normalize("NFC");
// One or two digits: a line opening with a year ("2026. ...") is prose, not a list item.
const numbered = /^(\d{1,2})\.\s+(.*)$/;

/** Problems that make the post text disagree with its slides. Empty means the text follows the asset. */
export function deckCopyProblems(text: string, deck: Deck, digest: string): string[] {
  if (!isListDeck(deck)) return [];
  const prose = norm(proseOf(text));
  const entries = deckEntries(deck);
  const problems: string[] = [];
  const missing = entries.filter((e) => !prose.includes(norm(e.name))).map((e) => e.name);
  if (missing.length) problems.push(`post text is missing slide items: ${missing.join(", ")}`);
  for (const line of proseOf(text).split("\n")) {
    const m = line.trim().match(numbered);
    if (!m) continue;
    const item = entries.find((e) => e.n === Number(m[1]));
    if (!item) problems.push(`post text has item ${m[1]}, the slides do not`);
    else if (!norm(m[2]).startsWith(norm(item.name))) problems.push(`post text item ${m[1]} is "${m[2].slice(0, 40)}", the slide says ${item.name}`);
  }
  if (stampOf(text) !== digest) problems.push("the slides changed since this text was last synced to them (deck_sha256): regenerate the list or update the text, then restamp");
  return problems;
}

/**
 * Rewrites the first run of numbered lines (blank lines between items allowed) from the slides,
 * keeping the run's direction (10 to 1 or 1 to 10) and spacing. Returns null when there is no run
 * to rewrite, so prose lists are left for a person to edit.
 */
export function syncNumberedList(text: string, deck: Deck): string | null {
  const entries = deckEntries(deck).filter((e): e is DeckEntry & { n: number } => e.n !== null);
  if (!entries.length) return null;
  const lines = text.split("\n");
  const start = lines.findIndex((l) => numbered.test(l));
  if (start < 0) return null;
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    if (numbered.test(lines[i])) end = i;
    else if (lines[i].trim() !== "") break;
  }
  const run = lines.slice(start, end + 1);
  const nums = run.map((l) => l.match(numbered)).filter(Boolean).map((m) => Number(m![1]));
  const descending = nums.length > 1 && nums[0] > nums[nums.length - 1];
  const spaced = run.some((l) => l.trim() === "");
  const ordered = [...entries].sort((a, b) => (descending ? b.n - a.n : a.n - b.n));
  const block = ordered.map((e) => `${e.n}. ${e.line}`).join(spaced ? "\n\n" : "\n").split("\n");
  return [...lines.slice(0, start), ...block, ...lines.slice(end + 1)].join("\n");
}

/** The deck a carousel was rendered from: `slides.json` beside its slide images (the exporter writes it there). */
export function findDeck(mediaFiles: string[]): { path: string; raw: string; deck: Deck } | null {
  for (const f of mediaFiles) {
    if (!/\.(png|jpe?g|webp)$/i.test(f)) continue;
    const path = join(dirname(f), "slides.json");
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, "utf8");
    return { path, raw, deck: JSON.parse(raw) as Deck };
  }
  return null;
}
