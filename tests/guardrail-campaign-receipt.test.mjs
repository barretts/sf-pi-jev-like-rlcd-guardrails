import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  guardrailRequest,
  GUARDRAIL_PROTOCOL_SHA256,
} from "../dist/guardrail.js";
import {
  GUARDRAIL_CRITERIA,
  GUARDRAIL_CRITERIA_SHA256,
} from "../dist/guardrail-evaluation.js";
import {
  assertCompatibleCampaignSnapshot,
  assertFrozenTrainingPolicy,
  assertPreparedTrainingData,
  collectJevExecutableSources,
  verifyBaselineSources,
} from "../scripts/guardrail-campaign-receipt.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "jev-guardrail-receipt-"));
  const names = [
    "extensions/sf-guardrail/tests/guardrail-corpus.test.ts",
    "extensions/sf-guardrail/lib/risk-baseline-identity.ts",
    "extensions/sf-guardrail/index.ts",
    ...Array.from(
      { length: 8 },
      (_, i) => `extensions/sf-guardrail/lib/source-${i}.ts`,
    ),
  ];
  const sources = {};
  for (const name of names) {
    const file = join(root, name);
    await mkdir(dirname(file), { recursive: true });
    const bytes = Buffer.from(`source ${name}\n`);
    await writeFile(file, bytes);
    sources[name] = sha(bytes);
  }
  const runtime = Object.fromEntries(Object.entries(sources).sort());
  const bundle = {
    version: 1,
    mockedExecution: true,
    corpusSha256: "c".repeat(64),
    baselineSourceSha256: sha(JSON.stringify(runtime)),
    provenanceSourceSha256: sha(JSON.stringify(sources)),
    sourceSha256: sources,
    runtimeSourceSha256: runtime,
    records: [{ id: "synthetic" }],
    summary: { cases: 1 },
  };
  return { root, bundle, names };
}

test("receipt preflight rehashes the physical exporter and runtime inventory", async () => {
  const { root, bundle } = await fixture();
  try {
    const result = await verifyBaselineSources(root, bundle);
    assert.equal(result.baselineSourceSha256, bundle.baselineSourceSha256);
    assert.equal(
      result.exporterSha256,
      bundle.sourceSha256[
        "extensions/sf-guardrail/tests/guardrail-corpus.test.ts"
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("receipt preflight rejects a changed source even when the saved bundle is unchanged", async () => {
  const { root, bundle, names } = await fixture();
  try {
    await writeFile(join(root, names[3]), "changed\n");
    await assert.rejects(verifyBaselineSources(root, bundle), /source changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("receipt preflight rejects omitted exporter and inconsistent source summaries", async () => {
  const { root, bundle } = await fixture();
  try {
    delete bundle.sourceSha256[
      "extensions/sf-guardrail/tests/guardrail-corpus.test.ts"
    ];
    await assert.rejects(
      verifyBaselineSources(root, bundle),
      /omits an enforcement or export surface/,
    );
    bundle.sourceSha256[
      "extensions/sf-guardrail/tests/guardrail-corpus.test.ts"
    ] = "0".repeat(64);
    await assert.rejects(verifyBaselineSources(root, bundle), /source changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const jsonl = (rows) =>
  Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n") + "\n");

function preparedFixture() {
  const run = "/tmp/candidate";
  const bundlePath = "/tmp/candidate-admitted-bundle.json";
  const records = [
    ["train-safe", "train", "allow", "pwd"],
    ["train-risk", "train", "confirm", "rm -r scratch"],
    ["train-read", "train", "allow", "ls"],
    ["valid-safe", "validation", "allow", "date"],
    ["valid-risk", "validation", "confirm", "rm -r cache"],
  ].map(([id, split, expected, command]) => ({
    id,
    groupId: `${id}-group`,
    split,
    expected,
    modelEligible: true,
    riskInput: { version: 2, toolName: "bash", input: { command }, facts: {} },
  }));
  const bundle = {
    version: 1,
    mockedExecution: true,
    trainingReady: true,
    corpusSha256: "c".repeat(64),
    baselineSourceSha256: "b".repeat(64),
    records,
  };
  const admitted = {
    file: { path: bundlePath, sha256: sha(JSON.stringify(bundle)) },
    bundle,
  };
  admitted.receipt = {
    outputSha256: admitted.file.sha256,
    trainingReady: true,
    trainRows: 3,
    validationRows: 2,
    testRows: 0,
    modelCalls: 0,
    externalOperationsExecuted: 0,
    reservedLabelsRead: false,
    reservedContentEmitted: false,
  };
  admitted.receiptFile = {
    path: "/tmp/candidate-admission-receipt.json",
    sha256: sha(JSON.stringify(admitted.receipt)),
  };
  const authoredRows = records.map((row) => ({
    id: row.id,
    group_id: row.groupId,
    split: row.split,
    request: guardrailRequest(row.riskInput, "google/gemma-3-1b-it"),
    targets: { risk: { answer: row.expected } },
    target_provenance: { risk: { source: "supplied" } },
  }));
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
  const prepared = {
    authored: jsonl(authoredRows),
    dataset: jsonl(authoredRows),
    train: jsonl(branches.filter((row) => row.split === "train")),
    validation: jsonl(branches.filter((row) => row.split === "validation")),
    testSize: 0,
  };
  const runFiles = {
    "guardrail-plan.json": {
      path: `${run}/guardrail-plan.json`,
      sha256: sha("training plan"),
    },
    "authored-train-validation.jsonl": {
      path: `${run}/authored-train-validation.jsonl`,
      sha256: sha(prepared.authored),
    },
    "dataset.jsonl": {
      path: `${run}/dataset.jsonl`,
      sha256: sha(prepared.dataset),
    },
    "train.jsonl": { path: `${run}/train.jsonl`, sha256: sha(prepared.train) },
    "validation.jsonl": {
      path: `${run}/validation.jsonl`,
      sha256: sha(prepared.validation),
    },
  };
  const preparedSha256 = sha(
    Buffer.concat([
      Buffer.from("train\n"),
      prepared.train,
      Buffer.from("validation\n"),
      prepared.validation,
      Buffer.from("test\n"),
    ]),
  );
  const manifest = {
    directory: run,
    source: {
      file: runFiles["authored-train-validation.jsonl"].path,
      sha256: sha(prepared.authored),
      examples: records.length,
    },
    prepared: {
      sha256: preparedSha256,
      dataset_file: runFiles["dataset.jsonl"].path,
      dataset_sha256: sha(prepared.dataset),
      files: {
        train: runFiles["train.jsonl"].path,
        validation: runFiles["validation.jsonl"].path,
        test: `${run}/test.jsonl`,
      },
      branches: { train: 3, validation: 2, test: 0 },
    },
  };
  const training = {
    bundleSha256: admitted.file.sha256,
    admission: { bundle: bundlePath, receipt: admitted.receiptFile.path },
    admissionReceiptSha256: admitted.receiptFile.sha256,
    corpusSha256: bundle.corpusSha256,
    baselineSourceSha256: bundle.baselineSourceSha256,
    steps: 16,
    testPassedToTraining: false,
    forbiddenFallbacks: true,
    protocolSha256: GUARDRAIL_PROTOCOL_SHA256,
    selection:
      "Validation only; all guardrail gates must pass before a frozen held-out test",
  };
  const prospective = {
    run,
    bundleFile: bundlePath,
    bundleSha256: admitted.file.sha256,
    admissionReceiptSha256: admitted.receiptFile.sha256,
    corpusSha256: bundle.corpusSha256,
    baselineSourceSha256: bundle.baselineSourceSha256,
    trainingPlanSha256: runFiles["guardrail-plan.json"].sha256,
    authoredTrainValidationSha256: sha(prepared.authored),
    preparedDatasetSha256: sha(prepared.dataset),
    trainSha256: sha(prepared.train),
    validationSha256: sha(prepared.validation),
    emptyTestSha256: sha(Buffer.alloc(0)),
    preparedSha256,
    trainRows: 3,
    validationRows: 2,
    testRowsPassedToTraining: 0,
    noTeacher: true,
    noForbiddenFallback: true,
    testNotPassedToTraining: true,
    modelCallsBeforeFreeze: 0,
    testEvaluationsBeforeFreeze: 0,
    allowCutoff: 0.99,
    criteriaSha256: GUARDRAIL_CRITERIA_SHA256,
    criteria: GUARDRAIL_CRITERIA,
    selection: "validation_only",
    protocolSha256: GUARDRAIL_PROTOCOL_SHA256,
    steps: 16,
  };
  const verify = () =>
    assertPreparedTrainingData(
      prospective,
      training,
      manifest,
      runFiles,
      admitted,
      prepared,
    );
  return {
    prospective,
    training,
    manifest,
    runFiles,
    admitted,
    prepared,
    verify,
  };
}

test("receipt independently checks admitted TRAIN/VALID counts and membership", () => {
  const fixture = preparedFixture();
  assert.doesNotThrow(fixture.verify);
  fixture.prospective.trainRows = 2;
  fixture.prospective.validationRows = 3;
  fixture.manifest.prepared.branches.train = 2;
  fixture.manifest.prepared.branches.validation = 3;
  assert.throws(fixture.verify, /train split count changed/);
});

test("receipt rejects a prepared branch moved across split membership with matching hashes", () => {
  const fixture = preparedFixture();
  const rows = fixture.prepared.train
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .map(JSON.parse);
  rows[0].source_id = "valid-safe";
  fixture.prepared.train = jsonl(rows);
  fixture.runFiles["train.jsonl"].sha256 = sha(fixture.prepared.train);
  fixture.prospective.trainSha256 = sha(fixture.prepared.train);
  fixture.manifest.prepared.sha256 = sha(
    Buffer.concat([
      Buffer.from("train\n"),
      fixture.prepared.train,
      Buffer.from("validation\n"),
      fixture.prepared.validation,
      Buffer.from("test\n"),
    ]),
  );
  fixture.prospective.preparedSha256 = fixture.manifest.prepared.sha256;
  assert.throws(fixture.verify, /prepared train source membership changed/);
});

test("receipt rejects a nonempty prepared TEST branch without opening it", () => {
  const fixture = preparedFixture();
  fixture.prepared.testSize = 1;
  assert.throws(
    fixture.verify,
    /prepared TRAIN\/VALID data or source identity changed/,
  );
});

test("receipt binds the physical admission receipt and source bundle path", () => {
  const fixture = preparedFixture();
  assert.doesNotThrow(fixture.verify);
  fixture.training.admission.bundle = "/tmp/another-bundle.json";
  assert.throws(fixture.verify, /source identity changed/);
  fixture.training.admission.bundle = fixture.admitted.file.path;
  fixture.prospective.admissionReceiptSha256 = "0".repeat(64);
  assert.throws(fixture.verify, /source identity changed/);
});

test("receipt enforces the full frozen criteria and validation-only policy", () => {
  const { prospective, training } = preparedFixture();
  assert.doesNotThrow(() => assertFrozenTrainingPolicy(prospective, training));
  assert.throws(
    () =>
      assertFrozenTrainingPolicy(
        {
          ...prospective,
          criteria: { ...GUARDRAIL_CRITERIA, warmP95MaxMs: 600 },
        },
        training,
      ),
    /frozen criteria changed/,
  );
  assert.throws(
    () =>
      assertFrozenTrainingPolicy(
        { ...prospective, selection: "test_selection" },
        training,
      ),
    /no-TEST training policy/,
  );
});

test("receipt pins RFDT source, worker and dependency bytes", async () => {
  const names = Object.keys(await collectJevExecutableSources());
  for (const name of [
    "src/rfdt.ts",
    "dist/rfdt.js",
    "rfdt/worker.py",
    "rfdt/requirements.txt",
    "rfdt/requirements.lock",
    "scripts/build-rfdt.sh",
  ])
    assert.ok(names.includes(name), `missing executable source ${name}`);

  const root = await mkdtemp(join(tmpdir(), "jev-guardrail-rfdt-sources-"));
  try {
    for (const name of names) {
      const file = join(root, name);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `source ${name}\n`);
    }
    const original = await collectJevExecutableSources(root);
    await writeFile(join(root, "src/rfdt.ts"), "changed RFDT source\n");
    const changed = await collectJevExecutableSources(root);
    assert.throws(
      () =>
        assertCompatibleCampaignSnapshot(
          { jevCommit: "same-commit", jevSources: original },
          { jevCommit: "same-commit", jevSources: changed },
          root,
        ),
      /campaign inputs or executable surfaces changed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("receipt remains valid across a later docs commit but rejects source drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-guardrail-receipt-history-"));
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  const commit = (message) => {
    git("add", "docs.md", "source.ts");
    git(
      "-c",
      "user.name=Receipt Test",
      "-c",
      "user.email=receipt@example.test",
      "commit",
      "-qm",
      message,
    );
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "--quiet");
    await writeFile(join(root, "source.ts"), "export const risk = 1;\n");
    await writeFile(join(root, "docs.md"), "first\n");
    const first = commit("initial");
    const pinned = {
      jevCommit: first,
      jevSources: { "source.ts": sha("export const risk = 1;\n") },
      modelSha256: "a".repeat(64),
    };
    await writeFile(join(root, "docs.md"), "later evidence\n");
    const docsCommit = commit("evidence");
    assert.doesNotThrow(() =>
      assertCompatibleCampaignSnapshot(
        pinned,
        { ...pinned, jevCommit: docsCommit },
        root,
      ),
    );
    assert.throws(
      () =>
        assertCompatibleCampaignSnapshot(
          pinned,
          { ...pinned, jevCommit: "0".repeat(40) },
          root,
        ),
      /not a descendant/,
    );
    await writeFile(join(root, "source.ts"), "export const risk = 2;\n");
    const sourceCommit = commit("changed executable source");
    assert.throws(
      () =>
        assertCompatibleCampaignSnapshot(
          pinned,
          {
            ...pinned,
            jevCommit: sourceCommit,
            jevSources: { "source.ts": sha("export const risk = 2;\n") },
          },
          root,
        ),
      /campaign inputs or executable surfaces changed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
