import test from "node:test";
import assert from "node:assert/strict";
import { deckCopyProblems, deckDigest, deckEntries, stampOf, syncNumberedList, withStamp, type Deck } from "../lib/deck";

const deck: Deck = {
  template: "listicle",
  slides: [
    { type: "cover", title: "Top 3" },
    { type: "item", n: 1, title: "OpenClaw", body: "Self-hosted assistant. Went from demo to default." },
    { type: "item", n: 2, title: "gstack", body: "Garry Tan's setup: 23 tools. The YC way. Source: github.com/x" },
    { type: "item", n: 3, title: "A docs repo plus MCP", body: "Start cheap.", line: "A docs repo plus MCP, the cheap start" },
    { type: "cta", name: "AIOS", title: "AIOS. The operating system for teams of humans and agents." },
  ],
};
const digest = deckDigest(JSON.stringify(deck));

test("entries carry every numbered item and the named bonus, with a line from the slide", () => {
  assert.deepEqual(deckEntries(deck).map((e) => [e.n, e.name, e.line]), [
    [1, "OpenClaw", "OpenClaw. Self-hosted assistant."],
    [2, "gstack", "gstack. Garry Tan's setup: 23 tools."],
    [3, "A docs repo plus MCP", "A docs repo plus MCP, the cheap start"],
    [null, "AIOS", "AIOS"],
  ]);
});

test("the numbered list is rebuilt from the slides in the post's own direction and spacing", () => {
  const post = "Intro.\n\n3. Old three\n2. Old two\n1. Old one\n\nOutro.";
  assert.equal(syncNumberedList(post, deck), "Intro.\n\n3. A docs repo plus MCP, the cheap start\n2. gstack. Garry Tan's setup: 23 tools.\n1. OpenClaw. Self-hosted assistant.\n\nOutro.");
  const spaced = "1. a\n\n2. b\n\n3. c\n\nEnd";
  assert.equal(syncNumberedList(spaced, deck), "1. OpenClaw. Self-hosted assistant.\n\n2. gstack. Garry Tan's setup: 23 tools.\n\n3. A docs repo plus MCP, the cheap start\n\nEnd");
  assert.equal(syncNumberedList("No list here, OpenClaw and gstack.", deck), null);
});

test("problems: a missing name, a wrong number and an unsynced stamp each fail; a synced post passes", () => {
  const good = withStamp(syncNumberedList("Top.\n\n1. x\n2. y\n3. z\n\nNumber 11 is AIOS.", deck)!, digest);
  assert.deepEqual(deckCopyProblems(good, deck, digest), []);
  assert.match(deckCopyProblems(good.replace("Number 11 is AIOS.", "Bonus."), deck, digest).join(), /missing slide items: AIOS/);
  assert.match(deckCopyProblems(good.replace("2. gstack", "2. Ollama"), deck, digest).join(), /item 2 is "Ollama.*the slide says gstack/);
  assert.match(deckCopyProblems(good, deck, deckDigest("changed")).join(), /slides changed/);
  const nameInCommentOnly = `---\nfirst_comment: AIOS\n---\n\nOpenClaw gstack a docs repo plus MCP`;
  assert.match(deckCopyProblems(withStamp(nameInCommentOnly, digest), deck, digest).join(), /missing slide items: AIOS/);
});

test("the stamp keeps other frontmatter keys and adds frontmatter to a plain file", () => {
  const withFm = withStamp("---\nfirst_comment: hi\n---\n\nBody\n", "abc");
  assert.match(withFm, /first_comment: hi/);
  assert.equal(stampOf(withFm), "abc");
  assert.ok(withFm.endsWith("\n\nBody\n"));
  const plain = withStamp("Body\n", "abc");
  assert.equal(plain, "---\ndeck_sha256: abc\n---\n\nBody\n");
  assert.equal(stampOf(withStamp(plain, "def")), "def");
});

test("framework decks are not lists: names on steps are not required and no stamp is demanded", () => {
  const framework: Deck = { template: "framework", slides: [{ type: "step", name: "Go all in" }, { type: "cta", name: "Read the water" }] };
  assert.deepEqual(deckEntries(framework), []);
  assert.deepEqual(deckCopyProblems("A post about waves.", framework, "x"), []);
});

test("a year at the start of a line is prose, and BOM or empty frontmatter is stamped without corruption", () => {
  const good = withStamp(syncNumberedList("1. a\n2. b\n3. c\n\n2026. The year agents went mainstream. AIOS too.", deck)!, digest);
  assert.deepEqual(deckCopyProblems(good, deck, digest), []);
  assert.equal(withStamp("\uFEFFBody\n", "abc"), "---\ndeck_sha256: abc\n---\n\nBody\n");
  assert.equal(withStamp("---\n---\n\nBody\n", "abc"), "---\ndeck_sha256: abc\n---\n\nBody\n");
  assert.equal(stampOf(withStamp("\uFEFF---\nfirst_comment: hi\n---\nBody", "abc")), "abc");
});
