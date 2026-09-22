import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { verifyC9Q8Artifact } from "../scripts/guardrail-candidate9-artifact-provenance.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const baseRevision = "dcc83ea841ab6100d6b47a070329e1ba4cf78752";
const quantizerRevision = "f072b103714dfa1eee531f80b24512faf38e3dd2";
const quantizerBinary =
  "e2c48c541efe39436f0edbbbfe0e65c9185e1bb1d6295fcfb28ebc38c1e77985";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function pinnedScorerBytes(name) {
  const path = join(root, "scripts", name);
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // This verifier branch starts before the frozen evaluator source commit.
    return execFileSync("git", ["show", `f5067cc:scripts/${name}`], {
      cwd: root,
      maxBuffer: 64 * 1024,
    });
  }
}
const save = async (path, value) => {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
  await writeFile(path, bytes);
  return sha(bytes);
};

async function fixture(arm = "B") {
  const runDirectory = await mkdtemp(join(tmpdir(), "c9-artifact-proof-"));
  const location = (name) => join(runDirectory, name);
  const fitBytes = Buffer.from('{"id":"fit-one","split":"train"}\n');
  const fitSha256 = sha(fitBytes);
  const fitSource = location("fit.jsonl");
  await writeFile(fitSource, fitBytes);
  const pairSha256 = "a".repeat(64),
    familySha256 = "b".repeat(64);
  const admissionSha256 = "c".repeat(64);
  const objective = {
    version: 2,
    purpose: "candidate9_train_only",
    arm,
    objective:
      arm === "A"
        ? "guardrail_train_group_pair_margin_v1"
        : "guardrail_train_balanced_symmetric_v1",
    pair_manifest_sha256: pairSha256,
    family_manifest_sha256: familySha256,
    steps: 256,
    cutoff_status: "unset_requires_c9_train_cal_hard_veto_before_valid",
    validation_rows_passed_to_training: 0,
    test_rows_passed_to_training: 0,
  };
  const objectivePlan = location("objective-plan.json");
  const objectivePlanSha256 = await save(objectivePlan, objective);
  await writeFile(location("train.jsonl"), fitBytes);
  await writeFile(location("dataset.jsonl"), fitBytes);
  await writeFile(location("validation.jsonl"), "");
  await writeFile(location("test.jsonl"), "");
  const frozen = sha(
    Buffer.concat([
      Buffer.from("train\n"),
      fitBytes,
      Buffer.from("validation\ntest\n"),
    ]),
  );
  const f16Model = location("gemma-3-1b-rfdt-f16.gguf");
  const q8Model = location("gemma-3-1b-rfdt-q8_0.gguf");
  const f16Bytes = Buffer.from("GGUFsynthetic-f16");
  const q8Bytes = Buffer.from("GGUFsynthetic-q8");
  await writeFile(f16Model, f16Bytes);
  await writeFile(q8Model, q8Bytes);
  const f16Sha256 = sha(f16Bytes),
    modelSha256 = sha(q8Bytes);
  const f16Id = "jev/c9-synthetic",
    q8Id = `${f16Id}-q8_0`;
  const run = {
    version: 1,
    id: "c9-synthetic-run",
    status: "exported",
    directory: runDirectory,
    base_model: "google/gemma-3-1b-it",
    base_revision: baseRevision,
    template_version: "v2",
    source: { file: fitSource, sha256: fitSha256, examples: 1 },
    prepared: {
      sha256: frozen,
      dataset_file: location("dataset.jsonl"),
      dataset_sha256: fitSha256,
      files: {
        train: location("train.jsonl"),
        validation: location("validation.jsonl"),
        test: location("test.jsonl"),
      },
      branches: { train: 1, validation: 0, test: 0 },
    },
    training: {
      objective: objective.objective,
      steps: 256,
      hyperparameters: { steps: 256 },
      provenance: {
        base_model: "google/gemma-3-1b-it",
        base_revision: baseRevision,
      },
      model_path: `/synthetic/models--google--gemma-3-1b-it/snapshots/${baseRevision}`,
      training_data_sha256: fitSha256,
      validation_data_sha256: null,
      validation: null,
      guardrail_train_plan: { sha256: objectivePlanSha256, content: objective },
      guardrail_pairs: { sha256: pairSha256 },
      guardrail_fit_families: { sha256: familySha256 },
    },
    exports: {
      id: f16Id,
      file: f16Model,
      sha256: f16Sha256,
      size: f16Bytes.length,
      converter_revision: quantizerRevision,
      converter_sha256: "d".repeat(64),
    },
  };
  const runManifestSha256 = await save(location("manifest.json"), run);
  const artifact = {
    version: 1,
    id: f16Id,
    file: f16Model,
    base_model: run.base_model,
    base_revision: baseRevision,
    template_version: "v2",
    training_run: run.id,
    sha256: f16Sha256,
    size: f16Bytes.length,
    run_manifest: location("manifest.json"),
  };
  const artifactManifestSha256 = await save(
    location("artifact.json"),
    artifact,
  );
  const fitPlan = {
    version: 1,
    purpose: "candidate9_fit_only_rfdt",
    qualification: false,
    validationRead: false,
    heldOutTestRead: false,
    steps: 256,
    inferenceArtifactFormat: "GGUF_Q8_0",
    rfdtPreparedSha256: frozen,
    selection: "C9_TRAIN_CAL_hard_veto_before_blind_VALID",
    checkpoint: `/synthetic/models--google--gemma-3-1b-it/snapshots/${baseRevision}`,
    baseFiles: {
      "model.safetensors": {
        sha256:
          "3d4ef8d71c14db7e448a09ebe891cfb6bf32c57a9b44499ae0d1c098e48516b6",
      },
    },
    baseGguf: {
      sha256:
        "05bd381a5f45611ce53f4fdcc6641cf6cec68c3091d74e8a32ea591f062d3fc5",
    },
    source: {
      arm,
      admissionSha256,
      inferenceArtifactFormat: "GGUF_Q8_0",
      fit: {
        path: fitSource,
        sha256: fitSha256,
        preparedDatasetSha256: fitSha256,
        rows: 1,
        groups: 1,
      },
      pairsSha256: pairSha256,
      familiesSha256: familySha256,
      objectiveSha256: objectivePlanSha256,
    },
  };
  const fitPlanSha256 = await save(
    location("candidate9-fit-plan.json"),
    fitPlan,
  );
  const descriptor = {
    id: q8Id,
    file: q8Model,
    sha256: modelSha256,
    size: q8Bytes.length,
    base_model: run.base_model,
    revision: baseRevision,
    template_version: "v2",
    roles: ["classifier"],
    license: "gemma",
    training_run: run.id,
  };
  const registrySha256 = await save(location("q8-candidate-registry.json"), {
    version: 1,
    artifacts: [descriptor],
  });
  const quantization = {
    version: 1,
    purpose: "candidate9_same_weights_q8_0_calibration_candidate",
    qualification: false,
    sourceWeights: {
      modelId: f16Id,
      file: f16Model,
      sha256: f16Sha256,
      size: f16Bytes.length,
    },
    quantizer: {
      sourceDirectory: location("llama.cpp"),
      sourceRevision: quantizerRevision,
      binarySha256: quantizerBinary,
      type: "Q8_0",
      leaveOutputTensorUnquantized: true,
      importanceMatrix: null,
    },
    output: {
      modelId: q8Id,
      file: q8Model,
      sha256: modelSha256,
      size: q8Bytes.length,
      registrySha256,
    },
  };
  const quantizationManifestSha256 = await save(
    location("candidate9-q8-manifest.json"),
    quantization,
  );
  await mkdir(location("scripts"));
  const calScorerCli = location("scripts/guardrail-candidate9-cal-cli.mjs"),
    calScorerCore = location("scripts/guardrail-candidate9-cal-score.mjs");
  const cli = await pinnedScorerBytes("guardrail-candidate9-cal-cli.mjs"),
    core = await pinnedScorerBytes("guardrail-candidate9-cal-score.mjs");
  await writeFile(calScorerCli, cli);
  await writeFile(calScorerCore, core);
  const paths = {
    runDirectory,
    objectivePlan,
    f16Model,
    q8Model,
    calScorerCli,
    calScorerCore,
  };
  const expected = {
    arm,
    artifactFormat: "q8_0",
    modelId: q8Id,
    modelSha256,
    artifactManifestSha256,
    runManifestSha256,
    fitPlanSha256,
    registrySha256,
    quantizationManifestSha256,
    calScorerCliSha256: sha(cli),
    calScorerCoreSha256: sha(core),
    objectivePlanSha256,
    admissionSha256,
    fitSha256,
    pairManifestSha256: pairSha256,
    familyManifestSha256: familySha256,
  };
  const admission = {
    fit: { sha256: fitSha256, rows: 1, groups: 1 },
    source: { pairsSha256: pairSha256, familiesSha256: familySha256 },
  };
  return {
    runDirectory,
    paths,
    expected,
    admission,
    objectivePlanSha256,
    modelSha256,
    arm,
    files: {
      run: location("manifest.json"),
      fit: location("candidate9-fit-plan.json"),
      registry: location("q8-candidate-registry.json"),
      quantization: location("candidate9-q8-manifest.json"),
    },
  };
}

async function withFixture(action, arm = "B") {
  const inputs = await fixture(arm);
  try {
    await action(inputs);
  } finally {
    await rm(inputs.runDirectory, { recursive: true, force: true });
  }
}

test("C9 artifact verifier binds actual F16, Q8, run, FIT, and scorer bytes for both arms", async () => {
  for (const arm of ["A", "B"])
    await withFixture(async (inputs) => {
      const proof = await verifyC9Q8Artifact(inputs);
      assert.equal(proof.arm, arm);
      assert.equal(proof.modelId, inputs.expected.modelId);
      assert.equal(proof.modelSha256, inputs.modelSha256);
      assert.equal(proof.registrySha256, inputs.expected.registrySha256);
    }, arm);
});

test("C9 artifact verifier rejects changed F16, Q8, or scorer bytes", async () => {
  for (const kind of ["f16Model", "q8Model", "calScorerCli", "calScorerCore"])
    await withFixture(async (inputs) => {
      await writeFile(inputs.paths[kind], "GGUFchanged");
      await assert.rejects(verifyC9Q8Artifact(inputs), /SHA-256|model bytes/);
    });
});

test("C9 artifact verifier rejects a forged scorer with a self-consistent score hash", async () => {
  await withFixture(async (inputs) => {
    const forged = Buffer.from("// forged synthetic CAL scorer\n");
    await writeFile(inputs.paths.calScorerCli, forged);
    inputs.expected.calScorerCliSha256 = sha(forged);
    await assert.rejects(
      verifyC9Q8Artifact(inputs),
      /pre-CAL frozen evaluator source/,
    );
  });
});

test("C9 artifact verifier rejects quantizer settings even when the manifest hash is repinned", async () => {
  for (const [field, changed] of [
    ["sourceRevision", "0".repeat(40)],
    ["binarySha256", "0".repeat(64)],
    ["leaveOutputTensorUnquantized", false],
  ])
    await withFixture(async (inputs) => {
      const value = JSON.parse(await readFile(inputs.files.quantization));
      value.quantizer[field] = changed;
      inputs.expected.quantizationManifestSha256 = await save(
        inputs.files.quantization,
        value,
      );
      await assert.rejects(verifyC9Q8Artifact(inputs), /Q8 quantizer/);
    });
});

test("C9 artifact verifier rejects VALID branches and schedule changes after repinning the run", async () => {
  for (const mutate of [
    (run) => {
      run.prepared.branches.validation = 1;
    },
    (run) => {
      run.training.steps = 512;
    },
  ])
    await withFixture(async (inputs) => {
      const run = JSON.parse(await readFile(inputs.files.run));
      mutate(run);
      inputs.expected.runManifestSha256 = await save(inputs.files.run, run);
      await assert.rejects(verifyC9Q8Artifact(inputs), /FIT-only|schedule/);
    });
});

test("C9 artifact verifier rejects a nonempty prepared VALID file without reading its contents", async () => {
  await withFixture(async (inputs) => {
    await writeFile(join(inputs.runDirectory, "validation.jsonl"), "synthetic");
    await assert.rejects(
      verifyC9Q8Artifact(inputs),
      /prepared branch is nonempty/,
    );
  });
});

test("C9 artifact verifier rejects changed FIT admission, family, and objective pins", async () => {
  for (const mutate of [
    (fit) => {
      fit.source.admissionSha256 = "0".repeat(64);
    },
    (fit) => {
      fit.source.familiesSha256 = "0".repeat(64);
    },
    (fit) => {
      fit.source.objectiveSha256 = "0".repeat(64);
    },
    (fit) => {
      fit.baseGguf.sha256 = "0".repeat(64);
    },
    (fit) => {
      fit.checkpoint = "/synthetic/unapproved-model";
    },
  ])
    await withFixture(async (inputs) => {
      const fit = JSON.parse(await readFile(inputs.files.fit));
      mutate(fit);
      inputs.expected.fitPlanSha256 = await save(inputs.files.fit, fit);
      await assert.rejects(
        verifyC9Q8Artifact(inputs),
        /FIT plan source pins|RFDT training used another schedule/,
      );
    });
});

test("C9 artifact verifier rejects a Q8 registry model ID mismatch despite matching hashes", async () => {
  await withFixture(async (inputs) => {
    const registry = JSON.parse(await readFile(inputs.files.registry));
    registry.artifacts[0].id = "jev/other-q8_0";
    inputs.expected.registrySha256 = await save(
      inputs.files.registry,
      registry,
    );
    const quantization = JSON.parse(await readFile(inputs.files.quantization));
    quantization.output.registrySha256 = inputs.expected.registrySha256;
    inputs.expected.quantizationManifestSha256 = await save(
      inputs.files.quantization,
      quantization,
    );
    await assert.rejects(verifyC9Q8Artifact(inputs), /Q8 registry descriptor/);
  });
});
