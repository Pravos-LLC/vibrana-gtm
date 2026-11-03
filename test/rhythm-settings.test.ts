import test from "node:test";
import assert from "node:assert/strict";
import { RHYTHM, channelAllowed, dayLabels, pillarAllowed } from "../lib/rhythm";
import { applyRhythm, guideRhythm, loadRhythm, rhythmProblems } from "../lib/rhythm-settings";

const db = (value: unknown, error: { message: string } | null = null) => ({
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: value === undefined ? null : { value }, error }) }) }) }),
}) as never;

test("a saved rhythm replaces the guide's everywhere the rhythm is read; no setting puts the guide's back", async () => {
  const mine = guideRhythm();
  mine.days[2] = { day: "Wed", primary: "build", fallback: [], channels: ["linkedin"], note: "" };
  mine.blocked = [{ channel: "youtube", pillars: ["lists"] }];
  try {
    assert.deepEqual(await loadRhythm(db(mine), { fresh: true }), { source: "setting", problems: [] });
    assert.equal(dayLabels("Wed").primary, "Build");
    assert.equal(channelAllowed("Wed", "linkedin"), true);
    assert.equal(pillarAllowed("lists", "youtube"), false);
    assert.deepEqual(await loadRhythm(db(undefined), { fresh: true }), { source: "guide", problems: [] });
    assert.deepEqual(RHYTHM.days, guideRhythm().days);
  } finally {
    applyRhythm(guideRhythm());
  }
});

test("a broken saved rhythm is refused and the guide's stays; a failed read keeps what is in place", async () => {
  const r = await loadRhythm(db({ days: [] }), { fresh: true });
  assert.equal(r.source, "guide");
  assert.match(r.problems.join(" "), /Monday to Sunday/);
  assert.match((await loadRhythm(db(undefined, { message: "relation does not exist" }), { fresh: true })).problems[0], /relation does not exist/);
  assert.deepEqual(RHYTHM.days, guideRhythm().days);
});

test("rhythmProblems names what a person typed wrong", () => {
  const g = guideRhythm();
  assert.deepEqual(rhythmProblems(g), []);
  const offWithChannels = { ...g, days: g.days.map((d) => (d.day === "Sun" ? { ...d, primary: null, channels: ["linkedin"] } : d)) };
  assert.match(rhythmProblems(offWithChannels).join(" "), /off day posts on no channel/);
  const badChannel = { ...g, blocked: [{ channel: "tiktok", pillars: ["proof"] }] };
  assert.match(rhythmProblems(badChannel).join(" "), /not known/);
  const noPosting = { ...g, days: g.days.map((d) => ({ ...d, primary: null, fallback: [], channels: [] })) };
  assert.match(rhythmProblems(noPosting).join(" "), /At least one day/);
});
