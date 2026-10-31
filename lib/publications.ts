// Browser-safe publication types and synthetic defaults. Real registries are resolved on the server.
export type Publication = string;
export type PublicationDetails = { label: string; url: string };
export type PublicationRegistry = Record<string, PublicationDetails>;
export type PublicationConfig = { publications: PublicationRegistry; publicationChannels: Record<string, string> };
export const PUBLICATIONS: PublicationRegistry = {
  sample_author: { label: "Sample Author (personal Substack)", url: "https://sample_author.substack.com" },
  regenera: { label: "Regenera", url: "https://iamregenera.substack.com" },
};
export const SAMPLE_PUBLICATION_CHANNELS: Record<string, string> = {
  "personal-substack": "sample_author", "regenera-substack": "regenera",
};
export const SAMPLE_PUBLICATION_CONFIG: PublicationConfig = { publications: PUBLICATIONS, publicationChannels: SAMPLE_PUBLICATION_CHANNELS };

/** The selected publication only; callers must never pass a private registry to a client component. */
export const substackEditorUrl = (publication: Publication, registry: PublicationRegistry = PUBLICATIONS): string => {
  if (!Object.hasOwn(registry, publication)) throw new Error("Publication is not configured");
  return `${registry[publication].url}/publish/post?type=newsletter`;
};
