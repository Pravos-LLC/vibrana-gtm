// One frontmatter reader for copy files. The block between the leading `---` fences is YAML, so it is
// parsed as YAML: block scalars (`|`, `|-`, `>`), quoted values with colons and multi-line values all
// come back as the text they mean. A line-by-line `key: value` reader returned `"|-"` for a block
// scalar, which is how a LinkedIn first comment became the literal string "|-".
import { parseDocument } from "yaml";

/** Leading frontmatter block: `---\n<yaml>\n---`. A UTF-8 BOM and an empty block (`---\n---`) are allowed. */
const FENCE = /^﻿?---\n(?:([\s\S]*?)\n)?---(?:\n|$)/;

/** Splits a copy file into its raw frontmatter (no fences, trimmed) and the prose after it (trimmed). */
export function splitFrontmatter(text: string): { frontmatter: string; prose: string } {
  const fm = text.match(FENCE);
  if (!fm) return { frontmatter: "", prose: text.trim() };
  return { frontmatter: (fm[1] ?? "").trim(), prose: text.slice(fm[0].length).trim() };
}

/** Same split, with the body untrimmed so callers that split it further keep its exact text. */
export function splitFrontmatterRaw(text: string): { frontmatter: string; body: string } | null {
  const fm = text.match(FENCE);
  return fm ? { frontmatter: fm[1] ?? "", body: text.slice(fm[0].length) } : null;
}

/**
 * Parses frontmatter YAML to a plain object; not a mapping gives an empty object. Copy files written
 * by hand are not always strict YAML (`first_comment: Full case study: https://...` is a plain scalar
 * with ": " in it, which YAML rejects), so when the whole block does not parse, each top-level key is
 * parsed on its own (its line plus the indented lines under it) and a key that still fails keeps its
 * raw single-line value, which is what the old line reader returned.
 */
export function frontmatterData(frontmatter: string): Record<string, unknown> {
  if (!frontmatter.trim()) return {};
  const whole = parseMapping(frontmatter);
  if (whole) return whole;
  const out: Record<string, unknown> = {};
  for (const entry of topLevelEntries(frontmatter)) {
    const parsed = parseMapping(entry.text);
    if (parsed && entry.key in parsed) out[entry.key] = parsed[entry.key];
    else if (!entry.text.includes("\n")) out[entry.key] = entry.raw.replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

function parseMapping(text: string): Record<string, unknown> | null {
  const doc = parseDocument(text);
  if (doc.errors.length) return null;
  const data = doc.toJS() as unknown;
  if (data === null || data === undefined) return {};
  return typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
}

/** Top-level `key: value` entries, each with the indented, comment and blank lines that follow it. */
function topLevelEntries(frontmatter: string): { key: string; raw: string; text: string }[] {
  const entries: { key: string; raw: string; lines: string[] }[] = [];
  for (const line of frontmatter.split("\n")) {
    const m = line.match(/^([A-Za-z_][\w-]*):(?:\s+(.*))?$/);
    if (m) entries.push({ key: m[1], raw: (m[2] ?? "").trim(), lines: [line] });
    else entries.at(-1)?.lines.push(line);
  }
  return entries.map((e) => ({ key: e.key, raw: e.raw, text: e.lines.join("\n").trimEnd() }));
}

/**
 * Frontmatter as flat strings, for callers that read `meta.first_comment` and friends. Scalars become
 * strings (numbers and booleans as written, null as ""); a list becomes its items joined with ", "
 * (`youtube_tags: [a, b]` reads like `youtube_tags: a, b`); nested mappings are dropped. Keys are
 * lowercase snake_case; anything else is ignored, as before.
 */
export function frontmatterMeta(frontmatter: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(frontmatterData(frontmatter))) {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) continue;
    const text = scalarText(value);
    if (text !== null) out[key] = text;
  }
  return out;
}

function scalarText(value: unknown): string | null {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.map(scalarText).filter((v): v is string => v !== null && v !== "").join(", ");
  return null;
}
