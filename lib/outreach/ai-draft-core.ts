import { assertLiveProvidersAllowed, providerFetch } from "../demo-safety";
import { activeOffers, eligibleOffers, selectionSchema, validateOfferResponse, type Offer, type OfferOverride, type OfferChoice, type OfferSelection } from "./offers-server";
import { guestRoute, scaffoldFor, type DossierRow, type Profile, type Route, type Track } from "./desk";
import { formatOutreachEmail, outreachSignature, stripLinks } from "./email-format";

export const OUTREACH_ANGLE_KEYS = ["light_touch", "direct_fit", "useful_value"] as const;
/** A podcast guest's three angles: their own work, the conversation John has in mind, and what he and they share. */
export const GUEST_ANGLE_KEYS = ["their_work", "the_conversation", "shared_ground"] as const;
export type OutreachAngleKey = (typeof OUTREACH_ANGLE_KEYS)[number] | (typeof GUEST_ANGLE_KEYS)[number];
export const angleKeysFor = (track: Track): readonly OutreachAngleKey[] => (track === "guest" ? GUEST_ANGLE_KEYS : OUTREACH_ANGLE_KEYS);

export type OutreachEvidence = { id: string; label: string; detail: string; url?: string; date?: string };
export type OutreachAngle = {
  offer_id?: OfferChoice;
  claim_ids?: string[];
  key: OutreachAngleKey;
  label: string;
  rationale: string;
  role_read: "likely_decision_maker" | "adjacent_influencer" | "unclear";
  role_evidence_ids: string[];
  evidence_ids: string[];
  subject: string;
  body: string;
  linkedin_note: string;
};
/** `run_id` names the stored baseline for learning from later edits. */
export type OutreachAngles = { angles: OutreachAngle[]; evidence: OutreachEvidence[]; selection?: OfferSelection; run_id?: string };

export type DraftContext = {
  recipient: { first_name: string; title: string; headline: string; about: string; recent_posts: Array<{ text: string; url: string; date: string }> };
  company: { name: string; description: string; industry: string; employees: string; ai_native: boolean | null };
  research: { problem: string; why_now: string; how_john_helps: string[]; door_questions: string[]; asset: { id: string; label: string; url: string } | null };
  signal: { text: string; date: string; type: string; evidence_id: string } | null;
  triggers: Array<{ id: string; date: string; summary: string; url: string }>;
  evidence: OutreachEvidence[];
  sender: { signature: string; positioning: string; point_of_view: string[]; verified_facts: string[]; proof: string[]; assets: Array<{ id: string; name: string; pitch: string; fits: string[] }>; asks: string[]; voice: string[] };
  offers?: { version: number; override: OfferOverride; catalog: Offer[]; exclusions?: Array<{ offer_id: string; reason: string }> };
  /** Podcast guests only: how they are reached, what the invitation is about, and John's own podcasting history. */
  guest?: GuestDraftContext;
};
export type GuestDraftContext = {
  route: Route; season: string; template: string; central_question: string; prompts: string[]; wisdom_angle: string;
  how_to_approach: string[]; warm_path: string; reach: { website: string; contact_line: string; organization: string };
  host_history: string[]; scaffold: string;
};

const clean = (value: unknown, max = 1000): string => value == null ? "" : (typeof value === "string" ? value : String(value)).trim().slice(0, max);
const list = (values: Array<string | null | undefined> | null | undefined, maxItems = 6, maxText = 600) =>
  (values ?? []).map((value) => clean(value, maxText)).filter(Boolean).slice(0, maxItems);

/** Build a bounded, minimal prompt context. Do not pass mailbox history or desk drafts to the model. */
export function outreachDraftContext(row: DossierRow, profile: Profile, override: OfferOverride = "auto"): DraftContext {
  const offers = row.track === "guest" ? [] : activeOffers();
  if (override !== "auto" && override !== "none" && !offers.some((offer) => offer.id === override)) throw new Error("That offer is unavailable. Choose another offer.");
  const dossier = row.dossier;
  const prospect = dossier.prospect ?? {};
  const company = dossier.company ?? {};
  const evidence: OutreachEvidence[] = [];
  const addEvidence = (item: OutreachEvidence) => {
    if (item.detail) evidence.push(item);
  };

  addEvidence({ id: "role", label: "CRM role", detail: clean(row.title || prospect.title, 300) });
  addEvidence({
    id: "company", label: "Company profile",
    detail: [clean(company.description, 700), clean(company.employees ?? prospect.employees, 80) ? `Headcount: ${clean(company.employees ?? prospect.employees, 80)}` : "", clean(company.industry ?? prospect.industry, 100), typeof company.ai_native === "boolean" ? `AI-native company: ${company.ai_native ? "yes" : "no"}` : ""].filter(Boolean).join(" · "),
  });
  if (dossier.person?.headline) addEvidence({ id: "linkedin-headline", label: "LinkedIn headline", detail: clean(dossier.person.headline, 350) });
  if (dossier.person?.about) addEvidence({ id: "linkedin-about", label: "LinkedIn about", detail: clean(dossier.person.about, 800) });
  if (dossier.signal?.text) addEvidence({ id: "signal", label: "Current signal", detail: clean(dossier.signal.text, 900), url: clean(dossier.signal.url, 1000), date: clean(dossier.signal.date, 80) });

  const triggers = (dossier.triggers ?? []).slice(0, 3).map((trigger, index) => {
    const id = `trigger-${index + 1}`;
    const summary = clean(trigger.summary, 800);
    addEvidence({ id, label: clean(trigger.subtype || trigger.family, 100) || `Trigger ${index + 1}`, detail: summary, url: clean(trigger.source_url, 1000), date: clean(trigger.event_date, 80) });
    return { id, date: clean(trigger.event_date, 80), summary, url: clean(trigger.source_url, 1000) };
  }).filter((trigger) => trigger.summary);

  for (const [index, source] of (dossier.sources ?? []).slice(0, 5).entries()) {
    addEvidence({
      id: `source-${index + 1}`, label: clean(source.title, 140) || `Source ${index + 1}`,
      detail: clean(source.text, 900), url: clean(source.url, 1000), date: clean(source.published, 80),
    });
  }

  const brief = dossier.brief ?? {};
  const briefDetail = [clean(brief.problem, 500), clean(brief.why_now, 500), clean(brief.problem_quote?.text, 350)].filter(Boolean).join(" ");
  addEvidence({ id: "research-brief", label: "Research brief", detail: briefDetail });

  const firstName = clean(prospect.first_name, 100) || clean(row.name.split(/\s+/)[0], 100);
  const recentPosts = (dossier.person?.recent_posts ?? []).slice(0, 3).map((post) => ({ text: clean(post.text, 700), url: clean(post.url, 1000), date: clean(post.date, 80) })).filter((post) => post.text);
  for (const [index, post] of recentPosts.entries()) addEvidence({ id: `linkedin-post-${index + 1}`, label: "LinkedIn post", detail: post.text, url: post.url, date: post.date });

  const candidates = eligibleOffers(offers, evidence, override);
  return {
    recipient: {
      first_name: firstName, title: clean(row.title || prospect.title, 200), headline: clean(dossier.person?.headline, 350),
      about: clean(dossier.person?.about, 1000), recent_posts: recentPosts,
    },
    company: {
      name: clean(row.company || company.name, 200), description: clean(company.description, 900),
      industry: clean(company.industry ?? prospect.industry, 150), employees: clean(company.employees ?? prospect.employees, 100),
      ai_native: typeof company.ai_native === "boolean" ? company.ai_native : null,
    },
    research: {
      problem: clean(brief.problem, 600), why_now: clean(brief.why_now, 600),
      how_john_helps: (brief.how_john_helps ?? []).map((item) => clean(item.text, 350)).filter(Boolean).slice(0, 4),
      door_questions: list(brief.door_questions, 4, 250),
      asset: brief.asset ? { id: clean(brief.asset.id, 80), label: clean(brief.asset.label, 160), url: clean(brief.asset.url, 400) } : null,
    },
    signal: dossier.signal?.text ? {
      text: clean(dossier.signal.text, 900), date: clean(dossier.signal.date, 80), type: clean(dossier.signal.type, 100), evidence_id: "signal",
    } : null,
    triggers,
    evidence,
    offers: { version: 1, override, ...candidates },
    sender: {
      signature: outreachSignature(profile.signature),
      positioning: clean(profile.positioning, 700), point_of_view: list(profile.point_of_view, 5, 300),
      verified_facts: (profile.facts ?? []).map((item) => clean(item.text, 350)).filter(Boolean).slice(0, 6),
      proof: (profile.proof ?? []).map((item) => clean(item.text, 300)).filter(Boolean).slice(0, 4),
      assets: candidates.catalog.map((offer) => ({ id: offer.id, name: offer.name, pitch: Object.values(offer.claims).join(" "), fits: offer.fits })),
      asks: list(profile.asks, 5, 200), voice: list(profile.voice, 8, 200),
    },
  };
}

/**
 * The context for a podcast guest: the generic dossier evidence (role, signal, sources), then what the guest dossier adds (the
 * wisdom angle, the central question, the prompts, the warm path, the protocol notes), how they are reached, John's podcasting
 * history and his guest-invite scaffold. Nothing else about John goes in: the model may claim only what is listed here.
 */
export function guestDraftContext(row: DossierRow, profile: Profile): DraftContext {
  const base = outreachDraftContext({ ...row, track: "guest" }, profile);
  const dossier = row.dossier;
  const g = dossier.guest ?? {};
  const evidence = [...base.evidence];
  const add = (item: OutreachEvidence) => { if (item.detail) evidence.push(item); };
  add({ id: "guest-wisdom", label: "Their work", detail: clean(g.wisdom_angle, 600) });
  add({ id: "guest-question", label: "The episode's central question", detail: clean(g.central_question, 400) });
  const prompts = list(g.prompts, 3, 300);
  add({ id: "guest-prompts", label: "Questions John could ask", detail: prompts.join(" | ") });
  add({ id: "guest-backup", label: "Another recent hook", detail: clean(g.backup_trigger, 500) });
  add({ id: "guest-warm-path", label: "Connections and warm path", detail: clean(g.warm_path, 700) });
  const approach = list([g.approach_note, g.protocol_note], 2, 700);
  const history = profile.podcast_history;
  const hostHistory = [
    ...(profile.facts ?? []).map((item) => clean(item.text, 350)).filter(Boolean),
    clean(history?.summary, 500),
    ...(history?.shows ?? []).map((show) => [clean(show.name, 120), clean(show.language, 40), show.host ? `host ${clean(show.host, 80)}` : "", clean(show.note, 250)].filter(Boolean).join(", ")),
    ...(history?.notable_guests ?? []).slice(0, 10).map((guest) => [clean(guest.name, 100), clean(guest.role, 150)].filter(Boolean).join(", ")),
  ].filter(Boolean).slice(0, 24);
  const scaffold = scaffoldFor(profile, dossier);
  return {
    ...base,
    offers: undefined,
    evidence,
    sender: { ...base.sender, assets: (profile.assets ?? []).slice(0, 5).map(item => ({ id: clean(item.id, 80), name: clean(item.name, 120), pitch: clean(item.pitch, 250), fits: list(item.fits, 6, 80) })), verified_facts: hostHistory.slice(0, 24) },
    guest: {
      route: guestRoute(dossier), season: clean(g.season, 80), template: clean(g.template, 10),
      central_question: clean(g.central_question, 400), prompts, wisdom_angle: clean(g.wisdom_angle, 600),
      how_to_approach: approach, warm_path: clean(g.warm_path, 700),
      reach: { website: clean(g.website, 300), contact_line: clean(g.contact_line, 400), organization: clean(row.company || dossier.prospect?.company, 200) },
      host_history: hostHistory, scaffold: scaffold ? clean(scaffold.body, 1800) : "",
    },
  };
}

export function schemaForEvidence(evidence: OutreachEvidence[], keys: readonly string[] = OUTREACH_ANGLE_KEYS, offers?: Offer[], override: OfferOverride = "auto") {
  const evidenceIds = evidence.map((item) => item.id);
  const roleEvidenceIds = evidenceIds.filter((id) => ["role", "linkedin-headline", "linkedin-about", "linkedin-post-1", "linkedin-post-2", "linkedin-post-3"].includes(id));
  return {
    type: "object", additionalProperties: false, required: offers ? ["selection", "angles"] : ["angles"],
    properties: {
      ...(offers ? { selection: selectionSchema(evidenceIds, offers, override) } : {}),
      angles: {
        type: "array", minItems: 3, maxItems: 3,
        items: {
          type: "object", additionalProperties: false,
          required: ["key", "label", "rationale", "role_read", "role_evidence_ids", "evidence_ids", "subject", "body", "linkedin_note", ...(offers ? ["offer_id", "claim_ids"] : [])],
          properties: {
            ...(offers ? { offer_id: { type: "string", enum: ["none", ...offers.map((offer) => offer.id)] }, claim_ids: { type: "array", items: { type: "string", enum: offers.length ? offers.flatMap((offer) => Object.keys(offer.claims)) : ["__none__"] }, maxItems: 2 } } : {}),
            key: { type: "string", enum: [...keys] },
            label: { type: "string", minLength: 2, maxLength: 80 },
            rationale: { type: "string", minLength: 10, maxLength: 500 },
            role_read: { type: "string", enum: ["likely_decision_maker", "adjacent_influencer", "unclear"] },
            role_evidence_ids: { type: "array", items: { type: "string", enum: roleEvidenceIds.length ? roleEvidenceIds : ["__none__"] }, maxItems: Math.min(3, roleEvidenceIds.length) },
            evidence_ids: { type: "array", items: { type: "string", enum: evidenceIds.length ? evidenceIds : ["__none__"] }, maxItems: Math.min(5, evidenceIds.length) },
            subject: { type: "string", minLength: 2, maxLength: 120 },
            body: { type: "string", minLength: 20, maxLength: 2400 },
            linkedin_note: { type: "string", minLength: 1, maxLength: 300 },
          },
        },
      },
    },
  } as const;
}

/** One schema branch binds the decision, all angle identities and claim IDs together. */
export function draftResponseSchema(context: DraftContext, keys: readonly string[] = OUTREACH_ANGLE_KEYS) {
  const base = schemaForEvidence(context.evidence, keys, context.offers?.catalog, context.offers?.override);
  if (!context.offers) return base;
  const { catalog, override } = context.offers;
  const selections = selectionSchema(context.evidence.map(item => item.id), catalog, override).anyOf;
  return {
    type: "object", additionalProperties: false, required: ["draft"],
    properties: { draft: { anyOf: selections.map(selection => {
      const id = selection.properties.offer_id.enum[0];
      const claims = Object.keys(catalog.find(offer => offer.id === id)?.claims ?? {});
      return {
        type: "object", additionalProperties: false, required: ["selection", "angles"],
        properties: {
          selection,
          angles: { ...base.properties.angles, items: { ...base.properties.angles.items, properties: {
            ...base.properties.angles.items.properties,
            offer_id: { type: "string", enum: [id] },
            claim_ids: { type: "array", items: { type: "string", enum: claims.length ? claims : ["__none__"] }, maxItems: claims.length ? 2 : 0 },
          } } },
        },
      };
    }) } },
  };
}

const noAiClaim = /\b(?:no ai (?:was )?(?:used|written)|written by human hands|human[- ]written)\b/i;
const dashFree = (text: string) => text.replace(/\s*[—–]\s*/g, ", ").replace(/,\s*([.?!])/g, "$1");

export function parseAngles(value: unknown, allowedEvidence: Set<string>, keyList: readonly string[] = OUTREACH_ANGLE_KEYS): OutreachAngle[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { angles?: unknown }).angles)) throw new Error("The drafting model returned an invalid response. Try again.");
  const angles = (value as { angles: unknown[] }).angles;
  if (angles.length !== 3) throw new Error("The drafting model did not return three complete options. Try again.");
  const keys = new Set<string>();
  const parsed = angles.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("The drafting model returned an invalid option. Try again.");
    const angle = raw as Record<string, unknown>;
    const key = angle.key;
    if (typeof key !== "string" || !keyList.includes(key) || keys.has(key)) throw new Error("The drafting model returned duplicate or unknown angles. Try again.");
    keys.add(key);
    const stringField = (field: string, max: number) => {
      const value = angle[field];
      if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("The drafting model returned an incomplete option. Try again.");
      const normalized = dashFree(value.trim());
      if (normalized.length > max) throw new Error("The drafting model returned an incomplete option. Try again.");
      return normalized;
    };
    const roleRead = angle.role_read;
    if (roleRead !== "likely_decision_maker" && roleRead !== "adjacent_influencer" && roleRead !== "unclear") throw new Error("The drafting model returned an invalid role assessment. Try again.");
    const body = stringField("body", 2400);
    const linkedinNote = stringField("linkedin_note", 300);
    if (noAiClaim.test(body) || noAiClaim.test(linkedinNote)) throw new Error("A draft contained an inaccurate authorship claim. Try generating again.");
    const evidenceIds = Array.isArray(angle.evidence_ids) ? angle.evidence_ids.filter((id): id is string => typeof id === "string" && allowedEvidence.has(id)).slice(0, 5) : [];
    const roleEvidenceIds = Array.isArray(angle.role_evidence_ids)
      ? angle.role_evidence_ids.filter((id): id is string => typeof id === "string" && ["role", "linkedin-headline", "linkedin-about", "linkedin-post-1", "linkedin-post-2", "linkedin-post-3"].includes(id) && allowedEvidence.has(id))
      : [];
    const supportedRoleRead: OutreachAngle["role_read"] = roleEvidenceIds.length ? roleRead : "unclear";
    return {
      ...(typeof angle.offer_id === "string" ? { offer_id: angle.offer_id as OfferChoice, claim_ids: angle.claim_ids as string[] } : {}),
      key: key as OutreachAngleKey,
      label: stringField("label", 80), rationale: stringField("rationale", 500),
      role_read: supportedRoleRead, role_evidence_ids: roleEvidenceIds, evidence_ids: evidenceIds,
      subject: stringField("subject", 120), body, linkedin_note: linkedinNote,
    };
  });
  return keyList.map((key) => parsed.find((angle) => angle.key === key)!);
}

export const outreachDraftModel = (model?: string) => model ?? process.env.OUTREACH_DRAFT_MODEL ?? "deepseek/deepseek-v4.1-flash";

export async function requestOutreachAngles(context: DraftContext, system: string, opts: { key?: string; model?: string; fetcher?: typeof fetch; timeoutMs?: number; keys?: readonly string[] } = {}): Promise<OutreachAngles> {
  const keys = opts.keys ?? OUTREACH_ANGLE_KEYS;
  assertLiveProvidersAllowed();
  const key = opts.key ?? process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not configured for the Writing Desk.");
  const model = outreachDraftModel(opts.model);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 45_000);
  try {
    const response = await providerFetch(opts.fetcher)("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-title": "Vibrana GTM Cockpit" },
      body: JSON.stringify({
        model, temperature: 0.6, max_tokens: 4500,
        ...(model === "deepseek/deepseek-v4.1-flash" ? { reasoning: { effort: "none" } } : {}),
        messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(context) }],
        response_format: { type: "json_schema", json_schema: { name: "outreach_angles", strict: true, schema: draftResponseSchema(context, keys) } },
        provider: { require_parameters: true },
      }), signal: controller.signal,
    });
    if (!response.ok) throw new Error(response.status === 402 ? "The drafting provider has no available credit. Your text is safe. Restore provider credit before retrying." : `OpenRouter request failed (HTTP ${response.status}).`);
    const envelope: unknown = await response.json();
    const choices = (envelope as { choices?: Array<{ message?: { content?: unknown } }> })?.choices;
    const content = choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("The drafting model returned no content. Try again.");
    let decoded: unknown;
    try { decoded = JSON.parse(content); } catch { throw new Error("The drafting model returned invalid JSON. Try again."); }
    // Guest output is unchanged; client output nests one coherent offer branch.
    if (context.offers && decoded && typeof decoded === "object" && "draft" in decoded) decoded = (decoded as { draft: unknown }).draft;
    const evidenceById = new Set(context.evidence.map((item) => item.id));
    const selection = context.offers ? validateOfferResponse(decoded, evidenceById, context.offers.catalog, context.offers.override) : undefined;
    return { ...(selection ? { selection } : {}), angles: parseAngles(decoded, evidenceById, keys).map((angle) => {
      const body = formatOutreachEmail(stripLinks(angle.body), context.sender.signature);
      if (noAiClaim.test(body)) throw new Error("A draft contained an inaccurate authorship claim. Try generating again.");
      return { ...angle, body, subject: stripLinks(angle.subject).trim() || angle.subject.replace(/\.[a-z]{2,}\b/gi, ""), linkedin_note: stripLinks(angle.linkedin_note) };
    }), evidence: context.evidence };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("The drafting request timed out. Try again.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
