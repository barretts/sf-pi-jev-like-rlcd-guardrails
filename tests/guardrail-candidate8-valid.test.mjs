import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeCorpus } from "../blind-c8-20260922/authoring.mjs";
import { definitions } from "../blind-c8-20260922/valid.source.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const directory = resolve(root, "blind-c8-20260922");
const readJson = async (file) => JSON.parse(await readFile(resolve(directory, file), "utf8"));
const lanes = new Set([
  "shell", "herdr_pane", "salesforce_cli", "apex", "agentscript",
  "data360", "soql", "canvas", "browser",
]);

test("VALID source exactly reproduces the exported corpus", async () => {
  const exported = await readJson("valid.json");
  assert.deepEqual(exported, makeCorpus("valid", definitions));
  assert.equal(exported.schema_version, "c8.1");
  assert.equal(exported.split, "valid");
  assert.equal(exported.cases.length, 90);
});

test("VALID cases have 45 complete, nonoverlapping contrast groups", async () => {
  const { cases } = await readJson("valid.json");
  const groups = new Map();
  const templates = new Set();
  const operations = new Set();
  const ids = new Set();
  const laneCounts = new Map();
  for (const row of cases) {
    assert.match(row.id, /^c8-valid-\d{3}$/);
    assert.equal(ids.has(row.id), false, `duplicate case ${row.id}`);
    ids.add(row.id);
    assert.equal(lanes.has(row.family), true, row.id);
    assert.match(row.group_id, /^c8-valid-/);
    assert.match(row.template_id, /^c8-valid-/);
    assert.equal(templates.has(row.template_id), false, row.template_id);
    templates.add(row.template_id);
    assert.ok(row.fixture.cwd && row.fixture.facts.length > 0, row.id);
    assert.ok(row.operation.tool && Object.keys(row.operation.input).length > 0, row.id);
    assert.ok(row.expected.reason_code && row.expected.rationale, row.id);
    assert.ok(row.sources.includes("fixtures/guardrail/RUBRIC.md"), row.id);
    const key = JSON.stringify([row.operation.tool, row.operation.input]);
    assert.equal(operations.has(key), false, `duplicate operation ${row.id}`);
    operations.add(key);
    groups.set(row.group_id, [...(groups.get(row.group_id) ?? []), row]);
    laneCounts.set(row.family, (laneCounts.get(row.family) ?? 0) + 1);
  }
  assert.equal(groups.size, 45);
  for (const [group, rows] of groups) {
    assert.equal(rows.length, 2, group);
    assert.deepEqual(new Set(rows.map((row) => row.expected.decision)),
      new Set(["allow", "require_approval"]), group);
  }
  for (const lane of lanes) assert.equal(laneCounts.get(lane), 10, lane);
});

test("VALID browser and org facts are separately supplied", async () => {
  const { cases } = await readJson("valid.json");
  for (const row of cases) {
    const observed = row.fixture.observations ?? {};
    if (observed.org) {
      assert.equal(observed.org.guessed, false, row.id);
      assert.ok(["production", "sandbox", "scratch", "developer", "trial", "unknown"].includes(observed.org.type), row.id);
    }
    if (row.operation.tool === "sf_browser_click") {
      assert.equal(typeof row.operation.input.ref, "string", row.id);
      assert.ok(observed.browserRef, row.id);
      if (observed.browserRef.status === "fresh") {
        assert.equal(observed.browserRef.snapshotSha256, observed.browserPage?.snapshotSha256, row.id);
        assert.ok(observed.browserPage.snapshot.includes(`ref=${row.operation.input.ref}`), row.id);
      }
    }
  }
});
