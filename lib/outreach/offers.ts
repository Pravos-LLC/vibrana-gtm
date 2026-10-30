import catalog from "../../config/outreach-offers.json";

export const OFFER_IDS = ["ai-readiness", "eu-ai-act-readiness", "simulator"] as const;
export type OfferId = typeof OFFER_IDS[number];
export type OfferChoice = OfferId | "none";
export type OfferOverride = OfferChoice | "auto";
export type Offer = typeof catalog.offers[number];
export type OfferSelection = { offer_id: OfferChoice; confidence: "high" | "medium" | "low"; evidence_ids: string[]; reason: string; uncertainty: string };
export const isOfferOverride = (value: unknown): value is OfferOverride => typeof value === "string" && ["auto", "none", ...OFFER_IDS].includes(value);
export const offerName = (id: OfferChoice) => catalog.offers.find((offer) => offer.id === id)?.name ?? "No offer: conversation opener";

/** Fail closed on missing, inactive or unreviewed definitions. Old CRM pitches never override product truth. */
export function activeOffers(source = catalog, now = Date.now()): Offer[] {
  const reviewed = Date.parse(source.reviewed_at);
  if (source.version !== 1 || !Number.isFinite(reviewed) || now - reviewed > 180 * 86_400_000 || reviewed > now + 86_400_000) throw new Error("The offer catalog needs review before drafting. Your text is safe.");
  if (new Set(source.offers.map((offer) => offer.id)).size !== source.offers.length) throw new Error("The offer catalog has duplicate identities.");
  return source.offers.filter((offer) => offer.active && OFFER_IDS.includes(offer.id as OfferId) && Number.isFinite(Date.parse(offer.reviewed_at)) && now - Date.parse(offer.reviewed_at) <= 180 * 86_400_000 && Date.parse(offer.reviewed_at) <= now + 86_400_000);
}

/** An explicit per-person assessment request cannot be silently reframed as the executive tool. */
export function eligibleOffers(offers: Offer[], evidence: Array<{ id: string; detail: string }>, override: OfferOverride) {
  if (override === "none") return { catalog: [] as Offer[], exclusions: [] as Array<{ offer_id: string; reason: string }> };
  if (override !== "auto") return { catalog: offers, exclusions: [] as Array<{ offer_id: string; reason: string }> };
  const jobs = evidence.filter(item => ["signal", "research-brief"].includes(item.id)).map(item => item.detail);
  const explicitIndividualJob = jobs.some(detail => detail.split(/[.!?;\n]/).some(sentence =>
    /\b(?:need|want|require|request|seeking|looking for)\b/i.test(sentence) && /\bassessments?\b/i.test(sentence) &&
    hasAffirmativeClaim(sentence, /\b(?:(?:each|every)[- ](?:employee|person|individual|team member)|per[- ](?:employee|person)|personali[sz]ed|department[- ]specific)\b/gi)));
  const unknownInitiative = jobs.some(detail => /\bno (?:current |known |active )*AI (?:initiative|project|program|need)s?\b/i.test(detail));
  const otherJob = jobs.some(detail => /\b(?:need|want|require|looking for|estimate|understand)\b[^.!?;]{0,100}\b(?:EU AI Act|business case|operating costs?|cost and capacity|organizational readiness|company-wide adoption)\b/i.test(detail));
  const reason = explicitIndividualJob ? "The stated job is individual or personalized departmental assessment, not one executive organizational result. No other tool need is evidenced." : "The research explicitly records no known current AI initiative and no evidenced tool need. A generic hire or geography alone does not justify an offer.";
  const exclusions = explicitIndividualJob || (unknownInitiative && !otherJob)
    ? offers.filter(offer => explicitIndividualJob && otherJob ? offer.id === "ai-readiness" : true).map(offer => ({ offer_id: offer.id, reason }))
    : [];
  return { catalog: offers.filter(offer => !exclusions.some(exclusion => exclusion.offer_id === offer.id)), exclusions };
}

export function selectionSchema(evidenceIds: string[], offers: Offer[], override: OfferOverride = "auto") {
  const choices = ["none", ...offers.map(offer => offer.id)].filter(id => override === "auto" || id === override);
  return { anyOf: choices.map(id => ({
    type: "object", additionalProperties: false,
    required: ["offer_id", "confidence", "evidence_ids", "reason", "uncertainty"],
    properties: {
      offer_id: { type: "string", enum: [id] },
      confidence: { type: "string", enum: id === "none" || override !== "auto" ? ["high", "medium", "low"] : ["high", "medium"] },
      evidence_ids: { type: "array", items: { type: "string", enum: evidenceIds.length ? evidenceIds : ["__none__"] }, minItems: id !== "none" && override === "auto" ? 1 : 0, maxItems: Math.min(5, evidenceIds.length) },
      reason: { type: "string", minLength: 10, maxLength: 500 },
      uncertainty: { type: "string", maxLength: 300 },
    },
  })) };
}

/** A qualification is not a positive promise. Contrast/conjunction boundaries reset negation. */
function hasAffirmativeClaim(text: string, pattern: RegExp): boolean {
  return [...text.matchAll(pattern)].some((match) => {
    const prefix = text.slice(Math.max(0, match.index! - 140), match.index);
    const clause = (prefix.split(/[.!?;:]|\b(?:but|however|and)\b/i).at(-1) ?? "").replace(/\bnot (?:only|just|merely)\b/gi, "");
    return !/\b(?:not|never|no|cannot|can['’]t|isn['’]t|doesn['’]t|without|rather than)\b[^.!?;]{0,100}$/i.test(clause);
  });
}

/** A no-offer opener can acknowledge the recipient's completed/requested assessment, never pitch ours. */
function namesResourceWithoutRecipientContext(text: string, allowTopicOnly = false): boolean {
  return text.split(/[.!?\n]/).some(sentence => {
    if (!catalog.offers.some(offer => sentence.toLowerCase().includes(offer.name.toLowerCase()))) return false;
    const recipient = /\b(?:you|your|their|they|curious|wondering)\b/i.test(sentence);
    const invitation = /\bour\b|\b(?:i|we) (?:have|built|offer|created|send|share)\b|\b(?:send|share|try|take|would|could|gives|produces|provides|maps|estimates|delivers|helps)\b/i.test(sentence);
    return invitation || (!recipient && !allowTopicOnly);
  });
}

/** Validate structured identity and claim ownership before any generated option reaches the editor. */
export function validateOfferResponse(raw: unknown, evidence: Set<string>, offers: Offer[], override: OfferOverride): OfferSelection {
  const value = raw as { selection?: OfferSelection; angles?: Array<Record<string, unknown>> };
  if (!Array.isArray(value?.angles) || value.angles.length !== 3) throw new Error("The model did not return three complete options. Try drafting again.");
  const s = value?.selection;
  const offer = offers.find((item) => item.id === s?.offer_id);
  if (!s || (s.offer_id !== "none" && !offer) || !["high", "medium", "low"].includes(s.confidence) || typeof s.reason !== "string" || s.reason.trim().length < 10 || typeof s.uncertainty !== "string" || !Array.isArray(s.evidence_ids) || s.evidence_ids.length > 5 || s.evidence_ids.some((id) => !evidence.has(id))) throw new Error("The model returned an unsupported offer decision. Try drafting again.");
  if (override !== "auto" && s.offer_id !== override) throw new Error("The draft did not honor your offer choice. Try drafting again.");
  if (offer && override === "auto" && s.confidence === "low") throw new Error("The offer choice was too uncertain. Choose no offer or retry with stronger evidence.");
  if (offer && !s.evidence_ids.length && override === "auto") throw new Error("The offer choice has no supporting evidence. Try drafting again or choose an offer.");
  for (const angle of value.angles ?? []) {
    if (angle.offer_id !== s.offer_id || !Array.isArray(angle.claim_ids) || angle.claim_ids.length > 2 || angle.claim_ids.some((id) => typeof id !== "string" || !offer || !Object.hasOwn(offer.claims, id))) throw new Error("The options mixed offers or used an unsupported claim. Try drafting again.");
    if (offer && typeof angle.body === "string") {
      const invitesResource = /\b(?:our|i (?:have|built|offer)|we (?:have|built|offer)|send|share|try|take)\b[^.!?]{0,100}\b(?:assessment|simulator|resource|tool)\b/i.test(angle.body);
      if (invitesResource && (!angle.body.toLowerCase().includes(offer.name.toLowerCase()) || !angle.claim_ids.length)) throw new Error("The draft did not clearly name the selected offer or its approved claim. Try drafting again.");
    }
    const text = [angle.subject, angle.body, angle.linkedin_note].join(". ");
    const productClaims = text.replace(/[^.!?]*\?/g, question => {
      const recipientQuestion = /\b(?:you|your|teams?|needs?|goal|looking)\b/i.test(question);
      const resource = catalog.offers.some(item => question.toLowerCase().includes(item.name.toLowerCase()));
      const promise = /\b(?:gives?|produces?|provides?|delivers?|offers?|generates?|certif(?:y|ies)|guarantees?)\b/i.test(question);
      return recipientQuestion && !resource && !promise ? "" : question;
    });
    const act = /\bEU AI Act\b|\bAI Act\b/i.test(text);
    const euAssessment = /\b(?:EU )?AI Act (?:Readiness )?assessment\b/i.test(text);
    const general = /(?<!Act )\bAI Readiness assessment\b/i.test(text);
    const simulator = /\b(?:AI Transformation )?Simulator\b/i.test(text);
    if ((s.offer_id !== "none" && ((euAssessment && s.offer_id !== "eu-ai-act-readiness") || (general && s.offer_id !== "ai-readiness") || (simulator && s.offer_id !== "simulator"))) || hasAffirmativeClaim(text, /\b(?:certif(?:y|ies|ied|ication|ying)|guarantee(?:d|s)?)\b/gi) || (/\b(?:December|Jan(?:uary)?|Feb(?:ruary)?|March|April|June|July|Aug(?:ust)?|Sept(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|20\d{2})\b/i.test(text) || /\b(?:(?:in|by|before|after|from|until|this|next)\s+May|May\s+(?:\d|deadline|rollout|obligation))\b/i.test(text)) && (act || /\b(?:deadline|rollout|obligation|compliance)\b/i.test(text))) throw new Error("A draft crossed an offer boundary or used an unreviewed regulatory date. Try drafting again.");
    if (s.offer_id === "none" && (namesResourceWithoutRecipientContext([angle.body, angle.linkedin_note].join(". ")) || namesResourceWithoutRecipientContext(String(angle.subject ?? ""), true))) throw new Error("A no-offer draft named a catalog resource. Try drafting again.");
    if (s.offer_id === "none" && /\b(?:free (?:readiness |AI )?(?:assessment|tool|resource)|(?:(?:i|we) have|offer|send|share|try|use|check|take|want|would|could)\b[^.!?]{0,60}\b(?:assessment|report|guide|simulator))\b/i.test(text)) throw new Error("A no-offer draft included a resource pitch. Try drafting again.");
    if (s.offer_id === "ai-readiness" && hasAffirmativeClaim(productClaims, /\b(?:(?:each|every|per)[- ](?:person|employee|individual|(?:member of (?:your|the) team)|(?:team member)|department)|individual(?:ized)? assessment|peer rank(?:ing)?|legal compliance|personali[sz]ed|tailored|department[- ]specific|(?:maps?|identif(?:y|ies)|determin(?:e|es))[^.!?]{0,50}obligations|applicable obligations)\b/gi)) throw new Error("The general assessment draft promised an unsupported outcome. Try drafting again.");
    if (s.offer_id === "eu-ai-act-readiness" && hasAffirmativeClaim(text, /\b(?:maturity score|transformation score|legal advice)\b/gi)) throw new Error("The EU assessment draft promised an unsupported outcome. Try drafting again.");
  }
  return { ...s, reason: s.reason.trim().slice(0, 500), uncertainty: s.uncertainty.trim().slice(0, 300) };
}
