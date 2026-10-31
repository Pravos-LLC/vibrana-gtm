"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import type { SubstackExport } from "@/lib/substack";
import type { NewsletterImage } from "@/lib/newsletter-card";
import { WatchedImage } from "@/components/media/watched-media";

/** Image bytes for "Copy image" come from `copyUrl` (CORS-enabled storage); the pasted HTML uses `url`. */
export type ExportPanelImage = NewsletterImage;

async function toPng(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`image fetch failed (${response.status})`);
  const blob = await response.blob();
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((png) => (png ? resolve(png) : reject(new Error("PNG encode failed"))), "image/png"));
}

export function SubstackExportPanel({ data, images, disabled }: { data: SubstackExport; images: ExportPanelImage[]; disabled?: boolean }) {
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const publication = data.publicationDetails;

  async function run(label: string, write: () => Promise<void>) {
    setNotice(null);
    setError(null);
    try {
      await write();
      setNotice(`${label} copied.`);
    } catch (e) {
      setError(`${label}: the browser blocked the copy (${(e as Error).message}).`);
    }
  }
  const copyText = (label: string, value: string) => run(label, () => navigator.clipboard.writeText(value));
  const copyRich = (label: string, html: string, text: string) => run(label, () => navigator.clipboard.write([
    new ClipboardItem({
      "text/html": new Blob([`<!doctype html><html><body>${html}</body></html>`], { type: "text/html" }),
      "text/plain": new Blob([text], { type: "text/plain" }),
    }),
  ]));
  const copyBody = () => copyRich("Body", data.html, data.text);
  // The PNG promise is handed to ClipboardItem synchronously so Safari keeps the user gesture.
  const copyImage = (image: ExportPanelImage) => run(`Image ${image.file}`, () => navigator.clipboard.write([new ClipboardItem({ "image/png": toPng(image.copyUrl) })]));

  return (
    <div className="mt-4 rounded-lg border border-line bg-[color:var(--surface-frost)] p-4" data-testid="substack-export">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-ink-3">Substack export</span>
        {publication
          ? <Badge variant="info" data-testid="substack-publication">{publication.label}</Badge>
          : <Badge variant="destructive">No publication set</Badge>}
        {publication && <a href={`${publication.url}/publish/post?type=newsletter`} target="_blank" rel="noreferrer" data-testid="substack-editor" className="text-xs text-violet-strong hover:underline">Open Substack editor ({publication.url.replace("https://", "")})</a>}
      </div>
      <dl className="mt-3 grid gap-2 text-sm">
        {([["Title", data.title], ["Subtitle", data.subtitle], ...(data.subject && data.subject !== data.title ? [["Email subject", data.subject]] : [])] as [string, string][]).map(([label, value]) => (
          <div key={label} className="flex items-start justify-between gap-3">
            <div className="min-w-0"><dt className="text-xs text-ink-3">{label}</dt><dd className="text-ink">{value || <span className="text-ink-3">(none in frontmatter)</span>}</dd></div>
            <Button size="sm" variant="outline" disabled={disabled || !value} onClick={() => copyText(label, value)}>Copy {label.toLowerCase()}</Button>
          </div>
        ))}
      </dl>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={copyBody} disabled={disabled}>Copy body for Substack</Button>
        {data.footer && <Button size="sm" variant="outline" onClick={() => copyRich("Footer", data.footerHtml, data.footer)} disabled={disabled}>Copy footer</Button>}
      </div>
      {disabled && <p className="mt-2 text-xs text-ink-3">Save the edit first: the export reflects the saved text.</p>}
      {data.missing.length > 0 && <p className="mt-2 text-sm text-red-strong">Not uploaded, left out of the body: {data.missing.join(", ")}.</p>}
      {data.expiring.length > 0 && <p className="mt-2 text-sm text-red-strong">These images only have a 1-hour link and will break after pasting: {data.expiring.join(", ")}. Run <code>gtm story publish-media</code> first.</p>}
      {data.footer && <p className="mt-2 text-xs text-ink-3">The closing italic lines (attribution and disclosure) are not in the body. Paste them at the end with Copy footer if the edition needs them.</p>}
      {images.length > 0 && (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {images.map((image) => (
            <figure key={image.file} className="space-y-1">
              <WatchedImage src={image.copyUrl} alt={image.alt || image.file} className="h-28 w-full rounded-md object-cover" />
              <figcaption className="flex items-center justify-between gap-1 text-xs text-ink-3">
                <span className="truncate">{image.file}{image.permanent ? "" : " (expiring)"}</span>
                <Button size="sm" variant="ghost" onClick={() => copyImage(image)} disabled={disabled}>Copy image</Button>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      <details className="mt-4" open>
        <summary className="cursor-pointer text-xs text-ink-3">Preview: exactly what Copy body pastes</summary>
        <div
          data-testid="substack-preview"
          className="mt-2 max-h-[40rem] overflow-y-auto rounded-md border border-line bg-[color:var(--surface-card)] p-4 text-sm leading-relaxed text-ink [&_a]:text-violet-strong [&_figure]:my-4 [&_h2]:mb-2 [&_h2]:mt-6 [&_h2]:font-display [&_h2]:text-xl [&_img]:max-h-80 [&_img]:rounded-lg [&_p]:my-3"
          dangerouslySetInnerHTML={{ __html: data.html }}
        />
      </details>
      {notice && <p className="mt-2 text-sm text-ink-2">{notice}</p>}
      {error && <p className="mt-2 text-sm text-red-strong">{error}</p>}
    </div>
  );
}
