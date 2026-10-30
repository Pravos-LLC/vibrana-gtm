// CRM people and deals from Twenty: who John is in conversation with, and the opportunities by stage.
// Photos come from Twenty's avatarUrl when it holds a real one; otherwise initials. Company marks are the
// company domain's favicon (only the company domain leaves the page, never a person's details).
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { Contact, Deal } from "@/lib/twenty";
import { cn } from "@/lib/ui/cn";

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

export function Avatar({ name, src, className = "size-10" }: { name: string; src: string | null; className?: string }) {
  return src
    // eslint-disable-next-line @next/next/no-img-element
    ? <img src={src} alt="" referrerPolicy="no-referrer" className={cn("shrink-0 rounded-full object-cover", className)} />
    : <span aria-hidden className={cn("grid shrink-0 place-items-center rounded-full text-xs font-semibold text-white", className)}
        style={{ background: "var(--gradient-prism)" }}>{initials(name)}</span>;
}

export function CompanyMark({ domain, className = "size-4" }: { domain: string | null; className?: string }) {
  if (!domain) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`} alt="" loading="lazy" referrerPolicy="no-referrer" className={cn("shrink-0 rounded-sm", className)} />;
}

const REL: Record<string, string> = { CLIENT: "client", FORMER_CLIENT: "former client", PERSONAL: "personal", PRIOR_CONVERSATION: "prior conversation", COMMUNITY: "community" };
const WARM: Record<string, "destructive" | "warning" | "info"> = { HOT: "destructive", WARM: "warning", MEDIA: "info" };

export function ago(iso: string | null, now = Date.now()) {
  if (!iso) return "";
  const days = Math.floor((now - Date.parse(iso)) / 86400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : days < 14 ? `${days}d ago` : days < 60 ? `${Math.round(days / 7)}w ago` : `${Math.round(days / 30)}mo ago`;
}

export function ConversationList({ contacts }: { contacts: Contact[] }) {
  if (!contacts.length) return <p className="text-sm text-ink-3">No recent conversations in Twenty.</p>;
  return (
    <ul className="divide-y divide-[color:var(--border-default)]">
      {contacts.map((c) => (
        <li key={c.id}>
          <a href={c.url} target="_blank" rel="noreferrer" className="group flex items-center gap-3 py-2.5">
            <Avatar name={c.name} src={c.avatar} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium text-ink group-hover:underline">{c.name}</span>
                {c.warmth && WARM[c.warmth] && <Badge variant={WARM[c.warmth]}>{c.warmth.toLowerCase()}</Badge>}
                {c.relationship && REL[c.relationship] && <Badge variant="outline">{REL[c.relationship]}</Badge>}
              </div>
              <div className="flex items-center gap-1.5 truncate text-xs text-ink-3">
                <CompanyMark domain={c.domain} className="size-3.5" />
                <span className="truncate">{[c.jobTitle, c.company].filter(Boolean).join(" · ") || "No role or company yet"}</span>
              </div>
              {c.nextStep && <div className="truncate text-xs text-ink-2">Next: {c.nextStep}</div>}
            </div>
            <div className="shrink-0 text-right text-xs text-ink-3">
              <div>{ago(c.lastExchangedAt)}</div>
              {c.channel && <div>{c.channel.toLowerCase()}</div>}
            </div>
          </a>
        </li>
      ))}
    </ul>
  );
}

export const STAGES = ["IDENTIFIED", "CONTACTED", "QUALIFIED", "PROPOSAL", "SIGNED", "LOST"] as const;

const money = (n: number, currency: string | null) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "EUR", maximumFractionDigits: 0 }).format(n);

/** Opportunities in stage columns. LOST is left out unless asked for: it is history, not pipeline. */
export function DealBoard({ deals, withLost = false }: { deals: Deal[]; withLost?: boolean }) {
  const stages = STAGES.filter((s) => withLost || s !== "LOST");
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {stages.map((stage) => {
        const list = deals.filter((d) => d.stage === stage);
        return (
          <section key={stage} className="rounded-lg border border-line bg-[color:var(--surface-frost)] p-2">
            <h3 className="mb-2 flex items-baseline justify-between px-1 text-xs font-medium uppercase tracking-wide text-ink-2">
              {stage.toLowerCase()} <span className="tabular-nums text-ink-3">{list.length}</span>
            </h3>
            <div className="space-y-2">
              {list.map((d) => (
                <a key={d.id} href={d.url} target="_blank" rel="noreferrer"
                  className="block rounded-md border border-line bg-[color:var(--surface-card)] p-2 text-sm hover:border-[color:var(--border-strong)]">
                  <div className="flex items-center gap-2">
                    <CompanyMark domain={d.domain} />
                    <span className="truncate font-medium text-ink">{d.name}</span>
                  </div>
                  <div className="mt-1 flex justify-between gap-2 text-xs text-ink-3">
                    <span className="truncate">{d.contact ?? d.company ?? ""}</span>
                    {d.amount != null && <span className="tabular-nums text-ink-2">{money(d.amount, d.currency)}</span>}
                  </div>
                </a>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function CrmError({ message }: { message: string }) {
  return <p className="rounded-md border border-line p-4 text-sm text-ink-2">{message}</p>;
}

export function TwentyLink({ path = "", label = "Open Twenty" }: { path?: string; label?: string }) {
  return (
    <a href={`${process.env.TWENTY_BASE ?? "https://brand.example.com"}${path}`} target="_blank" rel="noreferrer"
      className="inline-flex items-center gap-1 text-xs text-violet-strong underline-offset-2 hover:underline">
      {label} <ExternalLink aria-hidden className="size-3" />
    </a>
  );
}
