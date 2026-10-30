import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/shell";
import { sessionDb } from "@/lib/supabase/server";
import { loadDeliveryReport } from "@/lib/delivery-report";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export const metadata = { title: "Delivery" };

export default async function DeliveryPage({ searchParams }: { searchParams: Promise<{ verify?: string }> }) {
  const db = await sessionDb();
  const { data } = await db.auth.getClaims();
  if ((data?.claims?.app_metadata as { gtm_owner?: boolean })?.gtm_owner !== true) redirect("/login");
  const verify = (await searchParams).verify === "1";
  let rows;
  try { rows = await loadDeliveryReport(db, verify); }
  catch { return <Shell title="Publishing status" active="/content"><p role="alert">Publishing status could not be loaded. Refresh to retry.</p></Shell>; }
  const count = (state: string) => rows.filter((r) => r.state === state && r.verified).length;
  return <Shell title="Publishing status" active="/content" wide>
    <div className="space-y-6">
      <div className="flex flex-wrap gap-5 text-sm"><Link href="/content" className="underline">Back to review</Link><Link href="/content/delivery?verify=1" className="underline">Check publishing service</Link></div>
      <p>{count("published")} confirmed published · {count("scheduled")} confirmed scheduled · {rows.filter((r) => r.state === "unverified").length} unverified</p>
      <p className="text-sm text-ink-2">{verify ? "Checked the most recent 120 provider records. Failed checks and older records remain unverified." : "Recorded deliveries. Check the publishing service to confirm what went out."} This view never schedules or retries a post.</p>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-3">Piece</th><th className="p-3">Channel</th><th className="p-3">Status</th><th className="p-3">Details</th><th className="p-3">Published link</th></tr></thead><tbody>
        {rows.map((r) => <tr key={`${r.itemId}:${r.channel}`} className="border-t border-line"><td className="p-3"><Link href={r.storyId ? `/content?piece=${encodeURIComponent(r.storyId)}` : "/calendar"} className="underline">{r.title}</Link></td><td className="p-3">{r.channel}</td><td className="p-3">{r.state}</td><td className="p-3">{r.reason}</td><td className="p-3">{r.url && /^https:\/\//.test(r.url) ? <a href={r.url} target="_blank" rel="noopener noreferrer" className="underline">View post</a> : "No confirmed link"}</td></tr>)}
      </tbody></table></div>
    </div>
  </Shell>;
}
