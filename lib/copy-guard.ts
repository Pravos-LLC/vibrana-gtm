// Guards for copy that is about to be approved or published. An agent's note to John, written into the
// text while drafting ("[JOHN: add a scene here]"), must never reach a real post; and John writes American.

const AGENT_NOTE = /\[(?:JOHN|TODO|NOTE|REVIEWER|AGENT|CLAUDE|TBD|FIXME|PLACEHOLDER)\b[^\]]*\]/gi;

/** Every agent note or placeholder left in `text`, as written. */
export function findAgentNotes(text: string): string[] {
  return text.match(AGENT_NOTE) ?? [];
}

/** Throws when `text` still carries an agent note. `where` names the item or asset for the message. */
export function assertNoAgentNotes(where: string, text: string | undefined | null) {
  const notes = findAgentNotes(text ?? "");
  if (notes.length) throw new Error(`${where}: unresolved note to John in the text, resolve it before this goes out: ${notes.map((n) => n.slice(0, 80)).join(" | ")}`);
}

// British spellings John does not use. A warning, never an error: his own words ("a 3 metre set") stay his.
const BRITISH = /\b(?:realis(?:e|ed|es|ing|ation)|organis(?:e|ed|es|ing|ation)\w*|colour\w*|behaviour\w*|favour\w*|centre[sd]?|programme[sd]?|analys(?:e|ed|es|ing)|licen[c]e[sd]?|metres?|whilst|catalogue[sd]?|judgement|recognis\w+|optimis\w+|prioritis\w+|summaris\w+|customis\w+)\b/gi;

export function findBritishSpellings(text: string): string[] {
  return [...new Set((text.match(BRITISH) ?? []).map((w) => w.toLowerCase()))];
}
