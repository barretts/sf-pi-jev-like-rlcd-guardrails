import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertAggregateScreen,
  assertPinned,
  partitionResearchRows,
  validateResearchRows,
} from "../scripts/guardrail-candidate6-research-merge.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const corrected = resolve(
  root,
  ".build/guardrail/candidate-6-dev-corrections-v5-20260922/merged-train-validation.jsonl",
);
const script = resolve(root, "scripts/guardrail-candidate6-research-merge.mjs");
const supplement = resolve(
  root,
  ".build/guardrail/candidate-6-supplement-preflight-dd97a1a/train.jsonl",
);
const proposal = resolve(
  root,
  ".build/guardrail/candidate-6-proposal-projection-20260922-dd97a1a-v2/train.jsonl",
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonl = (path) =>
  readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));

test("source pins fail closed on changed bytes", () => {
  const bytes = Buffer.from("candidate-six-source");
  assert.doesNotThrow(() => assertPinned(bytes, sha(bytes), "fixture"));
  assert.throws(
    () => assertPinned(Buffer.from("tampered"), sha(bytes), "fixture"),
    /fixture SHA-256 mismatch/,
  );
});

test("RFDT requests must regenerate exactly and IDs and inputs must be unique", () => {
  const row = JSON.parse(readFileSync(corrected, "utf8").split("\n")[0]);
  assert.equal(row.split, "train");
  assert.equal(validateResearchRows([row], ["train"]).splits.train, 1);
  assert.throws(() => validateResearchRows([row, row], ["train"]));
  const changed = structuredClone(row);
  changed.id = `${row.id}-mutated`;
  changed.request.questions[0].criteria[0].description += " tampered";
  assert.throws(() => validateResearchRows([changed], ["train"]));
});

test("TRAIN and historical diagnostics remain separate and cannot cross splits", () => {
  const correctedRows = jsonl(corrected);
  const supplementRows = jsonl(supplement);
  const proposalRows = jsonl(proposal);
  const { trainRows, historicalDiagnosticRows } = partitionResearchRows(
    correctedRows,
    supplementRows,
    proposalRows,
  );
  assert.equal(trainRows.length, 186);
  assert.equal(historicalDiagnosticRows.length, 96);
  assert.ok(trainRows.every((row) => row.split === "train"));
  assert.ok(
    historicalDiagnosticRows.every((row) => row.split === "validation"),
  );
  assert.throws(() =>
    partitionResearchRows(
      correctedRows,
      [...supplementRows, historicalDiagnosticRows[0]],
      proposalRows,
    ),
  );
});

test("request-only screen rejects missing or nonzero collision aggregates", () => {
  const zero = Object.fromEntries(
    ["exact", "canonical", "groups", "templates", "same_effect"].map((key) => [
      key,
      { shared_keys: 0, cross_pairs: 0 },
    ]),
  );
  assert.doesNotThrow(() =>
    assertAggregateScreen(
      { left_count: 186, right_count: 55, collisions: zero },
      186,
      55,
    ),
  );
  assert.throws(() =>
    assertAggregateScreen(
      { left_count: 185, right_count: 55, collisions: zero },
      186,
      55,
    ),
  );
  const collision = {
    ...zero,
    same_effect: { shared_keys: 1, cross_pairs: 1 },
  };
  assert.throws(() =>
    assertAggregateScreen(
      { left_count: 186, right_count: 55, collisions: collision },
      186,
      55,
    ),
  );
});

test(
  "current host produces only a nonqualifying TRAIN and historical VALID handoff",
  { skip: !process.env.C6_SF_PI },
  async () => {
    const outputDir = resolve(
      root,
      `.build/guardrail/candidate-6-research-merge-test-${randomUUID()}`,
    );
    try {
      const result = spawnSync(
        process.execPath,
        [script, "--sf-pi", process.env.C6_SF_PI, "--output-dir", outputDir],
        { encoding: "utf8", timeout: 30_000 },
      );
      assert.equal(result.status, 0, result.stderr);
      const receipt = JSON.parse(
        readFileSync(resolve(outputDir, "receipt.json"), "utf8"),
      );
      assert.deepEqual(receipt.rows, {
        train: 186,
        historicalDiagnosticValidation: 96,
        prospectiveBlindValidation: 0,
        test: 0,
        groups: 94,
      });
      assert.equal(receipt.trainingReady, false);
      assert.equal(receipt.selection.mode, "validation_only");
      assert.equal(
        receipt.selection.historicalValidationRole,
        "diagnostic_only_not_candidate_selection",
      );
      assert.equal(receipt.splitIsolation.semanticDisjointnessProven, false);
      assert.equal(receipt.splitIsolation.blindRowsEmitted, false);
      assert.equal(receipt.modelCalls, 0);
      assert.equal(receipt.externalOperationsExecuted, 0);
      assert.equal(receipt.prepareRfdtCalls, 0);
      const trainBytes = readFileSync(resolve(outputDir, "train.jsonl"));
      const historicalBytes = readFileSync(
        resolve(outputDir, "historical-diagnostic-valid.jsonl"),
      );
      assert.equal(receipt.datasets.train.sha256, sha(trainBytes));
      assert.equal(
        receipt.datasets.historicalDiagnostic.sha256,
        sha(historicalBytes),
      );
      assert.equal(
        receipt.datasets.historicalDiagnostic.candidateSelectionAllowed,
        false,
      );
      assert.ok(
        jsonl(resolve(outputDir, "train.jsonl")).every(
          (row) => row.split === "train",
        ),
      );
      assert.ok(
        jsonl(resolve(outputDir, "historical-diagnostic-valid.jsonl")).every(
          (row) => row.split === "validation",
        ),
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  },
);
