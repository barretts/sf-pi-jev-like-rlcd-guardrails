import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { guardrailRequest } from "../dist/guardrail.js";
import { prepareRfdt, RFDT_BASE_MODEL } from "../dist/rfdt.js";
import {
  selectAdmittedTrainRows,
  verifyPreparedRun,
  withAttempt,
} from "../scripts/guardrail-candidate6-train.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function source() {
  const rows = Array.from({ length: 186 }, (_, index) => ({
    id: `c6-unit-${index}`,
    group_id: `c6-unit-group-${Math.floor(index / 2)}`,
    split: "train",
    request: guardrailRequest(
      {
        version: 2,
        toolName: "bash",
        input: { command: `printf unit-${index}` },
        facts: {},
      },
      RFDT_BASE_MODEL,
    ),
    targets: { risk: { answer: index % 2 ? "confirm" : "allow" } },
    target_provenance: { risk: { source: "supplied" } },
  }));
  const cases = rows.map((row) => ({
    id: row.id,
    groupId: row.group_id,
    disposition: "admit",
    reason: "Reviewed against the operation policy rubric.",
    sourceEvidence: ["sf-pi tool contract"],
  }));
  return { rows, cases };
}

test("admitted research TRAIN may be a group-complete exact source subset", () => {
  const { rows, cases } = source();
  for (const item of cases.slice(0, 2)) item.disposition = "exclude";
  const admitted = rows.slice(2);
  assert.deepEqual(selectAdmittedTrainRows(rows, admitted, cases), {
    sourceRows: 186,
    admittedRows: 184,
    excludedRows: 2,
    admittedGroups: 92,
    excludedGroups: 1,
  });
});

test("a partial operation group cannot be admitted", () => {
  const { rows, cases } = source();
  cases[0].disposition = "exclude";
  assert.throws(
    () => selectAdmittedTrainRows(rows, rows.slice(1), cases),
    /mixed admission dispositions/,
  );
});

test("an admitted file cannot change inputs, targets, or row order", () => {
  const { rows, cases } = source();
  const edited = structuredClone(rows);
  edited[2].targets.risk.answer = "allow";
  assert.throws(
    () => selectAdmittedTrainRows(rows, edited, cases),
    /changed a source row/,
  );
  const reordered = structuredClone(rows);
  [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  assert.throws(
    () => selectAdmittedTrainRows(rows, reordered, cases),
    /original order/,
  );
});

test("historical validation and unreviewed dispositions cannot enter training", () => {
  const { rows, cases } = source();
  const diagnostic = structuredClone(rows);
  diagnostic[0].split = "validation";
  assert.throws(
    () => selectAdmittedTrainRows(rows, diagnostic, cases),
    /C6 research row|split/i,
  );
  const incomplete = structuredClone(cases);
  incomplete[0].sourceEvidence = [];
  assert.throws(
    () => selectAdmittedTrainRows(rows, rows, incomplete),
    /source evidence/,
  );
});

test("actual RFDT preparation yields an empty internal VALID and TEST and a pinned TRAIN", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-c6-train-fixture-"));
  try {
    const rows = source().rows.slice(0, 2);
    const input = join(directory, "admitted-train.jsonl");
    const bytes = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    await writeFile(input, bytes);
    const run = join(directory, "rfdt-run");
    const backend = {
      async compile(plan) {
        return plan.questions.map((branch) => ({
          branch_id: branch.branch_id,
          rendered: "model-free fixture rendering",
          tokens: [1, 2, 3],
          token_ids: Object.fromEntries(
            branch.output_labels.map((label, index) => [label, index + 4]),
          ),
        }));
      },
    };
    const manifest = await prepareRfdt(input, {
      outputDir: run,
      templateVersion: "v2",
      backend,
    });
    const sourcePins = {
      admittedDatasetFile: input,
      admittedDatasetSha256: sha(bytes),
      counts: { admittedRows: rows.length },
    };
    const plan = { rfdtPreparedSha256: manifest.prepared.sha256 };
    const checked = await verifyPreparedRun(run, plan, sourcePins);
    assert.deepEqual(checked.prepared.branches, {
      train: 2,
      validation: 0,
      test: 0,
    });
    assert.equal(await readFile(join(run, "validation.jsonl"), "utf8"), "");
    assert.equal(await readFile(join(run, "test.jsonl"), "utf8"), "");
    await writeFile(join(run, "test.jsonl"), "{}\n");
    await assert.rejects(
      verifyPreparedRun(run, plan, sourcePins),
      /TEST file must be empty|test file must be empty/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed or cancelled research operation leaves an exact attempt receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-c6-attempt-fixture-"));
  try {
    const controller = new AbortController();
    controller.abort(new Error("fixture cancelled"));
    await assert.rejects(
      withAttempt(
        directory,
        "train",
        { admittedDatasetSha256: "fixture-pin" },
        async () => {
          throw controller.signal.reason;
        },
        controller.signal,
      ),
      /fixture cancelled/,
    );
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    const receipt = JSON.parse(
      await readFile(join(directory, files[0]), "utf8"),
    );
    assert.equal(receipt.phase, "train");
    assert.equal(receipt.status, "aborted");
    assert.equal(receipt.sourcePins.admittedDatasetSha256, "fixture-pin");
    assert.match(receipt.error.message, /fixture cancelled/);
    assert.equal(receipt.qualification, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
