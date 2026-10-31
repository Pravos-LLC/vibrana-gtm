// Server/CLI operational settings. Public CI and previews resolve only the synthetic sample.
import { loadRuntimeConfig } from "../lib/runtime-config.mjs";
export const CALENDAR = loadRuntimeConfig().calendar;
