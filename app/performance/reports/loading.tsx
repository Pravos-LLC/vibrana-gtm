import { Shell } from "@/components/shell";

export default function Loading() {
  return (
    <Shell title="Reports" active="/performance/reports">
      <div className="space-y-3" aria-busy="true" aria-label="Loading reports">
        {[0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse rounded-xl border border-line bg-surface-raised" />)}
      </div>
    </Shell>
  );
}
