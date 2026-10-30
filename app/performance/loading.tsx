import { Shell } from "@/components/shell";

/** Skeleton in the page's own shape: filter row, report strip, four tiles, platform rows, a table. */
export default function Loading() {
  return (
    <Shell title="Performance" active="/performance">
      <div aria-busy="true" aria-label="Loading performance">
        <div className="flex flex-wrap gap-4"><div className="skeleton h-8 w-64" /><div className="skeleton h-8 w-48" /><div className="skeleton h-8 w-80" /></div>
        <div className="skeleton mt-3 h-3 w-72" />
        <div className="skeleton mt-6 h-11 w-full" />
        <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">{Array.from({ length: 4 }, (_, i) => <div key={i} className="skeleton h-32 rounded-xl" />)}</div>
        <div className="skeleton mt-12 h-5 w-40" />
        <div className="mt-4 space-y-2">{Array.from({ length: 3 }, (_, i) => <div key={i} className="skeleton h-16" />)}</div>
        <div className="skeleton mt-12 h-5 w-40" />
        <div className="mt-4 space-y-2">{Array.from({ length: 5 }, (_, i) => <div key={i} className="skeleton h-12" />)}</div>
      </div>
    </Shell>
  );
}
