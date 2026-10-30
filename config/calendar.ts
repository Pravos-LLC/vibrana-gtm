// Calendar settings that are not per-item. A TS module (not YAML) so the Vercel bundle includes it.
// Zernio account ids are not secrets (`gtm accounts` lists them).
export const CALENDAR = {
  timezone: "Europe/Berlin",
  accounts: {
    linkedin: "8f30df26d908626d0d2dbc2a",
    instagram: "a73f863ea30fa338aada5f44",
    youtube: "313d4ab49642526cbed73766",
  } as Record<string, string>,
  // Tracked, published by hand, never sent to Zernio.
  manual: ["newsletter", "website"],
};
