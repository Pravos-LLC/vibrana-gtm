"use client";

// The writing desk's right pane: everything we hold on one person, scannable, and John's own profile and gold examples
// for reference. Read only, except "Use this version" on an earlier desk text and the copy-link buttons. Any field of
// the dossier may be missing; a section with nothing in it is left out. A guest's dossier (track 'guest') gets its own
// layout after "Who": pillar, template, the dated trigger, the angle and questions, the warm path, and the approach and
// protocol notes up front. Both streams warn when the export is more than 3 days old.
import { Fragment, useState } from "react";
import { AlertTriangle, CheckCircle2, Copy, ExternalLink, UserRound, Mail, Globe, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toaster";
import { cn } from "@/lib/ui/cn";
import { DESK_VARIANT, exportAgeDays, exportIsStale, guestReach, guestRoute, ROUTE_LABEL, safeUrl, STALE_DAYS, TEMPLATE_LABEL, type Dossier, type Profile } from "@/lib/outreach/desk";
import type { DeskPerson } from "@/lib/outreach/desk-store";
import type { Draft, DraftVersion } from "@/lib/outreach/model";

const link = "text-violet-strong underline-offset-4 hover:underline";
const has = (v: unknown) => (Array.isArray(v) ? v.length > 0 : typeof v === "string" ? v.trim() !== "" : v != null);
const when = (iso?: string | null) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

export const copy = (label: string, text: string) => {
  void navigator.clipboard?.writeText(text).then(() => toast(`${label} copied.`), () => toast(`Could not copy the ${label.toLowerCase()}.`));
};

function Ext({ href, children, className }: { href: string | null | undefined; children: React.ReactNode; className?: string }) {
  const u = safeUrl(href);
  if (!u) return <>{children}</>;
  return <a href={u} target="_blank" rel="noreferrer" className={cn(link, className)}>{children}<ExternalLink className="ml-0.5 inline size-3" /></a>;
}

function Section({ title, children, note, testid }: { title: string; children: React.ReactNode; note?: string; testid?: string }) {
  return (
    <section className="space-y-2 border-t border-line pt-3 first:border-t-0 first:pt-0" data-testid={testid}>
      <h3 className="flex items-baseline justify-between gap-2 text-xs font-medium uppercase tracking-wide text-ink-3">
        <span>{title}</span>{note && <span className="normal-case tracking-normal">{note}</span>}
      </h3>
      {children}
    </section>
  );
}


/**
 * Where to reach a guest, as links: LinkedIn, their email, the organization's address, their site, the page to write to. What the
 * dossier does not hold shows as a search link instead, so a name is never a dead end. Used above the composer and in the dossier.
 */
export function ReachLinks({ dossier, name, company, note }: { dossier: Dossier; name: string; company: string; note?: boolean }) {
  const links = guestReach(dossier, name, company);
  const g = dossier.guest ?? {};
  const icon = (k: string) => (k === "linkedin" ? <UserRound className="size-3.5" /> : k === "email" || k === "org_email" ? <Mail className="size-3.5" /> : k === "search" ? <Search className="size-3.5" /> : <Globe className="size-3.5" />);
  return (
    <div className="space-y-1.5" data-testid="desk-reach">
      <div className="flex flex-wrap gap-1.5">
        {links.map((l) => (
          <span key={`${l.kind}-${l.href}`} className={cn("inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs", l.found ? "border-violet/40 bg-violet/10 text-ink" : "border-dashed border-line text-ink-2")}>
            <a href={l.href} target={l.href.startsWith("mailto:") ? undefined : "_blank"} rel="noreferrer" className="inline-flex items-center gap-1 hover:underline" data-testid={`reach-${l.kind}`}>{icon(l.kind)}{l.label}</a>
            {l.copy && <button type="button" aria-label={`Copy ${l.label}`} className="text-ink-3 hover:text-ink" onClick={() => copy(l.label, l.copy!)}><Copy className="size-3" /></button>}
          </span>
        ))}
      </div>
      {note && (g.contact_note || (g.contact_confidence && g.contact_confidence !== "verified")) && (
        <p className="text-xs text-ink-3">{[g.contact_note, g.contact_confidence && g.contact_confidence !== "verified" ? `Contact details: ${g.contact_confidence}` : null].filter(Boolean).join(" · ")}</p>
      )}
    </div>
  );
}

function Fold({ summary, children, className, open }: { summary: React.ReactNode; children: React.ReactNode; className?: string; open?: boolean }) {
  return (
    <details className={cn("group rounded-md border border-line px-3 py-2", className)} open={open}>
      <summary className="cursor-pointer text-sm text-ink marker:text-ink-3">{summary}</summary>
      <div className="pt-2">{children}</div>
    </details>
  );
}

export function DeskDossier({ person, profile, onRestore }: { person: DeskPerson; profile: Profile; onRestore: (v: DraftVersion) => void }) {
  const [tab, setTab] = useState<"dossier" | "profile">("dossier");
  const tabClass = (on: boolean) => cn("rounded-full border px-3 py-1 text-xs", on ? "border-violet bg-violet/10 text-ink" : "border-line text-ink-2 hover:text-ink");
  return (
    <div className="space-y-4">
      <div className="flex gap-2" role="tablist" aria-label="Reference">
        <button type="button" role="tab" aria-selected={tab === "dossier"} className={tabClass(tab === "dossier")} onClick={() => setTab("dossier")}>Dossier</button>
        <button type="button" role="tab" aria-selected={tab === "profile"} className={tabClass(tab === "profile")} onClick={() => setTab("profile")}>Your profile and examples</button>
      </div>
      {tab === "dossier" ? <DossierView person={person} onRestore={onRestore} /> : <ProfileView profile={profile} />}
    </div>
  );
}

function DossierView({ person, onRestore }: { person: DeskPerson; onRestore: (v: DraftVersion) => void }) {
  const d: Dossier = person.row.dossier ?? { twenty_person_id: person.row.twenty_person_id };
  const p = d.prospect ?? {};
  const c = d.company ?? {};
  const s = d.signal ?? {};
  const b = d.brief;
  const check = d.client_check;
  const sources = (d.sources ?? []).filter(Boolean);
  const sourceById = new Map(sources.map((x) => [x.id ?? "", x]));
  const employees = p.employees ?? c.employees;
  const where = [p.city, p.country ?? c.country].filter(has).join(", ");
  const aiDrafts = person.reference.filter((r) => r.variant !== DESK_VARIANT);
  const own = person.reference.filter((r) => r.variant === DESK_VARIANT);
  const isGuest = d.track === "guest" || person.row.track === "guest";
  const builtAt = person.row.built_at ?? d.built_at;
  const age = exportAgeDays(builtAt);

  return (
    <div className="space-y-4 text-sm" data-testid="desk-dossier">
      {exportIsStale(builtAt) && (
        <div role="status" className="flex gap-2 rounded-md border border-[color:var(--amber)]/40 bg-[color:var(--amber)]/10 p-3 text-amber-strong" data-testid="export-stale">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>This export is {age} days old (built {when(builtAt)}). Re-export before you send: facts, status and client checks may have moved on since it was built (stale after {STALE_DAYS} days).</p>
        </div>
      )}
      {check?.ok === false && (
        <div role="alert" className="flex gap-2 rounded-md border border-[color:var(--red,#dc2626)]/40 bg-destructive/10 p-3 text-red-strong" data-testid="client-check">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div><p className="font-medium">Client check did not pass. Read why before you write.</p>{check.reason && <p className="text-xs">{check.reason}</p>}</div>
        </div>
      )}

      <Section title="Who">
        <div className="space-y-1">
          <p className="font-display text-base font-semibold text-ink">{person.row.name || person.row.twenty_person_id}</p>
          <p className="text-ink-2">{[p.title, p.company ?? c.name].filter(has).join(", ")}</p>
          <div className="flex flex-wrap gap-1.5">
            {employees != null && String(employees) !== "" && <Badge variant="outline">{String(employees)} people</Badge>}
            {where && <Badge variant="outline">{where}</Badge>}
            {has(p.industry ?? c.industry) && <Badge variant="outline">{p.industry ?? c.industry}</Badge>}
            {has(p.lane) && <Badge variant="outline">{p.lane}</Badge>}
            {p.score != null && <Badge variant="outline" title="Prospect score">Score {p.score}</Badge>}
            {check?.ok === true && <Badge variant="success" title={check.checked_at ? `Checked ${when(check.checked_at)}` : undefined}><CheckCircle2 className="mr-1 size-3" />Client check passed</Badge>}
            {check == null && <Badge variant="outline">Client check: none</Badge>}
          </div>
          <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {safeUrl(p.linkedin_url) && <Ext href={p.linkedin_url}>LinkedIn</Ext>}
            {person.row.domain && !person.row.domain.endsWith(".guest.invalid") && <Ext href={`https://${person.row.domain}`}>{person.row.domain}</Ext>}
            {p.email && <span className="font-mono text-ink-3">{p.email}</span>}
          </p>
        </div>
      </Section>

      {isGuest && <GuestView d={d} name={person.row.name} company={person.row.company} />}

      {!isGuest && (has(s.text) || has(s.url)) && (
        <Section title="Signal" note={[s.type, when(s.date)].filter(Boolean).join(" · ")} testid="desk-signal">
          <p className="whitespace-pre-wrap text-ink">{s.text}</p>
          {safeUrl(s.url) && <p className="text-xs"><Ext href={s.url}>{host(s.url!)}</Ext></p>}
        </Section>
      )}

      {d.person && (has(d.person.headline) || has(d.person.about) || has(d.person.recent_posts)) && (
        <Section title="On LinkedIn">
          {has(d.person.headline) && <p className="text-ink">{d.person.headline}</p>}
          {has(d.person.about) && <Fold summary="About"><p className="whitespace-pre-wrap text-ink-2">{d.person.about}</p></Fold>}
          {(d.person.recent_posts ?? []).map((post, n) => (
            <Fold key={n} summary={<span>{when(post.date) ?? "Post"} <span className="text-ink-3">{(post.text ?? "").slice(0, 80)}{(post.text ?? "").length > 80 ? "..." : ""}</span></span>}>
              <p className="whitespace-pre-wrap text-ink-2">{post.text}</p>
              {safeUrl(post.url) && <p className="pt-1 text-xs"><Ext href={post.url}>Open the post</Ext></p>}
            </Fold>
          ))}
        </Section>
      )}

      {b && (
        <Section title="Research notes (AI)" note={b.model ?? undefined} testid="desk-brief">
          <p className="text-xs text-ink-3">An agent wrote these from the sources below. Check anything you use against its source.</p>
          <dl className="space-y-2.5">
            {has(b.problem) && <div><dt className="text-xs text-ink-3">Their problem</dt><dd className="whitespace-pre-wrap text-ink">{b.problem}</dd></div>}
            {has(b.problem_quote?.text) && (
              <div><dt className="text-xs text-ink-3">In their words</dt>
                <dd><blockquote className="border-l-2 border-violet/40 pl-2.5 italic text-ink">{b.problem_quote!.text}</blockquote>
                  {b.problem_quote!.source_id && <p className="pt-0.5 text-xs text-ink-3">Source {b.problem_quote!.source_id}{safeUrl(sourceById.get(b.problem_quote!.source_id)?.url) && <> · <Ext href={sourceById.get(b.problem_quote!.source_id)!.url}>{host(sourceById.get(b.problem_quote!.source_id)!.url!)}</Ext></>}</p>}
                </dd>
              </div>
            )}
            {has(b.why_now) && <div><dt className="text-xs text-ink-3">Why now</dt><dd className="whitespace-pre-wrap text-ink">{b.why_now}</dd></div>}
            {has(b.how_john_helps) && <div><dt className="text-xs text-ink-3">How you can help</dt><dd><ul className="list-disc space-y-1 pl-4 text-ink">{b.how_john_helps!.map((h, n) => <li key={h.id ?? n}>{h.text}{h.id && <span className="ml-1 font-mono text-xs text-ink-3">{h.id}</span>}</li>)}</ul></dd></div>}
            {has(b.door_questions) && <div><dt className="text-xs text-ink-3">Questions that open a door</dt><dd><ul className="list-disc space-y-1 pl-4 text-ink">{b.door_questions!.map((q, n) => <li key={n}>{q}</li>)}</ul></dd></div>}
            {b.asset && (has(b.asset.label) || has(b.asset.url)) && (
              <div><dt className="text-xs text-ink-3">Asset to offer</dt>
                <dd className="flex flex-wrap items-center gap-2 text-ink">{b.asset.label ?? b.asset.id}
                  {safeUrl(b.asset.url) && <><Ext href={b.asset.url} className="text-xs">open</Ext><Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => copy("Link", b.asset!.url!)}><Copy /> Copy link</Button></>}
                </dd>
              </div>
            )}
            {has(b.recipient_note) && <div><dt className="text-xs text-ink-3">About the reader</dt><dd className="whitespace-pre-wrap text-ink-2">{b.recipient_note}</dd></div>}
          </dl>
        </Section>
      )}

      {(has(c.description) || has(c.technologies) || c.ai_native != null) && (
        <Section title="Company">
          {has(c.description) && <p className="whitespace-pre-wrap text-ink-2">{c.description}</p>}
          <div className="flex flex-wrap gap-1.5">
            {c.ai_native != null && <Badge variant="outline">{c.ai_native ? "AI native" : "Not AI native"}</Badge>}
            {(c.technologies ?? []).slice(0, 24).map((t) => <Badge key={t} variant="outline">{t}</Badge>)}
          </div>
        </Section>
      )}

      {has(d.triggers) && (
        <Section title={`Triggers (${d.triggers!.length})`}>
          <ul className="space-y-2">
            {d.triggers!.map((t, n) => (
              <li key={n}>
                <p className="text-xs text-ink-3">{[t.family, t.subtype].filter(Boolean).join(" / ")}{t.event_date ? ` · ${when(t.event_date)}` : ""}</p>
                <p className="text-ink">{t.summary}</p>
                {safeUrl(t.source_url) && <p className="text-xs"><Ext href={t.source_url}>{host(t.source_url!)}</Ext></p>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {sources.length > 0 && (
        <Section title={`Sources (${sources.length})`} testid="desk-sources">
          <div className="space-y-2">
            {sources.map((src, n) => (
              <Fold key={src.id ?? n} summary={<span><span className="mr-1 font-mono text-xs text-ink-3">{src.id ?? `S${n + 1}`}</span>{src.title || (src.url ? host(src.url) : "Untitled")}</span>}>
                <p className="pb-1 text-xs text-ink-3">{[src.via, when(src.published)].filter(Boolean).join(" · ")}{safeUrl(src.url) && <> · <Ext href={src.url}>{host(src.url!)}</Ext></>}</p>
                {has(src.text) ? <p className="max-h-80 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-ink-2">{src.text}</p> : <p className="text-xs text-ink-3">No text was read from this page.</p>}
              </Fold>
            ))}
          </div>
        </Section>
      )}

      {has(d.colleagues) && (
        <Section title={`Colleagues (${d.colleagues!.length})`}>
          <ul className="space-y-1.5">
            {d.colleagues!.map((col, n) => (
              <li key={n} className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-ink">{col.name}</span><span className="text-xs text-ink-2">{col.title}</span>
                {safeUrl(col.linkedin_url) && <Ext href={col.linkedin_url} className="text-xs">LinkedIn</Ext>}
                {col.email && <span className="font-mono text-xs text-ink-3">{col.email}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {has(d.history) && (
        <Section title="History">
          <ul className="space-y-1.5">
            {d.history!.map((h, n) => <li key={n}><span className="text-xs text-ink-3">{[h.channel, when(h.date)].filter(Boolean).join(" · ")}</span><p className="text-ink">{h.summary}</p></li>)}
          </ul>
        </Section>
      )}

      {own.length > 0 && (
        <Section title="Your earlier rewrites">
          {own.map((r) => <DraftFold key={r.id} draft={r} label={`Your rewrite (${r.batch})`} />)}
        </Section>
      )}

      {aiDrafts.length > 0 && (
        <Section title="AI drafts (reference only)" testid="desk-ai-drafts">
          <div className="space-y-2">{aiDrafts.map((r) => <DraftFold key={r.id} draft={r} label={`${r.variant}${r.model && r.model !== r.variant ? ` (${r.model})` : ""} · ${r.batch}`} />)}</div>
        </Section>
      )}

      {person.versions.length > 0 && (
        <Section title={`Earlier versions of your text (${person.versions.length})`}>
          <div className="space-y-2">
            {person.versions.map((v) => (
              <Fold key={v.id} summary={<span className="text-xs">{new Date(v.created_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })} <span className="text-ink-3">{v.subject || "(no subject)"}</span></span>}>
                <p className="whitespace-pre-wrap text-xs text-ink-2">{v.body}</p>
                <Button size="sm" variant="ghost" className="mt-1 h-7" onClick={() => onRestore(v)}>Use this version</Button>
              </Fold>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

/** The guest block of a podcast-guest dossier: what to know before writing the invite. Every field may be missing. */
function GuestView({ d, name, company }: { d: Dossier; name: string; company: string }) {
  const g = d.guest ?? {};
  const s = d.signal ?? {};
  const prompts = (g.prompts ?? []).filter(has);
  // Community-rooted guests: the approach and protocol notes come first, because they change how (and whether) to write.
  const care = [g.approach_note, g.protocol_note].filter(has);
  const trigger = g.trigger ?? s.text;
  const triggerUrl = g.trigger_url ?? s.url;
  const dated = when(s.date);
  const template = g.template ? `${g.template} ${TEMPLATE_LABEL[g.template] ?? ""}`.trim() : null;
  const facts = [g.season && `Season ${g.season}`, g.tier && `Tier ${g.tier}`, g.lane, g.pillar, template && `Template ${template}`, ROUTE_LABEL[guestRoute(d)], g.channel].filter(has);
  return (
    <div className="space-y-4" data-testid="desk-guest">
      <Section title="Reach them"><ReachLinks dossier={d} name={name} company={company} note /></Section>
      {care.length > 0 && (
        <div className="space-y-2 rounded-md border border-violet/40 bg-violet/5 p-3" data-testid="desk-protocol">
          <h3 className="text-xs font-medium uppercase tracking-wide text-ink-3">How to approach</h3>
          {has(g.approach_note) && <p className="whitespace-pre-wrap text-ink">{g.approach_note}</p>}
          {has(g.protocol_note) && <p className="whitespace-pre-wrap text-ink">{g.protocol_note}</p>}
        </div>
      )}
      {facts.length > 0 && <div className="flex flex-wrap gap-1.5">{facts.map((f) => <Badge key={String(f)} variant="outline">{String(f)}</Badge>)}</div>}
      {(has(trigger) || has(triggerUrl)) && (
        <Section title="Trigger" note={[dated, s.type && s.type !== "guest_trigger" ? s.type : null].filter(Boolean).join(" · ")} testid="desk-signal">
          {has(trigger) && <p className="whitespace-pre-wrap text-ink">{trigger}</p>}
          {safeUrl(triggerUrl) && <p className="text-xs"><Ext href={triggerUrl}>{host(triggerUrl!)}</Ext></p>}
          {has(g.backup_trigger) && <p className="text-xs text-ink-2"><span className="text-ink-3">Backup: </span>{g.backup_trigger}</p>}
        </Section>
      )}
      {has(g.wisdom_angle) && <Section title="Wisdom angle"><p className="whitespace-pre-wrap text-ink">{g.wisdom_angle}</p></Section>}
      {has(g.central_question) && <Section title="Central question"><p className="whitespace-pre-wrap text-ink">{g.central_question}</p></Section>}
      {prompts.length > 0 && <Section title="Prompts"><ol className="list-decimal space-y-1 pl-4 text-ink">{prompts.map((p, n) => <li key={n}>{p}</li>)}</ol></Section>}
      {has(g.warm_path) && <Section title="Warm path"><p className="whitespace-pre-wrap text-ink">{g.warm_path}</p></Section>}
      {has(g.representation) && <Section title="Representation"><p className="whitespace-pre-wrap text-ink-2">{g.representation}</p></Section>}
      {has(g.contact_line) && <Section title="Contact"><p className="whitespace-pre-wrap text-ink">{g.contact_line}</p></Section>}
    </div>
  );
}

function DraftFold({ draft, label }: { draft: Draft; label: string }) {
  return (
    <Fold summary={<span className="text-xs">{label}</span>}>
      <p className="pb-1 text-sm font-medium text-ink">{draft.subject}</p>
      <p className="whitespace-pre-wrap text-xs leading-relaxed text-ink-2">{draft.body}</p>
      {draft.linkedin_note && <p className="pt-2 text-xs text-ink-3">LinkedIn note: {draft.linkedin_note}</p>}
    </Fold>
  );
}

function ProfileView({ profile }: { profile: Profile }) {
  if (!Object.keys(profile).length) return <p className="text-sm text-ink-2">No profile yet. Load it with <code>gtm outreach import-profile --file outreach_profile.json</code>.</p>;
  return (
    <div className="space-y-4 text-sm" data-testid="desk-profile">
      {has(profile.positioning) && <Section title="Positioning"><p className="whitespace-pre-wrap text-ink">{profile.positioning}</p></Section>}
      {has(profile.gold_examples) && (
        <Section title="Your gold examples">
          <div className="space-y-2">
            {profile.gold_examples!.map((g, n) => (
              <Fold key={n} open={n === 0} summary={<span>{g.subject || `Example ${n + 1}`}</span>}>
                {g.note && <p className="pb-1 text-xs text-ink-3">{g.note}</p>}
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{g.body}</p>
              </Fold>
            ))}
          </div>
        </Section>
      )}
      {has(profile.facts) && (
        <Section title="Facts you can state">
          <ul className="space-y-1.5">{profile.facts!.map((f, n) => <li key={f.id ?? n} className="text-ink">{f.text}{f.source && <span className="block text-xs text-ink-3">{f.source}</span>}</li>)}</ul>
        </Section>
      )}
      {has(profile.proof) && (
        <Section title="Proof">
          <ul className="space-y-2">{profile.proof!.map((x, n) => (
            <li key={x.id ?? n}><p className="text-ink">{x.text}</p>
              {safeUrl(x.url) && <p className="flex items-center gap-2 text-xs"><Ext href={x.url}>{host(x.url!)}</Ext><Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => copy("Link", x.url!)}><Copy /> Copy link</Button></p>}
            </li>
          ))}</ul>
        </Section>
      )}
      {has(profile.assets) && (
        <Section title="Assets">
          <ul className="space-y-2" data-testid="desk-assets">{profile.assets!.map((a, n) => (
            <li key={a.id ?? n} className="space-y-0.5">
              <p className="font-medium text-ink">{a.name}</p>
              {a.pitch && <p className="text-xs text-ink-2">{a.pitch}</p>}
              {safeUrl(a.url) && <p className="flex items-center gap-2 text-xs"><Ext href={a.url}>{host(a.url!)}</Ext><Button size="sm" variant="ghost" className="h-6 px-2" aria-label={`Copy link: ${a.name ?? a.url}`} onClick={() => copy("Link", a.url!)}><Copy /> Copy link</Button></p>}
            </li>
          ))}</ul>
        </Section>
      )}
      {profile.podcast_history && (has(profile.podcast_history.summary) || has(profile.podcast_history.shows) || has(profile.podcast_history.notable_guests)) && (
        <Section title="Your podcasting history" testid="desk-podcast-history">
          {has(profile.podcast_history.summary) && <p className="whitespace-pre-wrap text-ink">{profile.podcast_history.summary}</p>}
          {has(profile.podcast_history.shows) && <ul className="list-disc space-y-1 pl-4 text-ink">{profile.podcast_history.shows!.map((x, n) => <li key={n}>{[x.name, x.language, x.host && `host ${x.host}`].filter(has).join(", ")}{x.note && <span className="block text-xs text-ink-3">{x.note}</span>}{safeUrl(x.url) && <Ext href={x.url} className="text-xs">{host(x.url!)}</Ext>}</li>)}</ul>}
          {has(profile.podcast_history.notable_guests) && (
            <Fold summary={<span className="text-xs">Notable guests ({profile.podcast_history.notable_guests!.length}{profile.podcast_history.guest_count ? ` of ${profile.podcast_history.guest_count}` : ""})</span>}>
              <ul className="space-y-1 text-xs text-ink-2">{profile.podcast_history.notable_guests!.map((x, n) => <li key={n}><span className="text-ink">{x.name}</span>{x.role ? `, ${x.role}` : ""}{x.episode ? ` · ${x.episode}` : ""} {safeUrl(x.url) && <Ext href={x.url}>episode</Ext>}</li>)}</ul>
            </Fold>
          )}
          {has(profile.podcast_history.source) && <p className="text-xs text-ink-3">{profile.podcast_history.source}</p>}
        </Section>
      )}
      {has(profile.asks) && <Section title="Asks"><ul className="list-disc space-y-1 pl-4 text-ink">{profile.asks!.map((a, n) => <li key={n}>{a}</li>)}</ul></Section>}
      {has(profile.voice) && <Section title="Voice"><ul className="list-disc space-y-1 pl-4 text-ink-2">{profile.voice!.map((a, n) => <li key={n}>{a}</li>)}</ul></Section>}
      {has(profile.signature) && <Section title="Signature"><p className="whitespace-pre-wrap font-mono text-xs text-ink-2">{profile.signature}</p></Section>}
      {has(profile.point_of_view) && (
        <Section title="Point of view"><ul className="list-disc space-y-1 pl-4 text-ink-2">{profile.point_of_view!.map((a, n) => <Fragment key={n}><li>{a}</li></Fragment>)}</ul></Section>
      )}
    </div>
  );
}
