"use client";
import { sharedMatches, type SharedFacts } from "@/lib/shared-filter";
import type { Filters } from "@/lib/season-review";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  sharedDecision,
  sharedText,
  adoptShared,
  convertLegacyNote,
  setSharedDispatch,
  retrySharedChannel,
  recoverSharedChannel,
  releaseSharedChannel,
  replaceSharedChannel,
  releaseShared,
  decideSharedCover,
} from "@/app/content/shared/actions";
import type {
  PieceReviewSnapshot,
  SharedCandidate,
  SharedPart,
  SharedDecision,
  SharedDeliveryState,
} from "@/lib/piece-review";
import { splitFrontmatter, frontmatterData } from "@/lib/frontmatter";
import { MentionCheck } from "@/components/review/mention-check";
import type { MentionChannel } from "@/lib/mentions";
import { SignedVideo } from "@/components/media/signed-video";
import { WatchedImage } from "@/components/media/watched-media";
const labels = {
  pending: "Needs approval",
  approved: "Approved",
  changes: "Changes requested",
  fixing: "Waiting for fix",
};
const button =
  "rounded border border-line px-3 py-2 text-sm disabled:opacity-40";
export function SharedPiece({
  title,
  storyId,
  initial,
  candidates,
  videoUrl,
  channels: initialChannels,
  notes: feedback,
  delivery = { ok: true },
  covers = [],
  filters,
  facts,
}: {
  filters?: Filters;
  facts?: SharedFacts;
  title: string;
  storyId: string;
  initial: PieceReviewSnapshot | null;
  candidates: SharedCandidate[];
  videoUrl: string | null;
  channels: string[];
  notes: { id: string; asset_id: string; body: string }[];
  /** Whether a shared piece can be published from this deployment (lib/piece-review.ts sharedDeliveryInstalled). */
  delivery?: SharedDeliveryState;
  /** The piece's covers and other images, each decided per platform. */
  covers?: { id: string; title: string; sha256: string; revision: number; src: string | null; rows: { channel: string; status: string }[] }[];
}) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { setHydrated(true); }, []);
  const router = useRouter(),
    [state, setState] = useState(initial),
    [observedInitial, setObservedInitial] = useState(initial),
    [editorVersion, setEditorVersion] = useState(initial?.text),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirmRelease, setConfirmRelease] = useState(false),
    [notice, setNotice] = useState("");
  const sole = (kind: string) => {
    const own = candidates.filter((c) => c.asset.kind === kind);
    return new Set(own.map((c) => c.fingerprint)).size === 1
      ? own[0].asset.id
      : "";
  };
  const [textId, setTextId] = useState(() => sole("copy")),
    [videoId, setVideoId] = useState(() => sole("video")),
    [channels, setChannels] = useState(initialChannels);
  const raw = splitFrontmatter(editorVersion?.asset.body ?? ""),
    fields = frontmatterData(raw.frontmatter);
  const [prose, setProse] = useState(raw.prose),
    [ytTitle, setTitle] = useState(String(fields.youtube_title ?? "")),
    [comment, setComment] = useState(String(fields.first_comment ?? ""));
  const [notes, setNotes] = useState({ text: "", video: "" });
  // A piece is never "Ready" while nothing can publish it (review #147 B2).
  const blockers = [
    ...(delivery.ok ? [] : [`Shared delivery is not installed: ${delivery.reason}`]),
    ...(state?.blockers ?? []),
  ];
  const dirty =
    !!state &&
    (prose !== raw.prose ||
      ytTitle !== String(fields.youtube_title ?? "") ||
      comment !== String(fields.first_comment ?? ""));
  // A refresh updates saved state without silently rebasing an unsaved human edit.
  if (initial !== observedInitial) {
    setObservedInitial(initial);
    setState(initial);
    if (!dirty) {
      const next = splitFrontmatter(initial?.text.asset.body ?? ""),
        fm = frontmatterData(next.frontmatter);
      setEditorVersion(initial?.text);
      setProse(next.prose);
      setTitle(String(fm.youtube_title ?? ""));
      setComment(String(fm.first_comment ?? ""));
    } else if (initial?.text.fingerprint !== editorVersion?.fingerprint)
      setError(
        "The saved version changed. Your draft is retained; reload or copy it before resolving the conflict.",
      );
  }
  async function run(
    action: () => Promise<{ snapshot?: PieceReviewSnapshot; error?: string; notice?: string }>,
    after?: () => void,
  ) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await action();
      if (result.error || !result.snapshot) {
        setError(result.error ?? "No saved state returned. Reload to verify.");
        return;
      }
      setState(result.snapshot);
      if (result.notice) setNotice(result.notice);
      setEditorVersion(result.snapshot.text);
      const text = splitFrontmatter(result.snapshot.text.asset.body ?? ""),
        fm = frontmatterData(text.frontmatter);
      setProse(text.prose);
      setTitle(String(fm.youtube_title ?? ""));
      setComment(String(fm.first_comment ?? ""));
      after?.();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  function decide(part: SharedPart, decision: SharedDecision) {
    if (!state) return;
    const a = state[part];
    void run(
      () =>
        sharedDecision({
          storyId,
          part,
          decision,
          note: notes[part],
          fingerprint: a.fingerprint,
          revision: a.asset.revision,
        }),
      // The note went out with the decision: the box clears, so it cannot ride on the next one (review #147 N6).
      () => setNotes((n) => ({ ...n, [part]: "" })),
    );
  }
  if (state && filters && facts && !dirty && !error && !busy && !sharedMatches(state, filters, facts)) return null;
  return (
    <article
      className="mb-6 rounded-xl border border-line bg-surface p-5"
      data-testid={`shared-${storyId}`}
    >
      <fieldset disabled={!hydrated} className="min-w-0">
      <h2 className="text-lg font-semibold">{title}</h2>
      <button
        className={button}
        disabled={busy}
        onClick={() => router.refresh()}
      >
        Refresh saved state
      </button>
      <p className="mb-4 text-sm text-ink-2">
        One text and one video across{" "}
        {state?.channels.join(", ") ||
          channels.join(", ") ||
          "selected channels"}
        .
      </p>
      {error && (
        <p role="alert" className="mb-4 text-red-strong">
          {error}
          {dirty ? " Your unsaved text remains in the editor." : ""}
        </p>
      )}
      {!state && !delivery.ok ? (
        <p className="text-sm text-ink-2">
          Shared delivery is not installed, so this piece stays on channel review: {delivery.reason}.
        </p>
      ) : !state ? (
        <div className="space-y-4">
          <p>
            Choose the shared assets. Historical versions and queued posts are
            retained. Scheduling stays paused after import.
          </p>
          {(["copy", "video"] as const).map((kind) => (
            <fieldset key={kind}>
              <legend className="font-medium">
                Choose one {kind === "copy" ? "text" : "video"}
              </legend>
              {candidates
                .filter((c) => c.asset.kind === kind)
                .map((c) => (
                  <label
                    key={c.asset.id}
                    className="my-2 block rounded border border-line p-3"
                  >
                    <input
                      type="radio"
                      name={`${storyId}-${kind}`}
                      checked={
                        (kind === "copy" ? textId : videoId) === c.asset.id
                      }
                      onChange={() =>
                        kind === "copy"
                          ? setTextId(c.asset.id)
                          : setVideoId(c.asset.id)
                      }
                    />{" "}
                    {c.asset.title} · v{c.asset.revision}
                    <p className="whitespace-pre-wrap text-sm text-ink-2">
                      {kind === "copy" ? c.asset.body : c.asset.source}
                    </p>
                  </label>
                ))}
            </fieldset>
          ))}
          <fieldset>
            <legend>Channels</legend>
            {["linkedin", "instagram", "youtube"].map((c) => (
              <label key={c} className="mr-4">
                <input
                  type="checkbox"
                  checked={channels.includes(c)}
                  onChange={() =>
                    setChannels(
                      channels.includes(c)
                        ? channels.filter((x) => x !== c)
                        : [...channels, c],
                    )
                  }
                />{" "}
                {c}
              </label>
            ))}
          </fieldset>
          <button
            className={button}
            disabled={busy || !textId || !videoId || !channels.length}
            onClick={() =>
              void run(() =>
                adoptShared({
                  storyId,
                  textId,
                  videoId,
                  textFingerprint: candidates.find(
                    (c) => c.asset.id === textId,
                  )!.fingerprint,
                  videoFingerprint: candidates.find(
                    (c) => c.asset.id === videoId,
                  )!.fingerprint,
                  channels,
                }),
              )
            }
          >
            Use these shared assets
          </button>
        </div>
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <section aria-label="Shared text">
              <h3 className="font-medium">
                Text · {labels[state.text.status]} · v
                {state.text.asset.revision}
              </h3>
              <label className="mt-3 block">
                Shared caption
                <textarea
                  aria-label="Shared caption"
                  className="mt-1 min-h-56 w-full rounded border border-line bg-transparent p-3"
                  disabled={busy}
                  value={prose}
                  onChange={(e) => setProse(e.target.value)}
                />
              </label>
              <MentionCheck
                texts={[prose]}
                channels={state.channels as MentionChannel[]}
              />
              <details className="my-3">
                <summary>Optional title, first comment and packaging</summary>
                <label className="mt-2 block">
                  YouTube title
                  <input
                    className="block w-full rounded border border-line bg-transparent p-2"
                    disabled={busy}
                    value={ytTitle}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </label>
                <label className="mt-2 block">
                  LinkedIn first comment
                  <textarea
                    className="block w-full rounded border border-line bg-transparent p-2"
                    disabled={busy}
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                  />
                </label>
                <MentionCheck
                  texts={[comment]}
                  channels={["linkedin"]}
                  comment
                />
                <p className="mt-2 text-sm text-ink-2">
                  Publishing cover:{" "}
                  {String(
                    state.text.asset.metadata?.thumbnail_path ??
                      "No cover selected",
                  )}
                  . Stage packaging changes with the shared asset; changed cover
                  bytes require approval.
                </p>
              </details>
              <button
                className={button}
                disabled={busy || !dirty}
                onClick={() =>
                  void run(() =>
                    sharedText({
                      storyId,
                      prose,
                      title: ytTitle,
                      firstComment: comment,
                      fingerprint: editorVersion!.fingerprint,
                      revision: editorVersion!.asset.revision,
                    }),
                  )
                }
              >
                Save shared text
              </button>
            </section>
            <section aria-label="Shared video">
              <h3 className="mb-3 font-medium">
                Video · {labels[state.video.status]} · v
                {state.video.asset.revision}
              </h3>
              {videoUrl ? (
                <SignedVideo
                  key={state.video.asset.id}
                  src={videoUrl}
                  controls
                  className="max-h-96 w-full rounded bg-black"
                />
              ) : (
                <p>Video preview unavailable. Refresh to retry.</p>
              )}
              <p className="mt-2 text-sm text-ink-2">
                {state.video.asset.source}
              </p>
            </section>
          </div>
          {dirty && (
            <p className="mt-3 text-sm">
              Save your shared text before deciding either part.
            </p>
          )}
          <div className="mt-5 grid gap-6 lg:grid-cols-2">
            {(["text", "video"] as const).map((part) => (
              <section key={part} aria-label={`${part} decision`}>
                <p className="font-medium">
                  {part === "text" ? "Text" : "Video"}:{" "}
                  {labels[state[part].status]}
                </p>
                {feedback
                  .filter(
                    (f) =>
                      f.asset_id === state[part].asset.id &&
                      !f.body.startsWith("[approved with note:") &&
                      !state.fixes.some((fix) => fix.feedback_id === f.id),
                  )
                  .map((f) => (
                    <p
                      key={f.id}
                      className="my-2 whitespace-pre-wrap rounded border border-line p-3"
                    >
                      {f.body}
                    </p>
                  ))}
                {state.fixes
                  .filter((f) => f.part === part)
                  .map((f) => (
                    <p key={f.id} className="my-2 rounded bg-amber-soft p-3">
                      Waiting for fix: {f.note}. Scheduling is blocked until the
                      authorised fix is recorded.
                    </p>
                  ))}
                <label className="block text-sm">
                  {part === "text" ? "Text" : "Video"} note
                  <textarea
                    className="my-2 block w-full rounded border border-line bg-transparent p-2"
                    value={notes[part]}
                    onChange={(e) =>
                      setNotes({ ...notes, [part]: e.target.value })
                    }
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    className={button}
                    disabled={busy || dirty}
                    onClick={() => decide(part, "approved")}
                  >
                    Approve {part}
                  </button>
                  <button
                    className={button}
                    disabled={busy || !notes[part].trim() || dirty}
                    onClick={() => decide(part, "changes")}
                  >
                    Request {part} changes
                  </button>
                  <button
                    className={button}
                    disabled={busy || !notes[part].trim() || dirty}
                    onClick={() => decide(part, "fixing")}
                  >
                    Accept {part} with note
                  </button>
                </div>
              </section>
            ))}
          </div>
          {state.legacyFixes.map((f) => (
            <div key={f.id} className="mt-4 rounded border border-line p-3">
              <p className="whitespace-pre-wrap">{f.body}</p>
              <p>Assign this existing accepted note to its shared part:</p>
              {(["text", "video"] as const).map((part) => (
                <button
                  key={part}
                  className={button}
                  disabled={busy || dirty}
                  onClick={() =>
                    void run(() =>
                      convertLegacyNote({
                        storyId,
                        feedbackId: f.id,
                        part,
                        fingerprint: state[part].fingerprint,
                        revision: state[part].asset.revision,
                      }),
                    )
                  }
                >
                  Convert to {part} fix
                </button>
              ))}
            </div>
          ))}
          {covers.length > 0 && (
            <section className="mt-5 space-y-3" aria-label="Covers">
              <h3 className="font-medium">Cover{covers.length > 1 ? "s and images" : ""}</h3>
              <p className="text-sm text-ink-2">Decided per platform. The Instagram Reel cover goes out only once approved for Instagram.</p>
              {covers.map((c) => {
                const approved = c.rows.every((r) => r.status === "approved");
                return (
                  <div key={c.id} className="flex flex-wrap items-center gap-3 rounded border border-line p-3">
                    {c.src ? <WatchedImage src={c.src} alt={c.title} className="h-20 w-auto rounded bg-black/5 object-contain" /> : <span className="text-sm">{c.title} (preview unavailable)</span>}
                    <span className="text-sm">{c.rows.map((r) => `${r.channel}: ${labels[r.status as keyof typeof labels] ?? (r.status === "rejected" ? "Changes requested" : r.status)}`).join(" · ")}</span>
                    <button className={button} disabled={busy} onClick={() => void run(() => decideSharedCover({ storyId, assetId: c.id, sha256: c.sha256, revision: c.revision, approve: !approved }))}>
                      {approved ? "Unapprove cover" : "Approve cover"}
                    </button>
                  </div>
                );
              })}
            </section>
          )}
          {!!state.deliveries?.length && (
            <section className="mt-5 space-y-3" aria-label="Channel deliveries">
              <h3 className="font-medium">Queued and published versions</h3>
              <p className="text-sm text-ink-2">
                Edits above are a separate draft. Each queued version stays
                frozen.
              </p>
              {state.deliveries.map((d) => (
                <div
                  key={d.id + d.channel}
                  className="rounded border border-line p-3"
                >
                  <p>
                    {d.channel}: {d.state} · {d.date} {d.time}
                    {d.textRevision !== null
                      ? ` · text v${d.textRevision}, video v${d.videoRevision}`
                      : " · kept: existing legacy post"}
                  </p>
                  {d.url && (
                    <a
                      href={d.url}
                      target="_blank"
                      rel="noreferrer"
                      className="mr-4 underline"
                    >
                      Open publication
                    </a>
                  )}
                  {!d.legacy && (
                    <a href={`/content/delivery/${d.id}`} className="underline">
                      View frozen version
                    </a>
                  )}
                  {d.error && (
                    <p className="mt-2 text-sm text-red-strong">{d.error}</p>
                  )}
                  {!d.legacy && d.providerId && (d.state === "failed" || d.state === "uncertain") && /no longer exists at Zernio or was cancelled/.test(d.error ?? "") && (
                    <button
                      className={`${button} mr-2`}
                      disabled={busy}
                      title="Zernio no longer has this post: the channel is scheduled again from the approved versions"
                      onClick={() => void run(() => replaceSharedChannel({ storyId, deliveryId: d.id }))}
                    >
                      Replace the cancelled {d.channel} post
                    </button>
                  )}
                  {!d.legacy && d.state === "failed" && !/no longer exists at Zernio or was cancelled/.test(d.error ?? "") && (
                    <button
                      className={button}
                      disabled={busy || dirty}
                      onClick={() =>
                        void run(() =>
                          retrySharedChannel({ storyId, deliveryId: d.id }),
                        )
                      }
                    >
                      Retry {d.channel} delivery
                    </button>
                  )}
                  {!d.legacy && d.state === "uncertain" && (
                    <div className="mt-2 space-y-1">
                      <p className="text-sm">Zernio has not confirmed this post. Recovering checks Zernio first and never posts twice.</p>
                      <button
                        className={button}
                        disabled={busy}
                        onClick={() => void run(() => recoverSharedChannel({ storyId, deliveryId: d.id }))}
                      >
                        Check Zernio and recover {d.channel}
                      </button>
                    </div>
                  )}
                  {!d.legacy && (d.state === "prepared" || (d.state === "failed" && !d.providerId)) && (
                    <button
                      className={`${button} ml-2`}
                      disabled={busy}
                      title="Frees the day for another post; the post goes back to drafted"
                      onClick={() => void run(() => releaseSharedChannel({ storyId, deliveryId: d.id }))}
                    >
                      Release the {d.channel} slot
                    </button>
                  )}
                </div>
              ))}
            </section>
          )}
          <div
            className="mt-5 rounded bg-surface-2 p-3"
            aria-label="Publishing blockers"
          >
            {blockers.length ? (
              <>
                <p className="font-medium">Publishing is blocked</p>
                <ul className="list-inside list-disc">
                  {blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p>
                {state.deliveries?.length
                  ? "The current draft is approved. Existing channel deliveries are retained."
                  : "Ready. Scheduling runs automatically."}
              </p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {state.dispatchEnabled ? (
                <button
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      setSharedDispatch({ storyId, enabled: false, textFingerprint: state.text.fingerprint, videoFingerprint: state.video.fingerprint }),
                    )
                  }
                >
                  Pause scheduling
                </button>
              ) : (
                <button
                  className={button}
                  disabled={busy || dirty}
                  title="Your approvals stand as they are; this only lets the approved piece schedule"
                  onClick={() =>
                    void run(() =>
                      setSharedDispatch({ storyId, enabled: true, textFingerprint: state.text.fingerprint, videoFingerprint: state.video.fingerprint }),
                    )
                  }
                >
                  Resume scheduling
                </button>
              )}
              {confirmRelease ? (
                <>
                  <button
                    className={button}
                    disabled={busy || dirty}
                    onClick={async () => {
                      setBusy(true);
                      setError("");
                      const r = await releaseShared({ storyId }).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
                      setBusy(false);
                      setConfirmRelease(false);
                      if ("error" in r && r.error) return setError(r.error);
                      // The card leaves the page with the shared review, so the outcome travels in the URL and the page
                      // shows it above the piece's per-platform cards (review #147 F3).
                      if ("released" in r && r.released) {
                        router.push(`/content?piece=${encodeURIComponent(storyId)}&released=${r.released.textApprovalKept ? 1 : 0}${r.released.videoApprovalKept ? 1 : 0}`);
                        return;
                      }
                      router.refresh();
                    }}
                  >
                    Confirm: back to per-platform review
                  </button>
                  <button className={button} disabled={busy} onClick={() => setConfirmRelease(false)}>
                    Keep shared review
                  </button>
                </>
              ) : (
                <button className={button} disabled={busy} onClick={() => setConfirmRelease(true)}>
                  Leave shared review
                </button>
              )}
              <a href="/content/delivery" className="text-sm underline">
                View channel deliveries and publication links
              </a>
            </div>
            {notice && <p role="status" className="mt-2 text-sm" data-testid="delivery-notice">{notice}</p>}
          </div>
        </>
      )}
      </fieldset>
    </article>
  );
}
