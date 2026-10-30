import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Eyebrow } from "@/components/brand";
import { Section } from "@/components/shell";
import { CAPTURE_OWNERS, HEARTBEAT_MAX_HOURS, ownerStatus, type CaptureHealth, type CaptureOwner, type OwnerCapture } from "@/lib/meeting-capture";

const OWNER_LABEL: Record<CaptureOwner, string> = { JOHN: "John", ABE: "Abe" };
const n = (v: number | null | undefined) => (v == null ? "-" : v.toLocaleString());
const usd = (v: number | null | undefined) => (v == null ? "-" : `$${v.toFixed(2)}`);
const age = (h: number | null) => (h == null ? "never" : h < 1 ? `${Math.round(h * 60)}m ago` : h < 48 ? `${Math.floor(h)}h ago` : `${Math.floor(h / 24)}d ago`);

function Stat({ label, value, tone }: { label: string; value: string; tone?: "red" | "amber" }) {
  return (
    <div>
      <div className="text-xs text-ink-3">{label}</div>
      <div className={`mt-1 tabular-nums ${tone === "red" ? "text-red-strong" : tone === "amber" ? "text-amber-strong" : "text-ink"}`}>{value}</div>
    </div>
  );
}

function OwnerCard({ owner, data, at }: { owner: CaptureOwner; data: OwnerCapture; at: Date }) {
  const s = ownerStatus(data, at);
  const r = data.run;
  const badge = s.status === "red" ? <Badge variant="destructive">Needs attention</Badge>
    : s.status === "amber" ? <Badge variant="warning">Check queue</Badge>
    : s.status === "ok" ? <Badge variant="success">Healthy</Badge>
    : <Badge variant="outline">Not onboarded</Badge>;
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3">
        <Eyebrow>{OWNER_LABEL[owner]}</Eyebrow>
        <div className="flex items-center gap-2">
          {r?.mode && <Badge variant={r.mode === "live" ? "info" : "outline"}>{r.mode}</Badge>}
          {badge}
        </div>
      </div>
      {!r ? (
        <p className="mt-4 text-sm text-ink-3">
          No heartbeat row yet. Capture has not run for this owner. Pending proposals: {n(data.pending)}.
        </p>
      ) : (
        <>
          {s.flags.length > 0 && (
            <ul className="mt-4 space-y-1 text-sm">
              {s.flags.map((f) => (
                <li key={f.text} className={f.level === "red" ? "text-red-strong" : "text-amber-strong"}>{f.text}</li>
              ))}
            </ul>
          )}
          <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
            <Stat label="Last heartbeat" value={age(s.heartbeatHours)} tone={s.heartbeatHours == null || s.heartbeatHours > HEARTBEAT_MAX_HOURS ? "red" : undefined} />
            <Stat label="Last success" value={age(s.lastSuccessHours)} tone={s.lastSuccessHours == null || s.lastSuccessHours > HEARTBEAT_MAX_HOURS ? "red" : undefined} />
            <Stat label="Day (UTC)" value={r.day ?? "-"} />
            <Stat label="Stale open" value={n(r.staleOpen)} tone={(r.staleOpen ?? 0) > 0 ? "red" : undefined} />
            <Stat label="Notes seen" value={n(r.notesSeen)} />
            <Stat label="Captured" value={n(r.captured)} />
            <Stat label="LLM calls" value={n(r.llmCalls)} />
            <Stat label="Spend (day)" value={usd(r.usd)} />
            <Stat label="Month to date" value={`${usd(r.monthUsd)} of ${usd(r.monthCapUsd)}`} />
            <Stat label="Proposals made / applied" value={`${n(r.proposalsCreated)} / ${n(r.proposalsApplied)}`} />
            <Stat label="Pending proposals" value={n(data.pending)} />
            <Stat label="Oldest pending" value={data.oldestPendingDays == null && r.pendingOldestDays == null ? "-" : `${Math.max(data.oldestPendingDays ?? 0, r.pendingOldestDays ?? 0)} days`}
              tone={s.flags.some((f) => f.level === "amber") ? "amber" : undefined} />
          </div>
          <div className="mt-4 text-xs text-ink-3">
            <span className="mr-2">States:</span>
            {Object.keys(r.states).length === 0 ? "none" : Object.entries(r.states).map(([k, v]) => `${k} ${v}`).join(" · ")}
            {Object.keys(r.errors).length > 0 && (
              <span className="ml-4">Errors: {Object.entries(r.errors).map(([k, v]) => `${k} ${v}`).join(" · ")}</span>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

/** Read-only health of meeting capture (spec 10.3). Flags are evaluated at the read time (live) or the snapshot time. */
export function MeetingCaptureSection({ health, capturedAt, live = false }: { health: CaptureHealth | undefined; capturedAt: string | undefined; live?: boolean }) {
  if (!health) {
    return (
      <Section title="Meeting capture">
        <p className="text-sm text-ink-3">No capture metrics in the latest snapshot. They appear after the next <code>gtm sync</code>.</p>
      </Section>
    );
  }
  if (!health.installed) {
    return (
      <Section title="Meeting capture" note={health.missing?.length ? `Twenty has no ${health.missing.join(", ")}` : undefined}>
        <p className="text-sm text-ink-3">Meeting capture not installed.</p>
        {health.error && <p className="mt-2 text-sm text-red-strong">Some capture metrics could not be read: {health.error}</p>}
      </Section>
    );
  }
  const at = capturedAt ? new Date(capturedAt) : new Date();
  const snapHours = (Date.now() - at.getTime()) / 3_600_000;
  return (
    <Section title="Meeting capture" note={`${n(health.notes7d)} capture notes in 7 days · ${live ? "live from Twenty" : "daily snapshot"}`}>
      {health.error && <p className="mb-3 text-sm text-red-strong">Some capture metrics could not be read: {health.error}</p>}
      {health.missing?.length ? <p className="mb-3 text-sm text-amber-strong">Twenty has no {health.missing.join(", ")} yet, so those counts show as "-".</p> : null}
      {health.missingFields?.length ? <p className="mb-3 text-sm text-amber-strong">Twenty is missing heartbeat fields {health.missingFields.join(", ")}; they show as "-".</p> : null}
      {snapHours > HEARTBEAT_MAX_HOURS && (
        <p className="mb-3 text-sm text-amber-strong">This snapshot is {Math.floor(snapHours)}h old. Flags describe the moment it was taken.</p>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {CAPTURE_OWNERS.map((o) => <OwnerCard key={o} owner={o} data={health.owners[o]} at={at} />)}
      </div>
    </Section>
  );
}
