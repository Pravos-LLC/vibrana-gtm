import { ArrowRight, ArrowUpRight, BadgeCheck, CalendarClock, ChartLine, FileText, Film, Image as ImageIcon, LayoutGrid, Mail, MessagesSquare, PenLine, ShieldCheck, Sprout, Type, type LucideIcon } from "lucide-react";
import { SocialMark } from "@/components/guide/social-mark";
import { GuideImage, GuideVideo } from "@/components/guide/media";
import { PillarConsole } from "@/components/guide/pillar-console";
import { BeforeAfter, DialByPillar } from "@/components/guide/voice-lab";
import { SlideViewer } from "@/components/guide/slide-viewer";
import { AddInspirationForm } from "@/components/inspiration/add-form";
import { KINDS } from "@/lib/inspiration";
import { PIPELINES } from "@/lib/pipelines";
import { ASSETS, CHANNELS, HYPOTHESIS, PILLARS, PILLAR_TONE, PIPELINE, REVIEW, STORIES, VOICE, WHY, type PillarSlug, type Substack } from "@/lib/guide/content";
import { youtubeThumb, type BoardItem } from "@/lib/guide/inspiration";
import type { PlanWeek } from "@/lib/guide/plan";
import type { SignedMedia } from "@/lib/guide/media";
import { cn } from "@/lib/ui/cn";

type M = Record<string, SignedMedia>;

export function Chapter({ id, title, lead, children, className }: { id: string; title: string; lead?: string; children: React.ReactNode; className?: string }) {
  return (
    <section id={id} className={cn("scroll-mt-24 border-t border-line pt-14 pb-20", className)}>
      <h2 className="font-display text-pl-3xl font-semibold tracking-tight text-ink">{title}</h2>
      {lead && <p className="mt-3 max-w-[62ch] text-pl-base leading-relaxed text-ink-2">{lead}</p>}
      <div className="mt-10">{children}</div>
    </section>
  );
}

function Media({ m, alt, ambient, className }: { m?: SignedMedia; alt: string; ambient?: boolean; className?: string }) {
  if (!m) return null;
  return m.kind === "video" ? <GuideVideo media={m} ambient={ambient} label={alt} className={className} /> : <GuideImage media={m} alt={alt} className={className} />;
}

/** A still for small slots: a video shows its poster, never a player. */
function Poster({ m, alt }: { m: SignedMedia; alt: string }) {
  if (m.kind === "image") return <GuideImage media={m} alt={alt} className="aspect-[4/5]" />;
  // eslint-disable-next-line @next/next/no-img-element
  return m.posterSrc ? <img src={m.posterSrc} alt={alt} loading="lazy" className="aspect-[4/5] w-full object-cover" /> : null;
}

const longDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });

const tone = (p: string | null | undefined) => (p && p in PILLAR_TONE ? PILLAR_TONE[p as PillarSlug] : "var(--text-tertiary)");

/* ---------------------------------------------------------------- 1. The why */

export function WhyHero({ m }: { m: M }) {
  const [lead, ...rest] = WHY.wall;
  const [first, ...others] = WHY.inquiries;
  return (
    <header id="why" className="scroll-mt-24 pb-20 pt-4">
      <div className="grid items-end gap-10 xl:grid-cols-[1fr_1.1fr]">
        <div className="guide-rise">
          <h1 className="font-display text-5xl font-semibold leading-[1.02] tracking-tight text-ink md:text-7xl">{first.question}</h1>
          <p className="mt-6 max-w-[46ch] text-pl-lg leading-relaxed text-ink-2">{first.answer.text}</p>
          {first.more && <p className="mt-4 max-w-[46ch] text-pl-base leading-relaxed text-ink-2">{first.more.text}</p>}
        </div>
        {lead && m[lead.media] && (
          <figure className="guide-rise overflow-hidden rounded-2xl border border-line shadow-[0_30px_80px_-40px_rgba(76,29,149,0.45)] [animation-delay:120ms]">
            <Media m={m[lead.media]} alt={lead.alt} ambient />
          </figure>
        )}
      </div>
      <div className="mt-4 grid grid-cols-3 gap-3 md:grid-cols-6">
        {rest.map((w, i) => m[w.media] && (
          <div key={w.media} className="guide-rise aspect-[4/5] overflow-hidden rounded-xl border border-line" style={{ animationDelay: `${200 + i * 60}ms` }}>
            <Media m={m[w.media]} alt={w.alt} className="h-full" />
          </div>
        ))}
      </div>
      <div className="mt-16">
        <p className="text-sm font-medium text-ink">Alongside it, two more inquiries</p>
        <p className="mt-1 max-w-[64ch] text-sm text-ink-3">{WHY.inquiries_note.text}</p>
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {others.map((q, i) => (
            <div key={q.question} className="rounded-2xl border border-line p-6">
              <p className="font-mono text-xs tabular-nums text-ink-3">0{i + 2}</p>
              <h3 className="mt-2 font-display text-pl-xl font-semibold leading-snug text-ink">{q.question}</h3>
              <p className="mt-3 text-pl-base leading-relaxed text-ink-2">{q.answer.text}</p>
              {q.more && <p className="mt-2 text-pl-base leading-relaxed text-ink-2">{q.more.text}</p>}
            </div>
          ))}
        </div>
      </div>
      <dl className="mt-16 grid gap-x-12 gap-y-10 md:grid-cols-[10rem_1fr]">
        <dt className="font-display text-pl-lg font-semibold text-ink">What we believe</dt>
        <dd className="space-y-3">{WHY.belief.map((b) => <p key={b.text} className="max-w-[64ch] text-pl-base leading-relaxed text-ink-2">{b.text}</p>)}</dd>
        <dt className="font-display text-pl-lg font-semibold text-ink">What we refuse</dt>
        <dd className="max-w-[64ch] text-pl-base leading-relaxed text-ink-2">{WHY.refuse.text}</dd>
        <dt className="font-display text-pl-lg font-semibold text-ink">Mission</dt>
        <dd className="max-w-[64ch] text-pl-base leading-relaxed text-ink-2">{WHY.mission.text}</dd>
        <dt className="font-display text-pl-lg font-semibold text-ink">How we do it</dt>
        <dd className="space-y-3">{WHY.how.map((h) => <p key={h.text} className="max-w-[64ch] text-pl-base leading-relaxed text-ink-2">{h.text}</p>)}</dd>
        <dt className="font-display text-pl-lg font-semibold text-ink">Credo</dt>
        <dd><ul className="space-y-2">{WHY.credo.map((c) => <li key={c.text} className="max-w-[64ch] text-pl-base text-ink-2">{c.text}</li>)}</ul></dd>
      </dl>
    </header>
  );
}

/* ---------------------------------------------------------------- 2. Pillars */

export function PillarsChapter({ m }: { m: M }) {
  return (
    <Chapter id="pillars" title="Four pillars" lead="Proof is the evidence that we deliver. Perspective is our take on the AI movement. The Build shows the depth of what we can create. Lists show we're on the cutting edge. Together they signal that we know this field, that we run a powerful AI-native studio, and that we deliver with a conscious mind and an open heart. A piece is filed under its lead pillar, and many weave in more than one. The dos and don'ts are guidance; a person makes the final call.">
      <div className="mb-10">
        <div className="flex h-3 gap-[2px] overflow-hidden rounded-full" aria-hidden>
          {PILLARS.map((p) => <div key={p.slug} style={{ width: `${p.share}%`, background: PILLAR_TONE[p.slug] }} />)}
        </div>
        <div className="mt-2 flex text-xs text-ink-3">
          {PILLARS.map((p) => <span key={p.slug} style={{ width: `${p.share}%` }} className="truncate pr-2">{p.name} {p.share}%</span>)}
        </div>
      </div>
      <PillarConsole pillars={PILLARS} media={m} />
    </Chapter>
  );
}

/* ---------------------------------------------------------------- 3. Stories */

export function StoriesChapter({ m }: { m: M }) {
  return (
    <Chapter id="stories" title="The stories we tell" lead={HYPOTHESIS}>
      <div className="mb-10 rounded-2xl border border-[color:var(--border-strong)] bg-[color:var(--surface-frost)] p-6">
        <p className="text-sm font-medium text-ink">How we test it</p>
        <p className="mt-1 text-sm text-ink-2">First read <strong className="font-medium text-ink">{longDate(REVIEW.first_read)}</strong>, after three weeks. Full re-evaluation <strong className="font-medium text-ink">{longDate(REVIEW.full_review)}</strong>, after four.</p>
        <ul className="mt-4 grid gap-2 text-sm text-ink-2 md:grid-cols-2">{REVIEW.questions.map((x) => <li key={x} className="flex gap-2"><span className="mt-2 size-1 shrink-0 rounded-full bg-ink-3" />{x}</li>)}</ul>
        <p className="mt-4 text-xs text-ink-3">{REVIEW.where}</p>
      </div>
      <div className="space-y-6">
        {STORIES.map((s) => {
          const ex = s.real_example;
          return (
            <article key={s.slug} className="grid gap-6 rounded-2xl border border-line p-6 md:p-8 lg:grid-cols-[1fr_1.1fr]" style={{ ["--tone" as string]: tone(s.pillar) }}>
              <div>
                <p className="text-xs font-medium" style={{ color: "var(--tone)" }}>{PILLARS.find((p) => p.slug === s.pillar)?.name}</p>
                <h3 className="mt-1 font-display text-pl-2xl font-semibold leading-tight tracking-tight text-ink">{s.name}</h3>
                <p className="mt-2 max-w-[54ch] text-ink-2">{s.summary}</p>
                <blockquote className="mt-6 border-l-2 border-[color:var(--tone)] pl-4">
                  <p className="font-display text-pl-lg font-medium leading-snug text-ink">{s.example_hook.text}</p>
                  <p className="mt-1 text-xs text-ink-3">Hook pattern: {s.hook_pattern}</p>
                </blockquote>
                <div className="mt-6 grid gap-5 sm:grid-cols-2">
                  <div><p className="mb-2 text-sm font-medium text-ink">Do</p><ul className="list-disc space-y-1 pl-4 text-sm text-ink-2">{s.dos.map((x) => <li key={x}>{x}</li>)}</ul></div>
                  <div><p className="mb-2 text-sm font-medium text-ink">Don&apos;t</p><ul className="list-disc space-y-1 pl-4 text-sm text-ink-2">{s.donts.map((x) => <li key={x}>{x}</li>)}</ul></div>
                </div>
                <p className="mt-5 text-sm text-ink-2"><span className="font-medium text-ink">We&apos;ll know it works if: </span>{s.signal}</p>
              </div>
              <div className="flex flex-col gap-5">
                <ol className="space-y-0">
                  {s.template.map((beat, i) => (
                    <li key={beat} className="relative flex gap-4 pb-4 last:pb-0">
                      <span className="relative z-[1] grid size-7 shrink-0 place-items-center rounded-full border border-[color:var(--tone)] bg-[color:var(--surface-base)] font-mono text-xs tabular-nums text-ink">{i + 1}</span>
                      {i < s.template.length - 1 && <span className="absolute left-[0.8rem] top-7 h-[calc(100%-1.75rem)] w-px bg-[color:var(--border-default)]" aria-hidden />}
                      <span className="pt-0.5 text-sm leading-relaxed text-ink-2">{beat}</span>
                    </li>
                  ))}
                </ol>
                {ex && (
                  <div className="mt-auto flex gap-4 rounded-xl bg-surface-overlay/60 p-4">
                    {ex.media && m[ex.media] && <div className="w-24 shrink-0 overflow-hidden rounded-lg"><Poster m={m[ex.media]} alt={ex.title} /></div>}
                    <div>
                      <p className="text-xs text-ink-3">Real example: {ex.title}</p>
                      <p className="mt-1 text-sm leading-relaxed text-ink">{ex.quote.text}</p>
                    </div>
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </Chapter>
  );
}

/* ---------------------------------------------------------------- 4. Voice */

export function VoiceChapter({ m }: { m: M }) {
  return (
    <Chapter id="voice" title="Voice" lead="This season publishes in John's voice, and anyone on the team may write in it or in their own. Vibrana lends the lexicon, the proof rules and the fear-to-aspiration arc. Regenera and the Sample Author Substack have their own chapters below.">
      <div className="grid gap-4 md:grid-cols-3">
        {VOICE.voices.map((v, i) => (
          <div key={v.slug} className={cn("overflow-hidden rounded-2xl border", i === 0 ? "border-[color:var(--border-strong)] bg-[color:var(--surface-frost)]" : "border-line")}>
            {v.media && m[v.media]
              ? <GuideImage media={m[v.media]} alt={v.alt ?? v.name} className="aspect-[16/10] border-b border-line object-top" />
              // eslint-disable-next-line @next/next/no-img-element
              : v.image_url ? <img src={v.image_url} alt={v.alt ?? v.name} loading="lazy" className="aspect-[16/10] w-full border-b border-line object-cover" /> : null}
            <div className="p-6">
            <p className="text-xs text-ink-3">{v.for}</p>
            <h3 className="mt-1 font-display text-pl-xl font-semibold leading-tight text-ink">{v.name}</h3>
            <p className="mt-1 text-sm text-ink-2">Speaks as: {v.who_speaks}</p>
            <ul className="mt-4 space-y-1.5 text-sm text-ink-2">{v.core.map((c) => <li key={c} className="flex gap-2"><span className="mt-2 size-1 shrink-0 rounded-full bg-ink-3" />{c}</li>)}</ul>
            <p className="mt-4 font-mono text-[0.7rem] text-ink-3">{v.file}</p>
            </div>
          </div>
        ))}
      </div>

      <h3 className="mt-16 font-display text-pl-xl font-semibold text-ink">The core, in five lines</h3>
      <ol className="mt-5 grid gap-x-10 gap-y-4 md:grid-cols-2">
        {VOICE.core_five.map((c, i) => (
          <li key={c.text} className="flex gap-4"><span className="font-display text-pl-2xl font-semibold tabular-nums text-ink-3">{i + 1}</span><span className="pt-1.5 text-ink-2">{c.text}</span></li>
        ))}
      </ol>

      <h3 className="mt-16 mb-5 font-display text-pl-xl font-semibold text-ink">Before and after</h3>
      <BeforeAfter items={VOICE.before_after} pillars={PILLARS} />

      <div className="mt-16 grid gap-12 lg:grid-cols-[1fr_1fr]">
        <div>
          <h3 className="mb-5 font-display text-pl-xl font-semibold text-ink">The dial, per pillar</h3>
          <DialByPillar pillars={PILLARS} />
          <p className="mt-6 max-w-[56ch] text-sm leading-relaxed text-ink-2">{VOICE.soul_meaning.text}</p>
        </div>
        <div>
          <h3 className="mb-5 font-display text-pl-xl font-semibold text-ink">Never write</h3>
          <div className="flex flex-wrap gap-1.5">
            {VOICE.banned_words.map((w) => <span key={w} className="rounded-md bg-surface-overlay px-2 py-1 text-xs text-ink-2 line-through decoration-[color:var(--border-strong)]">{w}</span>)}
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {VOICE.banned_phrases.map((w) => <span key={w} className="rounded-md border border-line px-2 py-1 text-xs text-ink-3">&ldquo;{w}&rdquo;</span>)}
          </div>
          <ul className="mt-6 space-y-2 text-sm text-ink-2">{VOICE.shared_bans.map((b) => <li key={b}>{b}</li>)}</ul>
          <h3 className="mt-10 mb-3 font-display text-pl-xl font-semibold text-ink">Always write</h3>
          <ul className="space-y-2 text-sm text-ink-2">
            {VOICE.preferred_terms.map((t) => <li key={t.term}><span className="font-medium text-ink">{t.term}.</span> {t.note} <span className="text-xs text-ink-3">({t.source})</span></li>)}
          </ul>
        </div>
      </div>

      {VOICE.editing && (
        <>
          <h3 className="mt-16 font-display text-pl-xl font-semibold text-ink">Editing in John&apos;s voice</h3>
          <p className="mt-3 max-w-[70ch] text-sm leading-relaxed text-ink-2">{VOICE.editing.lead}</p>
          <div className="mt-5 grid gap-3 md:grid-cols-2">
            {VOICE.editing.items.map((e) => (
              <div key={e.do} className="rounded-xl border border-line p-4">
                <p className="text-sm text-ink"><span className="font-medium">Do: </span>{e.do}</p>
                <p className="mt-1 text-sm text-ink-2"><span className="font-medium">Don&apos;t: </span>{e.dont}</p>
                <p className="mt-3 text-xs text-ink-3 line-through decoration-[color:var(--border-strong)]">{e.before}</p>
                <p className="mt-1 text-xs text-ink-2">{e.after.text}</p>
              </div>
            ))}
          </div>
        </>
      )}

      {VOICE.captured_edits.length > 0 && (
        <>
          <h3 className="mt-16 font-display text-pl-xl font-semibold text-ink">What John&apos;s edits taught us</h3>
          <div className="mt-5 grid gap-3 md:grid-cols-2">
            {VOICE.captured_edits.map((e) => (
              <div key={e.date + e.pattern.text} className="rounded-xl border border-line p-4">
                <p className="text-sm font-medium text-ink">{e.rule.text}</p>
                <p className="mt-1 text-xs text-ink-3">{e.date}: {e.pattern.text}</p>
              </div>
            ))}
          </div>
        </>
      )}
    </Chapter>
  );
}

/* ---------------------------------------------------------------- 5. The two Substacks */

/** One Substack: what it is, what its best posts teach (from the research), how it looks, and its top posts. */
export function SubstackChapter({ s }: { s: Substack }) {
  const bullets = (items: string[]) => <ul className="mt-4 space-y-2 text-sm text-ink-2">{items.map((r) => <li key={r} className="flex gap-2"><span className="mt-2 size-1 shrink-0 rounded-full bg-ink-3" />{r}</li>)}</ul>;
  return (
    <section id={s.slug} className="scroll-mt-24 border-t border-line pt-14 pb-20">
      <div className="relative overflow-hidden rounded-3xl">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={s.banner.image_url} alt={s.banner.alt} className="aspect-[16/9] w-full object-cover md:aspect-[21/9]" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/25 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 p-6 md:p-10">
          <p className="text-sm text-white/75">{s.ordinal} · {s.stats}</p>
          <h2 className="mt-1 font-display text-pl-3xl font-semibold tracking-tight text-white"><a href={s.url} target="_blank" rel="noreferrer" className="hover:underline">{s.name}</a></h2>
          <p className="mt-2 max-w-[60ch] text-white/85">{s.summary}</p>
        </div>
      </div>

      <div className="mt-12 grid gap-12 lg:grid-cols-[1fr_1fr]">
        <div>
          <h3 className="font-display text-pl-xl font-semibold text-ink">What engaged</h3>
          {bullets(s.what_worked)}
          <h3 className="mt-10 font-display text-pl-xl font-semibold text-ink">What didn&apos;t</h3>
          {bullets(s.what_didnt)}
          <p className="mt-6 text-xs text-ink-3">Full dissection: <span className="font-mono">{s.research}</span></p>
        </div>
        <div>
          <h3 className="font-display text-pl-xl font-semibold text-ink">How it looks</h3>
          <div className="mt-4 grid gap-6 sm:grid-cols-2">
            <div><p className="text-sm font-medium text-ink">Do</p>{bullets(s.visual.dos)}</div>
            <div><p className="text-sm font-medium text-ink">Don&apos;t</p>{bullets(s.visual.donts)}</div>
          </div>
          {s.key_lines.length > 0 && (
            <div className="mt-10 space-y-6">
              {s.key_lines.map((q) => <blockquote key={q.text} className="border-l-2 border-[color:var(--cyan-strong)] pl-5 font-display text-pl-lg leading-snug text-ink">&ldquo;{q.text}&rdquo;</blockquote>)}
            </div>
          )}
        </div>
      </div>

      <h3 className="mt-16 font-display text-pl-xl font-semibold text-ink">Top posts, by engagement</h3>
      <div className="mt-5 flex snap-x gap-4 overflow-x-auto pb-2">
        {s.top_posts.map((p) => (
          <a key={p.url} href={p.url} target="_blank" rel="noreferrer" className="group w-64 shrink-0 snap-start">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.image_url} alt="" loading="lazy" className="aspect-[16/10] w-full rounded-xl border border-line object-cover transition-transform duration-500 group-hover:scale-[1.02]" />
            <p className="mt-2 text-sm text-ink-2 group-hover:text-ink">{p.title}</p>
            <p className="mt-1 text-xs tabular-nums text-ink-3">{p.reactions} likes · {p.comments} comments · {p.restacks} restacks · {p.date.slice(0, 7)}</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-3">{p.note}</p>
          </a>
        ))}
      </div>

      <div className="mt-16 grid gap-12 lg:grid-cols-[1fr_1fr]">
        <div>
          <h3 className="font-display text-pl-xl font-semibold text-ink">The arc</h3>
          <ol className="mt-5 flex flex-wrap items-center gap-2 text-sm">
            {s.arc.map((a, i) => (
              <li key={a} className="flex items-center gap-2">
                <span className="rounded-full border border-line px-3 py-1.5 text-ink-2">{a}</span>
                {i < s.arc.length - 1 && <ArrowRight className="size-3.5 text-ink-3" />}
              </li>
            ))}
          </ol>
          <h3 className="mt-10 font-display text-pl-xl font-semibold leading-tight text-ink">{s.differs.title}</h3>
          {bullets(s.differs.items)}
        </div>
        <div>
          <h3 className="font-display text-pl-xl font-semibold text-ink">Voice</h3>
          {bullets(s.rules)}
          {s.voice_file && <p className="mt-6 font-mono text-[0.7rem] text-ink-3">{s.voice_file}</p>}
        </div>
      </div>

      {s.essays.length > 0 && (
        <>
          <h3 className="mt-16 font-display text-pl-xl font-semibold text-ink">Essays this season</h3>
          <div className="mt-5 grid gap-5 md:grid-cols-2">
            {s.essays.map((e) => (
              <a key={e.title} href={e.url} target="_blank" rel="noreferrer" className="overflow-hidden rounded-2xl border border-line">
                {e.image_urls.length > 0 && (
                  <div className={cn("grid gap-px bg-[color:var(--border-subtle)]", e.image_urls.length > 1 && "grid-cols-2")}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {e.image_urls.slice(0, 4).map((u) => <img key={u} src={u} alt="" loading="lazy" className={cn("w-full object-cover", e.image_urls.length > 1 ? "aspect-[2/1]" : "aspect-[16/9]")} />)}
                  </div>
                )}
                <div className="p-5"><p className="text-xs text-ink-3">{e.status}</p><p className="mt-1 font-display text-pl-lg font-medium text-ink">{e.title}</p></div>
              </a>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- 6. Asset library */

export function AssetsChapter({ m, carousels }: { m: M; carousels: { slug: string; title: string; slides: SignedMedia[] }[] }) {
  return (
    <Chapter id="assets" title="The asset library" lead="One section per format: the real thing we made, its specs, when to reach for it, and the skill that makes it.">
      <nav aria-label="Formats" className="mb-12 flex flex-wrap gap-2">
        {ASSETS.map((a) => <a key={a.slug} href={`#${a.slug}`} className="rounded-full border border-line px-3 py-1.5 text-xs text-ink-2 hover:text-ink">{a.name}</a>)}
      </nav>
      <div className="space-y-20">
        {ASSETS.map((a) => (
          <div key={a.slug} id={a.slug} className="scroll-mt-28">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h3 className="font-display text-pl-2xl font-semibold tracking-tight text-ink">{a.name}</h3>
              <span className="rounded-full bg-surface-overlay px-3 py-1 font-mono text-xs text-ink-2">skill: {a.skill}</span>
            </div>
            <p className="mt-2 max-w-[62ch] text-ink-2">{a.when}</p>
            <div className="mt-6"><FormatMedia slug={a.slug} keys={a.media} m={m} carousels={carousels} /></div>
            {a.image_urls && a.image_urls.length > 0 && (
              <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {a.image_urls.map((u) => <img key={u} src={u} alt="" loading="lazy" className="aspect-[4/3] w-full rounded-xl border border-line object-cover" />)}
              </div>
            )}
            <div className="mt-6 grid gap-8 md:grid-cols-2">
              <div><p className="mb-2 text-sm font-medium text-ink">Specs</p><ul className="space-y-1.5 text-sm text-ink-2">{a.specs.map((s) => <li key={s}>{s}</li>)}</ul></div>
              <div><p className="mb-2 text-sm font-medium text-ink">Rules</p><ul className="space-y-1.5 text-sm text-ink-2">{a.rules.map((s) => <li key={s}>{s}</li>)}</ul></div>
            </div>
            {a.taste_notes && a.taste_notes.length > 0 && (
              <div className="mt-8 rounded-2xl bg-surface-overlay/60 p-6">
                <p className="mb-4 text-sm font-medium text-ink">John&apos;s taste notes</p>
                <ul className="grid gap-4 md:grid-cols-2">{a.taste_notes.map((q) => <li key={q.text} className="text-sm leading-relaxed text-ink-2">&ldquo;{q.text}&rdquo;</li>)}</ul>
              </div>
            )}
            {a.note && <p className="mt-4 text-sm text-ink-3">{a.note}</p>}
            {a.links && <div className="mt-4 flex flex-wrap gap-4">{a.links.map((l) => <a key={l.href} href={l.href} target={l.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-violet-strong hover:underline">{l.label}<ArrowUpRight className="size-3.5" /></a>)}</div>}
          </div>
        ))}
      </div>
    </Chapter>
  );
}

function FormatMedia({ slug, keys, m, carousels }: { slug: string; keys: string[]; m: M; carousels: { slug: string; title: string; slides: SignedMedia[] }[] }) {
  const items = keys.map((k) => m[k]).filter(Boolean);
  if (slug === "carousels" && carousels.length) return <SlideViewer carousels={carousels} />;
  if (!items.length) return null;
  const videos = items.filter((x) => x.kind === "video");
  if (videos.length && videos.every((v) => v.h > v.w)) {
    return <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">{videos.map((v) => <div key={v.key} className="overflow-hidden rounded-xl border border-line"><GuideVideo media={v} label={v.key} /></div>)}</div>;
  }
  if (videos.length) {
    const [wide, ...more] = [...videos].sort((a, b) => b.w / b.h - a.w / a.h);
    return (
      <div className="grid items-start gap-3 md:grid-cols-[2.2fr_1fr]">
        <div className="overflow-hidden rounded-xl border border-line"><GuideVideo media={wide} label={wide.key} /></div>
        {more.map((v) => <div key={v.key} className="overflow-hidden rounded-xl border border-line"><GuideVideo media={v} label={v.key} /></div>)}
      </div>
    );
  }
  return (
    <div className="columns-2 gap-3 md:columns-3 [&>*]:mb-3">
      {items.map((x) => <div key={x.key} className="break-inside-avoid overflow-hidden rounded-xl border border-line"><GuideImage media={x} alt="" /></div>)}
    </div>
  );
}

/* ---------------------------------------------------------------- 7. Channels */

export function ChannelsChapter() {
  return (
    <Chapter id="channels" title="Channel playbook" lead="Where each format goes, how links travel, and the rhythm of the week.">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {CHANNELS.channels.map((c) => (
          <div key={c.slug} className="flex flex-col rounded-2xl border border-line p-6">
            <div className="flex items-center gap-3">
              <SocialMark channel={c.slug} className="size-8 shrink-0" />
              <div>
                <h3 className="font-display text-pl-xl font-semibold leading-tight text-ink">{c.name}</h3>
                <p className="text-xs text-ink-3">{c.account}</p>
              </div>
            </div>
            <p className="mt-4 rounded-lg bg-surface-overlay px-3 py-2 text-sm font-medium text-ink">{c.link_rule}</p>
            <ul className="mt-4 space-y-1.5 text-sm text-ink-2">{c.specs.map((s) => <li key={s}>{s}</li>)}</ul>
            <p className="mt-4 mb-4 text-xs text-ink-3">{c.timing}</p>
            <dl className="mt-auto space-y-3 border-t border-line pt-4">
              {c.formats.map((f) => (
                <div key={f.format}>
                  <dt className="text-sm font-medium text-ink">{f.format}</dt>
                  <dd className="text-xs text-ink-3">Suits {f.pillars}. {f.note}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
      <div className="mt-14">
        <h3 className="font-display text-pl-xl font-semibold text-ink">Weekly rhythm</h3>
        <p className="mt-2 max-w-[70ch] text-sm text-ink-3">{CHANNELS.rhythm.summary}</p>
        <div className="mt-5 grid gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {CHANNELS.rhythm.days.map((d) => (
            <div key={d.day} className="rounded-lg border border-line p-3">
              <p className="text-xs text-ink-3">{d.day}</p>
              <p className="mt-1 text-sm font-medium capitalize text-ink">{d.primary ?? "Off"}</p>
              {d.fallback.length > 0 && <p className="text-xs capitalize text-ink-3">fallback {d.fallback.join(", then ")}</p>}
              <p className="mt-2 text-xs text-ink-2">{d.note}</p>
            </div>
          ))}
        </div>
        <ol className="mt-5 space-y-1.5 text-sm text-ink-2">{CHANNELS.rhythm.rules.map((r, i) => <li key={r} className="flex gap-3"><span className="w-5 shrink-0 font-mono text-xs tabular-nums text-ink-3">{i + 1}</span>{r}</li>)}</ol>
      </div>
      <div className="mt-14 grid gap-12 lg:grid-cols-2">
        <div>
          <h3 className="font-display text-pl-xl font-semibold text-ink">Cadence</h3>
          <dl className="mt-5 space-y-4">
            {CHANNELS.cadence.map((c) => (
              <div key={c.surface} className="grid grid-cols-[8rem_1fr] gap-4">
                <dt className="text-sm font-medium text-ink">{c.surface}</dt>
                <dd className="text-sm text-ink-2">{c.rhythm}<span className="block text-xs text-ink-3">{c.slot}</span></dd>
              </div>
            ))}
          </dl>
        </div>
        <div>
          <h3 className="font-display text-pl-xl font-semibold text-ink">Format mix</h3>
          <ul className="mt-5 space-y-2 text-sm text-ink-2">{CHANNELS.format_mix.map((x) => <li key={x}>{x}</li>)}</ul>
          <h3 className="mt-10 font-display text-pl-xl font-semibold text-ink">Where long-form lives</h3>
          <ul className="mt-5 space-y-2 text-sm text-ink-2">{CHANNELS.publishing_model.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      </div>
      <h3 className="mt-14 font-display text-pl-xl font-semibold text-ink">Guardrails</h3>
      <p className="mt-2 text-sm text-ink-3">Guidance for the editor, not gates: a draft that breaks one should say why, and a person makes the call. 12 and 13 are firm. The reasoning for each is in the hub&apos;s gtm/content/STRATEGY.md.</p>
      <ol className="mt-5 grid gap-x-10 gap-y-3 md:grid-cols-2">
        {CHANNELS.guardrails.map((g, i) => <li key={g.text} className="flex gap-3 text-sm text-ink-2"><span className="w-5 shrink-0 font-mono text-xs tabular-nums text-ink-3">{i + 1}</span>{g.text}</li>)}
      </ol>
    </Chapter>
  );
}

/* ---------------------------------------------------------------- 8. Inspiration */

export function InspirationChapter({ board, m }: { board: BoardItem[]; m: M }) {
  const [featured, ...rest] = board;
  const vid = featured && youtubeThumb(featured.url)?.match(/vi\/([\w-]{11})/)?.[1];
  return (
    <Chapter id="inspiration" title="Inspiration board" lead="References we hold ourselves to, each with a line on why. Add one from here; it saves to the cockpit's inspiration library.">
      {featured && (
        <article className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
          <div className="overflow-hidden rounded-2xl border border-line">
            {vid
              ? <iframe src={`https://www.youtube-nocookie.com/embed/${vid}`} title={featured.title} loading="lazy" allow="encrypted-media; picture-in-picture" allowFullScreen className="aspect-video w-full" />
              : <Thumb item={featured} m={m} />}
          </div>
          <div className="self-center">
            <p className="text-xs text-ink-3">Featured {featured.kind}</p>
            <h3 className="mt-1 font-display text-pl-2xl font-semibold tracking-tight text-ink">{featured.title}</h3>
            <p className="mt-3 text-ink-2">{featured.why_we_like}</p>
            <a href={featured.url} target="_blank" rel="noreferrer" className="mt-4 inline-flex items-center gap-1 text-sm text-violet-strong hover:underline">Open<ArrowUpRight className="size-3.5" /></a>
          </div>
        </article>
      )}
      <div className="mt-10 grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {rest.map((x) => (
          <a key={x.url + x.title} href={x.url} target={x.url.startsWith("/") ? undefined : "_blank"} rel="noreferrer" className="group flex flex-col overflow-hidden rounded-2xl border border-line transition-colors hover:border-[color:var(--border-strong)]">
            <div className="overflow-hidden"><Thumb item={x} m={m} /></div>
            <div className="flex flex-1 flex-col p-5">
              <div className="flex items-center gap-2 text-xs text-ink-3">
                <KindIcon kind={x.kind} />{x.kind}{x.pillar && <span className="inline-flex items-center gap-1 text-ink-2"><span aria-hidden className="size-2 rounded-sm" style={{ background: tone(x.pillar) }} />{PILLARS.find((p) => p.slug === x.pillar)?.name}</span>}
                {x.source === "added" && <span className="ml-auto">added</span>}
              </div>
              <p className="mt-2 font-display text-pl-lg font-medium leading-snug text-ink">{x.title}</p>
              <p className="mt-2 text-sm text-ink-2">{x.why_we_like}</p>
            </div>
          </a>
        ))}
      </div>
      <div className="mt-10">
        <p className="mb-3 text-sm font-medium text-ink">Add a reference</p>
        <AddInspirationForm kinds={KINDS} pillars={PILLARS.map((p) => p.slug)} />
        <a href="/inspiration" className="mt-3 inline-flex items-center gap-1 text-sm text-violet-strong hover:underline">The full library, with filters<ArrowUpRight className="size-3.5" /></a>
      </div>
    </Chapter>
  );
}

function Thumb({ item, m }: { item: BoardItem; m: M }) {
  // Cards are links, so a video shows its poster here, never a player (no interactive content inside <a>).
  const media = item.media ? m[item.media] : undefined;
  const still = media && (media.kind === "image" ? media.src : media.posterSrc);
  // eslint-disable-next-line @next/next/no-img-element
  if (still) return <img src={still} alt="" loading="lazy" className="aspect-video w-full object-cover transition-transform duration-500 group-hover:scale-[1.02]" />;
  const src = item.image_url ?? youtubeThumb(item.url);
  // eslint-disable-next-line @next/next/no-img-element
  if (src) return <img src={src} alt="" loading="lazy" className="aspect-video w-full object-cover transition-transform duration-500 group-hover:scale-[1.02]" />;
  return <div className="grid aspect-video place-items-center bg-surface-overlay px-6 text-center font-display text-pl-lg text-ink-2">{item.title}</div>;
}

function KindIcon({ kind }: { kind: string }) {
  const I = kind === "video" ? Film : kind === "carousel" ? LayoutGrid : kind === "newsletter" ? Mail : Type;
  return <I className="size-3.5" />;
}

/* ---------------------------------------------------------------- 9. Pipeline */

const STEP_ICON: Record<string, LucideIcon> = {
  source: Sprout, draft: PenLine, "persona-review": ShieldCheck, review: MessagesSquare, approve: BadgeCheck, schedule: CalendarClock, metrics: ChartLine,
};

export function PipelineChapter() {
  return (
    <Chapter id="pipeline" title="The pipeline" lead="From a real source to a measured post. Each step links to the cockpit page that does it.">
      <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {PIPELINE.map((s, i) => {
          const body = (
            <>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-3">
                  {(() => { const Icon = STEP_ICON[s.slug]; return Icon ? (
                    <span className="grid size-11 place-items-center rounded-xl border border-line bg-[linear-gradient(135deg,rgba(124,58,237,0.10),rgba(59,130,246,0.08),rgba(45,212,191,0.08))]">
                      <Icon className="size-5 text-violet-strong" strokeWidth={1.75} />
                    </span>
                  ) : null; })()}
                  <span className="font-mono text-xs tabular-nums text-ink-3">{String(i + 1).padStart(2, "0")}</span>
                </span>
                {s.href && <ArrowUpRight className="size-4 text-ink-3 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />}
              </div>
              <p className="mt-3 font-display text-pl-lg font-semibold text-ink">{s.name}</p>
              <p className="mt-1 text-sm text-ink-2">{s.what}</p>
              <p className="mt-3 font-mono text-[0.7rem] text-ink-3">{s.tool}</p>
              {s.gate && <p className="mt-3 border-t border-line pt-3 text-xs text-ink-2"><span className="font-medium text-ink">Gate: </span>{s.gate}</p>}
            </>
          );
          return (
            <li key={s.slug} className="flex">
              {s.href
                ? <a href={s.href} className="group flex w-full flex-col rounded-2xl border border-line p-5 transition-colors hover:border-[color:var(--border-strong)] hover:bg-[color:var(--surface-card-hover)]">{body}</a>
                : <div className="flex w-full flex-col rounded-2xl border border-line p-5">{body}</div>}
            </li>
          );
        })}
      </ol>
      <FormatPipelines />
    </Chapter>
  );
}

/**
 * The per-format pipelines (lib/pipelines.ts, `gtm pipeline`): which stages are John's, where he reviews them, what an
 * approval authorizes, and that only the final schedules.
 */
function FormatPipelines() {
  return (
    <section aria-label="Pipelines per format" className="mt-8">
      <h3 className="font-display text-pl-lg font-semibold text-ink">Pipelines per format</h3>
      <p className="mt-1 text-sm text-ink-2">/content shows only what goes out (rough cuts, finals). There are no plan or storyboard gates: the agent builds the first draft and John reviews it. Only the final schedules. <span className="font-mono text-xs">gtm pipeline [format] --json</span></p>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {Object.values(PIPELINES).map((p) => (
          <div key={p.format} className="rounded-2xl border border-line p-4">
            <p className="font-medium text-ink">{p.label}</p>
            <ol className="mt-2 flex flex-wrap gap-1.5 text-xs">
              {p.stages.map((s) => (
                <li key={s.key} title={s.does} className={`rounded-full border px-2 py-0.5 ${s.gate === "john" ? "border-violet/40 bg-violet/5 text-violet-strong" : "border-line text-ink-2"}`}>
                  {s.label}{s.gate === "john" ? " · John, /content" : ""}{s.spends ? " · authorizes spend" : ""}{s.final ? " · schedules" : ""}
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- 10. Ten weeks */

const FORMAT_ICON: Record<string, typeof Film> = { video: Film, carousel: LayoutGrid, document: FileText, text: Type, image: ImageIcon, ig_story: ImageIcon };
const DAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const short = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

const CHANNEL_ABBR: Record<string, string> = { linkedin: "LI", instagram: "IG", youtube: "YT", newsletter: "Substack", website: "Site" };
const GRID = "md:grid-cols-[4.5rem_0.55fr_1.3fr_1.3fr_1.3fr_0.8fr_0.55fr_0.55fr]";

export function PlanChapter({ weeks, thumbs = {}, error }: { weeks: PlanWeek[]; thumbs?: Record<string, string>; error?: string }) {
  return (
    <Chapter id="plan" title="The next ten weeks" lead="Live from the calendar, always the ten weeks from this one. Color is the pillar, the icon is the format. Tuesday to Thursday carry the three weekly posts; one piece fanned out to several channels shows once. Review weeks are marked.">
      <div className="mb-6 flex flex-wrap gap-4 text-xs text-ink-2">
        {PILLARS.map((p) => <span key={p.slug} className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: PILLAR_TONE[p.slug] }} />{p.name}</span>)}
        <a href="/calendar" className="ml-auto inline-flex items-center gap-1 text-violet-strong hover:underline">Open the calendar<ArrowUpRight className="size-3.5" /></a>
      </div>
      {error && <p className="mb-6 text-sm text-red-strong">Could not load the calendar: {error}</p>}
      <div className="space-y-2">
        <div className={cn("hidden gap-2 px-2 text-xs text-ink-3 md:grid", GRID)}>
          <span />{DAY.map((d, i) => <span key={d} className={i >= 1 && i <= 3 ? "font-medium text-ink-2" : undefined}>{d}</span>)}
        </div>
        {weeks.map((w) => (
          <div key={w.monday} className={cn("grid gap-2 rounded-xl border border-line p-2", GRID)}>
            <p className="px-1 pt-1 text-xs text-ink-3">{short(w.monday)}<span className="block">{w.count ? `${w.count} piece${w.count === 1 ? "" : "s"}` : "nothing yet"}</span>
              {(w.monday === REVIEW.first_read || w.monday === REVIEW.full_review) && <a href="#stories" className="mt-1 block font-medium text-violet-strong">{w.monday === REVIEW.first_read ? "First read" : "Re-evaluate"}</a>}</p>
            {w.days.map((d, i) => (
              <div key={d.date} className={cn("min-h-12 space-y-1 rounded-lg p-1", i >= 1 && i <= 3 && "md:bg-surface-overlay/50", !d.entries.length && "hidden md:block")}>
                <p className="px-1 text-[0.65rem] text-ink-3 md:hidden">{DAY[i]} {short(d.date)}</p>
                {d.entries.map((e) => {
                  const Icon = FORMAT_ICON[e.formats[0] ?? ""] ?? Type;
                  return (
                    <div key={e.key} title={`${e.title} (${e.statuses.join(", ")})`} className="rounded-md border-l-[3px] bg-[color:var(--surface-base)] px-2 py-1.5 text-[0.72rem] leading-snug shadow-[0_1px_0_var(--border-subtle)]" style={{ borderColor: tone(e.pillar) }}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {(() => { const src = e.thumbs.map((t) => thumbs[t]).find(Boolean); return src ? <img src={src} alt="" loading="lazy" className="mb-1.5 aspect-[4/5] w-full rounded object-cover" /> : null; })()}
                      <span className="line-clamp-2 text-ink">{e.title}</span>
                      <span className="mt-1 flex items-center gap-1 text-[0.65rem] text-ink-3"><Icon className="size-3 shrink-0" />{e.channels.map((c) => CHANNEL_ABBR[c] ?? c).join(" ")}<span className="ml-auto">{e.statuses.length === 1 ? e.statuses[0] : "mixed"}</span></span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        ))}
      </div>
    </Chapter>
  );
}
