import { Shell } from "@/components/shell";

export default function Loading() {
  return (
    <Shell title="Post" active="/performance">
      <div aria-busy="true" aria-label="Loading post">
        <div className="skeleton h-4 w-32" />
        <div className="skeleton mt-6 h-4 w-64" />
        <div className="skeleton mt-3 h-9 w-[28rem] max-w-full" />
        <div className="mt-8 grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-6">{Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton h-14" />)}</div>
        <div className="mt-12 grid gap-12 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]"><div className="skeleton h-64 rounded-xl" /><div className="skeleton h-64 rounded-xl" /></div>
      </div>
    </Shell>
  );
}
