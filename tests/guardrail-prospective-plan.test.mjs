import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  guardrailRequest,
  GUARDRAIL_PROTOCOL_SHA256,
} from "../dist/guardrail.js";
import { GEMMA_TRAINING_REVISION } from "../dist/models.js";
import { prepareGuardrailProspectivePlan } from "../scripts/guardrail-prospective-plan.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonl = (rows) =>
  rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
const saveJson = (file, value) =>
  writeFile(file, JSON.stringify(value, null, 2) + "\n");
const baseWeightsSha256 =
  "3d4ef8d71c14db7e448a09ebe891cfb6bf32c57a9b44499ae0d1c098e48516b6";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "jev-guardrail-prospective-"));
  const run = join(root, "run");
  const bundleFile = join(root, "admitted-bundle.json");
  const receiptFile = join(root, "admission-receipt.json");
  await mkdir(run);
  const records = [
    {
      id: "train-safe",
      groupId: "train-group",
      split: "train",
      expected: "allow",
      modelEligible: true,
      riskInput: {
        version: 2,
        toolName: "bash",
        input: { command: "pwd" },
        facts: {},
      },
    },
    {
      id: "valid-risk",
      groupId: "valid-group",
      split: "validation",
      expected: "confirm",
      modelEligible: true,
      riskInput: {
        version: 2,
        toolName: "bash",
        input: { command: "rm -r scratch" },
        facts: {},
      },
    },
  ];
  const sourceSha256 = {
    corpusSha256: "a".repeat(64),
    baselineSha256: "b".repeat(64),
    baselineSourceSha256: "c".repeat(64),
    sfPiCommit: "d".repeat(40),
    supplementSha256: "e".repeat(64),
    treeFixtureSha256: "f".repeat(64),
    policyInterpretationSha256: "0".repeat(64),
  };
  const bundle = {
    version: 1,
    mockedExecution: true,
    trainingReady: true,
    status: "TRAIN/VALIDATION only; qualification pending",
    corpusSha256: sha(JSON.stringify(sourceSha256)),
    baselineSourceSha256: sourceSha256.baselineSourceSha256,
    sourceSha256,
    records,
  };
  await saveJson(bundleFile, bundle);
  const receipt = {
    version: 1,
    source: sourceSha256,
    outputSha256: sha(await readFile(bundleFile)),
    trainRows: 1,
    validationRows: 1,
    testRows: 0,
    trainingReady: true,
    modelCalls: 0,
    externalOperationsExecuted: 0,
    reservedLabelsRead: false,
    reservedContentEmitted: false,
  };
  await saveJson(receiptFile, receipt);
  const authored = records.map((row) => ({
    id: row.id,
    group_id: row.groupId,
    split: row.split,
    request: guardrailRequest(row.riskInput, "google/gemma-3-1b-it"),
    targets: { risk: { answer: row.expected } },
    target_provenance: { risk: { source: "supplied" } },
  }));
  const authoredBytes = jsonl(authored);
  await writeFile(join(run, "authored-train-validation.jsonl"), authoredBytes);
  await writeFile(join(run, "dataset.jsonl"), authoredBytes);
  const branches = records.map((row) => ({
    id: `${row.id}:risk`,
    source_id: row.id,
    group_id: row.groupId,
    split: row.split,
    question_id: "risk",
    question_type: "choice",
    template_version: "v2",
    output_labels: ["A", "B"],
    answer_labels: ["allow", "confirm"],
    target_probabilities: row.expected === "allow" ? [1, 0] : [0, 1],
    target_provenance: { risk: { source: "supplied" } },
  }));
  const trainBytes = jsonl([branches[0]]);
  const validationBytes = jsonl([branches[1]]);
  await writeFile(join(run, "train.jsonl"), trainBytes);
  await writeFile(join(run, "validation.jsonl"), validationBytes);
  await writeFile(join(run, "test.jsonl"), "");
  const plan = {
    version: 1,
    protocolSha256: GUARDRAIL_PROTOCOL_SHA256,
    bundleSha256: sha(await readFile(bundleFile)),
    admissionReceiptSha256: sha(await readFile(receiptFile)),
    admission: { bundle: bundleFile, receipt: receiptFile },
    corpusSha256: bundle.corpusSha256,
    baselineSourceSha256: bundle.baselineSourceSha256,
    sfPiCommit: sourceSha256.sfPiCommit,
    checkpoint: `/tmp/models--google--gemma-3-1b-it/snapshots/${GEMMA_TRAINING_REVISION}`,
    weights: { sha256: baseWeightsSha256 },
    baseFiles: {
      "model.safetensors": { sha256: baseWeightsSha256 },
      "config.json": { sha256: "1".repeat(64) },
      "tokenizer.json": { sha256: "2".repeat(64) },
    },
    steps: 16,
    testPassedToTraining: false,
    forbiddenFallbacks: true,
    selection:
      "Validation only; all guardrail gates must pass before a frozen held-out test",
  };
  await saveJson(join(run, "guardrail-plan.json"), plan);
  const manifest = {
    version: 1,
    status: "prepared",
    directory: run,
    base_model: "google/gemma-3-1b-it",
    base_revision: GEMMA_TRAINING_REVISION,
    template_version: "v2",
    source: {
      file: join(run, "authored-train-validation.jsonl"),
      sha256: sha(authoredBytes),
      examples: 2,
    },
    prepared: {
      files: {
        train: join(run, "train.jsonl"),
        validation: join(run, "validation.jsonl"),
        test: join(run, "test.jsonl"),
      },
      branches: { train: 1, validation: 1, test: 0 },
      sha256: sha(`train\n${trainBytes}validation\n${validationBytes}test\n`),
      dataset_file: join(run, "dataset.jsonl"),
      dataset_sha256: sha(authoredBytes),
    },
  };
  await saveJson(join(run, "manifest.json"), manifest);
  return {
    root,
    run,
    bundleFile,
    receiptFile,
    plan,
    bundle,
    receipt,
    manifest,
    branches,
  };
}

async function withFixture(check) {
  const state = await fixture();
  try {
    await check(state);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
}

test("prospective plan freezes a prepared TRAIN/VALID run with physical hashes", async () => {
  await withFixture(async ({ run, bundleFile }) => {
    const result = await prepareGuardrailProspectivePlan(run, bundleFile);
    const bytes = await readFile(result.path);
    const plan = JSON.parse(bytes);
    assert.equal(result.sha256, sha(bytes));
    assert.equal(plan.trainRows, 1);
    assert.equal(plan.validationRows, 1);
    assert.equal(plan.testRowsPassedToTraining, 0);
    assert.equal(plan.noTeacher, true);
    assert.equal(plan.criteria.deadlineMs, 750);
    assert.equal(plan.criteria.warmP95MaxMs, 500);
    assert.equal(
      plan.trainSha256,
      sha(await readFile(join(run, "train.jsonl"))),
    );
    assert.equal(
      plan.validationSha256,
      sha(await readFile(join(run, "validation.jsonl"))),
    );
    assert.equal(plan.emptyTestSha256, sha(""));
    await assert.rejects(
      prepareGuardrailProspectivePlan(run, bundleFile),
      /EEXIST/,
    );
    assert.deepEqual(await readFile(result.path), bytes);
  });
});

test("source bytes and authored labels cannot drift, even with a matching new bundle hash", async () => {
  await withFixture(
    async ({ run, bundleFile, receiptFile, bundle, receipt, plan }) => {
      bundle.records[0].expected = "confirm";
      await saveJson(bundleFile, bundle);
      await assert.rejects(
        prepareGuardrailProspectivePlan(run, bundleFile),
        /source bundle changed/,
      );
      plan.bundleSha256 = sha(await readFile(bundleFile));
      receipt.outputSha256 = plan.bundleSha256;
      await saveJson(receiptFile, receipt);
      plan.admissionReceiptSha256 = sha(await readFile(receiptFile));
      await saveJson(join(run, "guardrail-plan.json"), plan);
      await assert.rejects(
        prepareGuardrailProspectivePlan(run, bundleFile),
        /authored TRAIN\/VALID row differs/,
      );
    },
  );
});

test("prepared targets and original authored bytes are checked independently", async () => {
  await withFixture(async ({ run, bundleFile, manifest, branches }) => {
    branches[0].target_probabilities = [0, 1];
    const trainBytes = jsonl([branches[0]]);
    const validationBytes = await readFile(
      join(run, "validation.jsonl"),
      "utf8",
    );
    await writeFile(join(run, "train.jsonl"), trainBytes);
    manifest.prepared.sha256 = sha(
      `train\n${trainBytes}validation\n${validationBytes}test\n`,
    );
    await saveJson(join(run, "manifest.json"), manifest);
    await assert.rejects(
      prepareGuardrailProspectivePlan(run, bundleFile),
      /prepared branch differs/,
    );
  });
  await withFixture(async ({ run, bundleFile }) => {
    await writeFile(join(run, "authored-train-validation.jsonl"), "{}\n");
    await assert.rejects(
      prepareGuardrailProspectivePlan(run, bundleFile),
      /prepared dataset or split identity changed/,
    );
  });
});

test("trained runs, stale protocols and nonempty TEST splits cannot be frozen", async () => {
  await withFixture(async ({ run, bundleFile, manifest }) => {
    manifest.status = "trained";
    await saveJson(join(run, "manifest.json"), manifest);
    await assert.rejects(
      prepareGuardrailProspectivePlan(run, bundleFile),
      /not an untrained/,
    );
  });
  await withFixture(async ({ run, bundleFile, plan }) => {
    plan.protocolSha256 = "0".repeat(64);
    await saveJson(join(run, "guardrail-plan.json"), plan);
    await assert.rejects(
      prepareGuardrailProspectivePlan(run, bundleFile),
      /protocol differs/,
    );
  });
  await withFixture(async ({ run, bundleFile }) => {
    await writeFile(join(run, "test.jsonl"), "\n");
    await assert.rejects(
      prepareGuardrailProspectivePlan(run, bundleFile),
      /TEST is nonempty/,
    );
  });
});

test("changed admission receipts and symlinked run inputs cannot be frozen", async () => {
  await withFixture(async ({ run, bundleFile, receiptFile, receipt }) => {
    receipt.modelCalls = 1;
    await saveJson(receiptFile, receipt);
    await assert.rejects(
      prepareGuardrailProspectivePlan(run, bundleFile),
      /admission receipt changed/,
    );
  });
  await withFixture(async ({ root, run, bundleFile }) => {
    const authored = join(run, "authored-train-validation.jsonl");
    const relocated = join(root, "relocated-authored.jsonl");
    await writeFile(relocated, await readFile(authored));
    await rm(authored);
    await symlink(relocated, authored);
    await assert.rejects(
      prepareGuardrailProspectivePlan(run, bundleFile),
      /not a regular file/,
    );
  });
});
