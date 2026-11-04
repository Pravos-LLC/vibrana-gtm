import { Shell } from "@/components/shell";

/** Skeleton in the page's shape: controls, source strip, two rows of tiles, sections. */
export default function Loading() {
  return (
    <Shell title="Team" active="/performance/team">
      <div aria-busy="true" aria-label="Loading team performance">
        <div className="flex flex-wrap gap-4"><div className="skeleton h-8 w-64" /><div className="skeleton h-8 w-48" /></div>
        <div className="skeleton mt-6 h-16 w-full" />
        <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4">{Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton h-32 rounded-xl" />)}</div>
        <div className="skeleton mt-12 h-5 w-40" />
        <div className="mt-4 space-y-2">{Array.from({ length: 5 }, (_, i) => <div key={i} className="skeleton h-10" />)}</div>
      </div>
    </Shell>
  );
}
