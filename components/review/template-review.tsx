"use client";
import { useState, useTransition } from "react";
import { packagingFeedback } from "@/app/content/packaging-actions";
import { COVER_STYLES } from "@/lib/packaging/styles";
import { PROFILES } from "@/lib/packaging/catalog";
import { WatchedImage } from "@/components/media/watched-media";

export type TemplateCandidate = { id: string; storyId: string; title: string; style: string; brand: string; theme: string; shape: string;
  src: string | null; revision: number; sha256: string; notes: Array<{ id: string; body: string; resolved: boolean }> };
function Candidate({ asset }: { asset: TemplateCandidate }) {
  const [note, setNote] = useState(""), [error, setError] = useState(""), [saved, setSaved] = useState(false), [pending, start] = useTransition();
  return <article className="rounded-xl border border-line bg-panel p-4" data-testid="template-candidate">
    <div className="mb-3 flex items-center justify-between gap-2"><h3 className="font-medium">{COVER_STYLES[asset.style as keyof typeof COVER_STYLES]?.name ?? asset.title}</h3><span className="text-xs text-ink-3">v{asset.revision}</span></div>
    {asset.src ? <a href={asset.src} target="_blank" rel="noreferrer"><WatchedImage src={asset.src} alt={asset.title} className="max-h-[65vh] w-full rounded-md object-contain" /></a> : <p className="text-red-strong">Image unavailable</p>}
    <a className="mt-3 block text-sm text-violet-strong underline" href={`/content/publication/${asset.storyId}?cover=${encodeURIComponent(asset.id)}`}>See in publication mockups</a>
    <details className="mt-3 text-sm"><summary className="cursor-pointer text-ink-3">Feedback</summary><textarea value={note} onChange={e => { setNote(e.target.value); setSaved(false); }} aria-label={`Feedback for ${asset.title}`} placeholder="What works? What should change?" rows={3} className="mt-4 w-full rounded-md border border-line bg-transparent p-3 text-sm" maxLength={4800}/>
    <button disabled={pending || !note.trim()} className="rounded-md bg-ink px-3 py-2 text-sm text-panel disabled:opacity-40" onClick={() => start(async () => { const r = await packagingFeedback({ assetId: asset.id, sha256: asset.sha256, revision: asset.revision, body: note }); if (!r.ok) setError(r.error ?? "Feedback failed"); else { setSaved(true); setError(""); setNote(""); } })}>{pending ? "Saving…" : "Save iteration note"}</button>
    {saved && <p role="status" className="mt-2 text-sm">Saved to this template’s feedback.</p>}{error && <p role="alert" className="mt-2 text-sm text-red-strong">{error}</p>}
    </details>
    {asset.notes.length > 0 && <details className="mt-3 text-sm"><summary>{asset.notes.length} review notes</summary>{asset.notes.map(n => <p key={n.id} className={`mt-2 whitespace-pre-wrap ${n.resolved ? "text-ink-3" : "text-ink"}`}>{n.body}{n.resolved ? " · Resolved" : ""}</p>)}</details>}
  </article>;
}
export function TemplateReview({ assets, brands = Object.entries(PROFILES).map(([id, profile]) => ({ id, name: profile.name })) }: { assets: TemplateCandidate[]; brands?: Array<{ id: string; name: string }> }) {
  const [brand, setBrand] = useState(brands[0]?.id ?? ""), [theme, setTheme] = useState("dark"), [shape, setShape] = useState("landscape");
  const shown = assets.filter(a => a.brand === brand && a.theme === theme && a.shape === shape);
  return <section className="space-y-5"><div><h2 className="font-display text-3xl">Thumbnail template review</h2><p className="mt-2 text-sm text-ink-2"></p></div>
    <div className="flex flex-wrap gap-4 text-sm"><label>Brand <select aria-label="Template brand" value={brand} onChange={e => setBrand(e.target.value)} className="ml-2 rounded border border-line bg-panel p-2">{brands.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>Theme <select aria-label="Template theme" value={theme} onChange={e => setTheme(e.target.value)} className="ml-2 rounded border border-line bg-panel p-2"><option value="dark">Dark</option><option value="light">Light</option></select></label><label>Shape <select aria-label="Template shape" value={shape} onChange={e => setShape(e.target.value)} className="ml-2 rounded border border-line bg-panel p-2"><option value="landscape">16:9</option><option value="portrait">9:16</option><option value="square">Square</option></select></label></div>
    <p className="text-xs text-ink-3">{shown.length} assets</p>
    <div className="grid gap-6 xl:grid-cols-2">{shown.map(a => <Candidate key={a.id+":"+a.revision} asset={a}/>)}</div>
    {!shown.length && <p className="py-12 text-ink-2">No templates staged for this selection yet.</p>}
  </section>;
}
