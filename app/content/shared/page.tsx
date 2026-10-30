import { Shell } from "@/components/shell";
import { SharedReviewSection } from "./section";
import { unstable_rethrow } from "next/navigation";
export const maxDuration=800;
export const dynamic = "force-dynamic";
export const metadata = { title: "Shared review" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ piece?: string }>;
}) {
  try {
    const { piece } = await searchParams;
    return (
      <Shell title="Shared video review" active="/content" wide>
        <p className="mb-5">
          Choose one text and one video, review each once, then follow delivery
          on the{" "}
          <a href="/content/delivery" className="underline">
            publishing report
          </a>
          .
        </p>
        {await SharedReviewSection({ storyId: piece })}
      </Shell>
    );
  } catch (e) {
    unstable_rethrow(e);
    return (
      <Shell title="Shared video review" active="/content">
        <p role="alert">
          Shared review could not be loaded completely. Refresh to retry;
          approval status is unavailable.
        </p>
      </Shell>
    );
  }
}
