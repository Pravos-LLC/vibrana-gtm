// UTM tags on our own links in published posts (VIB-417), so a visit to the site (the assessment
// funnel) can be traced back to the post and platform that sent it:
//   utm_source=<platform>&utm_medium=social&utm_campaign=<season>-w<NN>&utm_content=<calendar item id>
// Only links to our own hosts are tagged; a link to someone else's article is left exactly as written.
// A link that already carries any utm_ parameter is left alone (someone tagged it on purpose).
import { isoWeek, seasonWeek } from "./week";

/** Hosts whose links get tagged: brand.example.com and its subdomains, or GTM_UTM_HOSTS (comma-separated). */
export function utmHosts(): string[] {
  const env = process.env.GTM_UTM_HOSTS?.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return env?.length ? env : ["brand.example.com"];
}

const ownHost = (host: string, hosts: string[]) => hosts.some((h) => host === h || host.endsWith(`.${h}`));

export type Utm = { source: string; campaign: string; content: string; medium?: string };

/** One URL with UTM parameters added, or unchanged when it is not ours or already tagged. */
export function tagUrl(raw: string, utm: Utm, hosts = utmHosts()): string {
  let url: URL;
  try { url = new URL(raw); } catch { return raw; }
  if (!/^https?:$/.test(url.protocol) || !ownHost(url.hostname.toLowerCase(), hosts)) return raw;
  if ([...url.searchParams.keys()].some((k) => k.toLowerCase().startsWith("utm_"))) return raw;
  url.searchParams.set("utm_source", utm.source);
  url.searchParams.set("utm_medium", utm.medium ?? "social");
  url.searchParams.set("utm_campaign", utm.campaign);
  url.searchParams.set("utm_content", utm.content);
  return url.toString();
}

// ASCII URL characters only (RFC 3986), so a typographic quote or ellipsis right after a link ends it instead of
// being swallowed into the path.
const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g;

/** Tags every own-host link in `text`. Trailing sentence punctuation stays outside the link. */
export function tagLinks(text: string, utm: Utm, hosts = utmHosts()): string {
  return text.replace(URL_RE, (match) => {
    const trail = /[.,;:!?)\]']+$/.exec(match)?.[0] ?? "";
    const link = trail ? match.slice(0, -trail.length) : match;
    return tagUrl(link, utm, hosts) + trail;
  });
}

/**
 * The campaign for a post on `date`: `<season id>-w<NN>` (season week, Monday to Sunday) when a season covers
 * the date, else the ISO week (`2026-w41`).
 */
export function utmCampaign(date: string, seasons: { id: string; starts_on: string; ends_on: string }[] = []): string {
  const season = seasons.find((s) => s.starts_on <= date && date <= s.ends_on);
  if (season) return `${season.id}-w${String(seasonWeek(season.starts_on, date)).padStart(2, "0")}`;
  const w = isoWeek(date);
  return `${w.year}-w${String(w.week).padStart(2, "0")}`;
}
