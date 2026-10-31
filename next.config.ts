import type { NextConfig } from "next";
import { contentMode, validateOverlay } from "./lib/content-overlay.mjs";
import { loadRuntimeConfig } from "./lib/runtime-config.mjs";
validateOverlay();
loadRuntimeConfig();

// The visual-check page (app/dev-fixtures) only exists when CONTENT_FIXTURES=1, so it is never compiled
// into a normal build.
const fixtures = process.env.CONTENT_FIXTURES === "1" && process.env.NODE_ENV !== "production";

const config: NextConfig = {
  pageExtensions: fixtures ? ["tsx", "ts", "fixture.tsx"] : ["tsx", "ts"],
  // The audience-fit calibration (lib/signals/audience.ts) is read from disk when present; ship it with the crons that brief.
  outputFileTracingIncludes: { "/*": contentMode() === "private" ? ["./content/sample/**/*.json", "./config/runtime.sample.json", "./.content-runtime/**/*.json"] : ["./content/sample/**/*.json", "./config/runtime.sample.json"] },
  outputFileTracingExcludes: { "/*": ["./content/guide/**/*", "./content/engage/**/*", "./content/private/**/*", "./config/season1.json", "./config/piece-traits.json", ...(contentMode() === "sample" ? ["./.content-runtime/**/*", "./.content-runtime-*/**/*"] : [])] },
  // The review screen used to live at /season, and the retired round-based review suite at /review.
  // Content review v3 (/content) replaces both, and the /stories index (a Story's own page, /stories/<id>,
  // stays for the newsletter export and non-season pieces). Old links keep working.
  async redirects() {
    return [
      { source: "/season", destination: "/content", permanent: true },
      { source: "/review", destination: "/content", permanent: true },
      { source: "/review/:path*", destination: "/content", permanent: true },
      { source: "/stories", destination: "/content", permanent: true },
    ];
  },
};
export default config;
