import { demoMode, demoZernio } from "./demo";
// Thin Zernio (formerly Late) REST client. Docs: https://docs.zernio.com
// Same backend as getlate.dev; base moved to zernio.com/api/v1.
import { guardMediaBytes, isVideo } from "./media-guard";

/** What a streaming caller passes once it has probed the bytes it streams (lib/media-guard.ts). */
export type PlayableCheck = "probed-playable" | "not-video";

const BASE = process.env.ZERNIO_API_URL ?? "https://zernio.com/api/v1";

export class ZernioError extends Error {
  constructor(
    public status: number,
    public body: string,
    path: string,
  ) {
    super(`Zernio ${status} on ${path}: ${body.slice(0, 300)}`);
  }
}

function key(): string {
  const k = process.env.ZERNIO_API_KEY ?? process.env.LATE_API_KEY;
  if (!k) throw new Error("ZERNIO_API_KEY is not set");
  return k;
}

export async function zernio<T = any>(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    query?: Record<string, string | number | undefined>;
    headers?: Record<string, string>;
    timeoutMs?: number;
    retry429?: boolean;
  } = {},
): Promise<T> {
  if (demoMode()) return demoZernio(path, init.method) as T;
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(init.query ?? {}))
    if (v !== undefined) url.searchParams.set(k, String(v));
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${key()}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.timeoutMs ? AbortSignal.timeout(init.timeoutMs) : undefined,
    });
    if (res.status === 429 && attempt < 3 && init.retry429 !== false) {
      const wait = Number(res.headers.get("retry-after") ?? 2) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new ZernioError(res.status, text, path);
    return (text ? JSON.parse(text) : {}) as T;
  }
}

export type ZAccount = {
  _id: string;
  platform: string;
  username?: string;
  displayName?: string;
  isActive: boolean;
  needsReconnection?: boolean;
  followersCount?: number;
};

export async function listAccounts() {
  return zernio<{ accounts: ZAccount[]; hasAnalyticsAccess: boolean }>(
    "/accounts",
  );
}

export type ZPlatformEntry = {
  platform: string;
  accountId: string | { _id: string };
  status?: string;
  platformPostUrl?: string | null;
  errorMessage?: string | null;
  publishedAt?: string | null;
};
export type ZPost = {
  publishedAt?: string;
  _id: string;
  content?: string;
  status: string;
  scheduledFor?: string;
  platforms: ZPlatformEntry[];
  metadata?: Record<string, unknown>;
  tags?: string[];
};

export async function getPost(
  id: string,
  opts: { timeoutMs?: number; retry429?: boolean } = {},
) {
  const r = await zernio<{ post: ZPost } | ZPost>(`/posts/${id}`, {
    timeoutMs: 15_000,
    ...opts,
  });
  return "post" in r ? r.post : r;
}

/** idempotencyKey: stable per logical post. Zernio returns the original post on a retry within 24h. */
export async function createPost(
  body: Record<string, unknown>,
  idempotencyKey?: string,
  options: { timeoutMs?: number; retry429?: boolean } = {},
) {
  return zernio<{ post?: ZPost; warnings?: string[]; message?: string }>(
    "/posts",
    {
      method: "POST",
      ...options,
      body,
      headers: idempotencyKey
        ? { "Idempotency-Key": idempotencyKey }
        : undefined,
    },
  );
}

/** Presign + PUT a local file to Zernio's R2 storage. Returns the public URL. */
export async function uploadMedia(
  bytes: Uint8Array,
  filename: string,
  contentType: string,
): Promise<string> {
  guardMediaBytes(bytes, contentType, filename, { publish: true });
  const p = await zernio<{ uploadUrl: string; publicUrl: string }>(
    "/media/presign",
    {
      method: "POST",
      body: { filename, contentType, size: bytes.byteLength },
    },
  );
  const put = await fetch(p.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: bytes as BodyInit,
  });
  if (!put.ok)
    throw new Error(`media upload failed: ${put.status} ${await put.text()}`);
  return p.publicUrl;
}

/**
 * Presign + PUT a byte stream of known size (a multi-GB episode master) without holding it in memory. The presigned PUT
 * needs a Content-Length, which the stream must match exactly. Zernio takes up to 5 GB per file.
 */
export async function uploadMediaStream(
  stream: ReadableStream<Uint8Array>,
  size: number,
  filename: string,
  contentType: string,
  checked: PlayableCheck,
): Promise<string> {
  // A stream cannot be re-read here: the caller proves it probed the same bytes (guardVideoFile / guardVideoRanged).
  if (isVideo(contentType, filename) && checked !== "probed-playable")
    throw new Error(
      `${filename}: a video stream needs its playability probed before upload`,
    );
  const p = await zernio<{ uploadUrl: string; publicUrl: string }>(
    "/media/presign",
    {
      method: "POST",
      body: { filename, contentType, size },
    },
  );
  const put = await fetch(p.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType, "Content-Length": String(size) },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  if (!put.ok)
    throw new Error(`media upload failed: ${put.status} ${await put.text()}`);
  return p.publicUrl;
}

export type ZMetrics = {
  impressions?: number;
  reach?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  clicks?: number;
  views?: number;
  engagementRate?: number;
  // Platform-specific extras (docs: PostAnalytics). Zernio sends 0 where a platform does not report one.
  sends?: number;
  follows?: number | null;
  igReelsAvgWatchTime?: number;
  igReelsVideoViewTotalTime?: number;
  reelsSkipRate?: number;
  profileViews?: number;
  websiteClicks?: number;
  reposts?: number;
  videoDurationSeconds?: number | null;
};
export type ZAnalyticsPost = {
  /** The external post id (Zernio's ExternalPost). */
  _id: string;
  /** The Zernio post id when it was scheduled through Zernio: what gtm_content_items.zernio_post_id holds. */
  latePostId?: string | null;
  content?: string;
  status: string;
  publishedAt?: string | null;
  platform?: string;
  platformPostUrl?: string | null;
  isExternal?: boolean;
  analytics?: ZMetrics;
  platforms?: Array<{
    platform: string;
    accountId: string;
    platformPostUrl?: string | null;
    analytics?: ZMetrics | null;
  }>;
};

/** Every post Zernio can see (its own + external), with metrics. Needs analytics access. */
export async function listAnalytics(fromDate: string, toDate: string) {
  const out: ZAnalyticsPost[] = [];
  for (let page = 1; page < 50; page++) {
    const r = await zernio<{
      posts: ZAnalyticsPost[];
      pagination?: { pages: number };
    }>("/analytics", {
      query: { fromDate, toDate, limit: 100, page, source: "all" },
    });
    out.push(...(r.posts ?? []));
    if (!r.pagination || page >= r.pagination.pages) break;
  }
  return out;
}

/** Read-only identity lookup; absence never authorises resending an ambiguous create. */
export async function findDeliveryPost(
  deliveryId: string,
): Promise<ZPost | null> {
  return (await scanDeliveryPost(deliveryId)).post;
}
/**
 * The complete metadata scan behind findDeliveryPost, with what it read: `post` null after a full scan is the evidence
 * an operator records when resolving an uncertain delivery (a partial scan throws, it never reads as absent).
 */
export async function scanDeliveryPost(
  deliveryId: string,
): Promise<{ post: ZPost | null; pages: number; scanned: number }> {
  const matches: ZPost[] = [];
  let scanned = 0;
  for (let page = 1; page <= 100; page++) {
    const result = await zernio<{
      posts: ZPost[];
      pagination: { pages: number };
    }>("/posts", {
      query: { includeHidden: "true", limit: 500, page },
      timeoutMs: 15_000,
      retry429: false,
    });
    if (
      !Array.isArray(result.posts) ||
      !Number.isFinite(result.pagination?.pages)
    )
      throw new Error("Provider returned incomplete reconciliation pages");
    scanned += result.posts.length;
    matches.push(
      ...result.posts.filter((p) => p.metadata?.deliveryId === deliveryId),
    );
    if (page >= result.pagination.pages) {
      if (matches.length > 1)
        throw new Error(
          "Multiple provider posts match this delivery; manual reconciliation required",
        );
      return { post: matches[0] ?? null, pages: page, scanned };
    }
  }
  throw new Error(
    "Provider reconciliation exceeded 100 pages; delivery remains unverified",
  );
}
export async function retryPost(id: string) {
  return zernio<{ post?: ZPost }>(`/posts/${id}/retry`, {
    method: "POST",
    timeoutMs: 120_000,
    retry429: false,
  });
}

/** Historical attempts lack a delivery identity. Only exact calendar metadata may recover their id. */
export async function findCalendarPost(
  calendarId: string,
): Promise<ZPost | null> {
  const matches: ZPost[] = [];
  for (let page = 1; page <= 100; page++) {
    const r = await zernio<{ posts: ZPost[]; pagination: { pages: number } }>(
      "/posts",
      {
        query: { includeHidden: "true", limit: 500, page },
        timeoutMs: 15_000,
        retry429: false,
      },
    );
    if (!Array.isArray(r.posts) || !Number.isFinite(r.pagination?.pages))
      throw new Error("Incomplete historical reconciliation page");
    matches.push(
      ...r.posts.filter(
        (p) => p.metadata?.calendarId === calendarId && p.status !== "draft",
      ),
    );
    if (page >= r.pagination.pages) {
      if (matches.length > 1)
        throw new Error(
          "Multiple provider posts match the calendar id; manual reconciliation required",
        );
      return matches[0] ?? null;
    }
  }
  throw new Error(
    "Historical reconciliation exceeds 50,000 posts; outcome remains unverified",
  );
}
