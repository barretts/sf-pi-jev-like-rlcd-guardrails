import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bytes = (path) => readFile(resolve(root, path));
const sha = (value) => createHash("sha256").update(value).digest("hex");

test("C9 VALID source, inventories, and model-free host receipt remain bound", async () => {
  const [sourceBytes, manifestBytes, schemaBytes, rubricBytes, preflightBytes] =
    await Promise.all([
      bytes("blind-c9-20260922/valid.json"),
      bytes("blind-c9-20260922/manifest.json"),
      bytes("blind-c9-20260922/case.schema.json"),
      bytes("fixtures/guardrail/RUBRIC.md"),
      bytes("reports/guardrail-risk-2026-09-21/candidate-9-evidence/valid/preflight-bdbf629.json"),
    ]);
  const source = JSON.parse(sourceBytes), manifest = JSON.parse(manifestBytes);
  const preflight = JSON.parse(preflightBytes);
  assert.equal(source.schema_version, "c9.1");
  assert.equal(source.split, "valid");
  assert.equal(manifest.source.sha256, sha(sourceBytes));
  assert.equal(manifest.authoring.schema_sha256, sha(schemaBytes));
  assert.equal(manifest.authoring.rubric_sha256, sha(rubricBytes));
  assert.equal(manifest.model_predictions_present, false);
  assert.equal(manifest.held_out_test_read, false);
  assert.equal(source.cases.length, 160);
  assert.equal(manifest.source.case_count, 160);
  const groups = new Map(), decisions = {};
  for (const [index, row] of source.cases.entries()) {
    assert.equal(row.id, `c9-valid-${String(index + 1).padStart(3, "0")}`);
    groups.set(row.group_id, [...(groups.get(row.group_id) ?? []), row.id]);
    decisions[row.expected.decision] = (decisions[row.expected.decision] ?? 0) + 1;
  }
  assert.equal(groups.size, 80);
  assert.ok([...groups.values()].every((ids) => ids.length === 2));
  assert.deepEqual(decisions, { allow: 80, require_approval: 78, hard_block: 2 });
  assert.equal(manifest.inventory.ordered_ids_sha256, sha(JSON.stringify(source.cases.map((row) => row.id))));
  assert.equal(
    manifest.inventory.groups_sha256,
    sha(JSON.stringify(Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b))))),
  );
  assert.equal(preflight.source_sha256, sha(sourceBytes));
  assert.equal(preflight.manifest_sha256, sha(manifestBytes));
  assert.equal(preflight.host_commit, manifest.host.commit);
  assert.equal(preflight.host_baseline_sha256, manifest.host.baseline_identity_sha256);
  assert.equal(preflight.default_policy_sha256, manifest.host.default_policy_sha256);
  assert.equal(preflight.mode, "fake-facts-no-model-no-execution");
  assert.equal(preflight.status.length, 160);
  for (const [index, row] of preflight.status.entries()) {
    assert.equal(row.id, source.cases[index].id);
    assert.equal(row.group_id, source.cases[index].group_id);
    assert.equal(row.expected, source.cases[index].expected.decision);
  }
  const routing = preflight.status.reduce((counts, row) => {
    counts[row.routing] = (counts[row.routing] ?? 0) + 1;
    return counts;
  }, {});
  assert.deepEqual(routing, { model_prepared: 116, rules_fallback: 39, pre_model_fallback: 5 });
  assert.equal(preflight.status.filter((row) => row.expected === "hard_block" && row.baseline_action === "block").length, 2);
  assert.equal(preflight.status.some((row) => row.routing === "preparation_error"), false);
});
