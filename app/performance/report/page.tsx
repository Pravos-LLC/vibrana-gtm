import { redirect } from "next/navigation";
import { sessionDb } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export const metadata = { title: "Weekly report" };

/** /performance/report opens the latest weekly report, or week 1 (which explains how to write one). */
export default async function LatestReport() {
  const db = await sessionDb();
  const { data } = await db.from("gtm_content_reports").select("week").eq("kind", "weekly").order("period_start", { ascending: false }).limit(1);
  redirect(`/performance/report/${(data?.[0] as { week?: number } | undefined)?.week ?? 1}`);
}
