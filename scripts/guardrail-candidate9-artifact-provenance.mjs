import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const BASE_MODEL = "google/gemma-3-1b-it";
const BASE_REVISION = "dcc83ea841ab6100d6b47a070329e1ba4cf78752";
const BASE_WEIGHTS_SHA256 =
  "3d4ef8d71c14db7e448a09ebe891cfb6bf32c57a9b44499ae0d1c098e48516b6";
const BASE_GGUF_SHA256 =
  "05bd381a5f45611ce53f4fdcc6641cf6cec68c3091d74e8a32ea591f062d3fc5";
const QUANTIZER_REVISION = "f072b103714dfa1eee531f80b24512faf38e3dd2";
const QUANTIZER_BINARY_SHA256 =
  "e2c48c541efe39436f0edbbbfe0e65c9185e1bb1d6295fcfb28ebc38c1e77985";
// Frozen before CAL scoring in evaluator commit f5067cc400dfa4c4f686ce21dbe46ca8d927541b.
const CAL_SCORER_CLI_SHA256 =
  "22fdf95b916bbd72a2e4c99b62368b1fbc5c7c6475dc8b9fcfb45f86395f9fa1";
const CAL_SCORER_CORE_SHA256 =
  "f85aa0ac9b411b08a844c2bcd9efa8ee47fb61e29f567dd006353005a822d4f0";
const MAX_JSON_BYTES = 16 * 1_048_576;
const MAX_MODEL_BYTES = 16 * 1024 * 1_048_576;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const pinned = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message) => {
  throw new Error(`C9 artifact provenance: ${message}`);
};
const check = (condition, message) => {
  if (!condition) fail(message);
};
const samePath = (actual, expected) =>
  typeof actual === "string" &&
  isAbsolute(actual) &&
  resolve(actual) === resolve(expected);

async function regular(path, maximum, keepBytes = false) {
  check(
    typeof path === "string" && isAbsolute(path),
    "an absolute file path is required",
  );
  const file = resolve(path);
  const listed = await lstat(file);
  check(
    listed.isFile() && !listed.isSymbolicLink() && listed.size <= maximum,
    `not a bounded regular file: ${file}`,
  );
  const handle = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat();
    check(
      before.isFile() && before.dev === listed.dev && before.ino === listed.ino,
      `file changed while opening: ${file}`,
    );
    const hash = createHash("sha256");
    const chunks = keepBytes ? [] : null;
    let size = 0;
    let magic = Buffer.alloc(0);
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      check(size <= maximum, `file grew beyond bound: ${file}`);
      hash.update(chunk);
      if (chunks) chunks.push(chunk);
      if (magic.length < 4)
        magic = Buffer.concat([magic, chunk]).subarray(0, 4);
    }
    const after = await handle.stat();
    const current = await lstat(file);
    check(
      size === before.size &&
        after.size === before.size &&
        current.dev === before.dev &&
        current.ino === before.ino &&
        current.size === before.size &&
        current.mtimeMs === before.mtimeMs,
      `file changed while hashing: ${file}`,
    );
    return {
      file,
      sha256: hash.digest("hex"),
      size,
      magic: magic.toString("ascii"),
      bytes: chunks ? Buffer.concat(chunks) : undefined,
    };
  } finally {
    await handle.close();
  }
}

async function json(path) {
  const source = await regular(path, MAX_JSON_BYTES, true);
  let value;
  try {
    value = JSON.parse(source.bytes.toString("utf8"));
  } catch {
    fail(`invalid JSON: ${source.file}`);
  }
  check(record(value), `expected JSON object: ${source.file}`);
  return { ...source, value };
}

async function emptyRegular(path) {
  check(
    typeof path === "string" && isAbsolute(path),
    "an absolute prepared split path is required",
  );
  const entry = await lstat(path);
  check(
    entry.isFile() && !entry.isSymbolicLink() && entry.size === 0,
    "VALID or TEST prepared branch is nonempty",
  );
}

function checkPin(actual, expected, name) {
  check(pinned(expected), `missing ${name} SHA-256 pin`);
  check(actual === expected, `${name} SHA-256 differs from actual bytes`);
}

/**
 * Verify the exact F16 parent, derived Q8 model, and CAL scorer bytes.
 * `expected` is the pinned CAL score record. `admission` must already have been
 * checked against its own independently supplied SHA-256 by the caller.
 */
export async function verifyC9Q8Artifact({
  paths,
  expected,
  admission,
  objectivePlanSha256,
  modelSha256,
  arm,
}) {
  check(
    record(paths) && record(expected) && record(admission),
    "paths, CAL pins, and admission are required",
  );
  check(arm === "A" || arm === "B", "C9 arm must be A or B");
  check(
    expected.arm === arm && expected.artifactFormat === "q8_0",
    "CAL arm or artifact format changed",
  );
  checkPin(modelSha256, expected.modelSha256, "CAL model");
  checkPin(
    objectivePlanSha256,
    expected.objectivePlanSha256,
    "TRAIN objective",
  );
  const runDirectory = resolve(paths.runDirectory ?? "");
  check(
    typeof paths.runDirectory === "string" && isAbsolute(paths.runDirectory),
    "absolute C9 run directory required",
  );
  const locations = {
    artifact: join(runDirectory, "artifact.json"),
    run: join(runDirectory, "manifest.json"),
    fit: join(runDirectory, "candidate9-fit-plan.json"),
    registry: join(runDirectory, "q8-candidate-registry.json"),
    quantization: join(runDirectory, "candidate9-q8-manifest.json"),
  };
  for (const [key, location] of Object.entries(locations))
    if (paths[key] !== undefined)
      check(samePath(paths[key], location), `${key} path differs from C9 run`);
  check(
    typeof paths.calScorerCli === "string" &&
      isAbsolute(paths.calScorerCli) &&
      basename(dirname(paths.calScorerCli)) === "scripts" &&
      basename(paths.calScorerCli) === "guardrail-candidate9-cal-cli.mjs" &&
      samePath(
        paths.calScorerCore,
        join(dirname(paths.calScorerCli), "guardrail-candidate9-cal-score.mjs"),
      ),
    "CAL scorer source paths differ from frozen evaluator",
  );
  const [
    artifactFile,
    runFile,
    fitFile,
    registryFile,
    quantizationFile,
    objectiveFile,
    cliFile,
    coreFile,
    nativeBinaryFile,
    selectorFile,
    verifierFile,
    calibrationRuntimeFile,
  ] = await Promise.all([
    json(locations.artifact),
    json(locations.run),
    json(locations.fit),
    json(locations.registry),
    json(locations.quantization),
    json(paths.objectivePlan),
    regular(paths.calScorerCli, MAX_JSON_BYTES),
    regular(paths.calScorerCore, MAX_JSON_BYTES),
    regular(paths.nativeBinary, 64 * 1_048_576),
    regular(paths.selectorCli, MAX_JSON_BYTES),
    regular(fileURLToPath(import.meta.url), MAX_JSON_BYTES),
    regular(paths.calibrationRuntime, MAX_JSON_BYTES),
  ]);
  checkPin(
    artifactFile.sha256,
    expected.artifactManifestSha256,
    "F16 artifact manifest",
  );
  checkPin(runFile.sha256, expected.runManifestSha256, "RFDT run manifest");
  checkPin(fitFile.sha256, expected.fitPlanSha256, "C9 FIT plan");
  checkPin(registryFile.sha256, expected.registrySha256, "Q8 registry");
  checkPin(
    quantizationFile.sha256,
    expected.quantizationManifestSha256,
    "Q8 quantization manifest",
  );
  checkPin(objectiveFile.sha256, objectivePlanSha256, "TRAIN objective plan");
  checkPin(cliFile.sha256, expected.calScorerCliSha256, "CAL scorer CLI");
  checkPin(coreFile.sha256, expected.calScorerCoreSha256, "CAL scorer core");
  checkPin(
    nativeBinaryFile.sha256,
    expected.nativeBinarySha256,
    "CAL native scorer",
  );
  check(
    cliFile.sha256 === CAL_SCORER_CLI_SHA256 &&
      coreFile.sha256 === CAL_SCORER_CORE_SHA256,
    "CAL scorer differs from pre-CAL frozen evaluator source",
  );

  const artifact = artifactFile.value,
    run = runFile.value,
    fit = fitFile.value;
  const registry = registryFile.value,
    quantization = quantizationFile.value;
  const objective = objectiveFile.value;
  const fitSha256 = admission.fit?.sha256;
  const admissionSha256 = expected.admissionSha256;
  const pairSha256 = admission.source?.pairsSha256;
  const familySha256 = admission.source?.familiesSha256;
  for (const [name, value] of Object.entries({
    fitSha256,
    admissionSha256,
    pairSha256,
    familySha256,
  }))
    check(pinned(value), `missing ${name} pin`);
  check(
    expected.fitSha256 === fitSha256 &&
      expected.pairManifestSha256 === pairSha256 &&
      expected.familyManifestSha256 === familySha256,
    "CAL FIT, pair, or family pins changed",
  );
  check(
    artifact.version === 1 &&
      /^jev\/[a-zA-Z0-9._-]+$/.test(artifact.id) &&
      artifact.base_model === BASE_MODEL &&
      artifact.base_revision === BASE_REVISION &&
      artifact.template_version === "v2" &&
      samePath(artifact.run_manifest, locations.run),
    "F16 artifact lineage or run path changed",
  );
  check(
    run.version === 1 &&
      run.status === "exported" &&
      run.id === artifact.training_run &&
      samePath(run.directory, runDirectory) &&
      run.base_model === BASE_MODEL &&
      run.base_revision === BASE_REVISION &&
      run.template_version === "v2",
    "RFDT run lineage changed",
  );
  check(
    run.prepared?.branches?.train > 0 &&
      run.prepared.branches.validation === 0 &&
      run.prepared.branches.test === 0 &&
      run.source?.sha256 === fitSha256 &&
      samePath(run.source?.file, fit.source?.fit?.path),
    "RFDT run is not exact FIT-only training",
  );
  check(
    samePath(run.prepared?.files?.train, join(runDirectory, "train.jsonl")) &&
      samePath(
        run.prepared?.files?.validation,
        join(runDirectory, "validation.jsonl"),
      ) &&
      samePath(run.prepared?.files?.test, join(runDirectory, "test.jsonl")) &&
      samePath(run.prepared?.dataset_file, join(runDirectory, "dataset.jsonl")),
    "prepared split paths changed",
  );
  const [train, dataset] = await Promise.all([
    regular(run.prepared.files.train, 64 * 1_048_576, true),
    regular(run.prepared.dataset_file, 64 * 1_048_576),
    emptyRegular(run.prepared.files.validation),
    emptyRegular(run.prepared.files.test),
  ]);
  check(
    run.prepared.dataset_sha256 === dataset.sha256 &&
      run.training?.training_data_sha256 === train.sha256 &&
      run.prepared.sha256 ===
        digest(
          Buffer.concat([
            Buffer.from("train\n"),
            train.bytes,
            Buffer.from("validation\ntest\n"),
          ]),
        ),
    "prepared TRAIN bytes or freeze hash changed",
  );
  check(
    run.training?.steps === 256 &&
      run.training?.hyperparameters?.steps === 256 &&
      run.training?.provenance?.base_model === BASE_MODEL &&
      run.training?.provenance?.base_revision === BASE_REVISION &&
      samePath(run.training?.model_path, fit.checkpoint) &&
      run.training?.validation_data_sha256 === null &&
      run.training?.validation === null,
    "RFDT training used another schedule or validation input",
  );
  const objectiveName =
    arm === "A"
      ? "guardrail_train_group_pair_margin_v1"
      : "guardrail_train_balanced_symmetric_v1";
  check(
    objective.version === 2 &&
      objective.purpose === "candidate9_train_only" &&
      objective.arm === arm &&
      objective.objective === objectiveName &&
      objective.steps === 256 &&
      objective.pair_manifest_sha256 === pairSha256 &&
      objective.family_manifest_sha256 === familySha256 &&
      objective.cutoff_status ===
        "unset_requires_c9_train_cal_hard_veto_before_valid" &&
      objective.validation_rows_passed_to_training === 0 &&
      objective.test_rows_passed_to_training === 0,
    "C9 objective or split boundary changed",
  );
  check(
    run.training.objective === objectiveName &&
      run.training.guardrail_train_plan?.sha256 === objectivePlanSha256 &&
      isDeepStrictEqual(
        run.training.guardrail_train_plan?.content,
        objective,
      ) &&
      run.training.guardrail_pairs?.sha256 === pairSha256 &&
      run.training.guardrail_fit_families?.sha256 === familySha256,
    "RFDT trained objective differs from frozen C9 plan",
  );
  check(
    fit.version === 1 &&
      fit.purpose === "candidate9_fit_only_rfdt" &&
      fit.qualification === false &&
      fit.validationRead === false &&
      fit.heldOutTestRead === false &&
      fit.steps === 256 &&
      fit.selection === "C9_TRAIN_CAL_hard_veto_before_blind_VALID" &&
      fit.inferenceArtifactFormat === "GGUF_Q8_0" &&
      fit.source?.arm === arm &&
      fit.source?.inferenceArtifactFormat === "GGUF_Q8_0" &&
      fit.source?.admissionSha256 === admissionSha256 &&
      fit.source?.fit?.sha256 === fitSha256 &&
      fit.source?.fit?.rows === admission.fit?.rows &&
      fit.source?.fit?.groups === admission.fit?.groups &&
      fit.source?.fit?.preparedDatasetSha256 === dataset.sha256 &&
      fit.source?.pairsSha256 === pairSha256 &&
      fit.source?.familiesSha256 === familySha256 &&
      fit.source?.objectiveSha256 === objectivePlanSha256 &&
      typeof fit.checkpoint === "string" &&
      fit.checkpoint.endsWith(
        `/models--google--gemma-3-1b-it/snapshots/${BASE_REVISION}`,
      ) &&
      fit.baseFiles?.["model.safetensors"]?.sha256 === BASE_WEIGHTS_SHA256 &&
      fit.baseGguf?.sha256 === BASE_GGUF_SHA256 &&
      fit.source?.code?.files?.[".build/jev-native"] ===
        nativeBinaryFile.sha256 &&
      fit.source?.code?.files?.[
        "scripts/guardrail-candidate9-select-cutoff.mjs"
      ] === selectorFile.sha256 &&
      fit.source?.code?.files?.[
        "scripts/guardrail-candidate9-artifact-provenance.mjs"
      ] === verifierFile.sha256 &&
      fit.source?.code?.files?.["dist/guardrail-c9-calibration.js"] ===
        calibrationRuntimeFile.sha256 &&
      fit.rfdtPreparedSha256 === run.prepared.sha256,
    "C9 FIT plan source pins or schedule changed",
  );
  check(
    run.prepared.branches.train === fit.source.fit.rows &&
      run.source.examples === fit.source.fit.rows,
    "FIT row count differs from prepared run",
  );

  check(
    samePath(artifact.file, paths.f16Model),
    "F16 artifact file path changed",
  );
  const f16 = await regular(paths.f16Model, MAX_MODEL_BYTES);
  check(
    f16.magic === "GGUF" &&
      artifact.sha256 === f16.sha256 &&
      artifact.size === f16.size &&
      run.exports?.id === artifact.id &&
      samePath(run.exports?.file, f16.file) &&
      run.exports?.sha256 === f16.sha256 &&
      run.exports?.size === f16.size,
    "F16 model bytes differ from RFDT export",
  );
  check(
    run.exports?.converter_revision === QUANTIZER_REVISION &&
      pinned(run.exports?.converter_sha256),
    "F16 converter source revision or hash changed",
  );
  check(
    quantization.version === 1 &&
      quantization.purpose ===
        "candidate9_same_weights_q8_0_calibration_candidate" &&
      quantization.qualification === false,
    "Q8 candidate identity changed",
  );
  check(
    quantization.sourceWeights?.modelId === artifact.id &&
      samePath(quantization.sourceWeights?.file, f16.file) &&
      quantization.sourceWeights?.sha256 === f16.sha256 &&
      quantization.sourceWeights?.size === f16.size,
    "Q8 source weights differ from F16 export",
  );
  check(
    typeof quantization.quantizer?.sourceDirectory === "string" &&
      isAbsolute(quantization.quantizer.sourceDirectory) &&
      quantization.quantizer.sourceRevision === QUANTIZER_REVISION &&
      quantization.quantizer.binarySha256 === QUANTIZER_BINARY_SHA256 &&
      quantization.quantizer.type === "Q8_0" &&
      quantization.quantizer.leaveOutputTensorUnquantized === true &&
      quantization.quantizer.importanceMatrix === null,
    "Q8 quantizer revision, binary, or options changed",
  );
  const q8Id = `${artifact.id}-q8_0`;
  check(
    /^jev\/[a-zA-Z0-9._-]+$/.test(q8Id) &&
      quantization.output?.modelId === q8Id &&
      samePath(quantization.output?.file, paths.q8Model),
    "Q8 output model ID or path changed",
  );
  if (expected.modelId !== undefined)
    check(expected.modelId === q8Id, "CAL model ID differs from Q8 output");
  const q8 = await regular(paths.q8Model, MAX_MODEL_BYTES);
  check(
    q8.magic === "GGUF" &&
      q8.sha256 === modelSha256 &&
      quantization.output.sha256 === q8.sha256 &&
      quantization.output.size === q8.size &&
      quantization.output.registrySha256 === registryFile.sha256,
    "Q8 model bytes or registry pin changed",
  );
  check(
    registry.version === 1 &&
      Array.isArray(registry.artifacts) &&
      registry.artifacts.length === 1,
    "Q8 registry inventory changed",
  );
  const descriptor = registry.artifacts[0];
  check(
    record(descriptor) &&
      isDeepStrictEqual(
        Object.keys(descriptor).sort(),
        [
          "id",
          "file",
          "sha256",
          "size",
          "base_model",
          "revision",
          "template_version",
          "training_run",
          "license",
          "roles",
        ].sort(),
      ) &&
      descriptor.id === q8Id &&
      samePath(descriptor.file, q8.file) &&
      descriptor.sha256 === q8.sha256 &&
      descriptor.size === q8.size &&
      descriptor.base_model === BASE_MODEL &&
      descriptor.revision === BASE_REVISION &&
      descriptor.template_version === "v2" &&
      descriptor.training_run === run.id &&
      descriptor.license === "gemma" &&
      isDeepStrictEqual(descriptor.roles, ["classifier"]),
    "Q8 registry descriptor differs from model and F16 lineage",
  );
  return {
    artifactFormat: "q8_0",
    arm,
    modelId: q8Id,
    modelSha256: q8.sha256,
    artifactManifestSha256: artifactFile.sha256,
    runManifestSha256: runFile.sha256,
    fitPlanSha256: fitFile.sha256,
    registrySha256: registryFile.sha256,
    quantizationManifestSha256: quantizationFile.sha256,
    calScorerCliSha256: cliFile.sha256,
    calScorerCoreSha256: coreFile.sha256,
  };
}
