// The analytics report document (gtm_analytics_reports.doc): what the weekly-report skill writes and
// /performance/reports/<slug> renders. A small, typed block language rather than free HTML, so a report
// written by an agent always renders in the cockpit's own design system and can never inject markup.
// validateReportDoc is the one gate: `gtm analytics publish` refuses a document it rejects.

export const CONFIDENCE = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCE)[number];
export const TONES = ["good", "bad", "neutral", "warn", "info"] as const;
export type Tone = (typeof TONES)[number];
export const CHANGE_KINDS = ["new", "drop", "keep", "order", "frequency", "format", "fix"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];
export const CHANNELS = ["linkedin", "instagram", "youtube", "tiktok", "substack", "x", "newsletter", "email"] as const;

export type Link = { label: string; url: string };
export type Delta = { value: number; label: string; good: "up" | "down" | "neutral"; unit?: string };
export type Kpi = { label: string; value: number | string | null; unit?: string; note?: string; delta?: Delta; spark?: (number | null)[]; tone?: Tone };
export type Cell = string | number | null | { text: string; url?: string; tone?: Tone };

export type Block =
  | { type: "kpis"; title: string; note?: string; items: Kpi[] }
  | { type: "bars"; title: string; note?: string; unit?: string; items: { label: string; value: number; group?: string; tone?: Tone }[] }
  | { type: "line"; title: string; note?: string; unit?: string; x: string[]; series: { name: string; values: (number | null)[]; dashed?: boolean }[] }
  | { type: "table"; title: string; note?: string; columns: { label: string; align?: "l" | "r" }[]; rows: Cell[][] }
  | { type: "findings"; title: string; note?: string; tone: Tone; items: { title: string; body: string; channel?: string; metrics?: string[]; url?: string }[] }
  | { type: "recommendations"; title: string; note?: string; items: { title: string; body: string; confidence: Confidence; why_confidence?: string; kind?: ChangeKind }[] }
  | { type: "plan"; title: string; note?: string; items: { date: string; title: string; body?: string; channels?: string[]; format?: string; status: "planned" | "open" | "suggested" | "skip"; sources?: Link[] }[] }
  | { type: "callout"; title: string; tone: Tone; body: string; items?: string[] }
  | { type: "text"; title: string; body: string };

export type ReportDoc = {
  version: 1;
  kind: "weekly";
  period: { start: string; end: string };
  title: string;
  headline: string;
  /** Two to five sentences: the short read before the dashboard. */
  summary: string[];
  author?: string;
  blocks: Block[];
  /** Where the numbers and the news came from. */
  sources: Link[];
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BYTES = 400_000;

function isDate(s: unknown): s is string {
  if (typeof s !== "string" || !ISO.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Every problem with a document, as plain lines; an empty list means it can be published. */
export function validateReportDoc(input: unknown): string[] {
  const out: string[] = [];
  const at = (path: string, msg: string) => out.push(`${path}: ${msg}`);
  const str = (v: unknown, path: string, max = 4000, optional = false): v is string => {
    if (v === undefined && optional) return true;
    if (typeof v !== "string" || !v.trim()) { at(path, "must be a non-empty string"); return false; }
    if (v.length > max) at(path, `longer than ${max} characters`);
    return true;
  };
  const num = (v: unknown, path: string, nullable = false) => {
    if (v === null && nullable) return;
    if (typeof v !== "number" || !Number.isFinite(v)) at(path, "must be a finite number");
  };
  const url = (v: unknown, path: string) => {
    if (!str(v, path, 2000)) return;
    try { if (new URL(v as string).protocol !== "https:") at(path, "must be an https URL"); } catch { at(path, "must be a URL"); }
  };
  const oneOf = <T extends string>(v: unknown, list: readonly T[], path: string, optional = false) => {
    if (v === undefined && optional) return;
    if (!list.includes(v as T)) at(path, `must be one of ${list.join(", ")}`);
  };
  const arr = (v: unknown, path: string, min = 0, max = 200): v is unknown[] => {
    if (!Array.isArray(v)) { at(path, "must be a list"); return false; }
    if (v.length < min) at(path, `needs at least ${min}`);
    if (v.length > max) at(path, `at most ${max}`);
    return true;
  };
  const link = (v: unknown, path: string) => {
    const l = v as Link;
    if (!l || typeof l !== "object") return at(path, "must be { label, url }");
    str(l.label, `${path}.label`, 300);
    url(l.url, `${path}.url`);
  };

  if (!input || typeof input !== "object" || Array.isArray(input)) return ["document must be a JSON object"];
  const d = input as ReportDoc;
  if (d.version !== 1) at("version", "must be 1");
  if (d.kind !== "weekly") at("kind", "must be weekly");
  if (!d.period || !isDate(d.period.start) || !isDate(d.period.end)) at("period", "needs start and end as YYYY-MM-DD dates");
  else if (d.period.end < d.period.start) at("period", "ends before it starts");
  str(d.title, "title", 200);
  str(d.headline, "headline", 400);
  str(d.author, "author", 200, true);
  if (arr(d.summary, "summary", 1, 6)) d.summary.forEach((s, i) => str(s, `summary[${i}]`, 600));
  if (arr(d.sources, "sources", 1, 80)) d.sources.forEach((s, i) => link(s, `sources[${i}]`));

  if (arr(d.blocks, "blocks", 1, 40)) d.blocks.forEach((b, i) => {
    const p = `blocks[${i}]`;
    if (!b || typeof b !== "object") return at(p, "must be an object");
    str(b.title, `${p}.title`, 200);
    if ("note" in b) str(b.note, `${p}.note`, 600, true);
    switch (b.type) {
      case "kpis":
        if (arr(b.items, `${p}.items`, 1, 12)) b.items.forEach((k, j) => {
          const q = `${p}.items[${j}]`;
          str(k.label, `${q}.label`, 80);
          if (typeof k.value !== "string") num(k.value, `${q}.value`, true);
          str(k.unit, `${q}.unit`, 40, true);
          str(k.note, `${q}.note`, 200, true);
          oneOf(k.tone, TONES, `${q}.tone`, true);
          if (k.delta !== undefined) {
            num(k.delta?.value, `${q}.delta.value`);
            str(k.delta?.label, `${q}.delta.label`, 80);
            oneOf(k.delta?.good, ["up", "down", "neutral"] as const, `${q}.delta.good`);
          }
          if (k.spark !== undefined && arr(k.spark, `${q}.spark`, 2, 60)) k.spark.forEach((v, m) => num(v, `${q}.spark[${m}]`, true));
        });
        break;
      case "bars":
        str(b.unit, `${p}.unit`, 40, true);
        if (arr(b.items, `${p}.items`, 1, 40)) b.items.forEach((x, j) => {
          str(x.label, `${p}.items[${j}].label`, 120);
          num(x.value, `${p}.items[${j}].value`);
          str(x.group, `${p}.items[${j}].group`, 60, true);
          oneOf(x.tone, TONES, `${p}.items[${j}].tone`, true);
        });
        break;
      case "line":
        str(b.unit, `${p}.unit`, 40, true);
        if (arr(b.x, `${p}.x`, 2, 120)) b.x.forEach((x, j) => str(x, `${p}.x[${j}]`, 40));
        if (arr(b.series, `${p}.series`, 1, 6)) b.series.forEach((s, j) => {
          str(s.name, `${p}.series[${j}].name`, 60);
          if (arr(s.values, `${p}.series[${j}].values`)) {
            if (Array.isArray(b.x) && s.values.length !== b.x.length) at(`${p}.series[${j}].values`, `has ${s.values.length} values for ${b.x.length} x labels`);
            s.values.forEach((v, m) => num(v, `${p}.series[${j}].values[${m}]`, true));
          }
        });
        break;
      case "table":
        if (arr(b.columns, `${p}.columns`, 1, 12)) b.columns.forEach((c, j) => { str(c.label, `${p}.columns[${j}].label`, 60); oneOf(c.align, ["l", "r"] as const, `${p}.columns[${j}].align`, true); });
        if (arr(b.rows, `${p}.rows`, 1, 100)) b.rows.forEach((r, j) => {
          if (!arr(r, `${p}.rows[${j}]`)) return;
          if (Array.isArray(b.columns) && r.length !== b.columns.length) at(`${p}.rows[${j}]`, `has ${r.length} cells for ${b.columns.length} columns`);
          r.forEach((c, m) => {
            const q = `${p}.rows[${j}][${m}]`;
            if (c === null || typeof c === "string") return;
            if (typeof c === "number") return num(c, q);
            if (typeof c === "object") { str(c.text, `${q}.text`, 300); if (c.url !== undefined) url(c.url, `${q}.url`); oneOf(c.tone, TONES, `${q}.tone`, true); return; }
            at(q, "must be text, a number, null or { text, url }");
          });
        });
        break;
      case "findings":
        oneOf(b.tone, TONES, `${p}.tone`);
        if (arr(b.items, `${p}.items`, 1, 20)) b.items.forEach((x, j) => {
          const q = `${p}.items[${j}]`;
          str(x.title, `${q}.title`, 200); str(x.body, `${q}.body`, 1500);
          oneOf(x.channel, CHANNELS, `${q}.channel`, true);
          if (x.metrics !== undefined && arr(x.metrics, `${q}.metrics`, 0, 8)) x.metrics.forEach((m, k) => str(m, `${q}.metrics[${k}]`, 80));
          if (x.url !== undefined) url(x.url, `${q}.url`);
        });
        break;
      case "recommendations":
        if (arr(b.items, `${p}.items`, 1, 20)) b.items.forEach((x, j) => {
          const q = `${p}.items[${j}]`;
          str(x.title, `${q}.title`, 200); str(x.body, `${q}.body`, 1500);
          oneOf(x.confidence, CONFIDENCE, `${q}.confidence`);
          str(x.why_confidence, `${q}.why_confidence`, 400, true);
          oneOf(x.kind, CHANGE_KINDS, `${q}.kind`, true);
        });
        break;
      case "plan":
        if (arr(b.items, `${p}.items`, 1, 21)) b.items.forEach((x, j) => {
          const q = `${p}.items[${j}]`;
          if (!isDate(x.date)) at(`${q}.date`, "must be YYYY-MM-DD");
          str(x.title, `${q}.title`, 200); str(x.body, `${q}.body`, 1500, true); str(x.format, `${q}.format`, 60, true);
          oneOf(x.status, ["planned", "open", "suggested", "skip"] as const, `${q}.status`);
          if (x.channels !== undefined && arr(x.channels, `${q}.channels`, 0, 8)) x.channels.forEach((c, k) => oneOf(c, CHANNELS, `${q}.channels[${k}]`));
          if (x.sources !== undefined && arr(x.sources, `${q}.sources`, 0, 10)) x.sources.forEach((s, k) => link(s, `${q}.sources[${k}]`));
        });
        break;
      case "callout":
        oneOf(b.tone, TONES, `${p}.tone`);
        str(b.body, `${p}.body`, 2000);
        if (b.items !== undefined && arr(b.items, `${p}.items`, 0, 12)) b.items.forEach((s, j) => str(s, `${p}.items[${j}]`, 600));
        break;
      case "text":
        str(b.body, `${p}.body`, 6000);
        break;
      default:
        at(`${p}.type`, "must be kpis, bars, line, table, findings, recommendations, plan, callout or text");
    }
  });

  const json = JSON.stringify(input);
  if (Buffer.byteLength(json) > MAX_BYTES) out.push(`document is larger than ${MAX_BYTES} bytes`);
  // John's voice rule for anything in his name: no em dashes.
  if (json.includes("—")) out.push("contains an em dash; rewrite those lines without it");
  return out;
}

/** The report's URL slug: one weekly report per Monday. */
export const reportSlug = (doc: Pick<ReportDoc, "kind" | "period">) => `${doc.kind}-${doc.period.start}`;
