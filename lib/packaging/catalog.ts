export { COVER_STYLES, HEADLINE_TYPES } from "./styles";
/** Composition is independent of brand, theme and editorial voice. */
export const TOOLKIT_VERSION = "1.1.0";
export const BRANDS = ["sample-author", "vibrana", "aios"] as const;
export type Brand = typeof BRANDS[number];
export type Theme = "light" | "dark";
export const SIZES = { landscape: [1920, 1080], portrait: [1080, 1920], square: [1080, 1080], feed: [1080, 1350] } as const;
export type Shape = keyof typeof SIZES;
export const TEMPLATES = {
  "clear-conversation": { name: "Clear Conversation", mood: "Warm / accessible", role: "Introduce one worthwhile conversation", mechanic: "Specific question", avoid: "Generic guest-name-only packaging" },
  "bold-statement": { name: "Bold Statement", mood: "Conviction", role: "Give a memorable claim visual weight", mechanic: "Concrete reveal", avoid: "A claim the cut cannot support" },
  "productive-tension": { name: "Productive Tension", mood: "Provocative / curious", role: "Make a real dilemma visible", mechanic: "Contrast", avoid: "Inventing disagreement between speakers" },
  "editorial-question": { name: "Editorial Question", mood: "Thoughtful", role: "Make an important question easy to grasp", mechanic: "Information gap", avoid: "Abstract questions without stakes" },
  "story-moment": { name: "Story Moment", mood: "Surprise / intimate", role: "Open a scene with an unresolved turn", mechanic: "Reported scene", avoid: "A twist the short never resolves" },
  "explain-mechanism": { name: "Explain the Mechanism", mood: "Practical / clear", role: "Show how an outcome happens", mechanic: "Mechanism reveal", avoid: "Several diagrams competing with the face" },
  "regenerative-possibility": { name: "Regenerative Possibility", mood: "Hopeful", role: "Connect an idea with a tangible possibility", mechanic: "Outcome and means", avoid: "Promising a completed result for a proposed project" },
} as const;
export type Template = keyof typeof TEMPLATES;
export type Profile = {
  name: string; defaultTheme: Theme; display: string; body: string;
  fonts: [string, string]; authority: string; voice: string; imagery: string;
  themes: Record<Theme, { bg: string; fg: string; muted: string; accent: string; positive: string }>;
};
export const PROFILES: Record<Brand, Profile> = {
  "sample-author": {
    name: "Sample Author Show", defaultTheme: "dark", display: "Clash Display", body: "Satoshi",
    fonts: ["clash-display.woff2", "satoshi.woff2"],
    authority: "sites/sample-author.com/DESIGN.md", voice: "sites/sample-author.com/writers-room/voice/style-guide.md",
    imagery: "Authentic source-frame faces; restrained Prism accents. Atmospheric plates optional, never blur the identifying face.",
    themes: { dark: { bg: "#050507", fg: "#ffffff", muted: "#bbb9c9", accent: "#8b5cf6", positive: "#4ade80" }, light: { bg: "#fafafa", fg: "#0f0f11", muted: "#555460", accent: "#7c3aed", positive: "#15803d" } },
  },
  vibrana: {
    name: "Vibrana", defaultTheme: "light", display: "Bricolage Grotesque", body: "Hanken Grotesk",
    fonts: ["bricolage.woff2", "hanken.woff2"],
    authority: "vibrana/brand.example.com/DESIGN.md", voice: "vibrana/brand.example.com/VOICE.md",
    imagery: "Orchid grade for atmospheric plates. Documentary speakers remain recognizable. See vibrana-imagery for plate creation.",
    themes: { dark: { bg: "#0b0b0f", fg: "#ffffff", muted: "#bebac8", accent: "#8b5cf6", positive: "#4ade80" }, light: { bg: "#ffffff", fg: "#0f0f11", muted: "#57515e", accent: "#7c3aed", positive: "#15803d" } },
  },
  aios: {
    name: "AIOS", defaultTheme: "dark", display: "Instrument Serif", body: "Instrument Sans",
    fonts: ["instrument-serif.woff2", "instrument-sans.woff2"],
    authority: "aios/aios-design/tokens/{color.light,color.dark,type}.json", voice: "aios/aios-marketing (current product voice)",
    imagery: "Editorial minimal; real artifacts, diagrams and people. Monochrome canonical logo; lime is an accent, never a logo tint.",
    themes: { dark: { bg: "#0b0b0b", fg: "#ffffff", muted: "#b8b8b8", accent: "#84cc16", positive: "#10b981" }, light: { bg: "#fafaf8", fg: "#1a1a1a", muted: "#57534e", accent: "#42680b", positive: "#047857" } },
  },
};
export function selectTemplate(text: string): Template {
  if (/crutch|versus|\bvs\b|dilemma/i.test(text)) return "productive-tension";
  if (/prophecy|stranger|story|cabin/i.test(text)) return "story-moment";
  if (/regenerat|land|grow/i.test(text)) return "regenerative-possibility";
  if (/how|mechanism|workflow/i.test(text)) return "explain-mechanism";
  if (/who owns|consent|question/i.test(text)) return "editorial-question";
  return "clear-conversation";
}
