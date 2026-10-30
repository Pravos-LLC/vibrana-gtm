"use client";

import { useRouter } from "next/navigation";

/** The batch select: the latest batch is the default; picking one keeps the status filter. */
export function BatchPicker({ batches, batch, status }: { batches: string[]; batch: string; status: string }) {
  const router = useRouter();
  return (
    <label className="flex items-center gap-2 text-xs text-ink-2">
      Batch
      <select value={batch} aria-label="Batch" onChange={(e) => router.push(`/outreach?${new URLSearchParams({ batch: e.target.value, ...(status ? { status } : {}) })}`)}
        className="h-8 rounded-md border border-input bg-[color:var(--surface-inset)] px-2 text-xs text-ink">
        {batches.map((b, i) => <option key={b} value={b}>{b}{i === 0 ? " (latest)" : ""}</option>)}
      </select>
    </label>
  );
}
