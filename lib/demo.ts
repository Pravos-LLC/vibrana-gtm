// Provider boundaries check this before reading credentials or making requests.
export const demoMode = () => process.env.DEMO_MODE === "1";
export function demoZernio(path: string, method = "GET"): unknown {
  if (method !== "GET") throw new Error("Demo mode: provider mutations are disabled");
  if (path === "/accounts") return { accounts: [
    { _id: "sample-linkedin", platform: "linkedin", displayName: "Sample account", isActive: true },
    { _id: "sample-instagram", platform: "instagram", displayName: "Sample account", isActive: true },
  ], hasAnalyticsAccess: true };
  if (path === "/posts") return { posts: [], pagination: { hasMore: false } };
  if (path.startsWith("/analytics")) return { posts: [], analytics: [], pagination: { hasMore: false } };
  throw new Error("Demo mode: unsupported provider read");
}
