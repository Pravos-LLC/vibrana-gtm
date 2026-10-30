import { Shell } from "@/components/shell";

export default function Loading() {
  return (
    <Shell title="Weekly report" active="/performance">
      <div aria-busy="true" aria-label="Loading report" className="max-w-[62ch]">
        <div className="skeleton h-3 w-56" />
        <div className="skeleton mt-4 h-10 w-full" />
        <div className="skeleton mt-4 h-20 w-full" />
        {Array.from({ length: 3 }, (_, i) => <div key={i} className="skeleton mt-10 h-28 w-full" />)}
      </div>
    </Shell>
  );
}
