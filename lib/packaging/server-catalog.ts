// Server/CLI registry. Clients receive display options only, never private profile instructions.
import { loadRuntimeConfig } from "../runtime-config.mjs";
import type { Profile } from "./catalog";
export function packagingProfiles(): Record<string, Profile> { return loadRuntimeConfig().packaging.profiles; }
export function defaultPackagingBrand(): string { return loadRuntimeConfig().packaging.personalBrandId; }
export function packagingBrandOptions(): Array<{ id: string; name: string }> {
  return Object.entries(packagingProfiles()).map(([id, profile]) => ({ id, name: profile.name }));
}
