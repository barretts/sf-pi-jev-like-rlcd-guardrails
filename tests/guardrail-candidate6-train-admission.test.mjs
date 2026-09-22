import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { reviewRows } from "../scripts/guardrail-candidate6-train-admission.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const mergedTrain = resolve(
  root,
  ".build/guardrail/candidate-6-research-merge-20260922-final/train.jsonl",
);
const parse = (text) => text.trimEnd().split("\n").map(JSON.parse);
const rows = async () => parse(await readFile(mergedTrain, "utf8"));

test("research admission preserves matched groups and excludes unresolved source effects", async () => {
  const result = reviewRows(await rows());
  assert.equal(result.cases.length, 186);
  assert.equal(result.admitted.length, 175);
  assert.deepEqual(result.excludedGroups.sort(), [
    "c5-draft-salesforce-pane-query-vs-create",
    "c6-supp-soql-rest-query-vs-queryall",
    "train-shell-typescript-check",
  ]);
  const dispositions = new Map();
  for (const entry of result.cases) {
    assert.ok(entry.reason && entry.sourceEvidence.length);
    const prior = dispositions.get(entry.groupId);
    if (prior) assert.equal(entry.disposition, prior);
    dispositions.set(entry.groupId, entry.disposition);
  }
  assert.equal(dispositions.size, 62);
  assert.ok(
    result.cases.some((entry) =>
      entry.fixturePreconditions.some((fact) => fact.includes("pane_split")),
    ),
  );
  assert.ok(
    result.cases.every(
      (entry) =>
        !entry.id.startsWith("c6-valid-") && !entry.id.startsWith("c6-test-"),
    ),
  );
  const browser = result.cases.filter((entry) =>
    entry.groupId.startsWith("c6-browser-"),
  );
  assert.equal(browser.length, 4);
  assert.ok(
    browser.every(
      (entry) =>
        entry.browserIntentOnly === true &&
        entry.fixturePreconditions.some((fact) =>
          fact.includes("eventual page effect is not established"),
        ),
    ),
  );
});

test("unreviewed or duplicate TRAIN identities cannot be admitted", async () => {
  const original = await rows();
  const unknown = structuredClone(original);
  unknown[0].group_id = "unreviewed-group";
  assert.throws(
    () => reviewRows(unknown),
    /Unreviewed or malformed TRAIN case/,
  );
  const duplicate = structuredClone(original);
  duplicate[1].id = duplicate[0].id;
  assert.throws(
    () => reviewRows(duplicate),
    /TRAIN case identity or split changed/,
  );
  const changedSplit = structuredClone(original);
  changedSplit[0].split = "test";
  assert.throws(
    () => reviewRows(changedSplit),
    /TRAIN case identity or split changed/,
  );
});
