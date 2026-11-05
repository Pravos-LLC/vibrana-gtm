// Reads YouTube Studio export zips or extracted folders (Content, Traffic source, Geography) into rows for gtm_yt_*.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseContentChart, parseContentTable, parseDimChart, parseTotals, type DimDay, type VideoDay, type VideoMeta } from "./studio";

/** One file from a zip (via `unzip -p`, no extraction to disk) or from a folder; null when absent. */
function readEntry(path: string, name: string): string | null {
  if (statSync(path).isDirectory()) { const f = join(path, name); return existsSync(f) ? readFileSync(f, "utf8") : null; }
  try { return execFileSync("unzip", ["-p", path, name], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
}

export function readStudioExport(paths: string[]) {
  const videos = new Map<string, VideoMeta>();
  const videoDays: VideoDay[] = [], dims: DimDay[] = [];
  const channel = new Map<string, number>();
  for (const p of paths) {
    const chart = readEntry(p, "Chart data.csv"), table = readEntry(p, "Table data.csv"), totals = readEntry(p, "Totals.csv");
    const head = (chart ?? "").split("\n")[0] ?? "";
    if (head.includes("Video title")) {
      const c = parseContentChart(chart!);
      c.videos.forEach((v) => videos.set(v.video_id, v)); videoDays.push(...c.days);
      if (table) parseContentTable(table).forEach((v) => videos.set(v.video_id, { ...videos.get(v.video_id), ...v }));
      // Channel views are the sum over videos, which equals Totals.csv; prefer Totals when present.
      if (totals) for (const t of parseTotals(totals)) channel.set(t.date, t.views);
    } else if (head.includes("Traffic source")) dims.push(...parseDimChart(chart!, "traffic_source"));
    else if (head.includes("Geography")) dims.push(...parseDimChart(chart!, "country"));
    else throw new Error(`${p}: not a YouTube Studio export (no Chart data.csv with a known header)`);
  }
  const dates = [...channel.keys(), ...videoDays.map((d) => d.date)].sort();
  return { videos: [...videos.values()], videoDays, dims, channelDays: [...channel].map(([date, views]) => ({ date, views })), range: [dates[0] ?? "", dates.at(-1) ?? ""] as [string, string] };
}
