import test from "node:test";
import assert from "node:assert/strict";
import { pickOwner } from "../lib/story-ops";

const owner = (email: string) => ({ email, app_metadata: { gtm_owner: true } });
const users = [owner("a@example.com"), owner("b@example.com"), { email: "r@example.com", app_metadata: { gtm_reviewer: true } }];

test("the only owner is picked without being named", () => {
  assert.equal(pickOwner([owner("a@example.com"), users[2]]), "a@example.com");
});
test("with several owners the named one is used, case-insensitively", () => {
  assert.equal(pickOwner(users, "B@Example.com"), "b@example.com");
});
test("with several owners and none named it refuses and lists them", () => {
  assert.throws(() => pickOwner(users), /2 cockpit owners \(a@example.com, b@example.com\).*--as/);
});
test("a named account that is not an owner is refused", () => {
  assert.throws(() => pickOwner(users, "r@example.com"), /not a cockpit owner/);
});
