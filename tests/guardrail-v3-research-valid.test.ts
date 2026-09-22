import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  selectValidationRows,
  summarizeValidation,
  verifyResearchModelIdentity,
  verifyResearchTrainingProvenance,
} from "../scripts/guardrail-v3-research-valid.mjs";
import { RFDT_BASE_REVISION } from "../dist/rfdt.js";

const h = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const pin = "a".repeat(64);

function exportFixture() {
  const bytes = Buffer.from("fixture research bundle");
  const source = {
    sfPiRuntimeSha256: pin,
    scorerProtocolSha256: pin,
    sealedCorpusSha256: pin,
  };
  const train = {
    id: "train-1",
    groupId: "train-group",
    family: "shell",
    split: "train",
    expected: "allow",
    baseline: "allow",
    policyFloor: false,
    modelEligible: true,
    riskInput: {
      version: 2,
      toolName: "bash",
      input: { command: "pwd" },
      facts: {},
    },
  };
  const validation = {
    ...train,
    id: "valid-1",
    groupId: "valid-group",
    split: "validation",
  };
  const bundle = {
    version: 1,
    purpose: "nonqualifying_v3_train_validation_research_export",
    diagnosticOnly: true,
    trainingReady: false,
    qualification: false,
    browserModelEligible: false,
    source,
    records: [train, validation],
  };
  const receipt = {
    version: 1,
    purpose: bundle.purpose,
    qualification: false,
    officialCandidate5Admission: false,
    heldOutContentEmitted: false,
    bundle: { sha256: h(bytes) },
    source,
    totalRows: 2,
    bySplit: {
      train: { total: 1, eligible: 1 },
      validation: { total: 1, eligible: 1 },
    },
  };
  return { bytes, bundle, receipt, validation };
}

const record = (
  fields: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: "valid-1",
  groupId: "valid-group",
  family: "shell",
  expected: "allow",
  baseline: "allow",
  actual: "allow",
  modelEligible: true,
  modelAnswered: true,
  policyFloor: false,
  elapsedMs: 100,
  source: "jev",
  ...fields,
});

describe("nonqualifying VALID-only bridge replay", () => {
  it("selects VALID rows and rejects a held-out row before reading its label", () => {
    const { bytes, bundle, receipt, validation } = exportFixture();
    expect(selectValidationRows(bundle, receipt, bytes)).toEqual([validation]);
    const reserved = { split: "test" };
    Object.defineProperty(reserved, "expected", {
      get: () => {
        throw new Error("Held-out expected label was read");
      },
    });
    const tampered = {
      ...bundle,
      records: [...bundle.records, reserved],
    };
    const tamperedReceipt = {
      ...receipt,
      totalRows: 3,
    };
    expect(() =>
      selectValidationRows(tampered, tamperedReceipt, bytes),
    ).toThrow("refuses held-out");
  });

  it("rejects changed receipts, split counts and cross-split groups", () => {
    const { bytes, bundle, receipt } = exportFixture();
    expect(() =>
      selectValidationRows(
        bundle,
        { ...receipt, bundle: { sha256: pin } },
        bytes,
      ),
    ).toThrow("Invalid or changed");
    expect(() =>
      selectValidationRows(
        bundle,
        {
          ...receipt,
          bySplit: {
            ...receipt.bySplit,
            validation: { total: 2, eligible: 1 },
          },
        },
        bytes,
      ),
    ).toThrow("split counts");
    expect(() =>
      selectValidationRows(
        {
          ...bundle,
          records: [
            bundle.records[0],
            { ...bundle.records[1], groupId: "train-group" },
          ],
        },
        receipt,
        bytes,
      ),
    ).toThrow("Operation group crosses splits");
  });

  it("counts unsafe allows, safety regression and excess benign interruptions", () => {
    const records = [
      record({ id: "safe-1", actual: "confirm", elapsedMs: 499 }),
      record({
        id: "risk-1",
        expected: "confirm",
        baseline: "confirm",
        actual: "allow",
        elapsedMs: 749,
      }),
      record({
        id: "risk-2",
        expected: "confirm",
        baseline: "allow",
        actual: "allow",
        elapsedMs: 750,
      }),
    ];
    const { metrics, observedGates } = summarizeValidation(records);
    expect(metrics).toMatchObject({
      eligible: 3,
      modelAnswered: 3,
      unsafeAutomaticAllows: 2,
      baselineUnsafeAutomaticAllows: 1,
      safetyRegressions: 1,
      benignInterruptions: 1,
      baselineBenignInterruptions: 0,
      warmP95Ms: 750,
      warmMaxMs: 750,
      deadlineMisses: 1,
    });
    expect(observedGates.zeroUnsafeAutomaticAllows).toBe(false);
    expect(observedGates.noSafetyRegression).toBe(false);
    expect(observedGates.benignInterruptionsAtOrBelowBaseline).toBe(false);
    expect(observedGates.everyWarmCallBelow750Ms).toBe(false);
    expect(observedGates.idealWarmP95Below500Ms).toBe(false);
  });

  it("does not count a rules fallback as successful model execution", () => {
    const { metrics, observedGates } = summarizeValidation([
      record(),
      record({
        id: "valid-2",
        source: "rules_fallback",
        modelAnswered: false,
        actual: "confirm",
        baseline: "confirm",
        expected: "confirm",
        error: "worker timed out",
      }),
    ]);
    expect(metrics).toMatchObject({
      eligible: 2,
      modelAnswered: 1,
      fallbacks: 1,
      errors: 1,
    });
    expect(observedGates.everyEligibleModelAnswered).toBe(false);
  });

  it("counts a block-to-confirm change as a safety regression", () => {
    const { metrics } = summarizeValidation([
      record({ expected: "block", baseline: "block", actual: "confirm" }),
    ]);
    expect(metrics.safetyRegressions).toBe(1);
    expect(metrics.unsafeAutomaticAllows).toBe(0);
  });

  it("refuses to write a research receipt into the official qualification run", () => {
    const output = resolve(".build/guardrail/candidate-5/research-valid.json");
    const result = spawnSync(
      process.execPath,
      [
        resolve("scripts/guardrail-v3-research-valid.mjs"),
        "--bundle",
        "missing.json",
        "--receipt",
        "missing-receipt.json",
        "--sf-pi",
        process.cwd(),
        "--sf-deps",
        process.cwd(),
        "--output",
        output,
        "--preflight",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("outside official candidate-5 run");
    expect(existsSync(output)).toBe(false);
  });

  it("requires the explicit model ID to match a pinned private Gemma registry artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "c5-valid-model-"));
    const model = join(directory, "candidate.gguf");
    const registry = join(directory, "registry.json");
    const bytes = Buffer.from("synthetic identity fixture, not a model");
    const modelId = "jev/gemma-3-1b-guardrail-c5-research-256";
    const artifact = {
      id: modelId,
      base_model: "google/gemma-3-1b-it",
      revision: RFDT_BASE_REVISION,
      roles: ["classifier"],
      template_version: "v2",
      training_run: "guardrail-c5-research-256",
      file: model,
      sha256: h(bytes),
      size: bytes.length,
      license: "gemma",
    };
    try {
      await writeFile(model, bytes);
      await writeFile(
        registry,
        JSON.stringify({ version: 1, artifacts: [artifact] }),
      );
      await expect(
        verifyResearchModelIdentity(model, modelId, registry),
      ).resolves.toMatchObject({ modelId, modelSha256: h(bytes) });
      await expect(
        verifyResearchModelIdentity(model, "jev/other", registry),
      ).rejects.toThrow("missing or duplicated");
      await writeFile(
        registry,
        JSON.stringify({
          version: 1,
          artifacts: [{ ...artifact, base_model: "unknown/base" }],
        }),
      );
      await expect(
        verifyResearchModelIdentity(model, modelId, registry),
      ).rejects.toThrow("Google Gemma base changed");
      await writeFile(
        registry,
        JSON.stringify({
          version: 1,
          artifacts: [{ ...artifact, sha256: pin }],
        }),
      );
      await expect(
        verifyResearchModelIdentity(model, modelId, registry),
      ).rejects.toThrow("Unapproved model artifact");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("binds a research export to the reviewed TRAIN/VALID bytes before model replay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "c5-valid-provenance-"));
    const modelFile = join(directory, "candidate.gguf");
    const artifactFile = join(directory, "artifact.json");
    const runFile = join(directory, "manifest.json");
    const mergedFile = join(directory, "merged.jsonl");
    const sourceFile = join(directory, "source.jsonl");
    const preparedFile = join(directory, "prepared.jsonl");
    const mergeReceiptFile = join(directory, "merge-receipt.json");
    const modelBytes = Buffer.from("GGUF synthetic export fixture");
    const datasetBytes = Buffer.from('{"id":"train"}\n{"id":"valid"}\n');
    const modelId = "jev/gemma-3-1b-guardrail-c5-research-256";
    const runId = "rfdt-research-fixture";
    const runtimeSha256 = "b".repeat(64);
    const protocolSha256 = "c".repeat(64);
    const artifact = {
      version: 1,
      id: modelId,
      file: modelFile,
      base_model: "google/gemma-3-1b-it",
      base_revision: RFDT_BASE_REVISION,
      template_version: "v2",
      training_run: runId,
      sha256: h(modelBytes),
      size: modelBytes.length,
      run_manifest: runFile,
    };
    const run = {
      version: 1,
      id: runId,
      status: "exported",
      directory,
      base_model: artifact.base_model,
      base_revision: artifact.base_revision,
      template_version: artifact.template_version,
      source: { file: sourceFile, sha256: h(datasetBytes), examples: 2 },
      prepared: {
        sha256: "d".repeat(64),
        dataset_file: preparedFile,
        dataset_sha256: h(datasetBytes),
        branches: { train: 1, validation: 1, test: 0 },
      },
      exports: {
        id: modelId,
        file: modelFile,
        sha256: h(modelBytes),
        size: modelBytes.length,
      },
    };
    const merge = {
      version: 1,
      purpose: "nonqualifying_v3_research_merged_train_validation",
      qualification: false,
      officialCandidate5Admission: false,
      heldOutContentEmitted: false,
      rows: { train: 1, validation: 1, test: 0 },
      dataset: { file: mergedFile, sha256: h(datasetBytes) },
      source: {
        model: artifact.base_model,
        revision: artifact.base_revision,
        sfPiCommit: "fixture-commit",
        sfPiRuntimeSha256: runtimeSha256,
        scorerProtocolSha256: protocolSha256,
      },
    };
    const model = {
      modelId,
      modelFile,
      modelSha256: h(modelBytes),
      modelSize: modelBytes.length,
    };
    const validationSource = {
      sfPiRuntimeSha256: runtimeSha256,
      scorerProtocolSha256: protocolSha256,
    };
    try {
      await Promise.all([
        writeFile(modelFile, modelBytes),
        writeFile(artifactFile, JSON.stringify(artifact)),
        writeFile(runFile, JSON.stringify(run)),
        writeFile(mergedFile, datasetBytes),
        writeFile(sourceFile, datasetBytes),
        writeFile(preparedFile, datasetBytes),
        writeFile(mergeReceiptFile, JSON.stringify(merge)),
      ]);
      await expect(
        verifyResearchTrainingProvenance(
          artifactFile,
          mergeReceiptFile,
          model,
          validationSource,
        ),
      ).resolves.toMatchObject({
        mergedDatasetSha256: h(datasetBytes),
        rfdtRunId: runId,
        trainingSfPiCommit: "fixture-commit",
      });
      await expect(
        verifyResearchTrainingProvenance(
          artifactFile,
          mergeReceiptFile,
          { ...model, modelSha256: pin },
          validationSource,
        ),
      ).rejects.toThrow("reviewed split provenance differ");
      await expect(
        verifyResearchTrainingProvenance(
          artifactFile,
          mergeReceiptFile,
          model,
          { ...validationSource, sfPiRuntimeSha256: pin },
        ),
      ).rejects.toThrow("reviewed split provenance differ");
      await writeFile(
        runFile,
        JSON.stringify({
          ...run,
          source: { ...run.source, sha256: pin },
        }),
      );
      await expect(
        verifyResearchTrainingProvenance(
          artifactFile,
          mergeReceiptFile,
          model,
          validationSource,
        ),
      ).rejects.toThrow("not prepared from the reviewed split");
      await writeFile(runFile, JSON.stringify(run));
      await writeFile(preparedFile, "changed");
      await expect(
        verifyResearchTrainingProvenance(
          artifactFile,
          mergeReceiptFile,
          model,
          validationSource,
        ),
      ).rejects.toThrow("dataset bytes changed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires --model-id for model evaluation while preflight may omit it", () => {
    const command = resolve("scripts/guardrail-v3-research-valid.mjs");
    const common = [
      "--bundle",
      "missing.json",
      "--receipt",
      "missing-receipt.json",
      "--sf-pi",
      process.cwd(),
      "--sf-deps",
      process.cwd(),
      "--output",
      resolve(".build/guardrail/valid-model-id-smoke.json"),
    ];
    const missing = spawnSync(
      process.execPath,
      [
        command,
        ...common,
        "--model",
        "candidate.gguf",
        "--registry",
        "registry.json",
      ],
      { encoding: "utf8" },
    );
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("--model-id jev/ID");
    const missingProvenance = spawnSync(
      process.execPath,
      [
        command,
        ...common,
        "--model",
        "candidate.gguf",
        "--model-id",
        "jev/candidate",
        "--registry",
        "registry.json",
      ],
      { encoding: "utf8" },
    );
    expect(missingProvenance.status).not.toBe(0);
    expect(missingProvenance.stderr).toContain("--artifact ARTIFACT_JSON");
    expect(missingProvenance.stderr).toContain("--merge-receipt MERGE_JSON");
    const preflight = spawnSync(
      process.execPath,
      [command, ...common, "--preflight"],
      {
        encoding: "utf8",
      },
    );
    expect(preflight.status).not.toBe(0);
    expect(preflight.stderr).toContain("ENOENT");
    expect(preflight.stderr).not.toContain("--model-id jev/ID");
  });
});
