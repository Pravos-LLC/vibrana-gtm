// The text of a calendar row. A row records the text it sent; until a Story's row is sent it carries none, and its
// Story's copy (the one copy asset bound to the row) is the text. One text, no mirror to drift (audit 2026-11-02).
export type CopyAsset = { id: string; kind: string; body?: string | null };

export function rowText(row: { body: string | null; story_assets?: string[] | null }, assets: Map<string, CopyAsset>): string | null {
  if (row.body) return row.body;
  for (const id of row.story_assets ?? []) {
    const a = assets.get(id);
    if (a?.kind === "copy") return a.body ?? null;
  }
  return null;
}
