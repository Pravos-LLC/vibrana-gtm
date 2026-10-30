// @mentions that actually tag (John, 2026-10-16: "How do I know when mentioning someone it will actually work?").
//
// John types `@Chetan Nandakumar` once in a piece's one shared text. A plain `@Name` tags nobody on any platform, so at
// publish each platform gets the form that tags there, from the people list (gtm_people):
//   LinkedIn   `@[<exact LinkedIn name>](urn:li:person:...)`  (Zernio's mention format; the URN is resolved once, cached)
//   Instagram  `@<handle>`
//   YouTube    the plain name (nobody is notified there; a stray "@" would read as a broken handle)
// Anyone not on file, or without the account for that platform, goes out as their plain name. /content shows the same
// result before John approves (mentionReport), so what he sees is what posts.
//
// Plain names (John, 2026-10-16: "how can we intelligently make sure that when I mention Chetan or Abe or Fatma ... it
// actually tags them?"): someone marked `auto_tag` (the team) is tagged on LinkedIn the first time John writes their name,
// no "@" needed: "Chetan and I built" goes out as `@[Chetan](urn) and I built`. LinkedIn links a person tag whose text is
// any one of their names, case-sensitive (Posts API docs, "Mentions and Hashtags"), so the tag carries the words John
// wrote, never a swapped-in "Chetan Nandakumar, PhD". Tags work only in the post: a tag in a comment posts as raw text
// (tested live 2026-10-12), so a LinkedIn first comment gets plain names.

export type Person = {
  name: string;
  linkedin_name: string | null;
  linkedin_urn: string | null;
  linkedin_error?: string | null;
  instagram_handle: string | null;
  /** Tag on LinkedIn whenever John writes their name, without "@". */
  auto_tag?: boolean | null;
};

/** `auto`: a plain name (no "@") of someone marked auto_tag. */
export type Mention = { start: number; end: number; typed: string; person: Person | null; auto?: boolean };
export type MentionChannel = "linkedin" | "instagram" | "youtube";
/** `fixable`: adding a profile link or handle for this person would make it tag. */
export type MentionResult = { typed: string; person: Person | null; channel: MentionChannel; tags: boolean; output: string; why: string; fixable: boolean };
/** `comment`: the text is a first comment, where LinkedIn shows a tag as raw text. */
export type MentionOpts = { comment?: boolean };

const nameChar = /[\p{L}\p{M}\p{N}'’.-]/u;
/** A name goes on only through letters and digits: "@Chetan Nandakumar." and "@Chetan Nandakumar's" still match him. */
const wordChar = /[\p{L}\p{M}\p{N}]/u;

/** Every `@...` in the text: the longest person name that follows the "@", else the unknown name as typed. */
export function findMentions(raw: string, people: Person[]): Mention[] {
  // NFC, so an accented name typed in decomposed form matches the stored one letter for letter.
  const text = raw.normalize("NFC");
  // The team (auto_tag) can also be @-mentioned by first name ("@Chetan") when no one else marked shares it.
  const byLength = [...people.map((p) => ({ p, n: p.name.normalize("NFC") })), ...teamFirstNames(people)].sort((a, b) => b.n.length - a.n.length);
  const out: Mention[] = [];
  for (let i = text.indexOf("@"); i >= 0; i = text.indexOf("@", i + 1)) {
    // An email address or a handle glued to a word is not a mention.
    if (i > 0 && nameChar.test(text[i - 1])) continue;
    // An "@" inside a link (tiktok.com/@example_approver) is part of the link, not a mention.
    const word = /\S*$/.exec(text.slice(0, i))![0];
    if (/[/:]|www\./i.test(word) || /^\S*\/$/.test(word)) continue;
    const rest = text.slice(i + 1);
    const hit = byLength.find(({ p, n }) => rest.slice(0, n.length).toLowerCase() === n.toLowerCase() && !wordChar.test(rest[n.length] ?? " ")
      // A team first name that starts someone else's name on the list is them, not the team member.
      && !(n !== p.name.normalize("NFC") && otherPerson(rest.slice(n.length), n, p, people)));
    if (hit) { const len = hit.n.length; out.push({ start: i, end: i + 1 + len, typed: text.slice(i, i + 1 + len), person: hit.p }); i += len; continue; }
    // Unknown: a handle (`@some.handle`) or up to three capitalized words (`@Jane Doe`).
    const m = /^([\p{L}\p{N}._]+(?:\s+\p{Lu}[\p{L}\p{M}'’-]*){0,2})/u.exec(rest);
    if (!m) continue;
    const typed = m[1].replace(/[.]+$/, "");
    if (!typed) continue;
    out.push({ start: i, end: i + 1 + typed.length, typed: `@${typed}`, person: null });
    i += typed.length;
  }
  return [...out, ...plainNames(text, people, out)].sort((a, b) => a.start - b.start);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const firstWord = (name: string) => name.split(/\s+/)[0];
/** A team first name that, with the word after it, starts someone else's name on the list ("Chetan Rao"). Only the list
 *  decides: skipping on any capitalized word would silently drop "Met Chetan Monday", and a wrong plain-name tag is at
 *  least visible in /content's check before approval. */
function otherPerson(after: string, first: string, p: Person, people: Person[]): boolean {
  const next = /^[ \t]+([\p{L}\p{M}'’-]+)/u.exec(after)?.[1];
  if (!next) return false;
  const both = `${first} ${next}`.toLowerCase();
  return people.some((q) => { if (q === p) return false; const n = q.name.normalize("NFC").toLowerCase(); return n === both || n.startsWith(both + " "); });
}

/** First names of auto_tag people that no other auto_tag person shares (and that are not their whole name). */
function teamFirstNames(people: Person[]): Array<{ p: Person; n: string }> {
  const team = people.filter((p) => p.auto_tag).map((p) => ({ p, n: firstWord(p.name.normalize("NFC")) }));
  return team.filter((t) => t.n !== t.p.name.normalize("NFC") && team.filter((u) => u.n.toLowerCase() === t.n.toLowerCase()).length === 1);
}

/** The first plain-text mention of each auto_tag person not already @-mentioned: their full name, or their first name
 *  when no one else marked auto_tag shares it. Case-sensitive, whole words, never inside a link, an email, a handle or
 *  a tag already in LinkedIn form. */
function plainNames(text: string, people: Person[], explicit: Mention[]): Mention[] {
  // Already tagged, by "@" or in LinkedIn form with their URN, means not tagged again.
  const marked = people.filter((p) => p.auto_tag && !explicit.some((m) => m.person === p) && !(p.linkedin_urn && text.includes(`](${p.linkedin_urn})`)));
  if (!marked.length) return [];
  const firsts = teamFirstNames(people);
  const blocked: Array<[number, number]> = explicit.map((m) => [m.start, m.end]);
  // Tags in LinkedIn form, links (any word with a "/", a "?", "=" or "&" running into more text, or a "x:y" scheme, so
  // example.com?name=Chetan and mailto:Abe, but not "Chetan?"), emails, handles and hashtags.
  for (const b of text.matchAll(/@\[[^\]]*\]\([^)]*\)|\S*(?:\/|[?=&][\p{L}\p{N}]|[\p{L}\p{N}]:[\p{L}\p{N}])\S*|\S+@\S+|[@#][\p{L}\p{N}._]+/gu)) blocked.push([b.index, b.index + b[0].length]);
  const out: Mention[] = [];
  for (const p of marked) {
    const full = p.name.normalize("NFC");
    const forms = [full, ...firsts.filter((f) => f.p === p).map((f) => f.n)];
    let best: Mention | null = null;
    for (const form of forms) {
      for (const hit of text.matchAll(new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_@#/-])${escapeRe(form)}(?![\\p{L}\\p{M}\\p{N}_])`, "gu"))) {
        const start = hit.index, end = start + form.length;
        if (form !== full && otherPerson(text.slice(end), form, p, people)) continue;
        if ([...blocked, ...out.map((m): [number, number] => [m.start, m.end])].some(([a, b]) => start < b && end > a)) continue;
        if (!best || start < best.start) best = { start, end, typed: form, person: p, auto: true };
        break;
      }
    }
    if (best) out.push(best);
  }
  return out;
}

/** The LinkedIn tag for the words John wrote. LinkedIn links a person tag whose text is their whole name, or any one of
 *  their names (case-sensitive), so the tag keeps his words: the whole of them when they are the LinkedIn name (with or
 *  without a "(She~her)"-style suffix; proven on the 2026-10-02 post), else the first word that is one of their names,
 *  with the rest left as he wrote it. */
function linkedinTag(written: string, name: string, urn: string): string {
  const bare = name.replace(/\s*\([^)]*\)/g, "").trim();
  const same = (a: string, b: string) => a.replace(/’/g, "'").toLowerCase() === b.replace(/’/g, "'").toLowerCase();
  if (written === name || written === bare) return `@[${written}](${urn})`;
  if (same(written, bare)) return `@[${bare}](${urn})`;
  const names = bare.split(/[\s,]+/).filter((w) => /\p{L}/u.test(w));
  const parts = written.split(/(\s+)/);
  for (let k = 0; k < parts.length; k += 2) {
    const own = names.find((n) => n === parts[k]) ?? names.find((n) => same(n, parts[k]));
    if (own) return [...parts.slice(0, k), `@[${own}](${urn})`, ...parts.slice(k + 1)].join("");
  }
  return `@[${name}](${urn})`;
}

/** What one mention becomes on one platform, and whether it tags there. */
export function mentionOn(m: Mention, channel: MentionChannel, opts: MentionOpts = {}): MentionResult {
  const p = m.person;
  const base = { typed: m.typed, person: p, channel, fixable: false };
  if (!p) return { ...base, tags: false, output: m.typed, why: opts.comment && channel === "linkedin" ? "LinkedIn tags only in the post, not in comments" : "not in your people list", fixable: !(opts.comment && channel === "linkedin") };
  // Where it does not tag, the name reads as written: a plain name exactly, "@Chetan" as "Chetan", "@fatma Sample Person" as
  // the name on file.
  const written = m.typed.replace(/^@/, "");
  const plain = !m.auto && written.toLowerCase() === p.name.normalize("NFC").toLowerCase() ? p.name : written;
  if (channel === "linkedin") {
    if (opts.comment) return { ...base, tags: false, output: plain, why: "LinkedIn tags only in the post, not in comments" };
    if (p.linkedin_urn && p.linkedin_name && !/[\[\]]/.test(p.linkedin_name)) return { ...base, tags: true, output: linkedinTag(written, p.linkedin_name, p.linkedin_urn), why: "" };
    if (p.linkedin_name && /[\[\]]/.test(p.linkedin_name)) return { ...base, tags: false, output: plain, why: "their LinkedIn name has a [ or ], which the tag cannot carry" };
    return { ...base, tags: false, output: plain, why: p.linkedin_error ? `LinkedIn could not resolve the profile (${p.linkedin_error})` : "no LinkedIn profile on file", fixable: !p.linkedin_urn };
  }
  if (channel === "instagram") {
    if (m.auto) return { ...base, tags: false, output: plain, why: "Instagram tags only an @handle; write @" + p.name + " to tag there" };
    if (p.instagram_handle) return { ...base, tags: true, output: `@${p.instagram_handle}`, why: "" };
    return { ...base, tags: false, output: plain, why: "no Instagram handle on file", fixable: true };
  }
  return { ...base, tags: false, output: plain, why: "YouTube does not tag" };
}

/** The text for one platform, every known mention in that platform's form. Unknown mentions stay as typed. */
export function renderMentions(raw: string, channel: MentionChannel, people: Person[], opts: MentionOpts = {}): string {
  const text = raw.normalize("NFC");
  const found = findMentions(text, people).filter((m) => m.person);
  let out = "";
  let at = 0;
  for (const m of found) { out += text.slice(at, m.start) + mentionOn(m, channel, opts).output; at = m.end; }
  return out + text.slice(at);
}

/** For /content: each distinct mention in the text, and what it does on each platform the piece posts to. */
export function mentionReport(text: string, channels: MentionChannel[], people: Person[], opts: MentionOpts = {}): Array<{ typed: string; person: Person | null; auto: boolean; results: MentionResult[] }> {
  const seen = new Map<string, { typed: string; person: Person | null; auto: boolean; results: MentionResult[] }>();
  for (const m of findMentions(text, people)) {
    const key = m.person ? `p:${m.person.name}` : `u:${m.typed.toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, { typed: m.typed, person: m.person, auto: !!m.auto, results: channels.map((c) => mentionOn(m, c, opts)) });
  }
  return [...seen.values()];
}

/** What John types for a LinkedIn name: no pronouns, credentials or emoji ("Fatma Sample Person (She~her)" -> "Fatma Sample Person"). */
export function typedName(linkedinName: string): string {
  return linkedinName
    .replace(/[\uFE0E\uFE0F\u200D]/g, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/,.*$/, " ")
    .replace(/[^\p{L}\p{M}\p{N}\s'’.-]/gu, " ")
    .replace(/\s+-\s+.*$/, " ")
    .replace(/\s+/g, " ")
    .trim();
}
