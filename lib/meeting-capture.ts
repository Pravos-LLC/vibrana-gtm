// Meeting capture health (VIB-411, meeting-capture spec sections 3.2, 10.2, 10.3). Pure types and rules only:
// the Twenty queries live in lib/twenty.ts, the section renders on /funnel. Absolute counts, never ratios.

export const CAPTURE_OWNERS = ["JOHN", "ABE"] as const;
export type CaptureOwner = (typeof CAPTURE_OWNERS)[number];

/** Error codes in mcrErrors that turn an owner red when non-zero (spec 10.2 continuing property, plus budgetCap). */
export const RED_ERROR_KEYS = ["granolaAuth", "breaker", "UNCERTAIN", "budgetCap"] as const;
export const HEARTBEAT_MAX_HOURS = 26;
/** The capture host writes current alert values into mcrErrors under this prefix (vibrana-crm capture_alert.py, VIB-427). */
export const ALERT_PREFIX = "alert:";
/** Errors on the latest heartbeat with no clean cycle for this long means every cycle is failing (3 cycles of 15 minutes). */
export const FAILING_CYCLES_MINUTES = 45;
export const PENDING_AMBER_DAYS = 14;

/** The latest meetingCaptureRun row for one owner, as stored in the snapshot (counts only, no personal data). */
export type CaptureRun = {
  day: string | null;
  mode: string | null;
  notesSeen: number | null;
  captured: number | null;
  proposalsCreated: number | null;
  proposalsApplied: number | null;
  pendingOldestDays: number | null;
  llmCalls: number | null;
  usd: number | null;
  monthUsd: number | null;
  monthCapUsd: number | null;
  staleOpen: number | null;
  states: Record<string, number>;
  errors: Record<string, number>;
  lastSuccessAt: string | null;
  updatedAt: string | null;
};

export type OwnerCapture = {
  /** PENDING meetingProposals for this owner (totalCount). */
  pending: number | null;
  /** Days the oldest PENDING proposal has been in the queue (by createdAt) at snapshot time. */
  oldestPendingDays: number | null;
  /** Latest heartbeat row; null means the owner has never written one (not onboarded). */
  run: CaptureRun | null;
};

export type CaptureHealth = {
  /** False when Twenty does not know the capture objects or fields yet. */
  installed: boolean;
  /** Objects Twenty does not have (or cannot filter/sort as queried). `meetingCaptureRun` missing means not installed. */
  missing?: string[];
  /** Heartbeat fields Twenty does not have yet (`meetingCaptureRun.mcrMode`); shown as "-" and listed on the page. */
  missingFields?: string[];
  /** A non-schema failure reading capture metrics; the rest of the snapshot is unaffected. */
  error?: string;
  /** `[meeting-capture]` Notes created in the 7 days before the snapshot. */
  notes7d: number | null;
  owners: Record<CaptureOwner, OwnerCapture>;
};

/**
 * The capture health the /funnel card shows: a live read replaces the stored snapshot only when it is clean and installed,
 * because captureHealth() reports a failed read in `error` rather than throwing (VIB-427).
 */
export function pickCapture(live: CaptureHealth | null | undefined, snapshot: CaptureHealth | undefined): { health: CaptureHealth | undefined; live: boolean } {
  return live && !live.error && live.installed ? { health: live, live: true } : { health: snapshot, live: false };
}

/** Rejects after `ms` so a slow source cannot spend the page's whole function budget. */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no answer within ${ms / 1000}s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export const emptyOwner = (): OwnerCapture => ({ pending: null, oldestPendingDays: null, run: null });
export const emptyOwners = (): Record<CaptureOwner, OwnerCapture> => ({ JOHN: emptyOwner(), ABE: emptyOwner() });

export type Flag = { level: "red" | "amber"; text: string };
export type OwnerStatus = { status: "not_onboarded" | "ok" | "amber" | "red"; flags: Flag[]; heartbeatHours: number | null; lastSuccessHours: number | null };

const hoursBetween = (from: string | null, now: Date) => {
  if (!from) return null;
  const t = Date.parse(from);
  return Number.isNaN(t) ? null : (now.getTime() - t) / 3_600_000;
};

/**
 * Red: heartbeat missing or older than 26 hours (row write and last successful cycle), any note seen but in no
 * terminal state for over 24 hours (mcrStaleOpen > 0), or a non-zero granolaAuth / breaker / UNCERTAIN / budgetCap.
 * Also red (VIB-427): any `alert:` key the capture host raised (3 consecutive failed cycles, or one meeting failing with
 * the same error again and again), and errors on a heartbeat whose last clean cycle is 45 minutes or more older than the
 * heartbeat itself (every cycle is failing, whatever the code).
 * Amber: the oldest pending proposal is older than 14 days. An owner with no heartbeat row ever is not onboarded,
 * which is not a failure. `now` is the snapshot time, so the flags describe the moment the snapshot was taken.
 */
export function ownerStatus(o: OwnerCapture, now: Date): OwnerStatus {
  const run = o.run;
  if (!run) return { status: "not_onboarded", flags: [], heartbeatHours: null, lastSuccessHours: null };
  const flags: Flag[] = [];
  const heartbeatHours = hoursBetween(run.updatedAt, now);
  const lastSuccessHours = hoursBetween(run.lastSuccessAt, now);
  if (heartbeatHours == null) flags.push({ level: "red", text: "Heartbeat time missing" });
  else if (heartbeatHours > HEARTBEAT_MAX_HOURS) flags.push({ level: "red", text: `Heartbeat ${Math.floor(heartbeatHours)}h old` });
  if (lastSuccessHours == null) flags.push({ level: "red", text: "No successful cycle recorded" });
  else if (lastSuccessHours > HEARTBEAT_MAX_HOURS) flags.push({ level: "red", text: `Last successful cycle ${Math.floor(lastSuccessHours)}h ago` });
  if ((run.staleOpen ?? 0) > 0) flags.push({ level: "red", text: `${run.staleOpen} note${run.staleOpen === 1 ? "" : "s"} seen but not finished after 24h` });
  for (const k of RED_ERROR_KEYS) {
    const n = run.errors[k] ?? 0;
    if (n > 0) flags.push({ level: "red", text: `${k}: ${n}` });
  }
  const cycles = run.errors[`${ALERT_PREFIX}failingCycles`] ?? 0;
  if (cycles > 0) flags.push({ level: "red", text: `Failing: ${cycles} consecutive cycles ended with an error` });
  const stuck = run.errors[`${ALERT_PREFIX}poisonedPlans`] ?? 0;
  if (stuck > 0) flags.push({ level: "red", text: `${stuck} meeting${stuck === 1 ? "" : "s"} stuck: the same error repeats on every retry` });
  const codes = Object.entries(run.errors).filter(([k, n]) => !k.startsWith(ALERT_PREFIX) && n > 0);
  const updated = run.updatedAt ? Date.parse(run.updatedAt) : NaN;
  const success = run.lastSuccessAt ? Date.parse(run.lastSuccessAt) : NaN;
  if (cycles === 0 && codes.length > 0 && !Number.isNaN(updated) && !Number.isNaN(success) && (updated - success) / 60_000 >= FAILING_CYCLES_MINUTES) {
    flags.push({ level: "red", text: `Every cycle failing since the last clean one (${codes.map(([k, n]) => `${k} ${n}`).join(", ")})` });
  }
  const oldest = Math.max(run.pendingOldestDays ?? 0, o.oldestPendingDays ?? 0);
  if (oldest > PENDING_AMBER_DAYS) flags.push({ level: "amber", text: `Oldest pending proposal ${Math.floor(oldest)} days` });
  const status = flags.some((f) => f.level === "red") ? "red" : flags.length ? "amber" : "ok";
  return { status, flags, heartbeatHours, lastSuccessHours };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** RAW_JSON comes back as an object, or occasionally a JSON string. Keeps numeric entries only. */
export function countMap(v: unknown): Record<string, number> {
  let o = v;
  if (typeof o === "string") {
    try { o = JSON.parse(o); } catch { return {}; }
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return {};
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(o as Record<string, unknown>)) {
    const n = num(x);
    if (n != null) out[k] = n;
  }
  return out;
}

/** Maps a Twenty meetingCaptureRun node onto the stored shape. */
export function toRun(n: Record<string, unknown>): CaptureRun {
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    day: str(n.mcrDay), mode: str(n.mcrMode),
    notesSeen: num(n.mcrNotesSeen), captured: num(n.mcrCaptured),
    proposalsCreated: num(n.mcrProposalsCreated), proposalsApplied: num(n.mcrProposalsApplied),
    pendingOldestDays: num(n.mcrPendingOldestDays), llmCalls: num(n.mcrLlmCalls),
    usd: num(n.mcrUsd), monthUsd: num(n.mcrMonthUsd), monthCapUsd: num(n.mcrMonthCapUsd), staleOpen: num(n.mcrStaleOpen),
    states: countMap(n.mcrStates), errors: countMap(n.mcrErrors),
    lastSuccessAt: str(n.mcrLastSuccessAt), updatedAt: str(n.updatedAt),
  };
}

/**
 * Classifies GraphQL errors that mean "Twenty has no such object or field yet", as opposed to an outage or a value
 * mismatch (an unknown enum value is an error, not "not installed"). Returns null unless every error is a schema miss.
 * `objectMissing`: the root object, or a field the query filters or sorts on, is unknown, so the object is unusable.
 * `fields`: selected fields Twenty does not have; the query can be retried without them.
 */
export function schemaMiss(errors: unknown): { objectMissing: boolean; fields: string[] } | null {
  if (!Array.isArray(errors) || errors.length === 0) return null;
  let objectMissing = false;
  const fields: string[] = [];
  for (const e of errors) {
    const msg = String((e as { message?: unknown })?.message ?? "");
    const sel = /Cannot query field "([^"]+)" on type "([^"]+)"/.exec(msg);
    if (sel) {
      if (sel[2] === "Query") objectMissing = true;
      else fields.push(sel[1]);
      continue;
    }
    if (/Field "[^"]+" is not defined by type "[^"]*(Filter|OrderBy)[^"]*"/.test(msg)) { objectMissing = true; continue; }
    return null;
  }
  return { objectMissing, fields };
}
