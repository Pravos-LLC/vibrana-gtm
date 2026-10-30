// Per-channel link rules (John, 2026-10-02). Hard rules are errors: `gtm check` fails and the
// scheduler refuses the item. Soft rules are warnings only.
//
//   instagram  no URL in the caption, ever (links are not clickable there and hurt reach).
//              A `first_comment` that holds a link is never sent to Instagram either.
//   linkedin   no URL in the body. The link goes in `first_comment` frontmatter, which Zernio posts
//              as the first comment right after publishing (platformSpecificData.firstComment).
//   youtube    soft: description links are clickable on regular videos only. A vertical or square
//              upload of 3 minutes or less becomes a Short, where description and comment links
//              are plain text; use YouTube Studio's "Related video" for Shorts.

/** Top-level domains we treat as a link when written bare (`brand.example.com/case-studies/x`). Deliberately
 *  short: `Node.js`, `e.g.` or `README.md` must not count. */
const BARE_TLDS = [
  "ai", "app", "biz", "ca", "ch", "co", "com", "de", "dev", "es", "eu", "fm", "fr", "gg", "info", "in", "io",
  "link", "ly", "net", "nl", "org", "page", "sh", "site", "studio", "tech", "tv", "uk", "xyz",
]; // English words (it, to, so, at, be, me, us) are left out so "do it.So" never counts.

// 1. explicit scheme, 2. www., 3. bare domain with a known TLD. The lookbehind keeps email addresses
// (`user-f538cb95fc21@example.com`) and the middle of longer tokens out; the lookahead stops `vibrana.aix`.
const URL_PATTERN = new RegExp(
  [
    String.raw`\bhttps?:\/\/[^\s<>"')\]]+`,
    String.raw`(?<![@\w.\/-])www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s<>"')\]]*)?`,
    String.raw`(?<![@\w.\/-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:${BARE_TLDS.join("|")})(?![\w-]|\.[a-z0-9])(?:\/[^\s<>"')\]]*)?`,
  ].join("|"),
  "gi",
);

/** Every URL-like token in `text`: http(s) links, `www.` hosts and bare domains. Email addresses are not URLs. */
export function findUrls(text: string | null | undefined): string[] {
  if (!text) return [];
  return [...text.matchAll(URL_PATTERN)].map((m) => m[0].replace(/[.,;:!?]+$/, ""));
}

export const hasUrl = (text: string | null | undefined) => findUrls(text).length > 0;

export type CopyParts = { base: string; perChannel: Record<string, string>; meta: Record<string, string> };
export type VideoShape = { width: number; height: number; duration?: number | null };
export type RuleResult = { errors: string[]; warnings: string[] };

/** Over this many characters a LinkedIn post still goes, but reads long: a warning (the hard limit is TEXT_LIMITS). */
export const LINKEDIN_WARN_CHARS = 3000;

/**
 * The LinkedIn length rule for one text, for approval and staging: the hard limit (checkChannelLength, 4,000 as LinkedIn
 * counts) as an error, and a warning over 3,000.
 */
export function checkLinkedinLength(id: string, text: string): RuleResult {
  const errors = checkChannelLength(id, ["linkedin"], { base: text, perChannel: {}, meta: {} });
  const count = TEXT_LIMITS.linkedin.count(text);
  return { errors, warnings: !errors.length && count > LINKEDIN_WARN_CHARS ? [`${id}: the LinkedIn post is ${count} characters (limit ${TEXT_LIMITS.linkedin.text}); consider cutting it under ${LINKEDIN_WARN_CHARS}.`] : [] };
}

const list = (urls: string[]) => urls.slice(0, 3).join(", ") + (urls.length > 3 ? ", ..." : "");

/** Text a channel will actually receive: its `--- channel: x ---` override, else the base text. */
export const channelText = (copy: CopyParts, channel: string) => copy.perChannel[channel] ?? copy.base;

/** True when YouTube will classify the upload as a Short: vertical or square, 3 minutes or less. */
export function isShort(video: VideoShape): boolean {
  return video.height >= video.width && (video.duration == null || video.duration <= 180);
}

/** Video shape from a filename hint such as `teaser-16x9.mp4` or `cut_9x16.mov`. */
export function shapeFromName(name: string): VideoShape | null {
  const m = /(?:^|[^0-9])(\d{1,2})x(\d{1,2})(?:[^0-9]|$)/.exec(name.split("/").pop() ?? "");
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/**
 * Check one item's copy against the channel link rules. `video` is the YouTube video's shape when
 * known (ffprobe or a filename hint); unknown shapes produce a reminder rather than a guess.
 */
export function checkChannelLinks(id: string, channels: string[], copy: CopyParts, video?: VideoShape | null): RuleResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const comment = copy.meta.first_comment ?? "";
  if (channels.includes("instagram")) {
    const urls = findUrls(channelText(copy, "instagram"));
    if (urls.length) errors.push(`${id}: instagram caption contains a link (${list(urls)}). Instagram captions never carry links; remove it (point to the bio instead).`);
    if (hasUrl(comment)) warnings.push(`${id}: instagram does not get first_comment because it contains a link; LinkedIn and YouTube still receive it.`);
  }
  if (channels.includes("linkedin")) {
    const urls = findUrls(channelText(copy, "linkedin"));
    if (urls.length) errors.push(`${id}: linkedin body contains a link (${list(urls)}). Move it to first_comment frontmatter; Zernio posts that as the first comment.`);
    // The hard limit is checkChannelLength below; this adds the over-3,000 warning.
    warnings.push(...checkLinkedinLength(id, channelText(copy, "linkedin")).warnings);
  }
  if (channels.includes("youtube")) {
    const description = channelText(copy, "youtube");
    const linked = hasUrl(description) || hasUrl(comment);
    if (video && isShort(video)) {
      warnings.push(`${id}: youtube video is vertical/square and 3 min or less, so it publishes as a Short: description and comment links are NOT clickable. Set "Related video" in YouTube Studio after publishing, or upload a 16:9 cut.`);
    } else if (!video && linked) {
      warnings.push(`${id}: youtube links are only clickable if the upload is a regular video (16:9, or longer than 3 min). A vertical cut of 3 min or less becomes a Short with dead links.`);
    }
    if (!linked) warnings.push(`${id}: youtube has no link in the description or first_comment. Regular videos can carry a clickable description link.`);
  }
  errors.push(...checkChannelLength(id, channels, copy));
  return { errors, warnings };
}

/**
 * The most each platform takes, in characters: a longer post is refused at publish time, so it is a hard rule like the
 * link rules (`gtm check` fails, the scheduler skips it, the send refuses it).
 *
 * LinkedIn, from its own refusals (Zernio post.failed, 2026-10): "ShareCommentary text length (4323 characters) exceeded
 * the maximum allowed (4000 characters)" for example-reference-45 and "(4022 characters)" for an earlier
 * s1-01-example-record-1 send. Both counts are exactly the UTF-16 length of the text Zernio holds for the post (Java's
 * String length), with its reserved characters ( ) [ ] @ # * _ ... counted once, not escaped. Every LinkedIn post that
 * published (11 on Zernio) is at most 2,420 by that count. The 3,000 seen in LinkedIn's composer is not the API limit.
 * Instagram 2,200 (caption) and YouTube 5,000 (description) / 100 (title) are the platforms' documented limits.
 */
export const TEXT_LIMITS: Record<string, { text: number; textName: string; title?: number; count: (text: string) => number }> = {
  linkedin: { text: 4000, textName: "LinkedIn post", count: (t) => t.length },
  instagram: { text: 2200, textName: "Instagram caption", count: (t) => charCount(t) },
  youtube: { text: 5000, textName: "YouTube description", title: 100, count: (t) => charCount(t) },
};

/** Characters as most platforms count them (code points, so an emoji is one). LinkedIn counts UTF-16 units (an emoji is two). */
export function charCount(text: string) { return [...text].length; }
const n = (x: number) => x.toLocaleString("en-US");

/** "too long: the LinkedIn post is 4,323 characters; LinkedIn takes at most 4,000" for each channel over its limit. */
export function checkChannelLength(id: string, channels: string[], copy: CopyParts): string[] {
  const out: string[] = [];
  for (const ch of channels) {
    const limit = TEXT_LIMITS[ch];
    if (!limit) continue;
    const count = limit.count(channelText(copy, ch));
    if (count > limit.text) out.push(`${id}: too long: the ${limit.textName} is ${n(count)} characters; ${limit.textName.split(" ")[0]} takes at most ${n(limit.text)}. Shorten it and restage.`);
    const title = copy.meta.youtube_title?.trim();
    if (ch === "youtube" && limit.title && title && charCount(title) > limit.title) out.push(`${id}: too long: the YouTube title is ${n(charCount(title))} characters; YouTube takes at most ${n(limit.title)}. Shorten youtube_title and restage.`);
  }
  return out;
}
