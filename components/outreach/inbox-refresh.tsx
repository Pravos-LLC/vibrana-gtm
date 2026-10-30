"use client";
import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";

export function InboxRefresh() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden && !pending) startTransition(() => router.refresh()); }, 60000);
    return () => clearInterval(timer);
  }, [router, pending]);
  return <button className="rounded border border-line px-3 py-2 text-sm disabled:opacity-50" disabled={pending} onClick={() => startTransition(() => router.refresh())}>{pending ? "Checking…" : "Check inbox now"}</button>;
}
