"use client";
import { OFFER_IDS, offerName, type OfferOverride } from "@/lib/outreach/offers";

// /outreach/write: John reviews each client email and guest invitation (VIB-463: two streams,
// one screen). Left, the stream switch, both meters (each stream's sent today against its own target, always visible) and
// the queue (highest score first); center, the composer, autosaved to his desk draft; right, the dossier and his own profile.
// A guest is reached by email, a LinkedIn note or an intermediary, so the composer follows the route on the dossier.
// Hints are advice only: nothing here blocks a save or a send, and a client email's dashes are his own.
// Keyboard: J/K next and previous person, / search, G switch stream, Cmd/Ctrl+S save, Cmd/Ctrl+Enter mark sent (one step; Not sent undoes it).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Copy, ExternalLink, FileText, Link2, Mail, Search, SkipForward, Sparkles, Undo2, X } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toaster";
import { cn } from "@/lib/ui/cn";
import {
  applyLink, blankBody, bodyHtml, bodyLinks, bodyPlain, DESK_LABEL, DESK_LIMITS, deskEditProblems, deskState, FILTER_LABEL, FILTERS, firstName, followUpDue, gmailComposeUrl, guestRoute, hasLinks, hints, matchesFilter,
  needsRoute, normalizeLinkUrl, removeLink, ROUTE_LABEL, routeSendProblems, safeUrl, sameDeskEdit, scaffoldFor, sentToday, SLOT, TRACK_LABEL, TRACKS, WORDS,
  type DeskEdit, type DeskFilter, type DeskSettings, type DeskState, type DossierRow, type QueueItem, type Track,
} from "@/lib/outreach/desk";
import type { DeskPerson } from "@/lib/outreach/desk-store";
import type { Draft, DraftVersion } from "@/lib/outreach/model";
import { formatOutreachEmail } from "@/lib/outreach/email-format";
import type { OutreachAngles } from "@/lib/outreach/ai-draft";
import type { DeskResult, SentAngle } from "@/app/outreach/write/actions";
import { requestDeskAngles, DRAFT_WAIT_MS } from "@/lib/outreach/draft-request";
import { DraftProgress } from "./draft-progress";
import { copy, DeskDossier, ReachLinks } from "./desk-dossier";

/** Every action names the stream, so a person of the other stream is refused by the server rather than half-handled. */
export type DeskActions = {
  load: (id: string, track: Track) => Promise<DeskResult<DeskPerson>>;
  save: (id: string, edit: DeskEdit, track: Track) => Promise<DeskResult<Draft>>;
  generate?: (id: string, track: Track, signal?: AbortSignal, offerOverride?: OfferOverride) => Promise<DeskResult<OutreachAngles>>;
  markSent: (id: string, edit: DeskEdit, track: Track, angle?: SentAngle) => Promise<DeskResult<Draft>>;
  undoSent: (id: string, track: Track) => Promise<DeskResult<Draft>>;
  markInvite: (id: string, edit: DeskEdit, track: Track, angle?: SentAngle) => Promise<DeskResult<Draft>>;
  markFollowUp: (id: string, track: Track) => Promise<DeskResult<Draft>>;
  undoFollowUp: (id: string, track: Track) => Promise<DeskResult<Draft>>;
  skip: (id: string, reason: string, track: Track) => Promise<DeskResult<DossierRow>>;
  unskip: (id: string, track: Track) => Promise<DeskResult<DossierRow>>;
  setTarget: (n: number, track: Track) => Promise<DeskResult<number>>;
};

const AUTOSAVE_MS = 1200;
const field = "w-full rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-inset)] px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus-visible:border-violet focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 disabled:opacity-60";
const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.tagName === "SELECT" || el.isContentEditable);
};
const STATE_TONE: Record<DeskState, "outline" | "info" | "success" | "warning"> = { to_write: "outline", written: "info", sent: "success", skipped: "warning" };
/** The body to the clipboard as HTML (links stay links when pasted into Gmail) with a plain-text fallback. */
const copyBody = (body: string, done = "Body copied.") => {
  const html = bodyHtml(body), plain = bodyPlain(body);
  const write = typeof ClipboardItem !== "undefined" && navigator.clipboard?.write
    ? navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([plain], { type: "text/plain" }) })])
    : navigator.clipboard?.writeText(plain);
  void Promise.resolve(write).then(() => toast(done), () => toast("Could not copy the body."));
};
const editOf = (p: DeskPerson): DeskEdit => ({ to: p.start.to, subject: p.start.subject, body: p.start.body, linkedin_note: p.start.linkedin_note });

export function WritingDesk({ initialQueues, initialTrack, initialPerson, tracks, tz, actions }: {
  initialQueues: Record<Track, QueueItem[]>; initialTrack: Track; initialPerson: DeskPerson | null; tracks: Record<Track, DeskSettings>; tz: string; actions: DeskActions;
}) {
  const [track, setTrack] = useState<Track>(initialTrack);
  const [queues, setQueues] = useState(initialQueues);
  const [filter, setFilter] = useState<DeskFilter>("to_write");
  const [query, setQuery] = useState("");
  const [person, setPerson] = useState<DeskPerson | null>(initialPerson);
  const [loading, setLoading] = useState(false);
  const [edit, setEdit] = useState<DeskEdit | null>(initialPerson ? editOf(initialPerson) : null);
  const [saved, setSaved] = useState<DeskEdit | null>(initialPerson ? editOf(initialPerson) : null);
  const [draft, setDraft] = useState<Draft | null>(initialPerson?.draft ?? null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [offerOverride, setOfferOverride] = useState<OfferOverride>("auto");
  const preserveOfferEdit = useRef(false);
  const [generatedOfferOverride, setGeneratedOfferOverride] = useState<OfferOverride>("auto");
  const [angles, setAngles] = useState<OutreachAngles | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generationPhase, setGenerationPhase] = useState<"saving" | "drafting">("saving");
  const generationController = useRef<AbortController | null>(null);
  const [activeAngleKey, setActiveAngleKey] = useState<string | null>(null);
  const [switchingAngle, setSwitchingAngle] = useState(false);
  const angleEdits = useRef<Record<string, DeskEdit>>({});
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [skipping, setSkipping] = useState(false);
  const [skipReason, setSkipReason] = useState("");
  const [targets, setTargets] = useState<Record<Track, number>>({ client: tracks.client.daily_target, guest: tracks.guest.daily_target });
  const [editingTarget, setEditingTarget] = useState<Track | null>(null);
  const [linking, setLinking] = useState<{ start: number; end: number; url: string } | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLTextAreaElement>(null);
  const generationRunId = useRef(0);

  // Refs for the async paths, so a save that finishes after John moved on never writes into the next person.
  const personRef = useRef(person); personRef.current = person;
  const editRef = useRef(edit); editRef.current = edit;
  const savedRef = useRef(saved); savedRef.current = saved;
  const trackRef = useRef(track); trackRef.current = track;
  const queuesRef = useRef(queues); queuesRef.current = queues;
  const inflight = useRef<Promise<boolean> | null>(null);

  const guest = track === "guest";
  const queue = queues[track];
  const profile = tracks[track].profile;
  const from = tracks[track].from_address;
  const id = person?.row.twenty_person_id ?? null;
  const item = queue.find((q) => q.twenty_person_id === id) ?? null;
  const state: DeskState | null = person ? deskState(item ?? person.row, draft, track) : null;
  // A client's email, or any of a guest's routes: once it is sent the text is final.
  const emailSent = guest
    ? draft?.email_status === "sent" || draft?.email_status === "replied" || draft?.linkedin_status === "sent" || draft?.linkedin_status === "connected"
    : draft?.email_status === "sent" || draft?.email_status === "replied";
  const inviteSent = draft?.linkedin_status === "sent" || draft?.linkedin_status === "connected";
  const clientCheckPassed = person?.row.dossier.client_check?.ok === true;
  const route = guest && person ? guestRoute(person.row.dossier) : "email";
  const followedUp = draft?.follow_up_status === "sent";
  const dirty = !!edit && !!saved && !sameDeskEdit(edit, saved);
  const problems = edit ? deskEditProblems(edit) : [];
  const hint = edit ? hints(edit, profile.signature, track) : null;
  const links = edit ? bodyLinks(edit.body) : [];
  // The tab names the person, so several desk tabs can be told apart. Next rewrites the title on a fresh load and on every
  // refresh, so this puts it back whenever the head changes.
  const tabTitle = person ? `Desk: ${person.row.name || "Person"}` : "Writing desk";
  useEffect(() => {
    const set = () => { if (document.title !== tabTitle) document.title = tabTitle; };
    set();
    const watch = new MutationObserver(set);
    watch.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => watch.disconnect();
  }, [tabTitle]);
  // Grow with the email so the signature and P.S. are never hidden in an inner scrollbar.
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const fit = () => { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; };
    fit();
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth !== width) { width = el.clientWidth; fit(); }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [edit?.body, guest, person?.row.twenty_person_id]);
  const assets = (profile.assets ?? []).filter((a) => safeUrl(a.url));
  const scaffold = guest && person && route !== "linkedin" ? scaffoldFor(profile, person.row.dossier) : null;
  const slots = guest && edit ? [...new Set(edit.body.match(SLOT) ?? [])] : [];
  const now = new Date();

  // Cmd/Ctrl+K in the body: link the selection (or the link the cursor is in).
  const openLink = (el: HTMLTextAreaElement) => {
    const { selectionStart: start, selectionEnd: end } = el;
    const inside = bodyLinks(el.value).find((l) => start >= l.start && end <= l.end && (start < l.end || start === end));
    setLinking({ start, end, url: inside?.url ?? "" });
  };
  const closeLink = (sel?: { start: number; end: number }) => {
    setLinking(null);
    requestAnimationFrame(() => { const el = body.current; if (!el) return; el.focus(); if (sel) el.setSelectionRange(sel.start, sel.end); });
  };
  const commitLink = (raw: string, label = "") => {
    if (!edit || !linking) return;
    const url = normalizeLinkUrl(raw);
    if (!url) { toast("That is not a web address."); return; }
    const r = applyLink(edit.body, linking.start, linking.end, url, label);
    setEdit({ ...edit, body: r.body });
    closeLink({ start: r.cursor, end: r.cursor });
  };

  const activeAngle = angles?.angles.find((angle) => angle.key === activeAngleKey) ?? null;
  const activeAngleIndex = angles?.angles.findIndex((angle) => angle.key === activeAngleKey) ?? -1;
  const stopGeneration = () => {
    generationRunId.current++;
    generationController.current?.abort();
    setGenerating(false);
    setGenerationError("Stopped waiting. Your text is unchanged. The server may finish its bounded request, but its result will not be applied.");
  };
  useEffect(() => () => { generationRunId.current++; generationController.current?.abort(); }, []);

  const generateAngles = async () => {
    if (!person || !clientCheckPassed || emailSent || generating || switchingAngle) return;
    const personId = person.row.twenty_person_id;
    const requestId = ++generationRunId.current;
    generationController.current?.abort();
    const controller = new AbortController();
    generationController.current = controller;
    setGenerating(true); setGenerationPhase("saving"); setGenerationError(null);
    // Covers saving, network transit and server work, not just the model request.
    const deadline = setTimeout(() => {
      if (generationRunId.current !== requestId) return;
      generationRunId.current++;
      controller.abort();
      setGenerating(false);
      setGenerationError("No drafts arrived within 60 seconds. The request may have stalled while saving, connecting, or drafting. Your text is safe. Try again or keep writing.");
    }, DRAFT_WAIT_MS);
    const before = editRef.current;
    const preserveEditor = Boolean(angles) || preserveOfferEdit.current || Boolean(draft) || Boolean(before && !sameDeskEdit(before, editOf(person)));
    try {
      if (!(await flush())) {
        if (generationRunId.current === requestId) setGenerationError("Drafting did not start because your changes could not be saved. Resolve the save error below, then try again.");
        return;
      }
      if (generationRunId.current !== requestId || personRef.current?.row.twenty_person_id !== personId) return;
      setGenerationPhase("drafting");
      const result = await (actions.generate ?? requestDeskAngles)(personId, track, controller.signal, offerOverride);
      if (generationRunId.current !== requestId || personRef.current?.row.twenty_person_id !== personId) return;
      if (!result.ok) { setGenerationError(result.error); return; }
      setAngles(result.value);
      setGeneratedOfferOverride(offerOverride);
      angleEdits.current = {};
      setActiveAngleKey(null);
      // A person can keep writing while the request runs. Never replace those newer edits.
      if (!preserveEditor && before && editRef.current && sameDeskEdit(before, editRef.current)) {
        if (!(await flush()) || generationRunId.current !== requestId || personRef.current?.row.twenty_person_id !== personId || !editRef.current || !sameDeskEdit(before, editRef.current)) return;
        const first = result.value.angles[0];
        const next = { ...editRef.current, subject: first.subject, body: formatOutreachEmail(first.body, profile.signature), linkedin_note: first.linkedin_note };
        editRef.current = next; setEdit(next); setActiveAngleKey(first.key);
        angleEdits.current[first.key] = next;
      }
    } catch {
      if (generationRunId.current === requestId && personRef.current?.row.twenty_person_id === personId) setGenerationError("The drafting request failed. Try again.");
    } finally {
      clearTimeout(deadline);
      if (generationRunId.current === requestId && personRef.current?.row.twenty_person_id === personId) setGenerating(false);
    }
  };

  const selectAngle = async (key: string) => {
    if (!angles || !editRef.current || emailSent || generating || switchingAngle || key === activeAngleKey) return;
    const angle = angles.angles.find((option) => option.key === key);
    if (!angle) return;
    const personId = personRef.current?.row.twenty_person_id;
    const runId = generationRunId.current;
    const before = editRef.current;
    if (activeAngleKey) angleEdits.current[activeAngleKey] = before;
    setSwitchingAngle(true);
    try {
      if (!(await flush())) return;
      if (runId !== generationRunId.current || personId !== personRef.current?.row.twenty_person_id || !editRef.current) return;
      // Editing during a pending save must never be overwritten by a late angle switch.
      if (!sameDeskEdit(before, editRef.current)) return;
      const next = { ...(angleEdits.current[key] ?? { ...before, subject: angle.subject, body: formatOutreachEmail(angle.body, profile.signature), linkedin_note: angle.linkedin_note }), to: before.to };
      editRef.current = next; setEdit(next); setActiveAngleKey(key); setError(null);
    } finally {
      if (runId === generationRunId.current) setSwitchingAngle(false);
    }
  };

  const formatEmail = async () => {
    if (!editRef.current || emailSent) return;
    const before = editRef.current;
    const personId = personRef.current?.row.twenty_person_id;
    if (!(await flush()) || personId !== personRef.current?.row.twenty_person_id || !editRef.current || !sameDeskEdit(before, editRef.current)) return;
    const next = { ...before, body: formatOutreachEmail(before.body, profile.signature) };
    editRef.current = next; setEdit(next);
  };
  // Both streams' progress is always on screen: each is counted on John's calendar day, against its own target.
  const todays: Record<Track, number> = { client: sentToday(queues.client, tz, "client"), guest: sentToday(queues.guest, tz, "guest") };
  const today = todays[track], target = targets[track];
  const otherTrack: Track = guest ? "client" : "guest";
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return queue.filter((i) => (q ? `${i.name} ${i.company} ${i.title} ${i.domain ?? ""}`.toLowerCase().includes(q) : matchesFilter(i, filter, tz)));
  }, [queue, filter, query, tz]);

  const patchQueue = useCallback((personId: string, d: Draft | null, row?: Partial<DossierRow>) => {
    const patch = (list: QueueItem[]) => list.map((q) => {
      if (q.twenty_person_id !== personId) return q;
      const next = { ...q, ...(row ? { skipped_at: row.skipped_at ?? null, skip_reason: row.skip_reason ?? "" } : {}) };
      const dd = d ?? (q.draft_id ? { status: q.status!, email_status: q.email_status!, linkedin_status: q.linkedin_status!, email_sent_at: q.email_sent_at, linkedin_sent_at: q.linkedin_sent_at, follow_up_status: q.follow_up_status, follow_up_sent_at: q.follow_up_sent_at } : null);
      if (d) Object.assign(next, {
        draft_id: d.id, status: d.status, email_status: d.email_status, linkedin_status: d.linkedin_status, email_sent_at: d.email_sent_at ?? null,
        linkedin_sent_at: d.linkedin_sent_at ?? null, follow_up_status: d.follow_up_status ?? null, follow_up_sent_at: d.follow_up_sent_at ?? null,
      });
      return { ...next, state: deskState(next, dd, q.track) };
    });
    setQueues((cur) => ({ client: patch(cur.client), guest: patch(cur.guest) }));
  }, []);

  /** Save now if anything changed. Resolves false when the text can't be saved (it says why). */
  const flush = useCallback(async (): Promise<boolean> => {
    while (inflight.current) await inflight.current;
    const p = personRef.current, e = editRef.current, s = savedRef.current;
    if (!p || !e || !s || sameDeskEdit(e, s)) return true;
    const bad = deskEditProblems(e);
    if (bad.length) { setSaveState("error"); setError(bad.join(" ")); return false; }
    const pid = p.row.twenty_person_id;
    setSaveState("saving");
    const run = (async () => {
      let r;
      try { r = await actions.save(pid, e, p.row.track); }
      catch {
        if (personRef.current?.row.twenty_person_id === pid) {
          setSaveState("error"); setError("Could not save your draft. Check your connection and try again. Your text is still here.");
        }
        return false;
      }
      if (personRef.current?.row.twenty_person_id !== pid) return r.ok;
      if (!r.ok) { setSaveState("error"); setError(r.error); return false; }
      savedRef.current = e;
      setSaved(e); setDraft(r.value); setSaveState("saved"); setError(null);
      patchQueue(pid, r.value);
      return true;
    })();
    inflight.current = run;
    try { return await run; } finally { inflight.current = null; }
  }, [actions, patchQueue]);

  // Autosave, debounced.
  useEffect(() => {
    if (!dirty || problems.length || emailSent) return;
    const t = setTimeout(() => { void flush(); }, AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [edit, dirty, problems.length, emailSent, flush]);

  // Leaving with unsaved text asks first.
  useEffect(() => {
    const onUnload = (ev: BeforeUnloadEvent) => { if (editRef.current && savedRef.current && !sameDeskEdit(editRef.current, savedRef.current)) { ev.preventDefault(); } };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  const setUrl = (t: Track, personId: string | null) => {
    const url = new URL(window.location.href);
    url.searchParams.set("t", t);
    if (personId) url.searchParams.set("p", personId); else url.searchParams.delete("p");
    window.history.replaceState(null, "", url.toString());
  };

  const open = useCallback(async (personId: string, t: Track = trackRef.current) => {
    if (personId === personRef.current?.row.twenty_person_id) return;
    if (!(await flush())) { toast("Not saved yet: fix the note above before moving on."); return; }
    generationRunId.current++;
    generationController.current?.abort();
    setOfferOverride("auto"); preserveOfferEdit.current = false;
    setLoading(true); setSkipping(false); setError(null); setAngles(null); setActiveAngleKey(null); angleEdits.current = {}; setSwitchingAngle(false); setGenerationError(null); setGenerating(false);
    const r = await actions.load(personId, t);
    setLoading(false);
    if (!r.ok) { setError(r.error); return; }
    const start = editOf(r.value);
    personRef.current = r.value; editRef.current = start; savedRef.current = start;
    setPerson(r.value); setEdit(start); setSaved(start); setDraft(r.value.draft); setSaveState("idle");
    setUrl(t, personId);
  }, [actions, flush]);

  /** Switch stream (G): the first person still to write there, else the first. Unsaved text is saved first. */
  const switchTrack = useCallback(async (t: Track) => {
    if (t === trackRef.current) return;
    if (!(await flush())) { toast("Not saved yet: fix the note above before moving on."); return; }
    trackRef.current = t;
    generationRunId.current++;
    generationController.current?.abort();
    setOfferOverride("auto"); preserveOfferEdit.current = false;
    setTrack(t); setFilter("to_write"); setQuery(""); setSkipping(false); setError(null); setAngles(null); setActiveAngleKey(null); angleEdits.current = {}; setSwitchingAngle(false); setGenerationError(null); setGenerating(false);
    const list = queuesRef.current[t];
    const first = list.find((q) => q.state === "to_write") ?? list[0];
    if (first) { await open(first.twenty_person_id, t); return; }
    personRef.current = null; editRef.current = null; savedRef.current = null;
    setPerson(null); setEdit(null); setSaved(null); setDraft(null); setSaveState("idle");
    setUrl(t, null);
  }, [flush, open]);

  const step = useCallback((dir: 1 | -1) => {
    if (!visible.length) return;
    const at = visible.findIndex((v) => v.twenty_person_id === personRef.current?.row.twenty_person_id);
    const next = at < 0 ? (dir === 1 ? 0 : visible.length - 1) : Math.min(visible.length - 1, Math.max(0, at + dir));
    void open(visible[next].twenty_person_id);
    document.querySelector(`[data-person="${visible[next].twenty_person_id}"]`)?.scrollIntoView({ block: "nearest" });
  }, [visible, open]);

  /** The generated angle in the editor, so the server can diff what John sends against it. None once he cleared the angles. */
  const sentAngle = (): SentAngle | undefined => (angles?.run_id && activeAngleKey ? { run_id: angles.run_id, key: activeAngleKey } : undefined);

  const markSent = async () => {
    if (!person || !edit) return;
    const bad = [...deskEditProblems(edit), ...routeSendProblems(edit, route)];
    if (bad.length) { setError(bad.join(" ")); return; }
    const pid = person.row.twenty_person_id;
    const before = queue;
    const r = await actions.markSent(pid, edit, track, sentAngle());
    if (!r.ok) { setQueues((cur) => ({ ...cur, [track]: before })); setError(r.error); return; }
    savedRef.current = edit; setSaved(edit); setDraft(r.value); setError(null);
    patchQueue(pid, r.value);
    toast(`Marked sent. ${today + 1} of ${target} today.`);
    // On to the next person still to write, in queue order.
    const order = queue.filter((q) => q.state === "to_write" && q.twenty_person_id !== pid);
    const at = queue.findIndex((q) => q.twenty_person_id === pid);
    const next = order.find((q) => queue.indexOf(q) > at) ?? order[0];
    if (next && filter === "to_write" && !query) void open(next.twenty_person_id);
  };

  const markSentRef = useRef(markSent);
  markSentRef.current = markSent;

  const undoSent = async () => {
    if (!person) return;
    const r = await actions.undoSent(person.row.twenty_person_id, track);
    if (!r.ok) { setError(r.error); return; }
    setDraft(r.value); patchQueue(person.row.twenty_person_id, r.value);
    toast("Marked not sent.");
  };

  const markInvite = async () => {
    if (!person || !edit) return;
    const r = await actions.markInvite(person.row.twenty_person_id, edit, track, sentAngle());
    if (!r.ok) { setError(r.error); return; }
    savedRef.current = edit; setSaved(edit); setDraft(r.value); setError(null);
    patchQueue(person.row.twenty_person_id, r.value);
    toast("LinkedIn invite marked sent.");
  };

  /** The single follow-up (guests): marked separately, so it never counts toward the target. */
  const markFollowUp = async (undo = false) => {
    if (!person) return;
    const r = await (undo ? actions.undoFollowUp : actions.markFollowUp)(person.row.twenty_person_id, track);
    if (!r.ok) { setError(r.error); return; }
    setDraft(r.value); patchQueue(person.row.twenty_person_id, r.value); setError(null);
    toast(undo ? "Follow-up marked not sent." : "Follow-up marked sent. It does not count toward today.");
  };

  const skip = async () => {
    if (!person) return;
    const r = await actions.skip(person.row.twenty_person_id, skipReason, track);
    setSkipping(false); setSkipReason("");
    if (!r.ok) { setError(r.error); return; }
    setPerson({ ...person, row: { ...person.row, ...r.value } });
    patchQueue(person.row.twenty_person_id, null, r.value);
    toast("Skipped.");
  };
  const unskip = async () => {
    if (!person) return;
    const r = await actions.unskip(person.row.twenty_person_id, track);
    if (!r.ok) { setError(r.error); return; }
    setPerson({ ...person, row: { ...person.row, ...r.value } });
    patchQueue(person.row.twenty_person_id, null, r.value);
  };

  const saveTarget = async (t: Track, n: number) => {
    setEditingTarget(null);
    if (!Number.isInteger(n) || n < 1 || n === targets[t]) return;
    const before = targets[t];
    setTargets((cur) => ({ ...cur, [t]: n }));
    const r = await actions.setTarget(n, t);
    if (!r.ok) { setTargets((cur) => ({ ...cur, [t]: before })); toast(r.error); }
  };

  /** Drop the guest's scaffold (profile.templates) in: replaces an untouched body, else goes in at the cursor. The first slot is selected. */
  const insertTemplate = () => {
    if (!edit || !person || !scaffold) return;
    const el = body.current;
    const blank = blankBody(firstName(person.row.dossier), profile.signature).trim();
    const untouched = !edit.body.trim() || edit.body.trim() === blank;
    const at = el && !untouched ? el.selectionStart : 0;
    const next = untouched ? scaffold.body : edit.body.slice(0, at) + scaffold.body + edit.body.slice(el?.selectionEnd ?? at);
    setEdit({ ...edit, subject: edit.subject || scaffold.subject, body: next });
    selectSlot(next, at);
  };
  /** Select the slot that starts at `from` in the body (or the first one at or after it), so he can type over it. */
  const selectSlot = (text: string, from: number) => {
    requestAnimationFrame(() => {
      const el = body.current;
      if (!el) return;
      const m = [...text.matchAll(SLOT)].find((x) => x.index! >= Math.max(0, from));
      el.focus();
      if (m) el.setSelectionRange(m.index!, m.index! + m[0].length);
    });
  };

  // Keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); void flush().then((ok) => ok && toast("Saved.")); return; }
      if (mod && e.key === "Enter") { e.preventDefault(); if (person && !emailSent) void markSentRef.current(); return; }
      if (e.key === "Escape" && e.target === search.current) { search.current?.blur(); return; }
      if (typing(e.target) || mod || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "j" || k === "k") { e.preventDefault(); step(k === "j" ? 1 : -1); return; }
      if (k === "g") { e.preventDefault(); void switchTrack(trackRef.current === "client" ? "guest" : "client"); return; }
      if (e.key === "/") { e.preventDefault(); search.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flush, step, switchTrack, person, emailSent]);

  const chip = (on: boolean) => cn("rounded-full border px-2.5 py-0.5 text-xs", on ? "border-violet bg-violet/10 text-ink" : "border-line text-ink-2 hover:text-ink");
  const linkedinUrl = safeUrl(person?.row.dossier?.prospect?.linkedin_url);
  const clientBad = person?.row.dossier?.client_check?.ok === false;
  const guestInfo = person?.row.dossier?.guest;
  const sentLabel = route === "linkedin" ? "LinkedIn note sent" : route === "intermediary" ? "Sent via an intermediary" : "Email sent";
  const sentAt = draft?.email_sent_at ?? draft?.linkedin_sent_at ?? null;
  const stamp = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  const due = !!item && guest && followUpDue(item, tz, now);
  const showEmailFields = route !== "linkedin";
  const showNoteBox = !guest || route === "linkedin";
  const gmailHref = edit ? gmailComposeUrl(edit, from) : "#";

  const meter = (t: Track) => {
    const n = todays[t], goal = targets[t], done = n >= goal;
    return (
      <div key={t} className={cn("space-y-1", t !== "client" && "border-t border-line pt-2")} data-testid={`desk-meter-${t}`} data-done={done ? "true" : undefined}>
        <div className="flex items-baseline justify-between text-sm">
          <span className={cn("text-ink", t !== track && "opacity-80")}>
            <span className="text-ink-2">{TRACK_LABEL[t]}</span>{" "}
            <span className="font-display text-xl font-semibold tabular-nums">{n}</span><span className="text-ink-3">/{goal}</span>
            {done && <Check className="ml-1 inline size-3.5 text-[color:var(--emerald)]" aria-label="Done for today" />}
          </span>
          {editingTarget === t
            ? <input type="number" min={1} max={200} defaultValue={goal} autoFocus aria-label={`${TRACK_LABEL[t]} daily target`} className="h-7 w-16 rounded-md border border-input bg-[color:var(--surface-inset)] px-2 text-xs text-ink"
                onBlur={(e) => void saveTarget(t, Number(e.currentTarget.value))} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setEditingTarget(null); }} />
            : <button type="button" onClick={() => setEditingTarget(t)} aria-label={`${TRACK_LABEL[t]} target ${goal}`} className="text-xs text-ink-3 underline-offset-4 hover:text-ink hover:underline">Target {goal}</button>}
        </div>
        <div className="h-1.5 rounded-full bg-surface-overlay"><div className={cn("h-1.5 rounded-full", done ? "bg-[color:var(--emerald)]" : "bg-violet")} style={{ width: `${Math.min(100, Math.round((n / Math.max(1, goal)) * 100))}%` }} /></div>
      </div>
    );
  };

  return (
    <div className="grid gap-4 lg:h-[calc(100dvh-7rem)] lg:grid-cols-[14rem_minmax(0,1fr)] xl:grid-cols-[13rem_minmax(0,1fr)_20rem] 2xl:grid-cols-[15rem_minmax(0,1fr)_minmax(22rem,28rem)]">
      {/* Queue */}
      <aside className="flex min-h-0 flex-col gap-3 lg:overflow-hidden" aria-label="Queue">
        <div role="tablist" aria-label="Stream" className="flex gap-1.5" data-testid="desk-streams">
          {TRACKS.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={t === track} onClick={() => void switchTrack(t)} className={cn(chip(t === track), "flex-1 text-center")}>{TRACK_LABEL[t]}</button>
          ))}
          <kbd className="pointer-events-none self-center rounded border border-line px-1 font-mono text-[0.65rem] text-ink-3" title="G switches stream">g</kbd>
        </div>
        <div className="space-y-2 rounded-lg border border-line bg-[color:var(--surface-raised)] p-3" data-testid="desk-progress">
          {TRACKS.map(meter)}
        </div>
        <label className="relative block">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" />
          <input ref={search} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name or company" aria-label="Search"
            className="h-9 w-full rounded-md border border-input bg-[color:var(--surface-inset)] pl-8 pr-8 text-sm text-ink placeholder:text-ink-3 focus-visible:border-violet focus-visible:outline-none" />
          <kbd className="pointer-events-none absolute right-2 top-2 rounded border border-line px-1 font-mono text-[0.65rem] text-ink-3">/</kbd>
        </label>
        <nav className="flex flex-wrap gap-1.5" aria-label="Filters">
          {FILTERS[track].map((f) => <button key={f} type="button" className={chip(!query && filter === f)} onClick={() => { setFilter(f); setQuery(""); }}>{FILTER_LABEL[f]} <span className="font-mono">{queue.filter((i) => matchesFilter(i, f, tz, now)).length}</span></button>)}
        </nav>
        <ol className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1" data-testid="desk-queue">
          {visible.map((q) => (
            <li key={q.twenty_person_id}>
              <button type="button" data-person={q.twenty_person_id} onClick={() => void open(q.twenty_person_id)} aria-current={q.twenty_person_id === id ? "true" : undefined}
                className={cn("w-full rounded-md border px-2.5 py-2 text-left transition-colors", q.twenty_person_id === id ? "border-violet/50 bg-violet/10" : "border-transparent hover:bg-[color:var(--surface-card-hover)]")}>
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium text-ink">{q.name || q.twenty_person_id}</span>
                  {q.score != null && <span className="shrink-0 font-mono text-xs text-ink-3">{Math.round(Number(q.score))}</span>}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-xs text-ink-2">{q.company}</span>
                  {q.client_ok === false && <AlertTriangle className="size-3 shrink-0 text-red-strong" aria-label="Client check did not pass" />}
                  {guest && needsRoute(q) && <Badge variant="warning" className="px-1.5 py-0 text-[0.65rem]">Route</Badge>}
                  {guest && followUpDue(q, tz, now) && <Badge variant="info" className="px-1.5 py-0 text-[0.65rem]">Follow up</Badge>}
                  {query && <Badge variant={STATE_TONE[q.state]} className="ml-auto px-1.5 py-0 text-[0.65rem]">{DESK_LABEL[q.state]}</Badge>}
                </span>
              </button>
            </li>
          ))}
          {!visible.length && <li className="px-2 py-6 text-center text-xs text-ink-3">{query ? "Nobody matches." : `Nobody ${FILTER_LABEL[filter].toLowerCase()}.`}</li>}
        </ol>
        <p className="text-[0.7rem] leading-relaxed text-ink-3">J/K next and previous · G switch stream · / search · Cmd+S save · Cmd+Enter mark sent · <Link href="/outreach" className="underline underline-offset-4 hover:text-ink">Review AI drafts</Link></p>
      </aside>

      {/* Composer */}
      <section className="min-h-0 space-y-3 lg:overflow-y-auto lg:pr-1" aria-label="Composer" data-testid="desk-composer">
        {todays[track] >= target && todays[otherTrack] < targets[otherTrack] && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-[color:var(--emerald)]/40 bg-[color:var(--emerald)]/10 px-3 py-2 text-sm text-ink" data-testid="desk-jump">
            <Check className="size-4 text-[color:var(--emerald)]" /> {TRACK_LABEL[track]} are done for today ({today}/{target}). {TRACK_LABEL[otherTrack]} are at {todays[otherTrack]}/{targets[otherTrack]}.
            <Button size="sm" variant="secondary" className="ml-auto" onClick={() => void switchTrack(otherTrack)}>Go to {TRACK_LABEL[otherTrack]}</Button>
          </div>
        )}
        {!person && <div className="rounded-lg border border-line p-10 text-center text-sm text-ink-2">{queue.length ? "Pick someone from the queue." : <>No {guest ? "guest " : ""}dossiers yet. Load them with <code>gtm outreach import-dossiers{guest ? " --track guest" : ""} --file dossiers.json</code>.</>}</div>}
        {person && edit && (
          <>
            <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <h2 className="font-display text-pl-lg font-semibold tracking-tight text-ink" data-testid="desk-name">{person.row.name || person.row.twenty_person_id}</h2>
              <span className="text-sm text-ink-2">{[person.row.title, person.row.company].filter(Boolean).join(", ")}</span>
              {state && <Badge variant={STATE_TONE[state]} data-testid="desk-state">{DESK_LABEL[state]}</Badge>}
              {guest && <Badge variant="outline" data-testid="desk-route">{ROUTE_LABEL[route]}</Badge>}
              {guest && String(person.row.dossier.not_in_twenty) === "true" && <Badge variant="warning">Not in Twenty</Badge>}
              {!guest && inviteSent && <Badge variant="outline">LinkedIn invite sent</Badge>}
              <span className="ml-auto text-xs text-ink-3" data-testid="desk-save-state" aria-live="polite">
                {loading ? "Loading..." : saveState === "saving" ? "Saving..." : dirty ? "Unsaved" : saveState === "saved" ? "Saved" : draft ? "Saved" : person.start.from === "own" ? "Your earlier rewrite, not saved here yet" : ""}
              </span>
            </header>
            {clientBad && <p className="flex items-center gap-1.5 text-xs text-red-strong"><AlertTriangle className="size-3.5" /> Client check did not pass: {person.row.dossier.client_check?.reason || "see the dossier"}.</p>}
            <section className="space-y-4 rounded-xl border border-line bg-[color:var(--surface-card)] p-4 sm:p-5" aria-label="AI outreach angles" data-testid="desk-ai-angles">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-base font-medium text-ink">Choose your opening</p>
                    <p className="mt-1 text-sm text-ink-2">{guest ? "Three ways into the invitation, one editor. Your edits stay with each angle." : <>Three angles, one editor. Your edits stay with each angle. Sent edits teach the next angles (<Link href="/outreach/write/learning" className="underline underline-offset-2">what it has learned</Link>).</>}</p>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => void generateAngles()} disabled={!clientCheckPassed || emailSent || generating || switchingAngle} data-testid="desk-generate-angles">
                    <Sparkles /> {generating ? "Drafting..." : angles ? "Regenerate angles" : "Generate angles"}
                  </Button>
                </div>
                {!guest && <div className="space-y-2 border-t border-line pt-3">
                  <label className="flex flex-wrap items-center gap-3 text-sm text-ink-2">Offer
                    <select aria-label="Offer choice" value={offerOverride} disabled={generating || switchingAngle || emailSent} onChange={(event) => { setOfferOverride(event.target.value as OfferOverride); preserveOfferEdit.current = true; }} className="min-h-10 rounded-md border border-line bg-[color:var(--surface-inset)] px-3 text-ink">
                      <option value="auto">Automatic: follow the evidence</option>
                      {OFFER_IDS.map((id) => <option key={id} value={id}>{offerName(id)}</option>)}
                      <option value="none">No offer: conversation opener</option>
                    </select>
                  </label>
                  {angles?.selection ? <div className="text-sm" data-testid="desk-offer-selection">
                    <p className="font-medium text-ink">{offerName(angles.selection.offer_id)}</p>
                    <p className="mt-1 text-ink-2">{angles.selection.reason}</p>
                    <p className="mt-1 text-xs text-ink-3">{angles.selection.confidence} confidence{angles.selection.uncertainty ? ` · ${angles.selection.uncertainty}` : ""}</p>
                    {angles.selection.evidence_ids.length > 0 && <p className="mt-1 text-xs text-ink-3">Based on: {angles.selection.evidence_ids.map((id) => angles.evidence.find((item) => item.id === id)?.label ?? id).join(", ")}</p>}
                    {offerOverride !== generatedOfferOverride && <p className="mt-2 text-amber-strong">Choice changed. Regenerate to use it; the options above still describe the previous choice.</p>}
                  </div> : <p className="text-xs text-ink-3">The same offer anchors all three openings. Weak fit can mean no offer.</p>}
                  <p className="text-xs text-ink-3">Changing the offer or regenerating keeps your current text. Choose a new angle when you want to replace it.</p>
                </div>}
                {!clientCheckPassed && <p className="text-sm text-amber-strong">The dossier's client check must pass before drafting.</p>}
                {generating && <DraftProgress phase={generationPhase} onStop={stopGeneration} />}
                {generationError && <div role="alert" className="space-y-2 rounded-lg border border-[color:var(--amber)]/40 bg-[color:var(--amber)]/10 p-3 text-sm" data-testid="desk-generation-error">
                  <p className="font-medium text-ink">Drafting needs attention</p>
                  <p className="text-ink-2">{generationError}</p>
                  <Button size="sm" variant="secondary" disabled={!clientCheckPassed || emailSent || generating || switchingAngle} onClick={() => void generateAngles()}>Try drafting again</Button>
                </div>}
                {angles && (
                  <>
                    <nav className="flex flex-wrap items-center gap-2" aria-label="Outreach angle choices">
                      <div className="flex min-w-0 flex-1 flex-wrap gap-1 rounded-lg bg-[color:var(--surface-inset)] p-1">
                        {angles.angles.map((angle, index) => (
                          <button key={angle.key} type="button" aria-pressed={activeAngleKey === angle.key} onClick={() => void selectAngle(angle.key)} disabled={emailSent || generating || switchingAngle}
                            data-testid={`desk-angle-tab-${angle.key}`}
                            className={cn("min-h-11 flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50", activeAngleKey === angle.key ? "bg-violet/15 text-violet-strong ring-1 ring-violet/40" : "text-ink-2 hover:bg-[color:var(--surface-card-hover)] hover:text-ink")}>
                            <span className="mr-2 opacity-60">{index + 1}</span>{angle.label}
                          </button>
                        ))}
                      </div>
                      <Button variant="secondary" size="icon" className="size-11" aria-label="Previous angle" disabled={emailSent || generating || switchingAngle} onClick={() => void selectAngle(angles.angles[(activeAngleIndex + angles.angles.length - 1) % angles.angles.length].key)}><ChevronLeft /></Button>
                      <Button variant="secondary" size="icon" className="size-11" aria-label="Next angle" disabled={emailSent || generating || switchingAngle} onClick={() => void selectAngle(angles.angles[(activeAngleIndex + 1) % angles.angles.length].key)}><ChevronRight /></Button>
                    </nav>
                    <p role="status" className="text-sm text-ink-2" data-testid="desk-angle-status">{activeAngle ? `${activeAngleIndex + 1} of ${angles.angles.length} · ${activeAngle.label} is in the editor below.` : "Options ready. Choose an angle to load it without replacing your current edits."}</p>
                    {activeAngle && (
                      <details className="border-t border-line pt-3" data-testid="desk-angle-reasoning">
                        <summary className="cursor-pointer text-sm font-medium text-ink-2">Why this angle</summary>
                        <div className="mt-3 space-y-3 text-sm leading-relaxed text-ink-2">
                          <p>{activeAngle.rationale}</p>
                          {!guest && <p><span className="font-medium text-ink">{activeAngle.role_read === "likely_decision_maker" ? "Likely decision maker" : activeAngle.role_read === "adjacent_influencer" ? "Adjacent influencer" : "Role unclear"}.</span> {activeAngle.role_evidence_ids.map((evidenceId) => angles.evidence.find((item) => item.id === evidenceId)?.detail).filter(Boolean).join(" · ") || "The dossier does not establish ownership."}</p>}
                          <ul className="space-y-2" aria-label="Supporting evidence">
                            {[...new Set(activeAngle.evidence_ids)].map((evidenceId) => {
                              const evidence = angles.evidence.find((item) => item.id === evidenceId);
                              if (!evidence) return null;
                              const label = `${evidence.label}${evidence.date ? ` · ${evidence.date}` : ""}`;
                              return <li key={evidence.id}>{evidence.url && safeUrl(evidence.url) ? <a href={evidence.url} target="_blank" rel="noreferrer" className="text-violet-strong underline underline-offset-4">{label}</a> : label}</li>;
                            })}
                          </ul>
                        </div>
                      </details>
                    )}
                  </>
                )}
              </section>
            {person.row.skipped_at && (
              <p className="flex flex-wrap items-center gap-2 rounded-md border border-[color:var(--amber)]/40 bg-[color:var(--amber)]/10 px-3 py-2 text-xs text-amber-strong">
                Skipped{person.row.skip_reason ? `: ${person.row.skip_reason}` : ""}.
                <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => void unskip()}><Undo2 /> Unskip</Button>
              </p>
            )}
            {guest && (
              <div className={cn("space-y-1.5 rounded-md border px-3 py-2 text-sm", route === "intermediary" ? "border-[color:var(--amber)]/40 bg-[color:var(--amber)]/10" : "border-line")} data-testid="desk-contact">
                <p className="text-xs font-medium uppercase tracking-wide text-ink-3">{route === "intermediary" ? "Reach them through" : "Find them"}</p>
                {route === "intermediary" && <p className="whitespace-pre-wrap text-ink">{guestInfo?.contact_line || "No contact line in the dossier. Use the links below to find the organization's contact."}</p>}
                <ReachLinks dossier={person.row.dossier} name={person.row.name} company={person.row.company} note />
                {route === "intermediary" && guestInfo?.contact_line && <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => copy("Contact line", guestInfo.contact_line!)}><Copy /> Copy contact line</Button>}
              </div>
            )}

            {showEmailFields && (
              <div className="overflow-hidden rounded-lg border border-[color:var(--border-default)] bg-[color:var(--surface-card)]">
                <div className="space-y-1 border-b border-line px-3 py-2 text-sm">
                  <p className="flex gap-2 text-xs text-ink-3"><span className="w-16 shrink-0">From</span><span className="font-mono" data-testid="desk-from">{from}</span></p>
                  <label className="flex items-center gap-2"><span className="w-16 shrink-0 text-ink-3">To</span>
                    <input value={edit.to} disabled={emailSent} onChange={(e) => setEdit({ ...edit, to: e.target.value })} aria-label="To" maxLength={DESK_LIMITS.to} placeholder={route === "intermediary" ? "Their contact's address, if you have one" : "user-35d973d92927@example.com"}
                      className="min-w-0 flex-1 bg-transparent font-mono text-base text-ink placeholder:text-ink-3 focus-visible:outline-none" />
                  </label>
                  <label className="flex items-center gap-2"><span className="w-16 shrink-0 text-ink-3">Subject</span>
                    <input value={edit.subject} disabled={emailSent} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} aria-label="Subject" maxLength={DESK_LIMITS.subject}
                      className="min-w-0 flex-1 bg-transparent text-lg font-medium text-ink focus-visible:outline-none" />
                  </label>
                </div>
                <textarea ref={body} value={edit.body} disabled={emailSent} onChange={(e) => setEdit({ ...edit, body: e.target.value })} aria-label="Email body" spellCheck
                  onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openLink(e.currentTarget); } }}
                  className="mx-auto block min-h-[28rem] w-full max-w-[76ch] resize-none overflow-hidden bg-transparent px-5 py-6 text-lg leading-[1.85] text-ink focus-visible:outline-none sm:px-7" />
              </div>
            )}

            {linking && (
              <div className="space-y-2 rounded-lg border border-violet/40 bg-[color:var(--surface-card)] p-3" data-testid="desk-link">
                <p className="text-xs text-ink-3">
                  {linking.start === linking.end ? "Insert a link" : <>Link <span className="font-medium text-ink">&ldquo;{edit.body.slice(linking.start, linking.end).trim().slice(0, 80)}&rdquo;</span></>}
                </p>
                <div className="flex gap-2">
                  <input autoFocus value={linking.url} onChange={(e) => setLinking({ ...linking, url: e.target.value })} aria-label="Link URL" placeholder="https://"
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitLink(linking.url); } if (e.key === "Escape") { e.preventDefault(); closeLink(linking); } }}
                    className={cn(field, "h-8 py-1 font-mono")} />
                  <Button size="sm" onClick={() => commitLink(linking.url)} disabled={!linking.url.trim()}>Link</Button>
                  <Button size="sm" variant="ghost" onClick={() => closeLink(linking)}>Cancel</Button>
                </div>
                {assets.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {assets.map((a) => (
                      <button key={a.url} type="button" onClick={() => commitLink(a.url!, a.name ?? "")} title={a.url}
                        className="rounded-full border border-line px-2.5 py-0.5 text-xs text-ink-2 hover:border-violet hover:text-ink">{a.name ?? a.url}</button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {links.length > 0 && (
              <ul className="flex flex-wrap gap-1.5 text-xs" data-testid="desk-links">
                {links.map((l) => (
                  <li key={`${l.start}-${l.url}`} className="flex items-center gap-1 rounded-full border border-line py-0.5 pl-2.5 pr-1 text-ink-2">
                    <Link2 className="size-3" /><span className="text-ink">{l.text}</span>
                    <a href={l.url} target="_blank" rel="noreferrer" className="font-mono text-ink-3 hover:text-ink">{l.url.replace(/^https?:\/\/(www\.)?/, "")}</a>
                    {!emailSent && <button type="button" aria-label={`Remove the link on ${l.text}`} onClick={() => setEdit({ ...edit, body: removeLink(edit.body, l) })} className="rounded-full p-0.5 text-ink-3 hover:text-ink"><X className="size-3" /></button>}
                  </li>
                ))}
              </ul>
            )}

            {scaffold && !emailSent && (
              <div className="flex flex-wrap items-center gap-2" data-testid="desk-template-bar">
                <Button size="sm" variant="secondary" onClick={insertTemplate} data-testid="desk-template"><FileText /> Insert template {scaffold.id}, {scaffold.label.toLowerCase()}</Button>
                {slots.map((sl) => (
                  <button key={sl} type="button" onClick={() => selectSlot(edit.body, edit.body.indexOf(sl))} data-testid="desk-slot"
                    className="rounded-full border border-[color:var(--amber)]/50 bg-[color:var(--amber)]/15 px-2.5 py-0.5 text-xs text-amber-strong hover:border-[color:var(--amber)]">{sl}</button>
                ))}
              </div>
            )}

            {hint && (
              <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3" data-testid="desk-hints">
                {!(guest && route === "linkedin") && (
                  <span className={cn("tabular-nums", hint.length === "long" && "text-amber-strong")} title={guest ? `Your gold examples run about ${WORDS.low + 10} to ${WORDS.high - 20} words` : "A short question and an optional resource offer can be enough for a first message."}>
                    {hint.words} words{guest && hint.length === "short" && hint.words >= 20 ? ", shorter than your examples" : hint.length === "long" ? ", longer than your examples" : ""}
                  </span>
                )}
                {hint.british.length > 0 && <span className="text-amber-strong">British spelling: {hint.british.join(", ")}</span>}
                {hint.wisdom.length > 0 && <span className="text-amber-strong">Uses &ldquo;{hint.wisdom.join(", ")}&rdquo;: only if the guest does</span>}
                {hint.emDash && <span className="text-amber-strong">Em dash</span>}
                {hint.slots > 0 && <span className="text-amber-strong">{hint.slots} template {hint.slots === 1 ? "slot" : "slots"} still to fill</span>}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {showEmailFields && <>
                {!guest && <Button size="sm" variant="ghost" onClick={() => void formatEmail()} disabled={emailSent} data-testid="desk-format-email"><FileText /> Format email</Button>}
                <Button size="sm" variant="secondary" onClick={() => copy("Subject", edit.subject)} disabled={!edit.subject}><Copy /> Copy subject</Button>
                <Button size="sm" variant="secondary" onClick={() => copyBody(edit.body)}><Copy /> Copy body</Button>
                {(route === "email" || edit.to.trim()) && (
                  <Button size="sm" variant="secondary" asChild>
                    <a href={gmailHref} target="_blank" rel="noreferrer" onClick={() => { void flush(); if (hasLinks(edit.body)) copyBody(edit.body, "Body copied with its links: paste it into Gmail."); }} data-testid="desk-gmail"><Mail /> Open in Gmail as {from}</a>
                  </Button>
                )}
              </>}
              {!emailSent
                ? <Button size="sm" onClick={() => void markSent()} disabled={problems.length > 0}><Check /> Mark sent</Button>
                : <><Badge variant="success">{guest ? sentLabel : "Email sent"}{sentAt ? ` ${stamp(sentAt)}` : ""}</Badge>
                    <Button size="sm" variant="ghost" className="text-ink-3" onClick={() => void undoSent()}><Undo2 /> Not sent</Button></>}
              {guest && emailSent && (followedUp
                ? <><Badge variant="success" data-testid="desk-followup-sent">Follow-up sent{draft?.follow_up_sent_at ? ` ${stamp(draft.follow_up_sent_at)}` : ""}</Badge>
                    <Button size="sm" variant="ghost" className="text-ink-3" onClick={() => void markFollowUp(true)}><Undo2 /> Follow-up not sent</Button></>
                : <>{due && <Badge variant="info" data-testid="desk-followup-due">Follow-up due</Badge>}
                    <Button size="sm" variant="secondary" onClick={() => void markFollowUp()} data-testid="desk-followup"><Check /> Mark follow-up sent</Button></>)}
              {!person.row.skipped_at && !emailSent && (skipping
                ? <span className="flex items-center gap-1.5">
                    <input autoFocus value={skipReason} onChange={(e) => setSkipReason(e.target.value)} maxLength={DESK_LIMITS.skip_reason} placeholder="Why skip (optional)" aria-label="Skip reason"
                      onKeyDown={(e) => { if (e.key === "Enter") void skip(); if (e.key === "Escape") setSkipping(false); }} className="h-8 w-52 rounded-md border border-input bg-[color:var(--surface-inset)] px-2 text-xs text-ink" />
                    <Button size="sm" variant="secondary" onClick={() => void skip()}>Skip</Button>
                    <Button size="sm" variant="ghost" onClick={() => setSkipping(false)}>Cancel</Button>
                  </span>
                : <Button size="sm" variant="ghost" className="ml-auto text-ink-3" onClick={() => setSkipping(true)}><SkipForward /> Skip</Button>)}
            </div>

            {showNoteBox && (
              <div className="space-y-2 rounded-lg border border-line p-3">
                <label className="block space-y-1">
                  <span className="flex justify-between text-xs text-ink-3"><span>LinkedIn note</span>
                    <span className={cn("tabular-nums", edit.linkedin_note.length > DESK_LIMITS.linkedin_note && "text-red-strong")} data-testid="desk-note-count">{edit.linkedin_note.length}/{DESK_LIMITS.linkedin_note}</span></span>
                  <textarea value={edit.linkedin_note} disabled={guest && emailSent} onChange={(e) => setEdit({ ...edit, linkedin_note: e.target.value })} rows={guest ? 8 : 4} aria-label="LinkedIn note" className={cn(field, "text-base leading-relaxed")} />
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="secondary" onClick={() => copy("Note", edit.linkedin_note)} disabled={!edit.linkedin_note}><Copy /> Copy note</Button>
                  {linkedinUrl && <Button size="sm" variant="secondary" asChild><a href={linkedinUrl} target="_blank" rel="noreferrer"><ExternalLink /> Open profile</a></Button>}
                  {!guest && (inviteSent ? <Badge variant="success">Invite sent</Badge> : <Button size="sm" variant="secondary" onClick={() => void markInvite()} disabled={problems.length > 0}><Check /> Mark invite sent</Button>)}
                </div>
              </div>
            )}

            {problems.map((m) => <p key={m} className="text-xs text-red-strong">{m}</p>)}
            {error && <p role="alert" className="text-xs text-red-strong">{error}</p>}
          </>
        )}
      </section>

      {/* Dossier */}
      <aside className="min-h-0 rounded-lg border border-line bg-[color:var(--surface-raised)] p-4 lg:col-span-2 lg:overflow-y-auto xl:col-span-1" aria-label="Dossier">
        {person
          ? <DeskDossier key={person.row.twenty_person_id} person={person} profile={profile} onRestore={(v: DraftVersion) => edit && setEdit({ ...edit, subject: v.subject, body: v.body, linkedin_note: v.linkedin_note })} />
          : <p className="text-sm text-ink-3">The dossier shows here.</p>}
      </aside>
    </div>
  );
}
