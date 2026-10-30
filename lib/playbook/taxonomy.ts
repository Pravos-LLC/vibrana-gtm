import { loadContent } from "../../lib/content-overlay.mjs";
// The content canon's taxonomy (VIB-421): stable ids for hooks, storylines, CTAs and formats.
// content/guide/playbook-taxonomy.json is vendored verbatim from the hub skill
// (vibrana/.agents/skills/content-canon/references/taxonomy.json); scripts/guide-check.mjs fails when the two
// differ. Ids never change meaning; a retired id stays in the file with "retired": true and is never offered.
const taxonomyJson = loadContent("guide/playbook-taxonomy.json") as typeof import("../../content/sample/guide/playbook-taxonomy.json");

export type Awareness = "use" | "limit" | "avoid";
export type TaxonomyEntry = { id: string; name: string; definition: string; signals?: string[]; example_creators?: string[]; retired?: boolean };
export type CtaEntry = TaxonomyEntry & { awareness: Awareness; note?: string };
export type Taxonomy = { version: number; hooks: TaxonomyEntry[]; storylines: TaxonomyEntry[]; ctas: CtaEntry[]; formats: TaxonomyEntry[] };

export const TAXONOMY = taxonomyJson as Taxonomy;

const live = <T extends TaxonomyEntry>(list: T[]) => list.filter((e) => !e.retired);
export const HOOK_IDS = live(TAXONOMY.hooks).map((e) => e.id);
export const STORYLINE_IDS = live(TAXONOMY.storylines).map((e) => e.id);
export const CTA_IDS = live(TAXONOMY.ctas).map((e) => e.id);

const index = <T extends TaxonomyEntry>(list: T[]) => new Map(list.map((e) => [e.id, e]));
export const HOOKS = index(TAXONOMY.hooks);
export const STORYLINES = index(TAXONOMY.storylines);
export const CTAS = index(TAXONOMY.ctas);

/** The CTA's awareness-phase flag: `use` starts conversations, `limit` is a soft ask, `avoid` is a conversion ask or bait. */
export const ctaAwareness = (id: string): Awareness | null => CTAS.get(id)?.awareness ?? null;
