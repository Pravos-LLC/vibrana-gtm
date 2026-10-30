import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A server component cannot call a function exported from a "use client" file: Next throws at request
// time ("Attempted to call X() from the server"), which `next build` does not catch. Server files may
// only use components (capitalized) or types from client modules.
const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : /\.(tsx?)$/.test(f) ? [p] : [];
});
const isClient = (src: string) => /^\s*["']use client["']/.test(src);
const resolveImport = (spec: string) => {
  const base = spec.startsWith("@/") ? join(root, spec.slice(2)) : null;
  if (!base) return null;
  return [".tsx", ".ts", "/index.tsx", "/index.ts"].map((e) => base + e).find(existsSync) ?? null;
};

test("server components only use components and types from client modules", () => {
  const offenders: string[] = [];
  for (const file of walk(join(root, "app")).filter((f) => /(page|layout)\.tsx$/.test(f))) {
    const src = readFileSync(file, "utf8");
    if (isClient(src)) continue;
    for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["']([^"']+)["']/g)) {
      const target = resolveImport(m[2]);
      if (!target || !isClient(readFileSync(target, "utf8"))) continue;
      for (const raw of m[1].split(",")) {
        const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()!;
        if (!name || raw.trim().startsWith("type ") || /^import\s+type/.test(m[0])) continue;
        if (!/^[A-Z]/.test(name)) offenders.push(`${file.replace(root + "/", "")}: ${name} from ${m[2]}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
