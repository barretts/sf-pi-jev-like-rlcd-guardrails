import assert from "node:assert/strict";
import test from "node:test";
import { summarizeContact } from "../.compiled/src/contact.js";

test("a named contact can have no email", () => {
  assert.deepEqual(
    summarizeContact({ displayName: "  Ada Lovelace  ", email: null }),
    { label: "Ada Lovelace", email: null },
  );
});

test("an email supplies the label when the display name is absent or blank", () => {
  for (const displayName of [null, "", " \t\n "]) {
    assert.deepEqual(
      summarizeContact({ displayName, email: "  Ada@Example.COM \n" }),
      { label: "ada@example.com", email: "ada@example.com" },
    );
  }
});

test("absent and blank values produce the explicit anonymous fallback", () => {
  for (const displayName of [null, "", " \t "]) {
    for (const email of [null, "", " \n "]) {
      assert.deepEqual(summarizeContact({ displayName, email }), {
        label: "Anonymous contact",
        email: null,
      });
    }
  }
});

test("a display name wins while normalized email remains available", () => {
  assert.deepEqual(
    summarizeContact({
      displayName: "  Team B  ",
      email: " OWNER@EXAMPLE.ORG ",
    }),
    { label: "Team B", email: "owner@example.org" },
  );
});

test("normalization does not mutate or retain mutable input state", () => {
  const contact = Object.freeze({
    displayName: "  Original Name ",
    email: " ORIGINAL@EXAMPLE.ORG ",
  });
  const summary = summarizeContact(contact);
  assert.deepEqual(contact, {
    displayName: "  Original Name ",
    email: " ORIGINAL@EXAMPLE.ORG ",
  });
  summary.label = "Changed summary";
  assert.equal(contact.displayName, "  Original Name ");
});
