export type RuntimeConfig = {
  schemaVersion: 1;
  calendar: { timezone: string; accounts: Record<string, string>; manual: string[] };
  publications: Record<string, { label: string; url: string }>;
  publicationChannels: Record<string, string>;
  offers: typeof import('../config/outreach-offers.json');
  candidates: typeof import('../config/candidates.json');
  brand: { websiteUrl: string; authorLabel: string; podcastName: string; personalFrontDoorId: string };
  packaging: { personalBrandId: string; profiles: Record<string, import('./packaging/catalog').Profile> };
  mail: { from: string; notify: string; engageFrom: string; outreachFrom: string; mailbox: string; trackFrom: { client: string; guest: string } };
};
export function validateRuntimeConfig(value: unknown): RuntimeConfig;
export function readPrivateRuntimeConfig(root: string, env?: Record<string, string | undefined>): { config: RuntimeConfig; bytes: Buffer };
export function loadRuntimeConfig(env?: Record<string, string | undefined>): RuntimeConfig;
