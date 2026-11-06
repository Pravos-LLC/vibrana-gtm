// One conversation per connected set of mailbox threads (VIB-510). Gmail thread ids are per mailbox, and one send can be
// observed in several of the team's mailboxes (a send-as alias, a delegated mailbox: the same keyed Message-ID). Threads
// that share any keyed send are one conversation, transitively: A|a and B|b share m1, B|b and C|c share m2, so a reply in
// C|c answers the sends in A|a. Union-find, so chains and cycles resolve to one stable identity.

export type ThreadEvent = { kind: string; thread_id: string; mailbox?: string | null; message_key?: string | null };

export const threadKey = (e: { thread_id: string; mailbox?: string | null }) => `${e.mailbox ?? ""}|${e.thread_id}`;

/** A function from an event to its conversation id: the smallest mailbox|thread key in its connected set. */
export function conversations(events: ThreadEvent[]): (e: { thread_id: string; mailbox?: string | null }) => string {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    let x = k;
    while (parent.has(x) && parent.get(x) !== r) { const n = parent.get(x)!; parent.set(x, r); x = n; }
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent.set(rb, ra); else parent.set(ra, rb);
  };
  const firstThreadOf = new Map<string, string>();
  for (const e of events) {
    if (e.kind !== "outreach" || !e.message_key) continue;
    const k = threadKey(e);
    if (!parent.has(k)) parent.set(k, k);
    const seen = firstThreadOf.get(e.message_key);
    if (seen) union(seen, k); else firstThreadOf.set(e.message_key, k);
  }
  return (e) => find(threadKey(e));
}
