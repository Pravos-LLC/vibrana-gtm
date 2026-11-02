// The text of a calendar row. A Story's row carries no copy of the text until it is sent: until then its Story's copy
// (the one copy asset bound to the row) is the text, even where an older row still holds a stale copy. Once sent, the
// row records the exact text that went out. A row with no Story keeps its own text. One text, no mirror (audit 2026-11-02).
export type CopyAsset = { id: string; kind: string; body?: string | null };
export type TextRow = { body: string | null; story_assets?: string[] | null; story_id?: string | null; status?: string; zernio_post_id?: string | null };

const SENT = ["scheduled", "published", "partial", "failed"];

export function rowText(row: TextRow, assets: Map<string, CopyAsset>): string | null {
  if (!row.story_id) return row.body;
  const sent = !!row.zernio_post_id || SENT.includes(row.status ?? "");
  if (sent && row.body) return row.body;
  for (const id of row.story_assets ?? []) {
    const a = assets.get(id);
    if (a?.kind === "copy") return a.body ?? row.body;
  }
  return row.body;
}
