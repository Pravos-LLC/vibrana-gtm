// A post's playbook tags (VIB-421) as small chips on the weekly report: hook, storyline, CTA. Names come from the
// vendored taxonomy; an `avoid` CTA (a conversion ask or bait in the awareness phase) carries an icon and a word.
import { AlertTriangle } from "lucide-react";
import { CTAS, HOOKS, STORYLINES } from "@/lib/playbook/taxonomy";
import type { PackPost } from "@/lib/reports/pack";

const AWARENESS: Record<string, { word: string; tone: string }> = {
  use: { word: "awareness CTA", tone: "border-line text-ink-2" },
  limit: { word: "soft ask, once a week", tone: "border-line text-ink-2" },
  avoid: { word: "avoid in awareness", tone: "border-amber-strong/40 text-amber-strong" },
};

/** The post's playbook tags as small chips: hook, storyline, CTA (an `avoid` CTA is flagged with an icon and a word). */
export function PlaybookChips({ p }: { p: PackPost }) {
  const t = p.playbook_tags;
  if (!t) return null;
  const chip = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.7rem] leading-tight";
  const cta = AWARENESS[t.cta_awareness] ?? AWARENESS.use;
  return (
    <p className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Playbook tags">
      <span className={`${chip} border-line text-ink-2`} title={HOOKS.get(t.hook)?.definition}><span className="text-ink-3">Hook</span> {HOOKS.get(t.hook)?.name ?? t.hook}</span>
      <span className={`${chip} border-line text-ink-2`} title={STORYLINES.get(t.storyline)?.definition}><span className="text-ink-3">Story</span> {STORYLINES.get(t.storyline)?.name ?? t.storyline}</span>
      <span className={`${chip} ${cta.tone}`} title={`${CTAS.get(t.cta)?.definition ?? ""} (${cta.word})`}>
        {t.cta_awareness === "avoid" && <AlertTriangle className="size-3" aria-hidden />}
        <span className={t.cta_awareness === "avoid" ? "" : "text-ink-3"}>CTA</span> {CTAS.get(t.cta)?.name ?? t.cta}
        {t.cta_awareness === "avoid" && <span>· {cta.word}</span>}
      </span>
    </p>
  );
}

