// The work board's pure rules (lib/work/model.ts): ETA parsing and labels, "updated 4m ago", the four groups.
import { test } from "node:test";
import assert from "node:assert/strict";
import { agoLabel, allHandled, answeredLine, buildBoard, contentStrip, defaultTitle, etaLabel, parseEta, pieceHref, workSummary, type WaitingNote, type WorkItem } from "../lib/work/model.ts";

const NOW = new Date("2026-10-13T10:00:00Z");
const min = (m: number) => new Date(NOW.getTime() + m * 60_000).toISOString();

test("parseEta: minutes, hours, both, bare minutes, an ISO time, none; anything else throws", () => {
  assert.equal(parseEta("45m", NOW)!.toISOString(), min(45));
  assert.equal(parseEta("2h", NOW)!.toISOString(), min(120));
  assert.equal(parseEta("1h30m", NOW)!.toISOString(), min(90));
  assert.equal(parseEta("90", NOW)!.toISOString(), min(90));
  assert.equal(parseEta("2026-10-13T12:00:00Z", NOW)!.toISOString(), "2026-10-13T12:00:00.000Z");
  assert.equal(parseEta("none", NOW), null);
  assert.equal(parseEta("", NOW), null);
  assert.throws(() => parseEta("soon", NOW), /give minutes or hours/);
});

test("etaLabel: about N min / h, any minute, overdue, and a dash when there is none or the job is staged or done", () => {
  assert.equal(etaLabel(min(30), "working", NOW), "about 30 min");
  assert.equal(etaLabel(min(44), "working", NOW), "about 45 min");
  assert.equal(etaLabel(min(150), "rendering", NOW), "about 2.5 h");
  assert.equal(etaLabel(min(1), "working", NOW), "any minute");
  assert.equal(etaLabel(min(-5), "working", NOW), "any minute");
  assert.equal(etaLabel(min(-30), "working", NOW), "overdue");
  assert.equal(etaLabel(null, "working", NOW), "—");
  assert.equal(etaLabel(min(30), "staged", NOW), "—");
  assert.equal(etaLabel(min(30), "done", NOW), "—");
});

test("agoLabel", () => {
  assert.equal(agoLabel(min(0), NOW), "just now");
  assert.equal(agoLabel(min(-4), NOW), "4m ago");
  assert.equal(agoLabel(min(-125), NOW), "2h ago");
  assert.equal(agoLabel(min(-60 * 50), NOW), "2d ago");
});

const item = (over: Partial<WorkItem>): WorkItem => ({
  id: over.title ?? "x", created_at: min(-60), updated_at: min(-10), story_id: "s1", asset_id: null, storyboard_id: null, source_note_ids: [],
  title: "t", status: "working", agent: "a", eta_at: null, last_update: "", blocked_reason: "", staged_at: null, done_at: null, ...over,
});
const note = (over: Partial<WaitingNote>): WaitingNote => ({ source: "content", note_id: "n", story_id: "s1", asset_id: "a1", storyboard_id: null, author: "john", body: "b", created_at: min(-20), ...over });

test("buildBoard: in progress (blocked included), review is staged in the last 24h even once done, done today, older work left out", () => {
  const b = buildBoard([
    item({ title: "working", status: "working", updated_at: min(-5) }),
    item({ title: "blocked", status: "blocked", updated_at: min(-1) }),
    item({ title: "staged", status: "staged", staged_at: min(-60) }),
    item({ title: "staged then done", status: "done", staged_at: min(-30), done_at: min(-20) }),
    item({ title: "staged long ago", status: "staged", staged_at: min(-60 * 30) }),
    item({ title: "done today", status: "done", done_at: min(-120) }),
    item({ title: "done yesterday", status: "done", done_at: min(-60 * 20) }),
  ], [], NOW, "Europe/Berlin");
  assert.deepEqual(b.inProgress.map((r) => r.kind === "item" && r.item.title), ["blocked", "working"]);
  assert.deepEqual(b.review.map((r) => r.kind === "item" && r.item.title).sort(), ["staged", "staged then done"]);
  assert.deepEqual(b.doneToday.map((r) => r.kind === "item" && r.item.title), ["done today"]);
});

test("buildBoard: waiting notes are one row per piece and surface, oldest first", () => {
  const b = buildBoard([], [
    note({ note_id: "a", created_at: min(-10) }), note({ note_id: "b", created_at: min(-30) }),
    note({ note_id: "c", source: "studio", storyboard_id: "sb-1", asset_id: null, created_at: min(-15) }),
    note({ note_id: "d", story_id: "s2", created_at: min(-6) }),
  ], NOW, "UTC");
  assert.deepEqual(b.waiting.map((r) => r.kind === "waiting" && [r.key, r.notes.length, r.since]), [["content:s1", 2, min(-30)], ["studio:sb-1", 1, min(-15)], ["content:s2", 1, min(-6)]]);
});

test("labels and links", () => {
  assert.equal(workSummary(3, 1), "3 in progress · 1 waiting");
  assert.equal(workSummary(0, 0), null);
  assert.equal(contentStrip(1, 0), "1 job in progress · 0 waiting");
  assert.equal(contentStrip(3, 1), "3 jobs in progress · 1 waiting");
  assert.equal(pieceHref({ storyId: "s1-21-sample-piece-21", storyboardId: null }), "/content?piece=s1-21-sample-piece-21");
  assert.equal(pieceHref({ storyId: "packaging-s1-22-sample-piece-22", storyboardId: null }), "/content?view=templates&story=s1-22-sample-piece-22");
  assert.equal(pieceHref({ storyId: "s1", storyboardId: "sb-s1-plan" }), "/content?piece=s1", "a retired /studio storyboard link falls back to the piece in /content");
  assert.equal(pieceHref({ storyId: null, storyboardId: null }), null);
  assert.equal(defaultTitle("Meridian Short B", 5), "Meridian Short B: 5 notes");
  assert.equal(defaultTitle("Meridian Short B", 1), "Meridian Short B: 1 note");
  assert.equal(defaultTitle(null, 0), "Work");
});

test("answeredLine: one note reads naturally", () => {
  assert.equal(answeredLine({ handled: 1, total: 1, all: true }), "your note answered");
  assert.equal(answeredLine({ handled: 3, total: 3, all: true }), "all 3 notes answered");
  assert.equal(answeredLine({ handled: 1, total: 2, all: false }), "1 of 2 notes answered");
});

test("allHandled: a missing note counts as handled; no notes is never 'all'", () => {
  assert.deepEqual(allHandled(["a", "b"], [{ id: "a", source: "content", handled: true }, { id: "b", source: "studio", handled: false }]), { handled: 1, total: 2, all: false });
  assert.deepEqual(allHandled(["a", "gone"], [{ id: "a", source: "content", handled: true }]), { handled: 2, total: 2, all: true });
  assert.deepEqual(allHandled([], []), { handled: 0, total: 0, all: false });
});
