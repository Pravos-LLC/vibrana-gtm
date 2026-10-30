import { findUrls, hasUrl } from "../channel-rules";

/**
 * A first-touch email carries no link: links in a cold first email cost deliverability (Abe, 2026-10-27), and a bare domain
 * such as brand.example.com counts as one. So the signature drops any line that is only a link, and the generator strips links
 * from the body. The signature is the profile's own text; the profile can keep the line for other uses.
 */
export const outreachSignature = (signature = ""): string =>
  signature.replace(/\r\n?/g, "\n").split("\n").filter((line) => !(hasUrl(line) && !line.replace(/\S*[./]\S*/g, "").trim())).join("\n").trim();

/** Removes every link from generated copy. A P.S. or line that offered one goes with it; inline links are cut and spacing tidied. */
export function stripLinks(raw: string): string {
  const paragraphs = raw.replace(/\r\n?/g, "\n").split(/\n\s*\n/).filter((p) => !(hasUrl(p) && /^\s*P\.?S\.?(?::|\s)/i.test(p)));
  return paragraphs.map((p) => {
    let out = p;
    for (const url of findUrls(p)) out = out.replace(url, "");
    return out.replace(/[ \t]+([,.;:!?])/g, "$1").replace(/[ \t]{2,}/g, " ").replace(/\(\s*\)/g, "").trim();
  }).filter(Boolean).join("\n\n");
}

/** Keep plain-text emails readable in the editor, clipboard and Gmail. */
export function formatOutreachEmail(raw: string, signature = ""): string {
  let text = raw.replace(/\r\n?/g, "\n").trim();
  const psAt = text.search(/(?:^|\n)[ \t]*P\.?S\.?(?::|[ \t])[^\n]*(?:\n(?![ \t]*\n)[^\n]+)*$/i);
  const postscript = psAt >= 0 ? text.slice(psAt).trim() : "";
  if (psAt >= 0) text = text.slice(0, psAt).trim();
  const sign = outreachSignature(signature);
  if (sign && text.endsWith(sign)) text = text.slice(0, -sign.length).trim();
  const greeting = text.match(/^(?:Hi|Hey|Hello)\s+[^,\n]{1,80},/i)?.[0];
  if (greeting) text = text.slice(greeting.length).trim();
  const paragraphs = text.split(/\n\s*\n/).flatMap((paragraph) => {
    const sentences = paragraph.trim().split(/(?<=[.!?])\s+(?=[A-Z])/);
    const chunks: string[] = [];
    let chunk = "";
    for (const sentence of sentences) {
      if (chunk && `${chunk} ${sentence}`.split(/\s+/).length > 45) {
        chunks.push(chunk); chunk = "";
      }
      chunk = chunk ? `${chunk} ${sentence}` : sentence;
    }
    if (chunk) chunks.push(chunk);
    return chunks;
  });
  return [greeting, ...paragraphs, sign, postscript].filter(Boolean).join("\n\n");
}
