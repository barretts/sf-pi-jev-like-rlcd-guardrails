import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const sha = (value) => createHash("sha256").update(value).digest("hex");
const baseRevision = "dcc83ea841ab6100d6b47a070329e1ba4cf78752";
const quantizerRevision = "f072b103714dfa1eee531f80b24512faf38e3dd2";
const quantizerBinary =
  "e2c48c541efe39436f0edbbbfe0e65c9185e1bb1d6295fcfb28ebc38c1e77985";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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
export const save = async (path, value) => {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
  await writeFile(path, bytes);
  return sha(bytes);
};

export async function fixture(arm = "B", options = {}) {
  const runDirectory = await mkdtemp(join(tmpdir(), "c9-artifact-proof-"));
  const location = (name) => join(runDirectory, name);
  const fitBytes =
    options.fitBytes ?? Buffer.from('{"id":"fit-one","split":"train"}\n');
  const fitRows = options.fitRows ?? 1;
  const fitGroups = options.fitGroups ?? 1;
  const nativeBinary = location("jev-native");
  const nativeBytes = Buffer.from("synthetic native scorer");
  await writeFile(nativeBinary, nativeBytes);
  const nativeBinarySha256 = sha(nativeBytes);
  const selectorCli = join(
    root,
    "scripts/guardrail-candidate9-select-cutoff.mjs",
  );
  const artifactVerifier = join(
    root,
    "scripts/guardrail-candidate9-artifact-provenance.mjs",
  );
  const calibrationRuntime = join(root, "dist/guardrail-c9-calibration.js");
  const sealedCodeFiles = {
    ".build/jev-native": nativeBinarySha256,
    "scripts/guardrail-candidate9-select-cutoff.mjs": sha(
      await readFile(selectorCli),
    ),
    "scripts/guardrail-candidate9-artifact-provenance.mjs": sha(
      await readFile(artifactVerifier),
    ),
    "dist/guardrail-c9-calibration.js": sha(await readFile(calibrationRuntime)),
  };
  const fitSha256 = sha(fitBytes);
  const fitSource = location("fit.jsonl");
  await writeFile(fitSource, fitBytes);
  const pairSha256 = options.pairSha256 ?? "a".repeat(64),
    familySha256 = options.familySha256 ?? "b".repeat(64);
  const admissionSha256 = options.admissionSha256 ?? "c".repeat(64);
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
    source: { file: fitSource, sha256: fitSha256, examples: fitRows },
    prepared: {
      sha256: frozen,
      dataset_file: location("dataset.jsonl"),
      dataset_sha256: fitSha256,
      files: {
        train: location("train.jsonl"),
        validation: location("validation.jsonl"),
        test: location("test.jsonl"),
      },
      branches: { train: fitRows, validation: 0, test: 0 },
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
        rows: fitRows,
        groups: fitGroups,
      },
      pairsSha256: pairSha256,
      familiesSha256: familySha256,
      objectiveSha256: objectivePlanSha256,
      code: { files: sealedCodeFiles },
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
    nativeBinary,
    selectorCli,
    calibrationRuntime,
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
    nativeBinarySha256,
    objectivePlanSha256,
    admissionSha256,
    fitSha256,
    pairManifestSha256: pairSha256,
    familyManifestSha256: familySha256,
  };
  const admission = {
    fit: { sha256: fitSha256, rows: fitRows, groups: fitGroups },
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
