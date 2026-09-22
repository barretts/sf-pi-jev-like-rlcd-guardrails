#!/usr/bin/env node
/** Seal independently authored C9 VALID cases before model fitting. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const blind = resolve(root, "blind-c9-20260922");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const need = (ok, message) => { if (!ok) throw new Error(message); };
const files = {
  native: resolve(blind, "native-cases.json"),
  shell: resolve(blind, "authoring/shell-herdr-valid.json"),
  schema: resolve(blind, "case.schema.json"),
  rubric: resolve(root, "fixtures/guardrail/RUBRIC.md"),
};
const bytes = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, path]) => [key, await readFile(path)])));
const native = JSON.parse(bytes.native), shell = JSON.parse(bytes.shell);
need(native.schema_version === "c9.1" && shell.schema_version === "c9.1", "Wrong source version");
need(native.split === "valid" && shell.split === "valid", "Only VALID sources are permitted");
need(native.cases.length === 112 && shell.cases.length === 48, "Unexpected authored case count");
const sourceIds = new Set();
const cases = [...native.cases, ...shell.cases].map((row, index) => {
  need(typeof row.id === "string" && !sourceIds.has(row.id), "Duplicate or invalid authored ID");
  sourceIds.add(row.id);
  return { ...row, id: `c9-valid-${String(index + 1).padStart(3, "0")}` };
});
const allowed = new Set(["allow", "require_approval", "hard_block"]);
const groups = new Map(), templates = new Set(), operations = new Set();
const familyCounts = {}, decisionCounts = {};
for (const row of cases) {
  need(row.family && row.group_id && row.template_id, `Missing identity on ${row.id}`);
  need(row.fixture?.cwd && Array.isArray(row.fixture.facts) && row.fixture.facts.length, `Missing fixture on ${row.id}`);
  need(row.operation?.tool && row.operation.input && !Array.isArray(row.operation.input), `Missing operation on ${row.id}`);
  need(allowed.has(row.expected?.decision) && row.expected?.reason_code && row.expected?.rationale, `Missing rubric label on ${row.id}`);
  need(Array.isArray(row.sources) && row.sources.length > 0, `Missing source on ${row.id}`);
  const group = groups.get(row.group_id) ?? [];
  group.push(row.id);
  groups.set(row.group_id, group);
  templates.add(row.template_id);
  const operation = JSON.stringify([row.operation.tool, row.operation.input]);
  need(!operations.has(operation), `Duplicate exact operation on ${row.id}`);
  operations.add(operation);
  familyCounts[row.family] = (familyCounts[row.family] ?? 0) + 1;
  decisionCounts[row.expected.decision] = (decisionCounts[row.expected.decision] ?? 0) + 1;
}
need(cases.length >= 140 && groups.size >= 70, "Population misses C9 floor");
need([...groups.values()].every((ids) => ids.length === 2), "Every related group must have exactly two cases");
const validBytes = Buffer.from(JSON.stringify({ schema_version: "c9.1", split: "valid", cases }, null, 2) + "\n");
const manifest = {
  version: 1,
  purpose: "candidate9_independent_prospective_valid_seal",
  split: "valid",
  model_predictions_present: false,
  held_out_test_read: false,
  authoring_boundary: "Rubric and sf-pi tool contracts only; no C9 TRAIN/CAL, C8 VALID case bodies, held-out TEST bodies, or model predictions read by the blind authors.",
  limited_review_exposure: "Before seal, the root agent saw only the already-disclosed c9-valid-144 indirect-eval line and its paired printed-control line while locating a host fallback bug; these cases were not shared with TRAIN or scorer owners.",
  human_label_review: "pending",
  source: { path: "blind-c9-20260922/valid.json", sha256: sha(validBytes), case_count: cases.length, group_count: groups.size, template_count: templates.size },
  authoring: {
    native_sha256: sha(bytes.native), shell_sha256: sha(bytes.shell),
    schema_sha256: sha(bytes.schema), rubric_sha256: sha(bytes.rubric),
  },
  host: {
    repo: "sf-pi",
    commit: "4f7fae07f7c04a7ca9f4fdbabc4594a20a8f1d2a",
    baseline_identity_sha256: "4c4f874ef4f19988e7a7db84055ebf28c6d25813723acf2c807934e2c8f15421",
    default_policy_sha256: "e02e9c0914c1b1395adb0b341d6149b54b0b514c2b86cceab44994b5f6425347",
  },
  inventory: {
    ids: cases.map((row) => row.id),
    ordered_ids_sha256: sha(JSON.stringify(cases.map((row) => row.id))),
    groups: Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b))),
    groups_sha256: sha(JSON.stringify(Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b))))),
    families: familyCounts,
    decisions: decisionCounts,
  },
  proof_limit: "This is independent machine-authored operation-policy gold, not human approval, model effectiveness, held-out qualification, or production acceptance.",
};
await writeFile(resolve(blind, "valid.json"), validBytes, { flag: "wx" });
await writeFile(resolve(blind, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ source_sha256: manifest.source.sha256, cases: cases.length, groups: groups.size, families: familyCounts, decisions: decisionCounts }));
