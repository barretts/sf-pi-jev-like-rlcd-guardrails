import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GUARDRAIL_LIMITS,
  GUARDRAIL_PROTOCOL_SHA256,
} from "../dist/guardrail.js";
import { GUARDRAIL_CRITERIA_SHA256 } from "../dist/guardrail-evaluation.js";

const owned: string[] = [];

afterEach(async () => {
  await Promise.all(
    owned
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("guardrail RFDT preparation", () => {
  it.each([
    {},
    { trainingReady: null },
    { trainingReady: false, status: "review-only; TRAIN coverage gaps remain" },
    { trainingReady: true, status: "diagnostic; no qualification baseline" },
    {
      diagnosticOnly: true,
      status: "TRAIN/VALIDATION only; qualification pending",
    },
  ])("refuses a non-ready bundle before creating a run: %j", async (state) => {
    const directory = await mkdtemp(
      join(tmpdir(), "jev-guardrail-train-readiness-"),
    );
    owned.push(directory);
    const bundle = join(directory, "bundle.json");
    const run = join(directory, "run");
    await writeFile(
      bundle,
      JSON.stringify({
        ...state,
        records: [
          {
            id: "train",
            split: "train",
            modelEligible: true,
            expected: "allow",
          },
          {
            id: "valid",
            split: "validation",
            modelEligible: true,
            expected: "confirm",
          },
        ],
      }),
    );
    const result = spawnSync(
      process.execPath,
      [
        resolve("scripts/guardrail-train.mjs"),
        "prepare",
        "--bundle",
        bundle,
        "--checkpoint",
        join(directory, "nonexistent-checkpoint"),
        "--run",
        run,
      ],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Guardrail bundle is not explicitly training-ready",
    );
    expect(existsSync(run)).toBe(false);
  });

  it("rejects a ready-looking bundle without builder admission inputs", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "jev-guardrail-train-readiness-"),
    );
    owned.push(directory);
    const bundle = join(directory, "bundle.json");
    const run = join(directory, "run");
    await writeFile(
      bundle,
      JSON.stringify({
        trainingReady: true,
        status: "TRAIN/VALIDATION only; qualification pending",
        records: [
          {
            id: "train",
            groupId: "train-group",
            split: "train",
            modelEligible: true,
            expected: "allow",
            riskInput: {
              version: 2,
              toolName: "bash",
              input: { command: "pwd" },
              facts: {},
            },
          },
          {
            id: "valid",
            groupId: "valid-group",
            split: "validation",
            modelEligible: true,
            expected: "confirm",
            riskInput: {
              version: 2,
              toolName: "bash",
              input: { command: "ls" },
              facts: {},
            },
          },
        ],
      }),
    );
    const result = spawnSync(
      process.execPath,
      [
        resolve("scripts/guardrail-train.mjs"),
        "prepare",
        "--bundle",
        bundle,
        "--checkpoint",
        join(directory, "nonexistent-checkpoint"),
        "--run",
        run,
      ],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("requires --receipt, --corpus");
    expect(result.stderr).not.toContain("not explicitly training-ready");
    expect(existsSync(run)).toBe(false);
  });

  it("rejects a forged ready bundle and matching self-issued receipt", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "jev-guardrail-train-readiness-"),
    );
    owned.push(directory);
    const bundle = join(directory, "bundle.json");
    const receipt = join(directory, "receipt.json");
    const corpus = join(directory, "corpus.json");
    const baseline = join(directory, "baseline.json");
    const run = join(directory, "run");
    const bundleBytes = JSON.stringify({
      trainingReady: true,
      status: "TRAIN/VALIDATION only; qualification pending",
      records: [
        {
          id: "train",
          groupId: "train-group",
          split: "train",
          modelEligible: true,
          expected: "allow",
          riskInput: {
            version: 2,
            toolName: "bash",
            input: { command: "pwd" },
            facts: {},
          },
        },
        {
          id: "valid",
          groupId: "valid-group",
          split: "validation",
          modelEligible: true,
          expected: "confirm",
          riskInput: {
            version: 2,
            toolName: "bash",
            input: { command: "ls" },
            facts: {},
          },
        },
      ],
    });
    const baselineBytes = JSON.stringify({ records: [] });
    const sha = (bytes: string) =>
      createHash("sha256").update(bytes).digest("hex");
    await writeFile(bundle, bundleBytes);
    await writeFile(
      receipt,
      JSON.stringify({
        trainingReady: true,
        outputSha256: sha(bundleBytes),
        source: { sfPiCommit: "forged" },
      }),
    );
    await writeFile(corpus, JSON.stringify({ cases: [] }));
    await writeFile(baseline, baselineBytes);

    const result = spawnSync(
      process.execPath,
      [
        resolve("scripts/guardrail-train.mjs"),
        "prepare",
        "--bundle",
        bundle,
        "--receipt",
        receipt,
        "--corpus",
        corpus,
        "--baseline",
        baseline,
        "--baseline-sha256",
        sha(baselineBytes),
        "--sf-pi",
        directory,
        "--checkpoint",
        join(directory, "nonexistent-checkpoint"),
        "--run",
        run,
      ],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Candidate-5 admission rebuild failed");
    expect(result.stderr).toContain("Sealed corpus identity changed");
    expect(result.stderr).not.toContain("Use the reviewed original pinned");
    expect(existsSync(run)).toBe(false);
  });

  it("refuses a changed prepared TRAIN split before starting training", async () => {
    const run = await mkdtemp(join(tmpdir(), "jev-guardrail-frozen-run-"));
    owned.push(run);
    const sha = (bytes: string) =>
      createHash("sha256").update(bytes).digest("hex");
    const bundle = join(run, "bundle.json");
    const authored = join(run, "authored-train-validation.jsonl");
    const dataset = join(run, "dataset.jsonl");
    const train = join(run, "train.jsonl");
    const validation = join(run, "validation.jsonl");
    const test = join(run, "test.jsonl");
    const bundleBytes = "{}\n";
    const authoredBytes = "{}\n";
    const trainBytes = "{}\n";
    const validationBytes = "{}\n";
    const aggregateSha256 = sha(
      `train\n${trainBytes}validation\n${validationBytes}test\n`,
    );
    const planBytes =
      JSON.stringify({
        version: 1,
        protocolSha256: GUARDRAIL_PROTOCOL_SHA256,
        bundleSha256: sha(bundleBytes),
        admissionReceiptSha256: "0".repeat(64),
        corpusSha256: "synthetic-corpus",
        baselineSourceSha256: "synthetic-baseline",
        admission: { bundle },
        steps: 256,
      }) + "\n";
    await Promise.all([
      writeFile(bundle, bundleBytes),
      writeFile(authored, authoredBytes),
      writeFile(dataset, authoredBytes),
      writeFile(train, trainBytes),
      writeFile(validation, validationBytes),
      writeFile(test, ""),
      writeFile(join(run, "guardrail-plan.json"), planBytes),
      writeFile(
        join(run, "manifest.json"),
        JSON.stringify({
          status: "prepared",
          directory: run,
          source: { file: authored, sha256: sha(authoredBytes) },
          prepared: {
            dataset_file: dataset,
            dataset_sha256: sha(authoredBytes),
            files: { train, validation, test },
            sha256: aggregateSha256,
            branches: { train: 1, validation: 1, test: 0 },
          },
        }),
      ),
    ]);
    await writeFile(
      join(run, "prospective-plan.json"),
      JSON.stringify({
        version: 1,
        purpose: "guardrail_training_prospective_plan",
        run,
        trainingPlanSha256: sha(planBytes),
        bundleFile: bundle,
        bundleSha256: sha(bundleBytes),
        admissionReceiptSha256: "0".repeat(64),
        corpusSha256: "synthetic-corpus",
        baselineSourceSha256: "synthetic-baseline",
        protocolSha256: GUARDRAIL_PROTOCOL_SHA256,
        criteriaSha256: GUARDRAIL_CRITERIA_SHA256,
        steps: 256,
        selection: "validation_only",
        noTeacher: true,
        noForbiddenFallback: true,
        testNotPassedToTraining: true,
        testRowsPassedToTraining: 0,
        modelCallsBeforeFreeze: 0,
        testEvaluationsBeforeFreeze: 0,
        allowCutoff: GUARDRAIL_LIMITS.minimumAllowScore,
        qualification: false,
        authoredTrainValidationSha256: sha(authoredBytes),
        preparedDatasetSha256: sha(authoredBytes),
        trainSha256: "0".repeat(64),
        validationSha256: sha(validationBytes),
        emptyTestSha256: sha(""),
        preparedSha256: aggregateSha256,
        trainRows: 1,
        validationRows: 1,
      }),
    );

    const result = spawnSync(
      process.execPath,
      [resolve("scripts/guardrail-train.mjs"), "train", "--run", run],
      { encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Guardrail prepared TRAIN/VALID files changed since the prospective plan",
    );
    expect(result.stderr).not.toContain("Original Google checkpoint");
  });

  it("replays admission provenance before exporting", async () => {
    const run = await mkdtemp(join(tmpdir(), "jev-guardrail-frozen-run-"));
    owned.push(run);
    const sha = (bytes: string) =>
      createHash("sha256").update(bytes).digest("hex");
    const bundle = join(run, "bundle.json");
    const receipt = join(run, "receipt.json");
    const corpus = join(run, "corpus.json");
    const baseline = join(run, "baseline.json");
    const bundleBytes = JSON.stringify({ trainingReady: true, records: [] });
    const baselineBytes = JSON.stringify({ records: [] });
    const receiptBytes = JSON.stringify({
      trainingReady: true,
      outputSha256: sha(bundleBytes),
      source: { sfPiCommit: "forged" },
    });
    await Promise.all([
      writeFile(bundle, bundleBytes),
      writeFile(receipt, receiptBytes),
      writeFile(corpus, JSON.stringify({ cases: [] })),
      writeFile(baseline, baselineBytes),
      writeFile(
        join(run, "guardrail-plan.json"),
        JSON.stringify({
          protocolSha256: GUARDRAIL_PROTOCOL_SHA256,
          bundleSha256: sha(bundleBytes),
          admissionReceiptSha256: sha(receiptBytes),
          sfPiCommit: "forged",
          admission: {
            bundle,
            receipt,
            corpus,
            baseline,
            baselineSha256: sha(baselineBytes),
            sfPi: run,
          },
          checkpoint: join(run, "nonexistent-checkpoint"),
        }),
      ),
    ]);

    const result = spawnSync(
      process.execPath,
      [resolve("scripts/guardrail-train.mjs"), "export", "--run", run],
      { encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Candidate-5 admission rebuild failed");
    expect(result.stderr).toContain("Sealed corpus identity changed");
    expect(result.stderr).not.toContain("Original Google checkpoint");
  });
});
