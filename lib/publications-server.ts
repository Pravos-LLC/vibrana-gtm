// Server/CLI only. Pass only a selected publication's label and URL to an authorized UI.
import { loadRuntimeConfig } from "./runtime-config.mjs";
import type { PublicationConfig } from "./publications";
export function publicationConfig(): PublicationConfig {
  const { publications, publicationChannels } = loadRuntimeConfig();
  return { publications, publicationChannels };
}
