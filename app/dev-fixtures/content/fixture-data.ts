import type { AssetVersion, CardData, FeedbackItem, PieceAsset, PieceData } from "@/lib/season-review";
import { newsletterExport } from "@/lib/newsletter-card";

export type Fixture = { pieces: PieceData[] };
type Media = { image: string; poster: string; video: string };

const at = (day: number) => `2026-10-${String(day).padStart(2, "0")}T10:00:00Z`;
const note = (id: string, asset_id: string, channel: string, body: string, revision: number, resolution?: string): FeedbackItem => ({
  id, asset_id, channel, body, created_at: at(6), revision, resolved_at: resolution ? at(7) : null, resolution: resolution ?? "",
});
const version = (revision: number, label: string, m: Partial<AssetVersion>): AssetVersion => ({ revision, label, createdAt: at(5 + revision), src: null, poster: null, prose: "", fields: {}, ...m });
const asset = (a: Partial<PieceAsset> & Pick<PieceAsset, "id" | "kind">): PieceAsset => ({
  title: a.id, revision: 1, source: a.id, src: null, poster: null, ratio: 4 / 5, prose: "", fields: {}, status: "pending", feedback: [], versions: [], ...a,
});

/** Mirrors the page's data for four states of one season: approved, needs approval, needs changes, new version (a held rough cut). */
export function buildFixture(m: Media): Fixture {
  const prose1 = "Most teams are still prompting.\n\nThe ones pulling ahead stopped asking for answers and started handing agents the work.\n\nWhere is your team on this ladder?";
  const prose2 = "A bad review habit: approving on the first read.\n\nSecond read, out loud, catches the sentence you skim.";
  const slides = (id: string, n: number, versions = 1): PieceAsset[] => Array.from({ length: n }, (_, i) => asset({
    id: `${id}-s${i + 1}`, kind: "image", src: m.image, revision: versions,
    versions: Array.from({ length: versions }, (_, v) => version(v + 1, v === 0 ? "v1" : `v1.${v}`, { src: m.image })),
  }));

  // The final after a rough-cut approval: the edit and dialogue hashes match, B-roll is new, two jump points.
  const inputs = (keep: string, dialogue: string, broll?: string) => ({ keep: keep.repeat(64), dialogue: dialogue.repeat(64), ...(broll ? { broll: broll.repeat(64) } : {}) });
  const waveVersions = [
    version(1, "v1", { src: m.video, poster: m.poster, stage: "rough-cut", changes: "Raw-track audio, new end card", meta: { label: "v4", inputs: inputs("a", "b") } }),
    version(2, "v1.1", { src: m.video, poster: m.poster, stage: "final", changes: "B-roll B1 to B7 and six Motion beats", meta: { label: "v5", inputs: inputs("a", "b", "c"), review_points: [{ t: 0.4, label: "B4 GPU rack" }, { t: 1.2, label: "Beat 2: sacred languages" }] } }),
  ];
  const wave: CardData[] = [
    { channel: "linkedin", textStatus: "approved", assetStatus: "approved",
      copy: asset({ id: "wave-li", kind: "copy", prose: prose2, fields: { first_comment: "Source and the full list: https://example.com" }, status: "approved", versions: [version(1, "v1", { prose: prose2, fields: { first_comment: "Source and the full list: https://example.com" } })] }),
      media: [asset({ id: "wave-li-v", kind: "video", revision: 2, src: m.video, poster: m.poster, ratio: 9 / 16, status: "pending", versions: waveVersions })] },
    { channel: "instagram", textStatus: "pending", assetStatus: "approved",
      copy: asset({ id: "wave-ig", kind: "copy", prose: prose2, versions: [version(1, "v1", { prose: prose2 })] }),
      media: [asset({ id: "wave-li-v", kind: "video", revision: 2, src: m.video, poster: m.poster, ratio: 9 / 16, status: "pending", versions: waveVersions })] },
  ];

  const maturity: CardData[] = [
    { channel: "linkedin", textStatus: "rejected", assetStatus: "pending",
      copy: asset({ id: "mm-li", kind: "copy", revision: 2, prose: prose1, fields: { first_comment: "The model, one slide per level." }, status: "rejected",
        feedback: [note("n1", "mm-li", "linkedin", "The opening line is too soft. Lead with the cost of staying at level one.", 2), note("n0", "mm-li", "linkedin", "Cut the second paragraph.", 1, "Cut. The post is now five lines.")],
        versions: [version(1, "v1", { prose: prose1 }), version(2, "v1.1", { prose: prose1, fields: { first_comment: "The model, one slide per level." } })] }),
      media: slides("mm-li", 4, 3).map((s, i) => i === 0 ? { ...s, revision: 3, feedback: [note("n2", s.id, "linkedin", "Slide 1 needs the level names larger.", 2, "Enlarged the level names on slide 1 and 3."), note("n3", s.id, "linkedin", "Slide 3 crowds the footer. Move the footer down.", 3)] } : { ...s, revision: 3 }) },
    { channel: "youtube", textStatus: "pending", assetStatus: "pending",
      copy: asset({ id: "mm-yt", kind: "copy", prose: "In this video: the five levels of agentic maturity and how to tell where you are.\n\n[JOHN: add the chapter timestamps]", fields: { youtube_title: "Example campaign title 1" }, versions: [version(1, "v1", { prose: "In this video: the five levels." })] }),
      media: [asset({ id: "mm-yt-v", kind: "video", src: m.video, poster: m.poster, ratio: 4 / 5, versions: [version(1, "v1", { src: m.video, poster: m.poster })] })] },
  ];

  const brain: CardData[] = [
    { channel: "linkedin", textStatus: "pending", assetStatus: "pending",
      copy: asset({ id: "br-li", kind: "copy", revision: 2, prose: prose1, fields: { first_comment: "Full write-up in the comments." }, feedback: [note("n4", "br-li", "linkedin", "Make the third line a question.", 1, "Third line is now a question.")], versions: [version(1, "v1", { prose: "old" }), version(2, "v1.1", { prose: prose1 })] }),
      media: [asset({ id: "br-li-v", kind: "video", revision: 2, stage: "rough-cut", src: m.video, poster: m.poster, ratio: 9 / 16, feedback: [note("n5", "br-li-v", "linkedin", "Trim the first two seconds.", 1, "Trimmed 2.1s from the start.")], versions: [version(1, "v1", { src: m.video, poster: m.poster }), version(2, "v1.1", { src: m.video, poster: m.poster })] })] },
  ];

  // A text piece with a Substack essay beside its LinkedIn post: the essay is approved here and pasted by hand.
  const essay = "---\ntitle: \"Your AI bill is an org chart\"\nchannel: personal-substack\npreviewText: \"Agents waste tokens the way companies waste people.\"\n---\n\n# Your AI bill is an org chart\n\n![Header](assets/hero.jpg)\n\nOne engineer fixed it in ten minutes.\n\n## The org chart\n\nEvery agent you add is a hire.\n";
  const tokens: CardData[] = [
    { channel: "linkedin", textStatus: "pending", assetStatus: "none",
      copy: asset({ id: "tk-li", kind: "copy", prose: "Your AI bill is an org chart.", versions: [version(1, "v1", { prose: "Your AI bill is an org chart." })] }), media: [] },
    { channel: "newsletter", textStatus: "pending", assetStatus: "pending",
      copy: asset({ id: "tk-substack", kind: "copy", title: "Substack essay", prose: essay.split("---\n")[2], versions: [version(1, "v1", {})] }),
      media: [asset({ id: "tk-header", kind: "image", src: m.image, versions: [version(1, "v1", { src: m.image })] })],
      substack: newsletterExport(essay, [{ source: "assets/hero.jpg", signedUrl: m.image, publicUrl: null, alt: "Header" }]) },
  ];

  return { pieces: [
    { storyId: "s1-30-tokenmaxxing", slot: "W2 Fri Oct 16", name: "Tokenmaxxing", pillar: "perspective", date: "2026-10-16", cards: tokens },
    { storyId: "s1-01-maturity", slot: "W2 Tue Oct 13", name: "Example campaign title 1", pillar: "build", date: "2026-10-13", cards: maturity },
    { storyId: "s1-02-wave", slot: "W2 Thu Oct 15", name: "The Wave", pillar: "perspective", date: "2026-10-15", cards: wave,
      decisions: [{ stage: "rough-cut", decision: "approved", assets: [{ asset_id: "wave-li-v", sha256: "a".repeat(64), revision: 1 }], decided_at: "2026-10-10T10:00:00Z" }] },
    // Paper edit not approved yet: John reviews it in the terminal, so /content shows no media for this piece.
    { storyId: "s1-19-sn-robots", slot: "W6 Thu Nov 12", name: "Robots are part of the Earth", pillar: "perspective", date: "2026-11-12",
      cards: [{ channel: "instagram", textStatus: "pending", assetStatus: "pending", copy: asset({ id: "rb-ig", kind: "copy", prose: "So Example campaign title 14 too.", versions: [version(1, "v1", { prose: "So Example campaign title 14 too." })] }), media: [] }],
      pipeline: { format: "short", series: "example-shorts", label: null, staged: [], final: { staged: false, approved: false, changes: false },
        rows: [{ stage: "paper-edit", status: "review", note: "keep.json v2 sent to John", actor: "agent" }], thirdParty: { who: "example_approver / Example Series", open: true } },
      hold: { who: "example_approver / Example Series", note: "", heldAt: null, kind: "third_party", finalStaged: false } },
    { storyId: "s1-09-brain", slot: "W7 Wed Dec 2", name: "Example campaign title 3", pillar: "perspective", date: "2026-12-03", cards: brain, stage: "rough-cut", hold: { who: "example_approver / Example Series", note: "example_approver only ever sees final versions, never rough cuts", heldAt: "2026-10-12T09:00:00Z", kind: "third_party", finalStaged: false },
      // A Example Series short: paper edit approved in the terminal, the rough cut (pipeline v4) waiting on John, example_approver signs off on the final.
      pipeline: { format: "short", series: "example-shorts", label: "v4", staged: ["rough-cut"], final: { staged: false, approved: false, changes: false },
        rows: [{ stage: "paper-edit", status: "approved", note: "John approved in terminal", actor: "agent" }, { stage: "rough-cut", status: "review", note: "", actor: "stage" }],
        thirdParty: { who: "example_approver / Example Series", open: true } },
      stageAssets: [asset({ id: "br-li-v", kind: "video", revision: 2, stage: "rough-cut", label: "v4", sha256: "a".repeat(64), src: m.video, poster: m.poster, ratio: 9 / 16, feedback: [note("n5", "br-li-v", "linkedin", "Trim the first two seconds.", 1, "Trimmed 2.1s from the start.")], versions: [version(1, "v1", { src: m.video, poster: m.poster }), version(2, "v1.1", { src: m.video, poster: m.poster })] })] },
  ] };
}
