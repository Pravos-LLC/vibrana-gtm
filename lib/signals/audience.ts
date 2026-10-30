// The audience-fit rubric, in one place (VIB-420). Both the Signal Desk brief (lib/signals/brief.ts) and the
// Sunday candidates' selection-time scorer (lib/candidates/fit.ts) use it, so a calibrated rubric replaces it
// everywhere without code changes.
//
// Calibration: when content/guide/audience-calibration.json exists (VIB-425 backtests audience fit against
// John's own LinkedIn history), its fields override the built-in ones below:
//   { "reader"?: string, "question"?: string, "rubric"?: string,
//     "examples"?: [{ "text": string, "audience_fit": number, "audience_reason"?: string }],
//     "min_audience_fit"?: number }
// Missing fields fall back to the built-in rubric; a missing or unreadable file means the built-in rubric.
import { loadContent } from "../content-overlay.mjs";

/** The reader every Vibrana post is written for (hub gtm/content/STRATEGY.md, "The goal"). */
const READER = "a founder, COO or people lead at a 50 to 500 person company who suspects they are behind on AI and doesn't know what good looks like";
const QUESTION = "would this reader change a decision, a budget, a hire or a conversation because of this story?";
const RUBRIC = `1 means clearly yes. 0 means it is for a different reader (developers choosing a tool, traders, researchers, people following a vendor's price list or a product launch). The regenerative thread (what AI does to people, power and the planet) counts as fit when this reader would feel it in their own company. Be strict: most AI news is not for this reader.`;

export type Calibration = {
  reader?: string; question?: string; rubric?: string; min_audience_fit?: number;
  examples?: { text: string; audience_fit: number; audience_reason?: string }[];
};
export type AudienceRubric = { reader: string; question: string; rubric: string; examples: NonNullable<Calibration["examples"]>; min_audience_fit: number | null; calibrated: boolean };

export const CALIBRATION_FILE = "content/guide/audience-calibration.json";

/** The rubric in force: the calibration file's fields where present, else the built-in rubric. */
export function audienceRubric(root = process.cwd()): AudienceRubric {
  const cal = loadContent("guide/audience-calibration.json") as Calibration;
  const str = (v: unknown, d: string) => (typeof v === "string" && v.trim() ? v.trim() : d);
  return {
    reader: str(cal.reader, READER), question: str(cal.question, QUESTION), rubric: str(cal.rubric, RUBRIC),
    examples: Array.isArray(cal.examples) ? cal.examples.filter((e) => e && typeof e.text === "string" && typeof e.audience_fit === "number").slice(0, 12) : [],
    min_audience_fit: typeof cal.min_audience_fit === "number" ? cal.min_audience_fit : null,
    calibrated: Object.keys(cal).length > 0,
  };
}

/** The instruction block both prompts embed. */
export function audienceInstructions(r = audienceRubric()): string {
  const examples = r.examples.length
    ? `\nCalibrated examples (from John's own posts):\n${r.examples.map((e) => `- fit ${e.audience_fit}: ${e.text.slice(0, 300)}${e.audience_reason ? ` (${e.audience_reason})` : ""}`).join("\n")}`
    : "";
  return `The reader is ${r.reader}. For audience_fit (0 to 1) ask: ${r.question} ${r.rubric}${examples}
For audience_reason write one plain sentence naming the decision the reader would change, or why they would not care. No em dashes.`;
}
