// Substack export: turns a newsletter draft (markdown + frontmatter) into exactly what gets pasted.
// Pure and browser-safe, so the dashboard preview and the clipboard payload come from one function.
import { HtmlRenderer, Parser } from "commonmark";
import { parse as parseYaml } from "yaml";

import { PUBLICATIONS, type Publication } from "./publications";
export { PUBLICATIONS, type Publication };

/** Draft `channel:` values from the editorial package, mapped to the Substack they go to. */
const CHANNEL_PUBLICATION: Record<string, Publication> = {
  "personal-substack": "sample_author",
  "regenera-substack": "regenera",
};

export function publicationOf(meta: Record<string, unknown>): Publication | null {
  const explicit = String(meta.publication ?? "").trim();
  if (explicit in PUBLICATIONS) return explicit as Publication;
  return CHANNEL_PUBLICATION[String(meta.channel ?? "").trim()] ?? null;
}

export type ExportImageSource = { file: string; url: string; permanent: boolean };
export type ExportImage = ExportImageSource & { alt: string };
export type SubstackExport = {
  publication: Publication | null;
  title: string;
  subtitle: string;
  subject: string;
  /** Body HTML for the clipboard (text/html). No H1, no footer, images at `url`. */
  html: string;
  /** Plain-text fallback for the clipboard (text/plain). */
  text: string;
  /** Footer blocks removed from the body (markdown and HTML), kept so nothing is silently lost. */
  footer: string;
  footerHtml: string;
  images: ExportImage[];
  /** Image references in the draft with no uploaded file: they are dropped from the HTML. */
  missing: string[];
  /** Images that only have an expiring (signed) URL. Pasting those breaks once the link expires. */
  expiring: string[];
};

const FOOTER_MARKER = /^<!--\s*(substack:)?footer\s*-->\s*$/m;
const IMAGE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function splitDraft(markdown: string): { meta: Record<string, unknown>; body: string } {
  const text = markdown.replace(/\r\n/g, "\n");
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!fm) return { meta: {}, body: text };
  let meta: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(fm[1]);
    if (parsed && typeof parsed === "object") meta = parsed as Record<string, unknown>;
  } catch {
    meta = {};
  }
  return { meta, body: text.slice(fm[0].length) };
}

const isItalicOnly = (block: string) => /^\*[^*][\s\S]*\*$/.test(block) || /^_[^_][\s\S]*_$/.test(block);

/**
 * Footer = everything after a `<!-- footer -->` marker, or else the trailing run of paragraphs that
 * are entirely italic (the attribution and disclosure lines the editorial package calls footers).
 * Raw `<footer>` HTML is always dropped.
 */
function splitFooter(body: string): { main: string; footer: string } {
  const withoutHtml = body.replace(/<footer\b[\s\S]*?<\/footer>/gi, "");
  const marker = withoutHtml.match(FOOTER_MARKER);
  if (marker && marker.index !== undefined) {
    return { main: withoutHtml.slice(0, marker.index).trim(), footer: withoutHtml.slice(marker.index + marker[0].length).trim() };
  }
  const blocks = withoutHtml.trim().split(/\n\s*\n/);
  let cut = blocks.length;
  while (cut > 1 && isItalicOnly(blocks[cut - 1].trim())) cut--;
  return { main: blocks.slice(0, cut).join("\n\n").trim(), footer: blocks.slice(cut).join("\n\n").trim() };
}

/** Removes the first level-1 heading (Substack has its own title field). Returns it as a fallback title. */
function stripH1(body: string): { body: string; h1: string } {
  const lines = body.split("\n");
  const index = lines.findIndex((line) => /^#\s+\S/.test(line));
  if (index < 0) return { body, h1: "" };
  const h1 = lines[index].replace(/^#\s+/, "").replace(/\s+#*\s*$/, "").trim();
  lines.splice(index, 1);
  return { body: lines.join("\n").replace(/^\s*\n/, ""), h1 };
}

const basename = (src: string) => decodeURIComponent(src.split(/[?#]/)[0].split("/").pop() ?? src);

function toPlain(markdown: string): string {
  return markdown
    .replace(/^\s*!\[[^\]]*\]\([^)]*\)\s*$/gm, "")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/gm, "$1$2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The file names of the stored images the essay's paste uses, matched exactly as substackExport matches them (the decoded
 * last path segment, query and hash dropped, H1 and footer left out; https images are not stored ones). The newsletter
 * card gates on this list, so what John approves is what "Copy for Substack" pastes (review #143 F1).
 */
export function referencedImages(markdown: string): string[] {
  const { body: raw } = splitDraft(markdown);
  const { main } = splitFooter(stripH1(raw).body);
  return [...main.matchAll(IMAGE)].map((m) => m[2]).filter((src) => !/^https:\/\//.test(src)).map(basename);
}

export function substackExport(markdown: string, sources: ExportImageSource[]): SubstackExport {
  const { meta, body: raw } = splitDraft(markdown);
  const { body: noH1, h1 } = stripH1(raw);
  const { main, footer } = splitFooter(noH1);
  const used: ExportImage[] = [];
  const missing: string[] = [];
  const body = main.replace(IMAGE, (_all, alt: string, src: string) => {
    if (/^https:\/\//.test(src)) {
      used.push({ file: basename(src), url: src, permanent: true, alt });
      return `![${alt}](${src})`;
    }
    const hit = sources.find((source) => source.file === basename(src));
    if (!hit) {
      missing.push(basename(src));
      return "";
    }
    used.push({ ...hit, alt });
    return `![${alt}](${hit.url})`;
  });
  const render = (md: string) => new HtmlRenderer({ safe: true }).render(new Parser().parse(md)).trim().replace(/\s*<!-- raw HTML omitted -->\s*/g, "");
  let html = render(body);
  // An image alone in a paragraph becomes a figure, which Substack's editor keeps as a full-width image block.
  html = html.replace(/<p>(<img [^>]*\/?>)<\/p>/g, (_all, img: string) => `<figure>${img}</figure>`);
  html = html.replace(/<img src="([^"]*)" alt="([^"]*)" \/>/g, (_all, src: string, alt: string) => `<img src="${src}" alt="${alt}">`);
  const str = (key: string) => (typeof meta[key] === "string" ? (meta[key] as string).trim() : "");
  const title = str("title") || h1;
  return {
    publication: publicationOf(meta),
    title,
    subtitle: str("subtitle") || str("previewText") || str("description"),
    subject: str("subject") || title,
    html,
    text: toPlain(body),
    footer,
    footerHtml: footer ? render(footer) : "",
    images: used,
    missing,
    expiring: used.filter((image) => !image.permanent).map((image) => image.file),
  };
}
