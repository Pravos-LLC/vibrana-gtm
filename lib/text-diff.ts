// Word-level text diff for the review screen: what changed in a caption since the version John last decided on.
// Pure LCS over tokens (words and the whitespace between them), no dependency.

export type DiffPart = { type: "same" | "add" | "del"; text: string };

const tokens = (s: string) => s.match(/\s+|[^\s]+/g) ?? [];

/** Word-level diff of `before` -> `after`. Adjacent parts of the same type are merged. Large inputs fall back to a whole replace. */
export function diffWords(before: string, after: string): DiffPart[] {
  if (before === after) return before ? [{ type: "same", text: before }] : [];
  const a = tokens(before), b = tokens(after);
  if (a.length * b.length > 4_000_000) return merge([...(before ? [{ type: "del" as const, text: before }] : []), ...(after ? [{ type: "add" as const, text: after }] : [])]);
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const out: DiffPart[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ type: "same", text: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ type: "del", text: a[i++] });
    else out.push({ type: "add", text: b[j++] });
  }
  while (i < a.length) out.push({ type: "del", text: a[i++] });
  while (j < b.length) out.push({ type: "add", text: b[j++] });
  return merge(out);
}

function merge(parts: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && last.type === p.type) last.text += p.text;
    else out.push({ ...p });
  }
  return out;
}

/** True when anything was added or removed (whitespace-only changes count as no change). */
export const hasChanges = (parts: DiffPart[]) => parts.some((p) => p.type !== "same" && p.text.trim() !== "");
