import { Shell } from "@/components/shell";
import { sessionDb } from "@/lib/supabase/server";
import { must } from "@/lib/db";
import type { PieceDelivery } from "@/lib/piece-delivery";
import { signedUrls } from "@/lib/sign-urls";
import { playPath } from "@/lib/reviewer/shared";
import { splitFrontmatter, frontmatterData } from "@/lib/frontmatter";
import { SignedVideo } from "@/components/media/signed-video";
export const dynamic = "force-dynamic";
export const metadata = { title: "Delivery" };

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const db = await sessionDb(),
    auth = await db.auth.getUser();
  if (auth.error || auth.data.user?.app_metadata?.gtm_owner !== true)
    throw new Error("Sign in as the cockpit owner");
  const { id } = await params;
  const d = must(
    await db.from("gtm_piece_deliveries").select("*").eq("id", id).single(),
    "frozen delivery",
  ) as PieceDelivery;
  const text = d.review_snapshot.text.asset,
    video = d.review_snapshot.video.asset,
    parts = splitFrontmatter(text.body ?? ""),
    meta = frontmatterData(parts.frontmatter),
    path = playPath(video),
    signed = path ? await signedUrls(db, [path], 21600) : null;
  return (
    <Shell title="Frozen channel version" active="/content">
      <p className="mb-4">
        {d.channel} · {d.state} · {d.slot_date} {d.slot_time.slice(0, 5)}{" "}
        {d.timezone}
      </p>
      <p className="mb-4 text-sm">
        Text v{text.revision} · Video v{video.revision}. Edits to the current
        draft do not replace this version.
      </p>
      {d.publication_url && (
        <a href={d.publication_url} className="underline">
          Open publication
        </a>
      )}
      {d.error && <p role="alert">{d.error}</p>}
      <section className="my-6 whitespace-pre-wrap">
        <h2 className="mb-2 font-medium">Shared text</h2>
        {parts.prose}
        {typeof meta.youtube_title === "string" && (
          <p>YouTube title: {String(meta.youtube_title)}</p>
        )}
        {typeof meta.first_comment === "string" && (
          <p>LinkedIn first comment: {String(meta.first_comment)}</p>
        )}
      </section>
      {signed?.data[0]?.signedUrl ? (
        <SignedVideo
          src={signed.data[0].signedUrl}
          controls
          className="max-h-[70vh] w-full"
        />
      ) : (
        <p>Video preview unavailable. Refresh to retry.</p>
      )}
      <a
        href={`/content/shared?piece=${encodeURIComponent(d.story_id)}`}
        className="mt-5 inline-block underline"
      >
        Open the separate draft
      </a>
    </Shell>
  );
}
