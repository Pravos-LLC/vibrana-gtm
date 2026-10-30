// The two Substacks John publishes to. Kept dependency-free so client components can import it.
export const PUBLICATIONS = {
  sample_author: { label: "Sample Author (personal Substack)", url: "https://sample_author.substack.com" },
  regenera: { label: "Regenera", url: "https://iamregenera.substack.com" },
} as const;
export type Publication = keyof typeof PUBLICATIONS;

/** Substack's editor for a new newsletter post on that publication: John pastes the export there. */
export const substackEditorUrl = (publication: Publication): string => `${PUBLICATIONS[publication].url}/publish/post?type=newsletter`;
