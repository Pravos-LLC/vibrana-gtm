export const PRODUCTION_IDENTITY: Readonly<{ projectId: string; repoOwner: string; repoSlug: string; repoId: string; branch: string }>;
export type ReleaseStamp = { schemaVersion: number; provider: string; environment: string; projectId: string; repoOwner: string; repoSlug: string; repoId: string; branch: string; gitCommitSha: string; deploymentId: string; privateRevision: string; overlayDigest: string; runtimeConfigDigest: string; privateBundleDigest?: string; privateContentUrl?: string };
export function canonicalProduction(env?: Record<string, string | undefined>): boolean;
export function providerReleaseContext(env?: Record<string, string | undefined>): ReleaseStamp;
export function validateReleaseStamp(repoRoot: string, env?: Record<string, string | undefined>): ReleaseStamp;
