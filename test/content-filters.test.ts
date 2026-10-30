import test from "node:test";
import assert from "node:assert/strict";
import { contentFilters, contentQuery } from "../lib/content-filters";

test("review defaults to Needs approval; explicit all-status choices and piece links remain inspectable", () => {
  assert.equal(contentFilters({}).status, "needs-approval");
  assert.equal(contentFilters({ platform: "linkedin" }).status, "needs-approval");
  assert.equal(contentFilters({ status: "all" }).status, "");
  assert.equal(contentFilters({ piece: "s1-01" }).status, "");
  assert.equal(contentFilters({ status: "approved" }).status, "approved");
  const all = contentFilters({ status: "all" });
  assert.equal(contentQuery(all), "?status=all");
  assert.deepEqual(contentFilters(Object.fromEntries(new URLSearchParams(contentQuery(all)))), all);
});
