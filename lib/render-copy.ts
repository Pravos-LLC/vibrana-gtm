import { Parser, HtmlRenderer } from "commonmark";

export { splitFrontmatter } from "./frontmatter";

/** Render essay prose to HTML, pointing local images at signed review URLs. */
export function renderProse(prose: string, images: { file: string; url: string }[]): string {
  const rewritten = prose.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_all, alt: string, src: string) => {
    const file = src.split("/").pop() ?? src;
    const hit = images.find((image) => image.file === file);
    return hit ? `![${alt}](${hit.url})` : `![${alt}](${src})`;
  });
  return new HtmlRenderer({ safe: true }).render(new Parser().parse(rewritten));
}
