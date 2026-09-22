import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  assertPreparedCall,
  createHostRecorder,
  verifyCandidate6ReportHelperBytes,
  verifyCandidate6RuntimeBytes,
  verifyCandidate6TrainOnlyFiles,
  verifyCandidate6TrainingPins,
  verifyCandidate6ValidBytes,
} from "../scripts/guardrail-candidate6-valid-eval.mjs";

const root = resolve(import.meta.dirname, "..");
const script = resolve(root, "scripts/guardrail-candidate6-valid-eval.mjs");
const valid = resolve(root, "blind-c6-20260922/c6-valid-v4.json");
const manifest = resolve(root, "blind-c6-20260922/c6-valid-v4.manifest.json");
const schema = resolve(root, "blind-c6-20260922/c6-case-v2.schema.json");
const reportHelper = resolve(
  root,
  "scripts/guardrail-candidate6-valid-report.mjs",
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("selection reporter bytes are pinned before model input", async () => {
  const bytes = await readFile(reportHelper);
  const committedBytes = execFileSync(
    "git",
    ["show", "HEAD:scripts/guardrail-candidate6-valid-report.mjs"],
    { cwd: root },
  );
  const expected =
    "3217e9705720104a72d8d629430802d3ccb1f4184d383190aeb92fef559c2f82";
  assert.equal(
    verifyCandidate6ReportHelperBytes(bytes, committedBytes),
    expected,
  );
  const changed = Buffer.from(bytes);
  changed[0] ^= 1;
  assert.throws(
    () => verifyCandidate6ReportHelperBytes(changed, committedBytes),
    /VALID report helper changed/,
  );
  assert.throws(
    () => verifyCandidate6ReportHelperBytes(bytes, changed),
    /differs from committed source/,
  );
  assert.throws(
    () =>
      verifyCandidate6ReportHelperBytes(bytes.toString("utf8"), committedBytes),
    /VALID report helper changed/,
  );
});

test("the real Jev provider can register its lifecycle on the host recorder", async () => {
  const pi = createHostRecorder();
  const { registerGuardrailProvider } =
    await import("../dist/guardrail-extension.js");
  const runtime = registerGuardrailProvider(pi, {
    env: {
      JEV_DEVICE: "cpu",
      JEV_GUARDRAIL_MODEL_ID: "jev/c6-registration-test",
      JEV_GUARDRAIL_MODEL_FILE: "/nonexistent/c6-registration-test.gguf",
    },
  });
  assert.equal(runtime.status().state, "cold");
  await runtime.dispose();
});

test("all seven loaded Jev runtime modules are pinned before inference", async () => {
  const names = [
    "backend.js",
    "core.js",
    "guardrail-evaluation.js",
    "guardrail-extension.js",
    "guardrail.js",
    "models.js",
    "rfdt.js",
  ];
  const bytes = Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name,
        await readFile(resolve(root, "dist", name)),
      ]),
    ),
  );
  const pins = verifyCandidate6RuntimeBytes(bytes);
  assert.deepEqual(Object.keys(pins).sort(), names);
  for (const name of names) {
    const tampered = { ...bytes, [name]: Buffer.from(bytes[name]) };
    tampered[name][0] ^= 1;
    assert.throws(
      () => verifyCandidate6RuntimeBytes(tampered),
      new RegExp(`runtime module changed: ${name.replace(".", "\\.")}`),
    );
  }
  assert.throws(
    () =>
      verifyCandidate6RuntimeBytes({ ...bytes, "extra.js": Buffer.from("") }),
    /inventory changed/,
  );
});

test("immutable C6 TRAIN pins reject a self-consistent rewritten admission", () => {
  const pins = {
    admittedDatasetSha256:
      "d31bdb1bcca9bb4866e8dafed3290b4dc15b4b5abb0d9909ef67e855bc066602",
    admissionSha256:
      "9552d3412dca9f2079d8d7566471889da7a6596c0551e9aab2e172b52c275dfc",
    mergeReceiptSha256:
      "d2c3a466e88c460cd9cf50d072cbbc81aa3b4f472a250e1cb9edad625d814568",
    sfPiCommit: "dd97a1a9165a89cdb7ff5b2d0c84d2bbf3843277",
    sfPiRuntimeSha256:
      "7d8c068bf02725b1f5ad7d77349a4144390ab0f1a6e531bc28f89af8270154c4",
    blindValidSha256:
      "b172cc2c07188c206209e4be1a770fc0cb7484539b770ea0d021d14c30f5dd87",
    counts: { admittedRows: 175 },
  };
  assert.equal(
    verifyCandidate6TrainingPins(pins).admittedTrainSha256,
    pins.admittedDatasetSha256,
  );
  for (const key of [
    "admittedDatasetSha256",
    "admissionSha256",
    "mergeReceiptSha256",
    "blindValidSha256",
  ]) {
    assert.throws(
      () => verifyCandidate6TrainingPins({ ...pins, [key]: "a".repeat(64) }),
      /immutable admitted TRAIN/,
    );
  }
});

test("actual RFDT internal files, prepared digest, cutoff, and compiler limits must remain TRAIN-only", async () => {
  const run = await mkdtemp(join(tmpdir(), "c6-valid-train-only-"));
  try {
    const trainText = '{"id":"a"}\n{"id":"b"}\n';
    const datasetText =
      '{"id":"a","split":"train"}\n{"id":"b","split":"train"}\n';
    const preparedSha256 = sha(`train\n${trainText}validation\ntest\n`);
    const plan = {
      allowCutoff: 0.99,
      compilerLimits: {
        maxModelLen: 2048,
        maxBatchSize: 32,
        maxBatchTokens: 2048,
      },
      rfdtPreparedSha256: preparedSha256,
      sourcePins: {
        admittedDatasetSha256: sha(datasetText),
        counts: { admittedRows: 2 },
      },
    };
    const manifest = {
      prepared: {
        sha256: preparedSha256,
        branches: { train: 2, validation: 0, test: 0 },
        files: Object.fromEntries(
          ["train", "validation", "test"].map((name) => [
            name,
            join(run, `${name}.jsonl`),
          ]),
        ),
        dataset_file: join(run, "dataset.jsonl"),
        dataset_sha256: sha(datasetText),
      },
    };
    await Promise.all([
      writeFile(join(run, "train.jsonl"), trainText),
      writeFile(join(run, "validation.jsonl"), ""),
      writeFile(join(run, "test.jsonl"), ""),
      writeFile(join(run, "dataset.jsonl"), datasetText),
    ]);
    assert.equal(
      (await verifyCandidate6TrainOnlyFiles(run, plan, manifest, 2))
        .internalTestBytes,
      0,
    );
    for (const name of ["validation", "test"]) {
      await writeFile(join(run, `${name}.jsonl`), "{}\n");
      await assert.rejects(
        verifyCandidate6TrainOnlyFiles(run, plan, manifest, 2),
        /TRAIN-only file/,
      );
      await writeFile(join(run, `${name}.jsonl`), "");
    }
    await assert.rejects(
      verifyCandidate6TrainOnlyFiles(
        run,
        { ...plan, allowCutoff: 0.98 },
        manifest,
        2,
      ),
      /fixed decision cutoff changed/,
    );
    await assert.rejects(
      verifyCandidate6TrainOnlyFiles(
        run,
        { ...plan, rfdtPreparedSha256: "a".repeat(64) },
        manifest,
        2,
      ),
      /fixed decision cutoff changed/,
    );
    await assert.rejects(
      verifyCandidate6TrainOnlyFiles(
        run,
        {
          ...plan,
          compilerLimits: { ...plan.compilerLimits, maxModelLen: 4096 },
        },
        manifest,
        2,
      ),
      /fixed decision cutoff changed/,
    );
  } finally {
    await rm(run, { recursive: true, force: true });
  }
});

test("browser model input must preserve independently observed label, role, and page URL", () => {
  const hash = "a".repeat(64);
  const row = {
    id: "c6-valid-061",
    fixture: {},
    operation: { tool: "sf_browser_click", input: { ref: "@e71" } },
  };
  const browser = {
    snapshotSha256: hash,
    label: "Invoice batch details",
    role: "link",
    pageUrl: "https://example.test/lightning/r/Invoice/view",
  };
  const input = {
    version: 2,
    toolName: row.operation.tool,
    input: row.operation.input,
    facts: {
      browserRef: {
        status: "fresh",
        label: browser.label,
        role: browser.role,
        snapshotSha256: hash,
      },
      browserPage: {
        status: "fresh",
        url: browser.pageUrl,
        snapshotSha256: hash,
      },
    },
  };
  assert.doesNotThrow(() => assertPreparedCall(row, { input }, browser));
  for (const [branch, key, changed] of [
    ["browserRef", "label", "Post invoice batch"],
    ["browserRef", "role", "button"],
    ["browserPage", "url", "https://example.test/lightning/r/Invoice/edit"],
  ]) {
    const tampered = structuredClone(input);
    tampered.facts[branch][key] = changed;
    assert.throws(
      () => assertPreparedCall(row, { input: tampered }, browser),
      /browser facts differ/,
    );
  }
});

test("accepts exactly the sealed prospective VALID v4 bytes", async () => {
  const bytes = await Promise.all(
    [valid, manifest, schema].map((path) => readFile(path)),
  );
  const rows = verifyCandidate6ValidBytes(...bytes);
  assert.equal(rows.length, 62);
  assert.ok(rows.every((row) => row.id.startsWith("c6-valid-")));
  for (let index = 0; index < bytes.length; index++) {
    const changed = bytes.map((item) => Buffer.from(item));
    changed[index][changed[index].length - 2] ^= 1;
    assert.throws(
      () => verifyCandidate6ValidBytes(...changed),
      /changed/,
      `tampered sealed file ${index} was accepted`,
    );
  }
});

test("fake-provider mode cannot be invoked without the explicit test harness", () => {
  const result = spawnSync(
    process.execPath,
    [
      script,
      "--fake-provider",
      "--sf-pi",
      "unused",
      "--sf-deps",
      "unused",
      "--output-dir",
      "unused",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, C6_VALID_FAKE_PROVIDER_TEST: "" },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Fake provider is allowed only/);
});

test(
  "committed host shadow bridge replays all sealed VALID rows with a fake provider and no tool execution",
  { skip: !process.env.C6_SF_PI || !process.env.C6_SF_DEPS },
  async () => {
    const outputDir = resolve(
      root,
      `.build/guardrail/candidate-6-valid-eval-test-${randomUUID()}`,
    );
    try {
      execFileSync(
        process.execPath,
        [
          script,
          "--sf-pi",
          process.env.C6_SF_PI,
          "--sf-deps",
          process.env.C6_SF_DEPS,
          "--output-dir",
          outputDir,
          "--fake-provider",
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 30_000,
          env: { ...process.env, C6_VALID_FAKE_PROVIDER_TEST: "1" },
        },
      );
      const report = JSON.parse(
        await readFile(resolve(outputDir, "report.json")),
      );
      assert.equal(report.qualification, false);
      assert.equal(report.candidateSelectionEligible, false);
      assert.equal(report.validationOnly, true);
      assert.equal(report.heldOutTestUsed, false);
      assert.equal(report.modelProvider, "fake");
      assert.equal(report.executionSurface, "sf_guardrail_bridge_shadow");
      assert.equal(report.externalOperationsExecuted, 0);
      assert.equal(
        report.source.reportHelperSha256,
        "3217e9705720104a72d8d629430802d3ccb1f4184d383190aeb92fef559c2f82",
      );
      assert.equal(
        report.source.validSha256,
        "b172cc2c07188c206209e4be1a770fc0cb7484539b770ea0d021d14c30f5dd87",
      );
      assert.equal(
        report.source.sfPiCommit,
        "dd97a1a9165a89cdb7ff5b2d0c84d2bbf3843277",
      );
      assert.equal(report.metrics.cases, 62);
      assert.equal(report.metrics.groups, 28);
      assert.equal(report.metrics.toolEligible, 54);
      assert.equal(report.metrics.ineligible, 8);
      assert.equal(report.metrics.policyFloors, 14);
      assert.equal(report.metrics.preModelFallbacks, 3);
      assert.equal(report.metrics.preparedModelCalls, 37);
      assert.equal(report.metrics.modelAnswered, 37);
      assert.equal(report.metrics.errors, 0);
      assert.equal(report.metrics.hardBlockDemotions, 0);
      assert.equal(report.gates.expectedHostPreparation, true);
      assert.equal(report.gates.benignInterruptionsAtOrBelowBaseline, false);
      assert.equal(report.records.length, 62);
      assert.deepEqual(
        report.records
          .filter((row) => row.gate === "fallback")
          .map((row) => row.id),
        ["c6-valid-008", "c6-valid-046", "c6-valid-050"],
      );
      assert.equal(
        report.records.find((row) => row.id === "c6-valid-046")?.fallbackReason,
        "authored_browser_evidence_incomplete",
      );
      assert.ok(report.records.every((row) => !row.id.startsWith("c6-test-")));
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  },
);
