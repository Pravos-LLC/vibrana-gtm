// Suggested publish slots per network, in the calendar timezone. Suggestions only: the owner edits them.
// Days follow the weekly rhythm (lib/rhythm.ts): LinkedIn Mon to Fri, Instagram and YouTube Mon to Sat, nothing Sunday.
import { zonedToUtc } from "./calendar";
import { channelAllowed } from "./rhythm";

export type Slot = { date: string; time: string };

const parts = (at: Date, timeZone: string) => Object.fromEntries(
  new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" })
    .formatToParts(at).map((p) => [p.type, p.value]));

const TIME: Record<string, string> = { linkedin: "08:30", instagram: "18:00", youtube: "17:00" };

/** The next day the rhythm lets this channel post, at its guide time, at least 30 minutes ahead. Anything else: next day 08:30. */
export function suggestSlot(channel: string, now: Date, timeZone: string): Slot {
  const wanted = TIME[channel] ?? "08:30";
  for (let d = 0; d < 9; d++) {
    const day = parts(new Date(now.getTime() + d * 86_400_000), timeZone);
    const date = `${day.year}-${day.month}-${day.day}`;
    if (TIME[channel] ? !channelAllowed(date, channel) : d === 0) continue;
    if (zonedToUtc(date, wanted, timeZone).getTime() >= now.getTime() + 30 * 60_000) return { date, time: wanted };
  }
  throw new Error(`no slot found for ${channel}`);
}
