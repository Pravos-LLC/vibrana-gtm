import test from "node:test";
import assert from "node:assert/strict";
import { findMentions, mentionReport, renderMentions, typedName, type Person } from "../lib/mentions";

const chetan: Person = { name: "Chetan Nandakumar", linkedin_name: "Chetan Nandakumar", linkedin_urn: "urn:li:person:WJpG06Dhal", instagram_handle: null };
const fatma: Person = { name: "Fatma Sample Person", linkedin_name: "Fatma Sample Person (She~her)", linkedin_urn: "urn:li:person:abc", instagram_handle: "fafouma" };
const example_approver: Person = { name: "example_approver", linkedin_name: null, linkedin_urn: null, instagram_handle: "example_approveroesg" };
const people = [chetan, fatma, example_approver];

test("a known name becomes each platform's tag; YouTube gets the plain name", () => {
  const text = "Recorded with @Chetan Nandakumar and @fatma Sample Person today.";
  // The tag keeps the words John wrote: "Fatma Sample Person" links on LinkedIn without her "(She~her)" (the 2026-10-02 post).
  assert.equal(renderMentions(text, "linkedin", people), "Recorded with @[Chetan Nandakumar](urn:li:person:WJpG06Dhal) and @[Fatma Sample Person](urn:li:person:abc) today.");
  assert.equal(renderMentions(text, "instagram", people), "Recorded with Chetan Nandakumar and @fafouma today.");
  assert.equal(renderMentions(text, "youtube", people), "Recorded with Chetan Nandakumar and Fatma Sample Person today.");
});

test("the longest name wins, a name must end at a word boundary, and emails are not mentions", () => {
  const more = [...people, { name: "Chetan", linkedin_name: "Other Chetan", linkedin_urn: "urn:li:person:x", instagram_handle: null }];
  assert.equal(findMentions("@Chetan Nandakumar", more)[0].person, chetan);
  assert.equal(findMentions("@example_approvero is here", people)[0].person, null);
  assert.equal(findMentions("mail user-f538cb95fc21@example.com", people).length, 0);
});

test("the report says, per platform, whether each mention tags and why not", () => {
  const r = mentionReport("Thanks @Chetan Nandakumar and @Jane Doe, again @Chetan Nandakumar", ["linkedin", "instagram"], people);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0].results.map((x) => [x.channel, x.tags, x.why]), [["linkedin", true, ""], ["instagram", false, "no Instagram handle on file"]]);
  assert.equal(r[1].typed, "@Jane Doe");
  assert.deepEqual(r[1].results.map((x) => x.tags), [false, false]);
});

test("typed names drop pronouns, credentials and emoji", () => {
  assert.equal(typedName("Fatma Sample Person (She~her)"), "Fatma Sample Person");
  assert.equal(typedName("Mariana Ortega, MAAL, ACC, CPC, CTIC"), "Mariana Ortega");
  assert.equal(typedName("Monty Bryant ⚡"), "Monty Bryant");
  assert.equal(typedName("🕸️ Shaun Church"), "Shaun Church");
  assert.equal(typedName("Gustavo Segovia - MBA"), "Gustavo Segovia");
  assert.equal(typedName("Dr. Stuart Cowan"), "Dr. Stuart Cowan");
});

test("punctuation after a name still tags; an @ inside a link is left alone; accents match in either form", () => {
  assert.equal(renderMentions("Thanks @Chetan Nandakumar. And @Chetan Nandakumar's idea.", "linkedin", people),
    "Thanks @[Chetan Nandakumar](urn:li:person:WJpG06Dhal). And @[Chetan Nandakumar](urn:li:person:WJpG06Dhal)'s idea.");
  assert.equal(renderMentions("Watch https://www.tiktok.com/@example_approver now", "instagram", people), "Watch https://www.tiktok.com/@example_approver now");
  const jose: Person = { name: "José Pérez", linkedin_name: "José Pérez", linkedin_urn: "urn:li:person:j", instagram_handle: null };
  assert.equal(findMentions("hi @Jose\u0301 Pe\u0301rez", [jose])[0].person, jose);
  assert.equal(findMentions("hi @Émile", []).length, 1);
});

test("a mention at the start of a line after a colon or a link still tags", () => {
  assert.equal(findMentions("Guests on this episode:\n@Chetan Nandakumar", people)[0]?.person, chetan);
  assert.equal(findMentions("https://x.y/\n@Chetan Nandakumar", people)[0]?.person, chetan);
});

const team = (p: Person): Person => ({ ...p, auto_tag: true });
const phd: Person = team({ name: "Chetan Nandakumar", linkedin_name: "Chetan Nandakumar, PhD", linkedin_urn: "urn:li:person:WJpG06Dhal", instagram_handle: null });
const abe: Person = team({ name: "Abe Sample Person", linkedin_name: "Abe Sample Person", linkedin_urn: "urn:li:person:3OMYPimaYv", instagram_handle: null });
const fat: Person = team(fatma);
const crew = [phd, abe, fat, example_approver];

test("the team tags on LinkedIn by plain name, first mention only, with the words John wrote", () => {
  assert.equal(renderMentions("Chetan and I built it. Abe Sample Person tested it. Chetan shipped it.", "linkedin", crew),
    "@[Chetan](urn:li:person:WJpG06Dhal) and I built it. @[Abe Sample Person](urn:li:person:3OMYPimaYv) tested it. Chetan shipped it.");
  // "Chetan Nandakumar" is not his LinkedIn name ("..., PhD"): the first name carries the tag, the rest reads as written.
  assert.equal(renderMentions("with Chetan Nandakumar's help", "linkedin", crew), "with @[Chetan](urn:li:person:WJpG06Dhal) Nandakumar's help");
  assert.equal(renderMentions("my wife Fatma Sample Person", "linkedin", crew), "my wife @[Fatma Sample Person](urn:li:person:abc)");
  // Instagram and YouTube leave a plain name exactly as written.
  assert.equal(renderMentions("Chetan and Fatma", "instagram", crew), "Chetan and Fatma");
  assert.equal(renderMentions("Chetan and Fatma", "youtube", crew), "Chetan and Fatma");
});

test("plain names are whole words, case-sensitive, and never inside links, emails, handles or existing tags", () => {
  assert.equal(renderMentions("Abed and abe and Fatmas", "linkedin", crew), "Abed and abe and Fatmas");
  assert.equal(renderMentions("see https://x.com/Chetan and user-42ccc3a5adc2@example.com and #Chetan", "linkedin", crew), "see https://x.com/Chetan and user-42ccc3a5adc2@example.com and #Chetan");
  assert.equal(renderMentions("with @[Fatma Sample Person](urn:li:person:abc) today, Fatma", "linkedin", crew), "with @[Fatma Sample Person](urn:li:person:abc) today, Fatma");
  assert.equal(renderMentions("see example.com?name=Chetan, mailto:Abe, Chetan_bot and pre-Chetan", "linkedin", crew), "see example.com?name=Chetan, mailto:Abe, Chetan_bot and pre-Chetan");
  // A team first name that starts someone else's name on the list is them; any other capitalized word after it still tags.
  const lincoln: Person = { name: "Abe Lincoln", linkedin_name: "Abe Lincoln", linkedin_urn: "urn:li:person:al", instagram_handle: null };
  assert.equal(renderMentions("Abe Lincoln said it. Then Abe agreed.", "linkedin", [...crew, lincoln]), "Abe Lincoln said it. Then @[Abe](urn:li:person:3OMYPimaYv) agreed.");
  assert.equal(findMentions("@Abe Lincoln", [...crew, lincoln])[0].person, lincoln);
  assert.equal(renderMentions("Met Chetan Monday. With Abe And Fatma", "linkedin", crew), "Met @[Chetan](urn:li:person:WJpG06Dhal) Monday. With @[Abe](urn:li:person:3OMYPimaYv) And @[Fatma](urn:li:person:abc)");
  assert.equal(findMentions("@Chetan PhD", crew)[0].person, phd);
  const anderson: Person = { name: "Abe Anderson", linkedin_name: "Abe Anderson", linkedin_urn: "urn:li:person:aa", instagram_handle: null };
  assert.equal(renderMentions("With Abe And Chetan", "linkedin", [...crew, anderson]), "With @[Abe](urn:li:person:3OMYPimaYv) And @[Chetan](urn:li:person:WJpG06Dhal)");
  assert.equal(renderMentions("Chetan: thanks", "linkedin", crew), "@[Chetan](urn:li:person:WJpG06Dhal): thanks");
  assert.equal(renderMentions("Did you ask Chetan? Abe & Fatma did.", "linkedin", crew), "Did you ask @[Chetan](urn:li:person:WJpG06Dhal)? @[Abe](urn:li:person:3OMYPimaYv) & @[Fatma](urn:li:person:abc) did.");
  // An explicit @ wins: the plain name later is not tagged again.
  assert.equal(renderMentions("@Chetan built it; Chetan again", "linkedin", crew), "@[Chetan](urn:li:person:WJpG06Dhal) built it; Chetan again");
  // Someone not marked auto_tag needs the @.
  assert.equal(renderMentions("Chetan built it", "linkedin", [chetan]), "Chetan built it");
});

test("a shared first name in the team needs the full name", () => {
  const other = team({ name: "Chetan Rao", linkedin_name: "Chetan Rao", linkedin_urn: "urn:li:person:r", instagram_handle: null });
  assert.equal(renderMentions("Chetan built it with Chetan Rao", "linkedin", [phd, other]), "Chetan built it with @[Chetan Rao](urn:li:person:r)");
  assert.equal(findMentions("@Chetan", [phd, other])[0].person, null);
});

test("a LinkedIn first comment gets plain names: a tag in a comment posts as raw text", () => {
  assert.equal(renderMentions("Thanks @Chetan Nandakumar and Abe", "linkedin", crew, { comment: true }), "Thanks Chetan Nandakumar and Abe");
  const r = mentionReport("Thanks @Chetan Nandakumar", ["linkedin"], crew, { comment: true });
  assert.deepEqual(r[0].results.map((x) => [x.tags, x.fixable]), [[false, false]]);
});

test("the report marks plain-name mentions and offers the add form only where a profile would fix it", () => {
  const r = mentionReport("Chetan and @Jane Doe", ["linkedin", "instagram"], crew);
  assert.deepEqual(r.map((m) => [m.typed, m.auto]), [["Chetan", true], ["@Jane Doe", false]]);
  assert.deepEqual(r[0].results.map((x) => [x.channel, x.tags, x.fixable]), [["linkedin", true, false], ["instagram", false, false]]);
  assert.ok(r[1].results.every((x) => x.fixable));
});
