// Server/CLI catalog selection. Browser components import only the pure synthetic definitions.
import { loadRuntimeConfig } from "../runtime-config.mjs";
import { activeOffers as validateOffers } from "./offers";
import type sampleCatalog from "../../config/outreach-offers.json";
export * from "./offers";
export function activeOffers(source = loadRuntimeConfig().offers as typeof sampleCatalog, now = Date.now()) {
  return validateOffers(source, now);
}
