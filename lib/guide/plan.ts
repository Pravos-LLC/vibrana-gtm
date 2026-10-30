// The guide's "ten weeks" view: live calendar rows grouped into Monday-start weeks.
export type PlanItem = { id: string; date: string; time: string | null; pillar: string | null; format: string | null; channels: string[]; status: string; title: string; media?: string[] | null };
/** One piece on one day: the same title and pillar fanned out to several channels is one entry. */
export type PlanEntry = { key: string; title: string; pillar: string | null; formats: string[]; channels: string[]; statuses: string[]; time: string | null; thumbs: string[] };

/** Storage paths that could stand in for a piece as a still, best first: images, then Story video poster frames. PDFs have none. */
export function thumbsFor(media: string[] | null | undefined): string[] {
  const list = media ?? [];
  return [
    ...list.filter((m) => /\.(png|jpe?g|webp)$/i.test(m)),
    ...list.filter((m) => /^stories\/.+\.mp4$/i.test(m)).map((m) => m.replace(/\.mp4$/i, "-poster.jpg")),
  ];
}
export type PlanWeek = { monday: string; days: { date: string; entries: PlanEntry[] }[]; count: number };

export function entriesFor(items: PlanItem[]): PlanEntry[] {
  const by = new Map<string, PlanEntry>();
  for (const i of [...items].sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""))) {
    const key = `${i.pillar ?? ""}|${i.title}`;
    const e = by.get(key) ?? { key: i.id, title: i.title, pillar: i.pillar, formats: [], channels: [], statuses: [], time: i.time, thumbs: [] };
    for (const t of thumbsFor(i.media)) if (!e.thumbs.includes(t)) e.thumbs.push(t);
    const add = (list: string[], v: string | null) => { if (v && !list.includes(v)) list.push(v); };
    add(e.formats, i.format);
    i.channels.forEach((c) => add(e.channels, c));
    add(e.statuses, i.status);
    by.set(key, e);
  }
  return [...by.values()];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (date: string, n: number) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

/** Monday of the week to start from. On a weekend the coming week is the useful one. */
export function planStart(today: string): string {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 Sun .. 6 Sat
  if (dow === 0) return addDays(today, 1);
  if (dow === 6) return addDays(today, 2);
  return addDays(today, 1 - dow);
}

export function planWindow(today: string, weeks = 10) {
  const from = planStart(today);
  return { from, to: addDays(from, weeks * 7 - 1) };
}

/** Groups items into `weeks` Monday-start weeks of seven days each; items outside the window are dropped. */
export function groupWeeks(items: PlanItem[], today: string, weeks = 10): PlanWeek[] {
  const { from } = planWindow(today, weeks);
  return Array.from({ length: weeks }, (_, w) => {
    const monday = addDays(from, w * 7);
    const days = Array.from({ length: 7 }, (_, d) => {
      const date = addDays(monday, d);
      return { date, entries: entriesFor(items.filter((i) => i.date === date)) };
    });
    return { monday, days, count: days.reduce((n, d) => n + d.entries.length, 0) };
  });
}
