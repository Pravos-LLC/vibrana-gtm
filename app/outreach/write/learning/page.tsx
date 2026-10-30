import Link from "next/link";
import { Shell } from "@/components/shell";
import { OutreachLearning } from "@/components/outreach/learning";
import { sessionDb } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 90;
export const metadata = { title: "Writing desk learning" };

/** What the angle generator has learned from John's edits (README "Writing desk"). The owner reads it through RLS. */
export default async function OutreachLearningPage() {
  const db = await sessionDb();
  return (
    <Shell title="Writing desk learning" active="/outreach/write" wide>
      <p className="mb-3 text-sm"><Link href="/outreach/write" className="text-ink-2 underline underline-offset-2">Back to the desk</Link></p>
      <OutreachLearning db={db} />
    </Shell>
  );
}
