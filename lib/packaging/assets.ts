// Licensed packaging fonts and marks are not part of the public tree. An operator with a private copy
// points the renderer at it with PACKAGING_ASSET_ROOT or --asset-root; nothing is copied into the repo.
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
export const BUNDLED_ASSET_ROOT = fileURLToPath(new URL("../../assets/packaging/", import.meta.url));
const within = (root: string, path: string) => { const r = relative(root, path); return r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r)); };

/** The packaging asset root: the --asset-root flag, else PACKAGING_ASSET_ROOT, else the bundled assets/packaging.
 *  A supplied root fails closed and never falls back to the bundled assets: it must be an absolute, existing
 *  directory outside this checkout that holds a fonts/ directory. */
export function packagingAssetRoot(options: { flag?: string; env?: Record<string, string | undefined> } = {}): string {
  const env = options.env ?? process.env;
  const source = options.flag !== undefined ? "--asset-root" : "PACKAGING_ASSET_ROOT";
  const supplied = options.flag ?? env.PACKAGING_ASSET_ROOT;
  if (supplied === undefined || (options.flag === undefined && supplied === "")) return BUNDLED_ASSET_ROOT;
  if (!isAbsolute(supplied)) throw new Error(`${source} must be an absolute path to the private packaging assets`);
  if (!existsSync(supplied) || !statSync(supplied).isDirectory()) throw new Error(`${source} ${supplied} is not a directory. Point it at the private packaging assets; do not silently substitute.`);
  const root = realpathSync(supplied);
  if (within(realpathSync(REPO), root)) throw new Error(`${source} must be outside this checkout; licensed fonts never go into the public tree`);
  const fonts = resolve(root, "fonts");
  if (!existsSync(fonts) || !statSync(fonts).isDirectory()) throw new Error(`${source} ${supplied} has no fonts/ directory`);
  return root;
}
