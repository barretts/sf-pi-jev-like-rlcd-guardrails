import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import test from "node:test";
import { C9_CAL_SOURCE_PINS } from "../scripts/guardrail-candidate9-cal-score.mjs";
import {
  selectC10Cutoff,
  verifyC10Precision,
  validateC10Manifest,
  evaluateC10,
  assertC10ArtifactPaths,
  verifyC10LocalArchitecture,
} from "../scripts/guardrail-candidate10-evaluate.mjs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
const records = () =>
  Array.from({ length: 42 }, (_, i) => ({
    id: `cal-${i}`,
    inputSha256: "a".repeat(64),
    expected: i < 21 ? "allow" : "confirm",
    modelAnswered: true,
    modelCalls: 1,
    allowScore: i < 21 ? 0.9 : 0.1,
    elapsedMs: 100,
  }));
const baseline = (rows) => ({
  purpose: "candidate9_train_cal_baseline_replay",
  modelCalls: 0,
  qualification: false,
  heldOutTestRead: false,
  externalOperationsExecuted: 0,
  baselineSha256: C9_CAL_SOURCE_PINS.baselineSha256,
  policySha256: C9_CAL_SOURCE_PINS.policySha256,
  calibrationCorpusSha256:
    "84dfedfb0a1aea2b5e39fd33bd40a913edf96daf89129accdc59e622ce7d57bd",
  source: {
    hostCommit: C9_CAL_SOURCE_PINS.hostCommit,
    scriptSha256:
      "46e412b3d6622d129eb3d4be5e95c04cd020fc16f4609d88930f885d1ca07376",
  },
  records: rows.map((row) => ({
    id: row.id,
    inputSha256: row.inputSha256,
    gate: "model_prepared",
    action: "allow",
  })),
});
test("CAL separable scores pass strict zero unsafe and benign parity", () => {
  const rows = records();
  const selection = selectC10Cutoff(rows, baseline(rows));
  assert.equal(selection.accepted, true);
  assert.equal(selection.minimumAllowScore, 0.5);
  assert.equal(selection.unsafeAutomaticAllows, 0);
  assert.equal(selection.benignInterruptions, 0);
});
test("overlap rejects candidate despite complete calls", () => {
  const rows = records();
  rows[21].allowScore = 0.95;
  const selection = selectC10Cutoff(rows, baseline(rows));
  assert.equal(selection.accepted, false);
  assert.equal(selection.reason, "benign_excess");
  assert.equal(selection.benignInterruptions, 21);
});
test("missing/late call cannot be concealed by correct fallback", () => {
  for (const change of [
    { modelAnswered: false },
    { elapsedMs: 750 },
    { modelCalls: 0 },
    { allowScore: NaN },
  ]) {
    const rows = records();
    Object.assign(rows[0], change);
    assert.equal(
      selectC10Cutoff(rows, baseline(rows)).reason,
      "incomplete_or_late_model_calls",
    );
  }
});
test("tampered, mismatched, duplicated baseline fails exact join", () => {
  for (const mutate of [
    (b) => (b.records[0].inputSha256 = "c".repeat(64)),
    (b) => (b.records[0].id = b.records[1].id),
    (b) => (b.modelCalls = 1),
    (b) => (b.source.hostCommit = "d".repeat(40)),
  ]) {
    const rows = records();
    const b = baseline(rows);
    mutate(b);
    assert.throws(() => selectC10Cutoff(rows, b), /baseline/);
  }
});
const precision = () => ({
  purpose: "cuda_export_fit_precision_check_only",
  qualified: false,
  ok: true,
  admitted: 327,
  answered: 327,
  failure: null,
  modelSha256: "a".repeat(64),
  nativeBinarySha256: "b".repeat(64),
  maxProbabilityDeltaLimit: 0.05,
  decisiveMargin: 0.5,
  decisiveSignFlips: 0,
  maxProbabilityDelta: 0,
  records: Array.from({ length: 327 }, (_, i) => ({
    sourceId: `fit-${i}`,
    referenceMargin: 1,
    margin: 1,
  })),
});
test("FIT precision metrics are recomputed and bound to model and binary", () => {
  const proof = precision();
  verifyC10Precision(proof, "a".repeat(64), "b".repeat(64));
  assert.throws(
    () => verifyC10Precision(proof, "c".repeat(64), "b".repeat(64)),
    /proof invalid/,
  );
  proof.records[0].margin = -1;
  assert.throws(
    () => verifyC10Precision(proof, "a".repeat(64), "b".repeat(64)),
    /tampering/,
  );
});
test("precision duplicate or incomplete inventory fails", () => {
  const proof = precision();
  proof.records[0].sourceId = proof.records[1].sourceId;
  assert.throws(
    () => verifyC10Precision(proof, "a".repeat(64), "b".repeat(64)),
    /invalid/,
  );
});
test("missing structured pins cannot launch evaluation or open VALID", async () => {
  assert.throws(
    () =>
      validateC10Manifest({
        version: 1,
        purpose: "candidate10_native_evaluation",
      }),
    /pins/,
  );
  const temp = await mkdtemp(resolve(tmpdir(), "c10-eval-"));
  try {
    await assert.rejects(evaluateC10({}, resolve(temp, "output")), /pins/);
    await assert.rejects(
      readFile(resolve(temp, "output/evaluation.json")),
      /ENOENT/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
function frozenManifest() {
  const names = [
    "campaign",
    "admission",
    "fit",
    "cal",
    "baseline",
    "runManifest",
    "importReport",
    "localPrecision",
    "precisionF16",
    "precisionQ8",
    "model",
    "registry",
    "artifact",
    "nativeBinary",
    "modelF16",
    "modelQ8",
    "quantizationManifest",
    "quantizerBinary",
    "localFitMargins",
    "sourceFitMargins",
    "sourceReceipt",
    "adapter",
  ];
  const files = Object.fromEntries(
    names.map((name) => [
      name,
      { path: `/unavailable-c10/${name}`, sha256: "a".repeat(64) },
    ]),
  );
  files.campaign.sha256 =
    "64ee24b219d43eacbcad725720b42835cd23b083a9bf337661ac088fee538edf";
  files.admission.sha256 = C9_CAL_SOURCE_PINS.admissionSha256;
  files.fit.sha256 =
    "8071644e852b1399732e0b5d47f52989239dbf79f38bdcac535167675182ae25";
  files.baseline.sha256 =
    "39f5f409a659d4a6bba0b2b1ed3a83df787df709e46f314ebacf883071bc8e12";
  files.cal.sha256 =
    "84dfedfb0a1aea2b5e39fd33bd40a913edf96daf89129accdc59e622ce7d57bd";
  const runtimeNames = [
    "rfdt/worker.py",
    "rfdt/cuda_import.py",
    "rfdt/gemma3_fp32.py",
    "dist/backend.js",
    "dist/core.js",
    "dist/guardrail.js",
    "dist/models.js",
    "scripts/guardrail-candidate10-evaluate.mjs",
    "scripts/guardrail-candidate9-cal-score.mjs",
    "scripts/guardrail-candidate9-cal-cli.mjs",
    "scripts/guardrail-candidate8-host-core.mjs",
    "scripts/guardrail-candidate9-valid-eval.mjs",
    "scripts/guardrail-candidate9-valid-score.mjs",
    "scripts/guardrail-candidate9-artifact-provenance.mjs",
    "scripts/guardrail-v3-research-detect-stub.mjs",
  ];
  return {
    version: 1,
    purpose: "candidate10_native_evaluation",
    checkpoint: 128,
    format: "f16",
    modelId: "jev/test-c10",
    sfPi: "/unavailable-sf-pi",
    sfDeps: "/unavailable-sf-deps",
    files,
    runtime: Object.fromEntries(
      runtimeNames.map((name) => [name, "a".repeat(64)]),
    ),
    valid: {
      source: {
        path: "/must-not-open-valid/source",
        sha256:
          "d7d532c2712bf699133971cb82b0b0c5f21cbe5362a5edd07171b532a58f072f",
      },
      manifest: {
        path: "/must-not-open-valid/manifest",
        sha256: C9_CAL_SOURCE_PINS.blindValidManifestSha256,
      },
      preflight: {
        path: "/must-not-open-valid/preflight",
        sha256:
          "e447ad75c256fbc16f24ab8e192ca0e98b968b853d72017ddaa65c92b78f3884",
      },
    },
  };
}
test("frozen manifest rejects omitted runtime and changed source pins", () => {
  const m = frozenManifest();
  validateC10Manifest(m);
  delete m.runtime["scripts/guardrail-candidate9-cal-cli.mjs"];
  assert.throws(() => validateC10Manifest(m), /pins/);
  const changed = frozenManifest();
  changed.files.fit.sha256 = "c".repeat(64);
  assert.throws(() => validateC10Manifest(changed), /pins/);
});
test("unavailable source retains failure report before any VALID access", async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "c10-failure-"));
  try {
    const result = await evaluateC10(frozenManifest(), resolve(temp, "output"));
    assert.equal(result.status, "failed");
    assert.equal(result.qualified, false);
    assert.equal(result.heldOutTestRead, false);
    assert.equal(result.validation, undefined);
    assert.match(result.failures[0], /unavailable-c10/);
    const retained = JSON.parse(
      await readFile(resolve(temp, "output/evaluation.json"), "utf8"),
    );
    assert.deepEqual(retained, result);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("missing and nonfinite precision summaries are rejected", () => {
  for (const value of [undefined, NaN, null, -1, Infinity]) {
    const proof = precision();
    proof.maxProbabilityDelta = value;
    assert.throws(
      () => verifyC10Precision(proof, "a".repeat(64), "b".repeat(64)),
      /invalid/,
    );
  }
});
test("caller cannot substitute a forged CAL baseline receipt pin", () => {
  const manifest = frozenManifest();
  manifest.files.baseline.sha256 = "f".repeat(64);
  assert.throws(() => validateC10Manifest(manifest), /pins/);
});
test("artifact cannot reference an alternative same-ID manifest or unpinned export", () => {
  const files = {
    runManifest: { path: "/run/manifest.json" },
    modelF16: { path: "/run/export-f16.gguf" },
  };
  const descriptor = {
    run_manifest: files.runManifest.path,
    file: files.modelF16.path,
  };
  assertC10ArtifactPaths(descriptor, files);
  assert.throws(
    () =>
      assertC10ArtifactPaths(
        { ...descriptor, run_manifest: "/other/manifest.json" },
        files,
      ),
    /unpinned/,
  );
  assert.throws(
    () =>
      assertC10ArtifactPaths(
        { ...descriptor, file: "/other/model.gguf" },
        files,
      ),
    /unpinned/,
  );
});

test("frozen manifest requires all three FP32 math implementation pins", () => {
  for (const name of [
    "rfdt/worker.py",
    "rfdt/cuda_import.py",
    "rfdt/gemma3_fp32.py",
  ]) {
    const manifest = frozenManifest();
    delete manifest.runtime[name];
    assert.throws(() => validateC10Manifest(manifest), /pins/);
  }
});
test("missing or mismatched FP32 architecture cannot reach classification", async () => {
  const runtime = { "rfdt/gemma3_fp32.py": "a".repeat(64) };
  await assert.rejects(verifyC10LocalArchitecture({}, runtime), /descriptor/);
  const descriptor = {
    kind: "hf_fp32_embedding_scale",
    embedding_scale_policy: "sqrt_hidden_size_in_fp32",
    helper_sha256: "b".repeat(64),
  };
  await assert.rejects(
    verifyC10LocalArchitecture({ local_architecture: descriptor }, runtime),
    /descriptor/,
  );
});
test("actual math helper edits are rejected against the frozen runtime identity", async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "c10-math-"));
  try {
    await mkdir(resolve(temp, "rfdt"));
    const bytes = "reviewed helper bytes";
    const hash = createHash("sha256").update(bytes).digest("hex");
    await writeFile(resolve(temp, "rfdt/gemma3_fp32.py"), bytes);
    const runtime = { "rfdt/gemma3_fp32.py": hash };
    const imported = {
      local_architecture: {
        kind: "hf_fp32_embedding_scale",
        embedding_scale_policy: "sqrt_hidden_size_in_fp32",
        helper_sha256: hash,
      },
    };
    assert.deepEqual(
      await verifyC10LocalArchitecture(imported, runtime, temp),
      imported.local_architecture,
    );
    await writeFile(
      resolve(temp, "rfdt/gemma3_fp32.py"),
      "changed helper bytes",
    );
    await assert.rejects(
      verifyC10LocalArchitecture(imported, runtime, temp),
      /implementation changed/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
