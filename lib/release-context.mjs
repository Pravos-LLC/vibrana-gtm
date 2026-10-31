// Provider-bound server release metadata. This is a deployment binding, not an approval signature.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const PRODUCTION_IDENTITY = Object.freeze({
  projectId: 'prj_7pEB6cPxDSB77W1UF2sFcl2EmCRt',
  repoOwner: 'Pravos-LLC', repoSlug: 'vibrana-gtm', repoId: '1440425392', branch: 'main',
});
const hex = (value, size) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(value);
function fail() { throw new Error('Production release binding failed'); }
export function canonicalProduction(env = process.env) {
  return env.VERCEL_ENV === 'production' && (
    env.VERCEL_PROJECT_ID === PRODUCTION_IDENTITY.projectId ||
    (env.VERCEL_GIT_REPO_OWNER === PRODUCTION_IDENTITY.repoOwner && env.VERCEL_GIT_REPO_SLUG === PRODUCTION_IDENTITY.repoSlug)
  );
}
export function providerReleaseContext(env = process.env) {
  const id = PRODUCTION_IDENTITY;
  if (env.VERCEL_ENV !== 'production' || env.VERCEL_GIT_PROVIDER !== 'github' || env.VERCEL_PROJECT_ID !== id.projectId ||
    env.VERCEL_GIT_REPO_OWNER !== id.repoOwner || env.VERCEL_GIT_REPO_SLUG !== id.repoSlug ||
    env.VERCEL_GIT_REPO_ID !== id.repoId || env.VERCEL_GIT_COMMIT_REF !== id.branch ||
    !hex(env.VERCEL_GIT_COMMIT_SHA, 40) || !/^dpl_[A-Za-z0-9]+$/.test(env.VERCEL_DEPLOYMENT_ID ?? '') ||
    env.CONTENT_MODE !== 'private' || env.DEMO_MODE === '1' || env.NODE_ENV === 'test' || env.NODE_TEST_CONTEXT ||
    (env.PRIVATE_RELEASE_SHA && env.PRIVATE_RELEASE_SHA !== env.VERCEL_GIT_COMMIT_SHA) ||
    !hex(env.PRIVATE_CONTENT_REVISION, 40) || !hex(env.PRIVATE_OVERLAY_DIGEST, 64) || !hex(env.PRIVATE_RUNTIME_DIGEST, 64)) fail();
  return {
    schemaVersion: 1, provider: 'github', environment: 'production', ...id,
    gitCommitSha: env.VERCEL_GIT_COMMIT_SHA, deploymentId: env.VERCEL_DEPLOYMENT_ID,
    privateRevision: env.PRIVATE_CONTENT_REVISION, overlayDigest: env.PRIVATE_OVERLAY_DIGEST,
    runtimeConfigDigest: env.PRIVATE_RUNTIME_DIGEST,
  };
}
export function validateReleaseStamp(repoRoot, env = process.env) {
  const expected = providerReleaseContext(env);
  try {
    const value = JSON.parse(readFileSync(resolve(repoRoot, '.content-runtime/release.json'), 'utf8'));
    if (!value || Array.isArray(value) || Object.keys(value).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([key, item]) => value[key] !== item)) fail();
    return value;
  } catch { fail(); }
}
