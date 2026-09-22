import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  "exact_policy",
]);

test("VALID source exactly reproduces the exported corpus", async () => {
  const exported = await readJson("valid.json");
  assert.deepEqual(exported, makeCorpus("valid", definitions));
  assert.equal(exported.schema_version, "c8.2");
  assert.equal(exported.split, "valid");
  assert.equal(exported.cases.length, 96);
});

test("VALID cases have 48 complete, nonoverlapping contrast groups", async () => {
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
  assert.equal(groups.size, 48);
  for (const [group, rows] of groups) {
    assert.equal(rows.length, 2, group);
    assert.deepEqual(new Set(rows.map((row) => row.expected.decision)),
      new Set(["allow", group.includes("exact_policy") ? "hard_block" : "require_approval"]), group);
  }
  for (const lane of lanes) assert.equal(laneCounts.get(lane), lane === "exact_policy" ? 6 : 10, lane);
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

test("VALID host receipt pins every baseline action and prepared input", async () => {
  const sourceBytes = await readFile(resolve(directory, "valid.json"));
  const corpus = JSON.parse(sourceBytes);
  const receipt = await readJson("valid-host-preflight.json");
  assert.equal(receipt.source_sha256, createHash("sha256").update(sourceBytes).digest("hex"));
  assert.equal(receipt.mode, "fake-facts-no-model-no-execution");
  assert.equal(receipt.label_review, "machine_authored_human_review_pending");
  assert.equal(receipt.host_commit, "d86cdcfcfa02e419a4255291d16e56c48a5f2ade");
  assert.equal(receipt.host_baseline_sha256, "927c25ebee99f59ea349bcd6d5da06c9a999255e4e99d7658ee0f113da96e4f2");
  assert.equal(receipt.jev_runtime_commit, "c8d276d9a4157c7d825a0960b3e886a6d508c499");
  assert.equal(receipt.decision_base_protocol_sha256, "f4f00541c9ce815ca17d19400488f5e4e999c87e9712b7c0ec17419068e85f9b");
  assert.equal(receipt.scorer_prompt_sha256, "d67044fb1a5d2a519f12e8b7561ce8e7ed743f42753f726812b0bd99ea6ab530");
  assert.equal(receipt.model_protocol_sha256, receipt.scorer_prompt_sha256);
  assert.equal(receipt.preflight_script_sha256,
    createHash("sha256").update(await readFile(resolve(root, "scripts/guardrail-candidate8-valid-preflight.mjs"))).digest("hex"));
  assert.equal(receipt.rubric_sha256,
    createHash("sha256").update(await readFile(resolve(root, "fixtures/guardrail/RUBRIC.md"))).digest("hex"));
  assert.equal(receipt.case_schema_sha256,
    createHash("sha256").update(await readFile(resolve(directory, "case.schema.json"))).digest("hex"));
  for (const field of ["jev_runtime_core_js_sha256", "jev_runtime_guardrail_js_sha256", "jev_runtime_calibration_js_sha256"])
    assert.match(receipt[field], /^[a-f0-9]{64}$/, field);
  assert.equal(receipt.status.length, corpus.cases.length);
  assert.deepEqual(receipt.status.map((row) => row.id), corpus.cases.map((row) => row.id));
  for (const row of receipt.status) {
    assert.ok(["allow", "confirm", "block"].includes(row.baseline_action), row.id);
    if (row.routing === "model_prepared")
      assert.match(row.risk_input_sha256, /^[a-f0-9]{64}$/, row.id);
    else
      assert.equal(row.risk_input_sha256, null, row.id);
  }
  assert.equal(receipt.summary.exact_policy.baseline_blocks, 3);
  assert.equal(receipt.summary.exact_policy.model_prepared, 0);
});
