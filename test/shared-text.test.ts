import test from "node:test";
import assert from "node:assert/strict";
import { latestText, sharedTextBaseline, sharedTextDirty, type AssetVersion, type CardData, type PieceAsset, type SharedTextValue } from "../lib/season-review";
import { initialPartState, partKey, partReducer, type PartState } from "../lib/review-state";
import type { EditableField, Role } from "../lib/season";

// The one-text editor (SharedText) after "Save text": the page's card props are never refreshed, only the part states
// move. s1-08-sample-piece-08 and sample-extra-38 (three copy files, one with a YouTube title) stayed on "Save first."
// after a successful save of the YouTube title, because the baseline read that title from the stale props.
const story = "s1-08-fx";
const v = (revision: number, prose: string, fields: Partial<Record<EditableField, string>> = {}): AssetVersion =>
  ({ revision, label: `v${revision}`, createdAt: "", src: null, poster: null, prose, fields });
const copy = (id: string, revision: number, versions: AssetVersion[]): PieceAsset =>
  ({ id, kind: "copy", title: id, revision, source: id, src: null, poster: null, ratio: 0.8, prose: versions.at(-1)!.prose, fields: versions.at(-1)!.fields, status: "pending", feedback: [], versions });
const card = (channel: Role, c: PieceAsset): CardData => ({ channel, copy: c, media: [], textStatus: "pending", assetStatus: "pending" });

/** Mirrors SharedText.save + commitSaved: each distinct file saved once, every platform it serves committed. */
function save(cards: CardData[], states: Record<string, PartState>, text: SharedTextValue): Record<string, PartState> {
  const next = { ...states };
  const files = new Map<string, CardData[]>();
  for (const c of cards) files.set(c.copy.id, [...(files.get(c.copy.id) ?? []), c]);
  for (const [, served] of files) {
    const k = partKey("text", story, served[0].channel);
    const revision = next[k].revision + 1;
    for (const c of served) {
      const key = partKey("text", story, c.channel);
      next[key] = partReducer(next[key], { type: "saved", version: { ...v(revision, text.prose, text.fields), label: "saved" } });
    }
  }
  return next;
}

function piece(cards: CardData[]) {
  const states: Record<string, PartState> = {};
  for (const c of cards) states[partKey("text", story, c.channel)] = initialPartState({ status: "approved", notes: [], revision: c.copy.revision });
  const primary = cards.find((c) => c.channel === "linkedin") ?? cards[0];
  const baseline = (s: Record<string, PartState>) => sharedTextBaseline(story, cards, primary, latestText(primary.copy, s[partKey("text", story, primary.channel)]), s);
  return { states, baseline };
}

const shapes: Array<[string, CardData[]]> = [
  ["three files, LinkedIn first comment and YouTube title, differing legacy texts (sample-extra-38, s1-08)", [
    card("linkedin", copy("li", 3, [v(2, "old li", { first_comment: "old" }), v(3, "Why your codebase is falling apart.", { first_comment: "Link: https://example.com" })])),
    card("instagram", copy("ig", 5, [v(2, "ig v1"), v(5, "Instagram's own legacy text.")])),
    card("youtube", copy("yt", 2, [v(1, "yt old", { youtube_title: "What is your agent rewarded for?" }), v(2, "YouTube legacy text.", { youtube_title: "Why Example campaign title 8" })])),
  ]],
  ["two files, LinkedIn and Instagram (s1-11)", [
    card("linkedin", copy("li", 7, [v(7, "Top 10.", { first_comment: "Repos:\n\nhttps://example.com" })])),
    card("instagram", copy("ig", 6, [v(6, "Top 10.")])),
  ]],
  ["one shared file for every platform", (() => { const c = copy("shared", 1, [v(1, "One text.", { first_comment: "c", youtube_title: "t" })]); return [card("linkedin", c), card("instagram", c), card("youtube", c)]; })()],
  ["no first comment or title fields, YouTube without a title", [
    card("instagram", copy("ig", 1, [v(1, "Plain.")])),
    card("youtube", copy("yt", 1, [v(1, "Plain.")])),
  ]],
];

for (const [name, cards] of shapes) {
  test(`after Save text the editor is clean and Approve is not blocked: ${name}`, () => {
    const { states, baseline } = piece(cards);
    let s = states;
    let text: SharedTextValue = baseline(s);
    assert.equal(sharedTextDirty(text, baseline(s)), false, "clean on load");
    // Every editable thing, one save at a time: the prose, then each field the piece has.
    const edits: Array<(t: SharedTextValue) => SharedTextValue> = [
      (t) => ({ ...t, prose: `${t.prose}\n\nEdited by John.` }),
      ...(Object.keys(baseline(s).fields) as EditableField[]).map((k) => (t: SharedTextValue) => ({ ...t, fields: { ...t.fields, [k]: `${t.fields[k] ?? ""} edited` } })),
      (t) => ({ ...t, prose: `${t.prose} Again.` }),
    ];
    for (const edit of edits) {
      text = edit(text);
      assert.equal(sharedTextDirty(text, baseline(s)), true, "dirty before save");
      s = save(cards, s, text);
      assert.equal(sharedTextDirty(text, baseline(s)), false, `clean after save: ${JSON.stringify(text.fields)}`);
      for (const c of cards) assert.equal(s[partKey("text", story, c.channel)].status, "pending", "the save reset the approval: Approve again");
    }
  });
}

test("latestText counts versions saved this session and falls back to the asset as v1", () => {
  const c = copy("x", 2, [v(1, "a"), v(2, "b")]);
  assert.equal(latestText(c).prose, "b");
  assert.equal(latestText(c, { addedVersions: [v(3, "c")] }).prose, "c");
  assert.equal(latestText({ ...c, versions: [], prose: "asset" }).prose, "asset");
});
