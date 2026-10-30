import type { StoryAsset, StoryChannel } from "../story";
import { splitFrontmatter } from "../frontmatter";
import { readFields, ratioOf } from "../season";
export type PublicationAsset = { id: string; title: string; src: string | null; poster: string | null; kind: string; ratio: number; candidate: boolean; group: string | null };
export type PublicationPlatform = "spotify" | "youtube" | "linkedin" | "instagram";
export type PublicationPackage = { storyId: string; title: string; identity: string; link: string; description: string; covers: PublicationAsset[];
  channels: Record<PublicationPlatform, { title: string; body: string; firstComment: string; media: PublicationAsset | null; cover: PublicationAsset | null; link: string; missing: string[] }>;
  clips: Array<{ storyId: string; title: string; media: Partial<Record<PublicationPlatform,PublicationAsset[]>>; covers: Partial<Record<PublicationPlatform,PublicationAsset>>; captions: Partial<Record<PublicationPlatform,string>>; firstComments: Partial<Record<PublicationPlatform,string>>; titles: Partial<Record<PublicationPlatform,string>> }> };
/** Channel mockups consume the exact staged text/media. No invented comments, counters or engagement. */
export function publicationPackage(head: { id: string; title: string; link_url: string }, assets: StoryAsset[], channels: StoryChannel[], urls: Map<string,string>, identity: string, selected?: string): PublicationPackage {
  const own = assets.filter(a => (a.story_id === head.id || a.metadata.publication_story_id === head.id)), final = (a: StoryAsset) => !a.stage || a.stage === "final";
  const assigned = (a: StoryAsset, ch: string) => channels.some(r => r.asset_id === a.id && r.channel === ch);
  const mapped = (a: StoryAsset): PublicationAsset => ({ id: a.id, title: a.title, src: a.storage_path ? urls.get(a.storage_path) ?? null : null, poster: typeof a.metadata.poster_path === "string" ? urls.get(a.metadata.poster_path) ?? null : null, kind: a.kind,
    ratio: typeof a.metadata.width === "number" && typeof a.metadata.height === "number" ? a.metadata.width / a.metadata.height : ratioOf(a.source), candidate: a.metadata.packaging_candidate === true, group: a.metadata.packaging_candidate ? [a.metadata.packaging_style,a.metadata.packaging_brand,a.metadata.packaging_theme].join("/") : null });
  const covers = own.filter(a => a.kind === "image" && (a.metadata.packaging_candidate === true || channels.some(r => r.asset_id === a.id))).map(mapped);
  const chosen = covers.find(a => a.id === selected) ?? covers.find(a => !a.candidate && a.ratio > 1) ?? covers[0] ?? null;
  const proposedTitle = own.find(a => a.id === chosen?.id)?.metadata.publication_title;
  const mainCopy = own.find(a => a.kind === "copy" && assigned(a,"youtube"));
  const main = splitFrontmatter(mainCopy?.body ?? ""), mainFields = readFields(main.frontmatter);
  const out = {} as PublicationPackage["channels"];
  for (const platform of ["spotify","youtube","linkedin","instagram"] as const) {
    const copy = own.find(a => a.kind === "copy" && assigned(a,platform));
    const text = splitFrontmatter(copy?.body ?? (platform === "spotify" ? mainCopy?.body ?? "" : "")), fields = readFields(text.frontmatter);
    const video = own.find(a => a.kind === "video" && final(a) && assigned(a,platform));
    const image = own.find(a => a.kind === "image" && final(a) && assigned(a,platform));
    const missing: string[] = [];
    if (!text.prose.trim()) missing.push(platform === "spotify" ? "Episode description" : "Promotion copy");
    if ((platform === "instagram" || platform === "linkedin") && !video && !image) missing.push("Episode promotion media; use a staged companion clip below");
    if (platform === "spotify" && !chosen) missing.push("Episode artwork");
    const shapeRatio = platform === "spotify" ? 1 : platform === "instagram" ? 9/16 : 16/9;
    const platformCover = chosen?.group ? covers.find(c => c.group === chosen.group && Math.abs(c.ratio-shapeRatio)<.01) ?? chosen : chosen;
    out[platform] = { title: typeof proposedTitle === "string" ? proposedTitle : fields.youtube_title ?? mainFields.youtube_title ?? head.title, body: text.prose, firstComment: fields.first_comment ?? "", media: video ? mapped(video) : image ? mapped(image) : null, cover: platformCover, link: head.link_url, missing };
  }
  const related = [...new Set(assets.filter(a => a.story_id !== head.id && !a.metadata.packaging_candidate).map(a => a.story_id))];
  const clips = related.map(storyId => { const own = assets.filter(a => a.story_id === storyId && final(a)); const media: PublicationPackage["clips"][number]["media"] = {}, covers: PublicationPackage["clips"][number]["covers"] = {}, captions: PublicationPackage["clips"][number]["captions"] = {}, firstComments: PublicationPackage["clips"][number]["firstComments"] = {}, titles: PublicationPackage["clips"][number]["titles"] = {};
    for (const p of ["youtube","linkedin","instagram"] as const) { media[p] = own.filter(a => a.kind === "video" && assigned(a,p)).map(mapped); const cover = own.find(a => a.kind === "image" && assigned(a,p)); if(cover) covers[p]=mapped(cover); const c = own.find(a => a.kind === "copy" && assigned(a,p)); if(c) { const t=splitFrontmatter(c.body ?? ""), f=readFields(t.frontmatter); captions[p] = t.prose; firstComments[p]=f.first_comment ?? ""; titles[p]=f.youtube_title ?? own.find(a=>a.kind==="video")?.title ?? storyId; } }
    return { storyId, title: own.find(a => a.kind === "video")?.title ?? storyId, media, covers, captions, firstComments, titles }; });
  return { storyId: head.id, title: typeof proposedTitle === "string" ? proposedTitle : mainFields.youtube_title ?? head.title, identity, link: head.link_url, description: main.prose, covers, channels: out, clips };
}
