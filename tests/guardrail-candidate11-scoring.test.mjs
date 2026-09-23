import test from "node:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical } from "../dist/core.js";
import { guardrailRequest } from "../dist/guardrail.js";
import { hashArtifact, GEMMA_TRAINING_REVISION } from "../dist/models.js";
import {
  C9_CAL_SOURCE_PINS,
  prepareCandidate9CalibrationRows,
} from "../scripts/guardrail-candidate9-cal-score.mjs";
import { candidate8OperationSha256 } from "../scripts/guardrail-candidate8-host-core.mjs";
import {
  assembleC10Manifest,
  assembleC11Manifest,
} from "../scripts/guardrail-candidate10-manifest.mjs";
import { runC11Q8 } from "../scripts/guardrail-candidate10-q8.mjs";
import {
  C11_CAMPAIGN_SHA256,
  C10_CAMPAIGN_SHA256,
  C11_SOURCE_RUNTIME,
  C10_HOST,
  validateC10Manifest,
  validateC11Manifest,
  evaluateC11,
  evaluateC11Diagnostic,
  c11Q8SourceIdentity,
} from "../scripts/guardrail-candidate10-evaluate.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const encode = (value) => Buffer.from(JSON.stringify(value) + "\n");
const jsonl = (rows) =>
  Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
const fitSha =
  "8071644e852b1399732e0b5d47f52989239dbf79f38bdcac535167675182ae25";
const trainSha =
  "8c6d83095fa9a4215e060f54b24c2116deb2c7355377f56d800de8540b0ab8e3";
const calSha =
  "84dfedfb0a1aea2b5e39fd33bd40a913edf96daf89129accdc59e622ce7d57bd";
const baselineSha =
  "a4d80d4a24a2e0fa047cf3224a3f670c555512556a5fa21f7fd32a8e6bb75b09";
const validSha =
  "d7d532c2712bf699133971cb82b0b0c5f21cbe5362a5edd07171b532a58f072f";
const preflightSha =
  "5bf72039c1a2881f9bc1fc9a801e5dff734aa38fffc95d8045d5f14405c24784";
const quantizerSha =
  "e2c48c541efe39436f0edbbbfe0e65c9185e1bb1d6295fcfb28ebc38c1e77985";

async function fixture(checkpoint = 128) {
  const temp = await mkdtemp(resolve(tmpdir(), "c11-scoring-synthetic-"));
  const local = resolve(temp, "local"),
    cuda = resolve(temp, "cuda");
  await mkdir(resolve(local, "adapter"), { recursive: true });
  const documents = new Map(),
    buffers = new Map(),
    pins = new Map(),
    reads = [];
  const put = (path, value, digest) => {
    const bytes = Buffer.isBuffer(value) ? value : encode(value);
    buffers.set(path, bytes);
    if (!Buffer.isBuffer(value)) documents.set(path, value);
    pins.set(path, digest ?? sha(bytes));
    return { path, sha256: pins.get(path) };
  };
  const campaignPath = resolve(
    root,
    "fixtures/guardrail/candidate11/cuda-campaign-327-fit.json",
  );
  const objectivePath = resolve(
    root,
    "fixtures/guardrail/candidate9/objective-plan-B.json",
  );
  const campaign = JSON.parse(await readFile(campaignPath));
  const objective = JSON.parse(await readFile(objectivePath));
  const runtime = { ...C11_SOURCE_RUNTIME };
  const code = Object.fromEntries(
    [
      "c11_cuda_campaign.py",
      "c11_fit_sampler.py",
      "cuda_worker.py",
      "worker.py",
      "gemma3_fp32.py",
      "cuda_memory_monitor.py",
    ].map((name) => [name, runtime[`rfdt/${name}`]]),
  );
  const fit = Array.from({ length: 327 }, (_, i) => ({
    id: `synthetic-fit-${i}`,
    group_id: `synthetic-fit-group-${i % 133}`,
  }));
  const localRows = fit.map((row) => ({ source_id: row.id, margin: 1 }));
  const sourceRows = fit.map((row) => ({
    source_id: row.id,
    initial: 0,
    final: 1,
  }));
  const marginPin = put(
    resolve(cuda, "run/fit-margins.jsonl"),
    jsonl(sourceRows),
  );
  const localPin = put(
    resolve(local, "adapter/local-fit-margins.jsonl"),
    jsonl(localRows),
  );
  const adapterPin = put(
    resolve(local, "adapter/adapters.safetensors"),
    Buffer.from("synthetic adapter; no tensors loaded"),
  );
  const precision = campaign.precision;
  const source = {
    experiment: "candidate11",
    mode: "train",
    steps: checkpoint,
    checkpoint_step: checkpoint,
    campaign_steps: 1024,
    campaign,
    campaign_sha256: C11_CAMPAIGN_SHA256,
    initialization: campaign.initialization,
    sampler_source_sha256: code["c11_fit_sampler.py"],
    source_objective_plan: objective,
    objective: {
      ...objective,
      purpose: "candidate11_train_only",
      sampler: campaign.sampler,
      steps: 1024,
    },
    source_sha256: code["c11_cuda_campaign.py"],
    contract_sha256: code["worker.py"],
    objective_worker_sha256: code["cuda_worker.py"],
    precision,
    inputs: {
      train: trainSha,
      pairs: campaign.pair_manifest_sha256,
      families: campaign.family_manifest_sha256,
      plan: runtime["fixtures/guardrail/candidate9/objective-plan-B.json"],
      base: {
        "model.safetensors":
          "3d4ef8d71c14db7e448a09ebe891cfb6bf32c57a9b44499ae0d1c098e48516b6",
        "config.json":
          "19cb5d28c97778271ba2b3c3df47bf76bdd6706724777a2318b3522230afe91e",
        "tokenizer.json":
          "4667f2089529e8e7657cfb6d1c19910ae71ff5f28aa7ab2ff2763330affad795",
      },
    },
  };
  const receipt = {
    mode: "train",
    qualified: false,
    adapter_changed: true,
    steps: checkpoint,
    checkpoint_step: checkpoint,
    source,
    adapter_sha256: adapterPin.sha256,
    fit_margins_sha256: marginPin.sha256,
    saved_adapter_reload: {
      ok: true,
      rows: 327,
      margin_delta_limit: 1e-5,
      max_margin_delta: 0,
      adapter_sha256: adapterPin.sha256,
      fit_margins_sha256: marginPin.sha256,
      precision,
    },
  };
  const receiptPin = put(resolve(cuda, "run/receipt.json"), receipt);
  const localProof = {
    ok: true,
    rows: 327,
    max_probability_delta: 0,
    max_probability_delta_limit: 0.05,
    decisive_margin: 0.5,
    decisive_sign_flips: 0,
  };
  put(resolve(local, "adapter/cuda-import-equivalence.json"), localProof);
  const imported = {
    ok: true,
    adapter_changed: true,
    reload_verified: true,
    adapter_dir: resolve(local, "adapter"),
    training_backend: "torch_cuda",
    qualified: false,
    checkpoint_step: checkpoint,
    cuda_campaign_sha256: C11_CAMPAIGN_SHA256,
    cuda_source: receipt,
    cuda_receipt_sha256: receiptPin.sha256,
    local_fit_margins_sha256: localPin.sha256,
    cross_backend_equivalence: localProof,
    local_precision: precision,
    local_architecture: {
      kind: "hf_fp32_embedding_scale",
      embedding_scale_policy: "sqrt_hidden_size_in_fp32",
      helper_sha256: code["gemma3_fp32.py"],
    },
  };
  put(resolve(local, "adapter/cuda-import-report.json"), imported);
  const modelF16 = resolve(local, "model-f16.gguf"),
    modelQ8 = resolve(local, "model-q8.gguf");
  await writeFile(modelF16, "GGUF synthetic F16 bytes; no model is loaded");
  await writeFile(modelQ8, "GGUF synthetic Q8 bytes; no model is loaded");
  const f16Hash = await hashArtifact(modelF16),
    q8Hash = await hashArtifact(modelQ8);
  const native = resolve(temp, "synthetic-native");
  await writeFile(native, "synthetic native binary never executed");
  const nativeSha = (await hashArtifact(native)).sha256;
  const descriptor = {
    version: 1,
    id: `jev/synthetic-c11-${checkpoint}`,
    file: modelF16,
    ...f16Hash,
    run_manifest: resolve(local, "manifest.json"),
    training_run: "synthetic-c11-run",
    base_model: "google/gemma-3-1b-it",
    base_revision: GEMMA_TRAINING_REVISION,
    template_version: "v2",
  };
  const fusion = {
    ok: true,
    fused: true,
    fusion_dtype: "float32",
    output_dir: resolve(local, "fused"),
    format: "safetensors",
    gguf_exported: false,
    template_version: "v2",
    adapter_sha256: adapterPin.sha256,
    tokenizer_projection: { prompt_parity: { training_data_sha256: trainSha } },
  };
  const run = {
    version: 1,
    id: descriptor.training_run,
    directory: local,
    status: "exported",
    base_model: descriptor.base_model,
    base_revision: descriptor.base_revision,
    template_version: "v2",
    source: { sha256: fitSha },
    prepared: {
      dataset_sha256: fitSha,
      branches: { train: 327, validation: 0, test: 0 },
      files: { train: resolve(local, "prepared/train.jsonl") },
    },
    training: { ...imported, fusion },
    exports: { id: descriptor.id, file: modelF16, ...f16Hash },
  };
  await writeFile(descriptor.run_manifest, encode(run));
  put(descriptor.run_manifest, run);
  put(resolve(local, "artifact.json"), descriptor);
  const registryArtifact = {
    id: descriptor.id,
    revision: GEMMA_TRAINING_REVISION,
    file: modelF16,
    ...f16Hash,
    base_model: descriptor.base_model,
    template_version: "v2",
    roles: ["classifier"],
    license: "gemma",
    training_run: run.id,
  };
  const q8Artifact = {
    ...registryArtifact,
    id: descriptor.id + "-q8",
    file: modelQ8,
    ...q8Hash,
  };
  const registry = resolve(local, "f16-registry.json"),
    q8Registry = resolve(local, "q8-registry.json");
  await writeFile(
    registry,
    encode({ version: 1, artifacts: [registryArtifact] }),
  );
  await writeFile(q8Registry, encode({ version: 1, artifacts: [q8Artifact] }));
  put(q8Registry, { version: 1, artifacts: [q8Artifact] });
  const proof = (modelSha, failed) => ({
    purpose: "cuda_export_fit_precision_check_only",
    qualified: false,
    ok: !failed,
    admitted: 327,
    answered: 327,
    failure: null,
    modelSha256: modelSha,
    nativeBinarySha256: nativeSha,
    maxProbabilityDeltaLimit: 0.05,
    decisiveMargin: 0.5,
    decisiveSignFlips: failed ? 327 : 0,
    maxProbabilityDelta: failed
      ? 1 / (1 + Math.exp(-1)) - 1 / (1 + Math.exp(1))
      : 0,
    records: fit.map((row) => ({
      sourceId: row.id,
      referenceMargin: 1,
      margin: failed ? -1 : 1,
    })),
  });
  const f16Proof = proof(f16Hash.sha256, false),
    q8Proof = proof(q8Hash.sha256, true);
  put(resolve(local, "precision-f16.json"), f16Proof);
  put(resolve(local, "precision-q8.json"), q8Proof);
  const handoff = {
    version: 1,
    purpose: "candidate11_local_checkpoint_handoff",
    qualified: false,
    checkpoint,
    run: local,
    artifact: resolve(local, "artifact.json"),
    registry,
    model: modelF16,
    precision: resolve(local, "precision-f16.json"),
  };
  put(resolve(local, "local-checkpoint-handoff.json"), handoff);
  const quantizer = resolve(temp, "synthetic-quantizer"),
    quantizationPath = resolve(local, "candidate11-q8-manifest.json");
  put(
    quantizer,
    Buffer.from("synthetic quantizer never executed"),
    quantizerSha,
  );
  const quantization = {
    version: 1,
    purpose: "candidate11_fit_only_q8_derivation",
    qualified: false,
    qualification: false,
    sourceWeights: descriptor,
    sourceCheckpoint: c11Q8SourceIdentity(run, imported, runtime),
    quantizer: {
      binarySha256: quantizerSha,
      type: "Q8_0",
      leaveOutputTensorUnquantized: true,
      importanceMatrix: null,
      sourceRevision: "f072b103714dfa1eee531f80b24512faf38e3dd2",
      runtimeLibraries: {},
      runtimeLibraryLinks: {},
    },
    output: {
      ...q8Artifact,
      modelId: q8Artifact.id,
      registrySha256: (await hashArtifact(q8Registry)).sha256,
    },
  };
  put(quantizationPath, quantization);
  const launch = {
    purpose: "candidate11_cuda_fit_only_campaign",
    mode: "train",
    worker_pid: 123,
    campaign_sha256: C11_CAMPAIGN_SHA256,
    code_sha256: code,
    launcher_sha256: runtime["rfdt/cuda_campaign_launch.py"],
    worker_sha256: code["c11_cuda_campaign.py"],
    objective_worker_sha256: code["cuda_worker.py"],
    rfdt_contract_sha256: code["worker.py"],
    watchdog_sha256: code["cuda_memory_monitor.py"],
    monitor_sha256: code["cuda_memory_monitor.py"],
    prepared_fit_sha256: trainSha,
    plan_sha256: runtime["fixtures/guardrail/candidate9/objective-plan-B.json"],
    qualification: false,
    hard_budget_bytes: 8e9,
    allocator_cap_bytes: 6.5e9,
    stop_dedicated_delta_bytes: 7.5e9,
    shared_growth_limit_bytes: 128e6,
    stop_total_dedicated_bytes: 16e9,
  };
  put(resolve(cuda, "launch.json"), launch);
  const memory = { reason: "checkpoint_snapshot" };
  put(resolve(cuda, "memory.summary.json"), memory);
  const snapshot = {
    checkpoint_step: checkpoint,
    checkpoint_receipt_sha256: receiptPin.sha256,
    worker_pid: launch.worker_pid,
    producer_sha256: launch.launcher_sha256,
    worker_sha256: launch.worker_sha256,
    monitor_sha256: launch.monitor_sha256,
  };
  put(resolve(cuda, "memory.snapshot.json"), snapshot);
  const trainRoot = resolve(
    root,
    "reports/guardrail-risk-2026-09-21/candidate-9-evidence/train",
  );
  const baselineRoot = resolve(
    root,
    "reports/guardrail-risk-2026-09-21/candidate-10-evidence/baseline",
  );
  put(resolve(trainRoot, "fit.jsonl"), jsonl(fit), fitSha);
  put(
    resolve(trainRoot, "admission.json"),
    { synthetic: true },
    C9_CAL_SOURCE_PINS.admissionSha256,
  );
  const calRows = Array.from({ length: 42 }, (_, i) => ({
    id: `synthetic-cal-${String(i).padStart(2, "0")}`,
    group_id: `synthetic-cal-group-${i}`,
    split: "calibration",
    request: guardrailRequest(
      {
        version: 2,
        toolName: "bash",
        input: { command: `printf synthetic-${i}` },
        facts: {},
      },
      "google/gemma-3-1b-it",
    ),
    targets: { risk: { answer: i < 21 ? "allow" : "confirm" } },
  }));
  put(resolve(trainRoot, "calibration.jsonl"), jsonl(calRows), calSha);
  const prepared = prepareCandidate9CalibrationRows(
    calRows,
    [...new Set(fit.map((row) => row.group_id))].sort(),
  );
  const baseline = {
    purpose: "candidate10_train_cal_baseline_replay",
    modelCalls: 0,
    qualification: false,
    heldOutTestRead: false,
    externalOperationsExecuted: 0,
    baselineSha256: C10_HOST.baselineSha256,
    policySha256: C9_CAL_SOURCE_PINS.policySha256,
    calibrationCorpusSha256: calSha,
    source: {
      hostCommit: C10_HOST.commit,
      authoredC9BaselineReceiptSha256:
        "39f5f409a659d4a6bba0b2b1ed3a83df787df709e46f314ebacf883071bc8e12",
      prospectiveHostProjectionSha256:
        "0ebac560090502879b94ee770cb240c3f3df82d63284cea173ee2acf0daa87f0",
    },
    records: prepared.map((row) => ({
      id: row.id,
      inputSha256: row.inputSha256,
      gate: "model_prepared",
      action: "allow",
    })),
  };
  put(
    resolve(baselineRoot, "calibration-baseline.json"),
    baseline,
    baselineSha,
  );
  const freeze = {
    purpose: "candidate10_prospective_baseline_freeze",
    host: {
      path: resolve(temp, "synthetic-host"),
      commit: C10_HOST.commit,
      baselineSha256: C10_HOST.baselineSha256,
      policySha256: C9_CAL_SOURCE_PINS.policySha256,
    },
    equivalence: {
      calibration: { differingCases: 0 },
      validation: { differingCases: 0 },
    },
    authoredC9: {
      validSourceSha256: validSha,
      validManifestSha256: C9_CAL_SOURCE_PINS.blindValidManifestSha256,
    },
  };
  put(resolve(baselineRoot, "manifest.json"), freeze, C10_HOST.freezeSha256);
  const cases = Array.from({ length: 160 }, (_, i) => ({
    id: `c9-valid-${String(i + 1).padStart(3, "0")}`,
    group_id: `synthetic-valid-group-${Math.floor(i / 2)}`,
    family: "synthetic",
    fixture: { cwd: "/synthetic" },
    operation: { tool: "bash", input: { command: `printf synthetic-${i}` } },
    expected: { decision: i >= 158 ? "hard_block" : "allow" },
  }));
  const status = cases.map((row, i) => ({
    id: row.id,
    group_id: row.group_id,
    family: row.family,
    expected: row.expected.decision,
    baseline_action: i >= 158 ? "block" : "allow",
    operation_sha256: candidate8OperationSha256(row),
    routing:
      i < 116
        ? "model_prepared"
        : i < 121
          ? "pre_model_fallback"
          : "rules_fallback",
    risk_input_sha256: i < 116 ? sha(`synthetic-${i}`) : null,
    policy_sha256: C9_CAL_SOURCE_PINS.policySha256,
    reason:
      i < 116 ? "prepared" : i < 121 ? "org_fact_unavailable" : "ineligible",
  }));
  const preflight = {
    version: 1,
    mode: "fake-facts-no-model-no-execution",
    source_sha256: validSha,
    manifest_sha256: C9_CAL_SOURCE_PINS.blindValidManifestSha256,
    host_commit: C10_HOST.commit,
    host_baseline_sha256: C10_HOST.baselineSha256,
    default_policy_sha256: C9_CAL_SOURCE_PINS.policySha256,
    status,
  };
  put(
    resolve(root, "blind-c9-20260922/valid.json"),
    { schema_version: "c9.1", split: "valid", cases },
    validSha,
  );
  put(
    resolve(root, "blind-c9-20260922/manifest.json"),
    {
      source: { case_count: 160, group_count: 80 },
      inventory: { ids: cases.map((row) => row.id) },
    },
    C9_CAL_SOURCE_PINS.blindValidManifestSha256,
  );
  put(resolve(baselineRoot, "valid-preflight.json"), preflight, preflightSha);
  const pin = async (path) => ({
    path,
    sha256: pins.get(path) ?? (await hashArtifact(path)).sha256,
  });
  const document = async (path) => {
    reads.push(path);
    if (documents.has(path)) return documents.get(path);
    if (path === campaignPath || path === objectivePath)
      return JSON.parse(await readFile(path));
    throw Error("Unexpected synthetic metadata read: " + path);
  };
  const pinned = async (identity) => {
    reads.push(identity.path);
    if (
      buffers.has(identity.path) &&
      pins.get(identity.path) === identity.sha256
    )
      return buffers.get(identity.path);
    throw Error("Unexpected synthetic body read: " + identity.path);
  };
  let veto = false,
    nativeCalls = 0,
    replayCalls = 0,
    failNativeAt = null,
    nativeStatus;
  class NativeBackend {
    constructor() {
      this.status = {
        state: "ready",
        ready: true,
        generation: 1,
        artifact: { sha256: f16Hash.sha256 },
      };
      nativeStatus = this.status;
    }
    async warmup() {}
  }
  class Classifier {
    async classify(request) {
      nativeCalls++;
      if (nativeCalls === failNativeAt) {
        nativeStatus.ready = false;
        nativeStatus.state = "failed";
        throw new Error("synthetic native request deadline");
      }
      if (nativeStatus.state === "failed") {
        nativeStatus.generation++;
        nativeStatus.ready = true;
        nativeStatus.state = "ready";
      }
      const row = calRows.find(
        (row) => canonical(row.request.state) === canonical(request.state),
      );
      const allow = row.targets.risk.answer === "allow";
      const score = allow ? 0.9 : veto ? 0.95 : 0.1;
      return {
        model: request.model,
        answers: {
          risk: {
            type: "choice",
            choice: score >= 0.5 ? "allow" : "confirm",
            probabilities: { allow: score, confirm: 1 - score },
          },
        },
        usage: { input_tokens: 1, output_tokens: 0 },
      };
    }
    async dispose() {}
  }
  const evaluator = {
    json: async (identity) => {
      await pin(identity.path).then((actual) =>
        assert.equal(actual.sha256, identity.sha256),
      );
      return document(identity.path);
    },
    pinned,
    capture: async (manifest) => {
      for (const identity of Object.values(manifest.files))
        assert.equal((await pin(identity.path)).sha256, identity.sha256);
      for (const [name, digest] of Object.entries(manifest.runtime))
        assert.equal((await hashArtifact(resolve(root, name))).sha256, digest);
      return {
        preparedTrain: trainSha,
        syntheticHostBaseline: C10_HOST.baselineSha256,
      };
    },
    backendModule: { configFromEnv: () => ({}), NativeBackend, Classifier },
    verifyQuantizerRuntime: async () => ({}),
    runCandidate8HostRows: async (options) => {
      replayCalls++;
      assert.equal(options.rows.length, 160);
      // Exercise the real provider factory creation, then return synthetic host records.
      assert.equal(typeof options.createProvider, "function");
      return {
        coldInitializationMs: 0,
        records: status.map((row) => {
          const eligible = row.routing === "model_prepared",
            actual = row.baseline_action;
          const source = eligible ? "jev" : "exact_policy";
          const comparison = {
            mode: "shadow",
            source,
            reason: eligible
              ? "safe_classification"
              : "exact_policy_constraint",
            baseline: actual,
            actual,
            prediction: eligible ? "allow" : null,
            allowScore: eligible ? 0.9 : null,
            inputSha256: row.risk_input_sha256,
            modelSha256: options.expectedModelSha256,
            protocolSha256: options.protocolSha256,
            calibrationSha256: options.expectedCalibrationSha256,
            minimumAllowScore: options.expectedMinimumAllowScore,
            policySha256: row.policy_sha256,
          };
          return {
            id: row.id,
            groupId: row.group_id,
            family: row.family,
            operationSha256: row.operation_sha256,
            routing: row.routing,
            expected: row.expected === "hard_block" ? "block" : "allow",
            baseline: actual,
            actual,
            elapsedMs: 10,
            modelCalls: eligible ? 1 : 0,
            modelAnswered: eligible,
            modelEligible: eligible,
            source,
            policyFloor: false,
            effectivePolicySha256: row.policy_sha256,
            inputSha256: row.risk_input_sha256,
            prediction: eligible ? "allow" : null,
            allowScore: eligible ? 0.9 : null,
            comparison,
            ...(row.routing === "pre_model_fallback"
              ? {
                  fallbackReason: row.reason,
                  hostReason: "exact_policy_constraint",
                }
              : {}),
          };
        }),
      };
    },
  };
  const options = {
    handoff: resolve(local, "local-checkpoint-handoff.json"),
    cudaRun: cuda,
    q8Manifest: quantizationPath,
    q8Registry,
    precisionQ8: resolve(local, "precision-q8.json"),
    quantizerBinary: quantizer,
    nativeBinary: native,
    sfDeps: resolve(temp, "synthetic-host-deps"),
    format: "f16",
  };
  const assemble = () =>
    assembleC11Manifest(options, {
      pin,
      document,
      bytes: async (path) => {
        reads.push(path);
        if (!buffers.has(path))
          throw Error("Unexpected synthetic raw read: " + path);
        return buffers.get(path);
      },
    });
  return {
    temp,
    local,
    cuda,
    options,
    assemble,
    evaluator,
    put,
    pin,
    document,
    documents,
    buffers,
    pins,
    reads,
    run,
    imported,
    receipt,
    source,
    launch,
    snapshot,
    memory,
    handoff,
    quantization,
    f16Proof,
    q8Proof,
    localRows,
    setVeto: () => {
      veto = true;
    },
    failNativeAt: (call) => {
      failNativeAt = call;
    },
    counters: () => ({ nativeCalls, replayCalls }),
    cleanup: () => rm(temp, { recursive: true, force: true }),
  };
}

async function withFixture(fn, step) {
  const f = await fixture(step);
  try {
    await fn(f);
  } finally {
    await f.cleanup();
  }
}

const q8Inputs = ["q8Manifest", "q8Registry", "precisionQ8", "quantizerBinary"];
const q8FileNames = [
  "precisionQ8",
  "modelQ8",
  "quantizationManifest",
  "quantizerBinary",
  "registryQ8",
];
async function removeUnselectedQ8(f) {
  const inputs = Object.fromEntries(
    q8Inputs.map((name) => [name, f.options[name]]),
  );
  const paths = [...Object.values(inputs), f.quantization.output.file];
  for (const name of q8Inputs) delete f.options[name];
  for (const path of paths) {
    f.documents.delete(path);
    f.buffers.delete(path);
    f.pins.delete(path);
    await rm(path, { force: true });
  }
  f.evaluator.verifyQuantizerRuntime = async () => {
    throw Error("Absent Q8 must not inspect a quantizer");
  };
  return { inputs, paths };
}

test("selected C11 F16 assembles and formally scores with genuinely absent Q8 evidence", async () => {
  await withFixture(async (f) => {
    const { paths } = await removeUnselectedQ8(f);
    const manifest = await f.assemble();
    validateC11Manifest(manifest);
    for (const name of q8FileNames)
      assert.equal(Object.hasOwn(manifest.files, name), false);
    const result = await evaluateC11(
      manifest,
      resolve(f.temp, "f16-only"),
      f.evaluator,
    );
    assert.equal(
      result.status,
      "valid_pass_test_and_hook_pending",
      result.failures.join("\n"),
    );
    assert.equal(result.precisionOutcomes.f16.passed, true);
    assert.deepEqual(result.precisionOutcomes.q8_0, {
      passed: false,
      reason: "unselected Q8 evidence absent; no attempt supplied",
    });
    assert.equal(Object.hasOwn(result.precisionChecks, "q8_0"), false);
    assert.equal(result.qualified, false);
    assert.equal(result.heldOutTestRead, false);
    assert.deepEqual(f.counters(), { nativeCalls: 42, replayCalls: 1 });
    for (const path of paths) assert.equal(f.reads.includes(path), false);
  }, 256);
});

test("C11 CAL keeps the failed row and scores later rows on a fresh native worker", async () => {
  await withFixture(async (f) => {
    await removeUnselectedQ8(f);
    const manifest = await f.assemble();
    f.failNativeAt(2);
    const result = await evaluateC11Diagnostic(
      manifest,
      resolve(f.temp, "worker-recovery"),
      f.evaluator,
    );
    assert.equal(result.status, "diagnostic_valid_complete");
    assert.equal(result.calibration.records.length, 42);
    assert.equal(result.calibration.records[1].modelAnswered, false);
    assert.match(
      result.calibration.records[1].error,
      /synthetic native request deadline/,
    );
    assert.equal(result.calibration.records[2].modelAnswered, true);
    assert.equal(result.calibration.records[41].modelAnswered, true);
    assert.deepEqual(f.counters(), { nativeCalls: 42, replayCalls: 1 });
  }, 256);
});

test("absent-Q8 F16 preserves formal CAL veto and fixed-.5 unqualified diagnostic VALID", async () => {
  await withFixture(async (f) => {
    await removeUnselectedQ8(f);
    const manifest = await f.assemble();
    f.setVeto();
    f.reads.length = 0;
    const formal = await evaluateC11(
      manifest,
      resolve(f.temp, "f16-only-formal"),
      f.evaluator,
    );
    assert.equal(formal.status, "rejected_cal", formal.failures.join("\n"));
    assert.equal(formal.validation, undefined);
    assert.equal(f.counters().replayCalls, 0);
    for (const identity of Object.values(manifest.valid))
      assert.equal(f.reads.includes(identity.path), false);
    const diagnostic = await evaluateC11Diagnostic(
      manifest,
      resolve(f.temp, "f16-only-diagnostic"),
      f.evaluator,
    );
    assert.equal(
      diagnostic.status,
      "diagnostic_valid_complete",
      diagnostic.failures.join("\n"),
    );
    assert.equal(diagnostic.selection.accepted, false);
    for (const report of [diagnostic, diagnostic.validation]) {
      assert.equal(report.diagnosticOnly, true);
      assert.equal(report.enforcementEligible, false);
      assert.equal(report.candidateAdmission, false);
      assert.equal(report.fixedDiagnosticMinimumAllowScore, 0.5);
    }
    assert.equal(diagnostic.qualified, false);
  }, 256);
});

test("partial or type-invalid Q8 inputs/pins reject instead of becoming absent unselected Q8", async () => {
  for (const name of q8Inputs)
    await withFixture(async (f) => {
      const { inputs } = await removeUnselectedQ8(f);
      f.options[name] = inputs[name];
      await assert.rejects(f.assemble(), /Required absolute --/);
      assert.equal(f.counters().nativeCalls, 0);
    }, 256);
  for (const name of q8FileNames)
    await withFixture(async (f) => {
      const complete = await f.assemble();
      await removeUnselectedQ8(f);
      const manifest = await f.assemble();
      manifest.files[name] = complete.files[name];
      assert.throws(
        () => validateC11Manifest(manifest),
        /Q8 evidence must be complete/,
      );
      manifest.files[name] = null;
      assert.throws(
        () => validateC11Manifest(manifest),
        /Q8 evidence must be complete/,
      );
      assert.equal(f.counters().nativeCalls, 0);
    }, 256);
  await withFixture(async (f) => {
    await removeUnselectedQ8(f);
    f.options.q8Manifest = undefined;
    await assert.rejects(f.assemble(), /Required absolute --q8-manifest/);
  }, 256);
});

test("absent-Q8 F16 still requires full source/import/327 FIT proof/model/native/registry/artifact and host seals", async () => {
  const mutations = [
    (f) => {
      f.f16Proof.answered = 326;
      f.f16Proof.records.pop();
    },
    (f) => {
      f.f16Proof.records[0].sourceId = f.f16Proof.records[1].sourceId;
    },
    (f) => {
      f.f16Proof.records[0].referenceMargin = 2;
    },
    (f) => {
      f.f16Proof.nativeBinarySha256 = "a".repeat(64);
    },
    (f) => {
      f.f16Proof.modelSha256 = "a".repeat(64);
    },
    (f) => {
      f.imported.reload_verified = false;
      f.run.training.reload_verified = false;
    },
    (f) => {
      f.documents.get(
        resolve(f.local, "adapter/cuda-import-equivalence.json"),
      ).rows = 326;
    },
    (f, manifest) => {
      f.documents.get(manifest.files.baselineFreeze.path).host.baselineSha256 =
        "a".repeat(64);
    },
    (f, manifest) => {
      manifest.files.model.sha256 = "a".repeat(64);
    },
    (f, manifest) => {
      manifest.files.nativeBinary.sha256 = "a".repeat(64);
    },
    (f, manifest) => {
      manifest.runtime["dist/backend.js"] = "a".repeat(64);
    },
    (f, manifest) => {
      f.documents.get(manifest.files.artifact.path).file = resolve(
        f.local,
        "foreign-f16.gguf",
      );
    },
    async (f, manifest) => {
      const path = manifest.files.registry.path;
      const registry = JSON.parse(await readFile(path));
      registry.artifacts[0].training_run = "foreign-run";
      await writeFile(path, encode(registry));
      manifest.files.registry = f.put(path, registry);
    },
  ];
  for (const mutate of mutations)
    await withFixture(async (f) => {
      await removeUnselectedQ8(f);
      const manifest = await f.assemble();
      await mutate(f, manifest);
      for (const name of [
        "precisionF16",
        "importReport",
        "runManifest",
        "localPrecision",
        "artifact",
      ]) {
        const path = manifest.files[name].path;
        manifest.files[name] = f.put(path, f.documents.get(path));
      }
      const result = await evaluateC11(
        manifest,
        resolve(f.temp, "invalid-f16-only"),
        f.evaluator,
      );
      assert.equal(
        result.status,
        "failed",
        "required F16 proof/seal mutation must reject",
      );
      assert.equal(f.counters().nativeCalls, 0);
    }, 256);
  for (const name of [
    "precisionF16",
    "modelF16",
    "registry",
    "artifact",
    "sourceReceipt",
    "sourceLaunch",
    "importReport",
    "localFitMargins",
    "nativeBinary",
    "baselineFreeze",
  ])
    await withFixture(async (f) => {
      await removeUnselectedQ8(f);
      const manifest = await f.assemble();
      delete manifest.files[name];
      assert.throws(() => validateC11Manifest(manifest), /pins/);
    }, 256);
});

test("C10 F16 and selected C11 Q8 retain strict complete-Q8 requirements", async () => {
  await withFixture(async (f) => {
    const complete = await f.assemble();
    const c10 = structuredClone(complete);
    c10.purpose = "candidate10_native_evaluation";
    c10.files.campaign.sha256 = C10_CAMPAIGN_SHA256;
    validateC10Manifest(c10);
    await removeUnselectedQ8(f);
    const manifest = await f.assemble();
    for (const name of q8FileNames) delete c10.files[name];
    assert.throws(() => validateC10Manifest(c10), /pins/);
    await assert.rejects(
      assembleC10Manifest(f.options),
      /Required absolute --q8-manifest/,
    );
    f.options.format = "q8_0";
    await assert.rejects(f.assemble(), /Required absolute --q8-manifest/);
    manifest.format = "q8_0";
    assert.throws(
      () => validateC11Manifest(manifest),
      /Q8 evidence must be complete/,
    );
  }, 256);
  await withFixture(async (f) => {
    f.options.format = "q8_0";
    const manifest = await f.assemble();
    const result = await evaluateC11(
      manifest,
      resolve(f.temp, "failed-selected-q8"),
      f.evaluator,
    );
    assert.equal(result.status, "failed");
    assert.match(result.failures[0], /selected export failed/);
    assert.equal(f.counters().nativeCalls, 0);
  }, 256);
});

test("C11 linked manifest → CAL → sealed VALID uses genuine export verification and retains failed Q8 independently", async () => {
  await withFixture(async (f) => {
    const manifest = await f.assemble();
    validateC11Manifest(manifest);
    assert.throws(() => validateC10Manifest(manifest), /pins/);
    assert.equal(f.run.training.fusion.fusion_dtype, "float32");
    const result = await evaluateC11(
      manifest,
      resolve(f.temp, "result"),
      f.evaluator,
    );
    assert.equal(
      result.status,
      "valid_pass_test_and_hook_pending",
      result.failures.join("\n"),
    );
    assert.equal(result.precisionOutcomes.f16.passed, true);
    assert.equal(result.precisionOutcomes.q8_0.passed, false);
    assert.equal(result.qualified, false);
    assert.equal(result.validation.fullAccuracy, 1);
    assert.equal(result.validation.modelEligibleAccuracy, 1);
    assert.equal(result.validation.source.minimumAllowScore, 0.5);
    assert.deepEqual(f.counters(), { nativeCalls: 42, replayCalls: 1 });
    assert.deepEqual(
      JSON.parse(await readFile(resolve(f.temp, "result/evaluation.json"))),
      result,
    );
  });
});

test("formal CAL veto opens zero VALID pins; separate fixed-.5 diagnostic keeps all admission flags false", async () => {
  await withFixture(async (f) => {
    const manifest = await f.assemble();
    f.setVeto();
    f.reads.length = 0;
    const formal = await evaluateC11(
      manifest,
      resolve(f.temp, "formal"),
      f.evaluator,
    );
    assert.equal(formal.status, "rejected_cal", formal.failures.join("\n"));
    assert.equal(formal.selection.accepted, false);
    assert.equal(formal.validation, undefined);
    assert.equal(f.counters().replayCalls, 0);
    for (const pin of Object.values(manifest.valid))
      assert.equal(f.reads.includes(pin.path), false);
    const diagnostic = await evaluateC11Diagnostic(
      manifest,
      resolve(f.temp, "diagnostic"),
      f.evaluator,
    );
    assert.equal(
      diagnostic.status,
      "diagnostic_valid_complete",
      diagnostic.failures.join("\n"),
    );
    assert.equal(diagnostic.selection.accepted, false);
    for (const proof of [diagnostic, diagnostic.validation]) {
      assert.equal(proof.diagnosticOnly, true);
      assert.equal(proof.enforcementEligible, false);
      assert.equal(proof.candidateAdmission, false);
      assert.equal(proof.fixedDiagnosticMinimumAllowScore, 0.5);
    }
    assert.equal(diagnostic.qualified, false);
    assert.equal(diagnostic.validation.source.minimumAllowScore, 0.5);
  });
});

test("all selected checkpoint metadata keeps derived objective steps1024 and original steps256; missing snapshot rejects", async () => {
  for (const step of [128, 256, 512, 1024])
    await withFixture(async (f) => {
      const manifest = await f.assemble();
      assert.equal(manifest.checkpoint, step);
      assert.equal(f.source.objective.steps, 1024);
      assert.equal(f.source.source_objective_plan.steps, 256);
      f.documents.delete(resolve(f.cuda, "memory.snapshot.json"));
      await assert.rejects(
        f.assemble(),
        /snapshot|Unexpected synthetic metadata read/,
      );
    }, step);
});

test("C10 receipt and changed C11 campaign/init/sampler/objectives/code/producer/checkpoint/prepared links fail before scoring", async () => {
  const mutations = [
    (f) => {
      f.source.experiment = "candidate10";
    },
    (f) => {
      f.source.campaign_sha256 = "a".repeat(64);
    },
    (f) => {
      f.source.campaign = { ...f.source.campaign, seed: 43 };
    },
    (f) => {
      f.source.initialization = "resume_previous_adapter";
    },
    (f) => {
      f.source.sampler_source_sha256 = "a".repeat(64);
    },
    (f) => {
      f.source.objective = { ...f.source.objective, steps: 128 };
    },
    (f) => {
      f.source.source_objective_plan = {
        ...f.source.source_objective_plan,
        steps: 1024,
      };
    },
    (f) => {
      f.source.contract_sha256 = "a".repeat(64);
    },
    (f) => {
      f.imported.local_architecture.helper_sha256 = "a".repeat(64);
    },
    (f) => {
      f.source.inputs.train = fitSha;
    },
    (f) => {
      f.source.inputs.plan = "a".repeat(64);
    },
    (f) => {
      f.source.steps = 256;
    },
    (f) => {
      f.launch.launcher_sha256 = "a".repeat(64);
    },
    (f) => {
      f.launch.code_sha256 = {
        ...f.launch.code_sha256,
        "c11_fit_sampler.py": "a".repeat(64),
      };
    },
    (f) => {
      f.snapshot.producer_sha256 = "a".repeat(64);
    },
    (f) => {
      f.snapshot.checkpoint_receipt_sha256 = "a".repeat(64);
    },
    (f) => {
      f.run.training.extra = "not fusion";
    },
    (f) => {
      f.run.training.ok = false;
    },
    (f) => {
      f.run.training.fusion.fusion_dtype = "float16";
    },
    (f) => {
      f.snapshot.checkpoint_step = 256;
    },
  ];
  for (const mutate of mutations)
    await withFixture(async (f) => {
      mutate(f);
      await assert.rejects(f.assemble(), /identity|changed|bound/);
      assert.equal(f.counters().nativeCalls, 0);
    });
  for (const mutate of [
    (f) => {
      f.run.source.sha256 = trainSha;
    },
    (f) => {
      f.run.prepared.dataset_sha256 = trainSha;
    },
  ])
    await withFixture(async (f) => {
      const manifest = await f.assemble();
      mutate(f);
      f.put(resolve(f.local, "manifest.json"), f.run);
      manifest.files.runManifest.sha256 = f.pins.get(
        resolve(f.local, "manifest.json"),
      );
      const result = await evaluateC11(
        manifest,
        resolve(f.temp, "bad"),
        f.evaluator,
      );
      assert.equal(result.status, "failed");
      assert.match(result.failures[0], /FIT source|prepared TRAIN/);
      assert.equal(f.counters().nativeCalls, 0);
    });
});

test("failed Q8 provenance drift, duplicate or nonfinite margins, and duplicate local margins invalidate F16 handoff", async () => {
  for (const mutate of [
    (f) => {
      f.q8Proof.modelSha256 = "a".repeat(64);
    },
    (f) => {
      f.q8Proof.purpose = "different_precision";
    },
    (f) => {
      f.q8Proof.records[0].sourceId = f.q8Proof.records[1].sourceId;
    },
    (f) => {
      f.q8Proof.records[0].margin = null;
    },
    (f) => {
      f.q8Proof.decisiveSignFlips = 0;
    },
    (f) => {
      f.quantization.purpose = "candidate10_fit_only_q8_derivation";
    },
    (f) => {
      f.quantization.output.training_run = "different-run";
    },
    (f) => {
      f.quantization.output.registrySha256 = "a".repeat(64);
    },
    (f) => {
      f.quantization.sourceCheckpoint.runtime["rfdt/cuda_campaign_launch.py"] =
        "a".repeat(64);
    },
  ])
    await withFixture(async (f) => {
      const manifest = await f.assemble();
      mutate(f);
      for (const name of ["precisionQ8", "quantizationManifest"]) {
        const path = manifest.files[name].path;
        f.put(path, f.documents.get(path));
        manifest.files[name].sha256 = f.pins.get(path);
      }
      const result = await evaluateC11(
        manifest,
        resolve(f.temp, "bad"),
        f.evaluator,
      );
      assert.equal(
        result.status,
        "failed",
        "wrong Q8 provenance must invalidate selected F16",
      );
      assert.equal(f.counters().nativeCalls, 0);
    });
  await withFixture(async (f) => {
    const manifest = await f.assemble();
    f.localRows.push(f.localRows[0]);
    const pin = f.put(manifest.files.localFitMargins.path, jsonl(f.localRows));
    manifest.files.localFitMargins = pin;
    f.imported.local_fit_margins_sha256 = pin.sha256;
    f.run.training.local_fit_margins_sha256 = pin.sha256;
    const importedPin = f.put(manifest.files.importReport.path, f.imported),
      runPin = f.put(manifest.files.runManifest.path, f.run);
    manifest.files.importReport = importedPin;
    manifest.files.runManifest = runPin;
    const result = await evaluateC11(
      manifest,
      resolve(f.temp, "duplicate"),
      f.evaluator,
    );
    assert.equal(result.status, "failed");
    assert.match(result.failures[0], /margin inventory/);
    assert.equal(f.counters().nativeCalls, 0);
  });
});

test("truthful partial failed Q8 report stays independent of passing F16", async () => {
  await withFixture(async (f) => {
    const manifest = await f.assemble();
    f.q8Proof.records = f.q8Proof.records.slice(0, 3);
    f.q8Proof.answered = 3;
    f.q8Proof.failure = "synthetic scorer stopped after three rows";
    f.q8Proof.decisiveSignFlips = 3;
    const pin = f.put(manifest.files.precisionQ8.path, f.q8Proof);
    manifest.files.precisionQ8 = pin;
    const result = await evaluateC11(
      manifest,
      resolve(f.temp, "partial"),
      f.evaluator,
    );
    assert.equal(
      result.status,
      "valid_pass_test_and_hook_pending",
      result.failures.join("\n"),
    );
    assert.equal(result.precisionOutcomes.q8_0.passed, false);
  });
});

async function q8Mocks(f, failPrecision = false) {
  const outputs = new Map(),
    calls = [];
  const deps = {
    readFile: async (path, encoding) => {
      if (f.buffers.has(path))
        return encoding ? f.buffers.get(path).toString() : f.buffers.get(path);
      // Only frozen profile metadata and synthetic regular exports may fall through.
      assert.ok(
        path.startsWith(resolve(root, "fixtures/guardrail/candidate")) ||
          path.startsWith(f.temp),
      );
      return readFile(path, encoding);
    },
    writeFile: async (path, bytes) => {
      assert.equal(outputs.has(path), false);
      outputs.set(path, Buffer.from(bytes));
    },
    access: async () => {
      throw Object.assign(Error("fresh mocked Q8 output"), { code: "ENOENT" });
    },
    hashArtifact: async (path) => {
      if (path === f.run.prepared.files.train)
        return { sha256: trainSha, size: 1 };
      if (path === f.options.quantizerBinary)
        return { sha256: quantizerSha, size: 1 };
      if (outputs.has(path))
        return {
          sha256: sha(outputs.get(path)),
          size: outputs.get(path).length,
        };
      return hashArtifact(path);
    },
    execFileSync: (_cmd, args) =>
      args.includes("rev-parse")
        ? "f072b103714dfa1eee531f80b24512faf38e3dd2\n"
        : "",
    inspectQuantizerLibraries: async () => ({
      runtimeLibraries: {},
      runtimeLibraryLinks: {},
    }),
    child: async (command, args) => {
      calls.push({ command, args });
      if (command === f.options.quantizerBinary)
        outputs.set(args[2], Buffer.from("GGUF synthetic derived Q8"));
      else {
        outputs.set(
          resolve(f.local, "precision-q8.json"),
          encode({ synthetic: true, ok: !failPrecision }),
        );
        if (failPrecision)
          throw Error("synthetic precision failure after retained report");
      }
    },
  };
  const args = [
    "--run",
    f.local,
    "--native-binary",
    f.options.nativeBinary,
    "--quantizer-binary",
    f.options.quantizerBinary,
    "--quantizer-source",
    resolve(f.temp, "mock-quantizer-source"),
  ];
  return { outputs, calls, deps, args };
}

test("executable C11 Q8 uses full F16 proof before any child and preserves reports before precision failure", async () => {
  await withFixture(async (f) => {
    const q = await q8Mocks(f, true);
    await assert.rejects(
      runC11Q8(q.args, q.deps),
      /precision failure after retained report/,
    );
    assert.equal(q.calls.length, 2);
    const quantization = JSON.parse(
      q.outputs.get(resolve(f.local, "candidate11-q8-manifest.json")),
    );
    assert.equal(quantization.purpose, "candidate11_fit_only_q8_derivation");
    assert.equal(
      quantization.sourceCheckpoint.campaignSha256,
      C11_CAMPAIGN_SHA256,
    );
    assert.equal(quantization.quantizer.leaveOutputTensorUnquantized, true);
    assert.ok(q.outputs.has(resolve(f.local, "precision-q8.json")));
  });
  for (const mutate of [
    (f) => {
      f.f16Proof.records[0].sourceId = f.f16Proof.records[1].sourceId;
    },
    (f) => {
      f.f16Proof.nativeBinarySha256 = "a".repeat(64);
    },
    (f) => {
      f.f16Proof.maxProbabilityDelta = 0.001;
    },
    (f) => {
      f.handoff.purpose = "candidate10_local_checkpoint_handoff";
    },
  ])
    await withFixture(async (f) => {
      mutate(f);
      f.put(resolve(f.local, "precision-f16.json"), f.f16Proof);
      f.put(f.options.handoff, f.handoff);
      const q = await q8Mocks(f);
      await assert.rejects(runC11Q8(q.args, q.deps), /proof|tampering|handoff/);
      assert.equal(q.calls.length, 0);
      assert.equal(q.outputs.size, 0);
    });
});

test("C11 pinned null/false launch or snapshot cannot bypass historical provenance; consistently repinned wrong quantizer rejects", async () => {
  for (const name of ["launch.json", "memory.snapshot.json"])
    for (const value of [null, false])
      await withFixture(async (f) => {
        f.put(resolve(f.cuda, name), value);
        await assert.rejects(f.assemble(), /provenance missing or changed/);
      });
  await withFixture(async (f) => {
    const manifest = await f.assemble();
    manifest.files.quantizerBinary.sha256 = "a".repeat(64);
    f.quantization.quantizer.binarySha256 = "a".repeat(64);
    assert.throws(() => validateC11Manifest(manifest), /pins/);
  });
});

async function finalFixture() {
  const f = await fixture(1024);
  Object.assign(f.source, { budget_bytes: 8e9, allocator_cap_bytes: 6.5e9 });
  Object.assign(f.receipt, {
    pre_step_placement: { parameters: 444, buffers: 5, gradients: 104 },
    post_step_placement: {
      parameters: 444,
      buffers: 5,
      gradients: 0,
      optimizer_tensors: 208,
    },
    memory: { peak_reserved_bytes: 2.5e9 },
  });
  const historicRoot = "/synthetic/c11-root",
    historicInputs = "/synthetic/c11-inputs",
    python = "/synthetic/python";
  const code = resolve(historicInputs, "code"),
    run = resolve(historicRoot, "run");
  Object.assign(f.launch, {
    run_root: historicRoot,
    inputs: historicInputs,
    watchdog_pid: 122,
    started_at: "1970-01-01T00:00:10+00:00",
    baseline_dedicated_bytes: 500,
    baseline_shared_bytes: 100,
  });
  f.launch.worker_command = [
    python,
    resolve(code, "c11_cuda_campaign.py"),
    "--campaign",
    resolve(code, "cuda-campaign.json"),
    "--mode",
    "train",
    "--base",
    resolve(historicInputs, "base"),
    "--train",
    resolve(historicInputs, "fit/prepared-train.jsonl"),
    "--pairs",
    resolve(historicInputs, "fit/pairs.json"),
    "--pairs-sha256",
    f.source.inputs.pairs,
    "--families",
    resolve(historicInputs, "fit/families.json"),
    "--families-sha256",
    f.source.inputs.families,
    "--plan",
    resolve(code, "objective-plan-B.json"),
    "--plan-sha256",
    f.source.inputs.plan,
    "--output",
    run,
    "--steps",
    "1024",
    "--budget-bytes",
    "8000000000",
    "--allocator-cap-bytes",
    "6500000000",
  ];
  f.launch.watchdog_command = [
    python,
    resolve(code, "cuda_memory_monitor.py"),
    "--pid-file",
    resolve(historicRoot, "worker.pid"),
    "--worker",
    resolve(code, "c11_cuda_campaign.py"),
    "--run-dir",
    run,
    "--output",
    resolve(historicRoot, "memory.jsonl"),
    "--adapter-tag",
    "synthetic",
    "--baseline-dedicated-bytes",
    "500",
    "--baseline-shared-bytes",
    "100",
    "--hard-budget-bytes",
    "8000000000",
    "--stop-dedicated-delta-bytes",
    "7500000000",
    "--shared-growth-limit-bytes",
    "128000000",
    "--stop-total-dedicated-bytes",
    "16000000000",
    "--interval-seconds",
    "2",
  ];
  Object.assign(f.memory, {
    reason: "worker_exit",
    worker_pid: f.launch.worker_pid,
    samples: 2,
    sampling_interval_seconds: 2,
    hard_budget_bytes: 8e9,
    stop_dedicated_delta_bytes: 7.5e9,
    shared_growth_limit_bytes: 128e6,
    stop_total_dedicated_bytes: 16e9,
    peak_total_dedicated_bytes: 1000,
    peak_dedicated_delta_bytes: 500,
    peak_shared_delta_bytes: 100,
  });
  const journal = [11, 12].map((time) => ({
    time_unix: time,
    elapsed_seconds: time - 10,
    dedicated_bytes: 1000,
    shared_bytes: 200,
    dedicated_delta_bytes: 500,
    shared_delta_bytes: 100,
  }));
  const guardian = [
    {
      status: "watching",
      worker_pid: f.launch.worker_pid,
      watchdog_pid: f.launch.watchdog_pid,
      worker_start_ticks: 12345,
      watchdog_start_ticks: 12345,
      time_unix: 10.5,
    },
    {
      status: "healthy",
      journalAgeSeconds: 0.5,
      sample: journal.at(-1),
      time_unix: 12.5,
    },
    { status: "worker_exit", worker_pid: f.launch.worker_pid, time_unix: 14 },
  ];
  const exit = { ok: true, steps_completed: 1024, elapsed_seconds: 3.5 };
  const checkpointExit = {
    ok: true,
    steps_completed: 1024,
    completed_time_unix: 13,
  };
  const paths = {
    sourceLaunch: resolve(f.cuda, "launch.json"),
    sourceExit: resolve(f.cuda, "run/exit.json"),
    sourceCheckpointExit: resolve(
      f.cuda,
      "run/checkpoints/step-1024/exit.json",
    ),
    sourceMemory: resolve(f.cuda, "memory.summary.json"),
    sourceMemoryJournal: resolve(f.cuda, "memory.jsonl"),
    sourceGuardian: resolve(f.cuda, "root-guardian.jsonl"),
  };
  const persist = () => {
    f.put(paths.sourceLaunch, f.launch);
    f.put(paths.sourceExit, exit);
    f.put(paths.sourceCheckpointExit, checkpointExit);
    f.put(paths.sourceMemory, f.memory);
    f.put(paths.sourceMemoryJournal, jsonl(journal));
    f.put(paths.sourceGuardian, jsonl(guardian));
  };
  const seal = async () => {
    persist();
    f.imported.final_envelope_sha256 = Object.fromEntries(
      Object.entries(paths).map(([name, path]) => [name, f.pins.get(path)]),
    );
    f.run.training.final_envelope_sha256 = f.imported.final_envelope_sha256;
    f.imported.cuda_receipt_sha256 = f.put(
      resolve(f.cuda, "run/receipt.json"),
      f.receipt,
    ).sha256;
    f.run.training.cuda_receipt_sha256 = f.imported.cuda_receipt_sha256;
    f.quantization.sourceCheckpoint = c11Q8SourceIdentity(
      f.run,
      f.imported,
      C11_SOURCE_RUNTIME,
    );
    f.put(f.options.q8Manifest, f.quantization);
    f.put(resolve(f.local, "adapter/cuda-import-report.json"), f.imported);
    f.put(resolve(f.local, "manifest.json"), f.run);
    await writeFile(resolve(f.local, "manifest.json"), encode(f.run));
  };
  await seal();
  return Object.assign(f, {
    finalJournal: journal,
    guardian,
    finalExit: exit,
    checkpointExit,
    finalPaths: paths,
    persist,
    seal,
  });
}
async function withFinal(fn) {
  const f = await finalFixture();
  try {
    await fn(f);
  } finally {
    await f.cleanup();
  }
}

test("genuine-shaped final C11 worker_exit → manifest → formal scorer passes without a post-completion sample", async () => {
  await withFinal(async (f) => {
    assert.ok(
      f.finalJournal.at(-1).time_unix < f.checkpointExit.completed_time_unix,
    );
    const manifest = await f.assemble();
    validateC11Manifest(manifest);
    assert.equal(manifest.files.sourceSnapshot, undefined);
    for (const name of Object.keys(f.finalPaths))
      assert.equal(
        f.imported.final_envelope_sha256[name],
        manifest.files[name].sha256,
      );
    const report = await evaluateC11(
      manifest,
      resolve(f.temp, "final-result"),
      f.evaluator,
    );
    assert.equal(
      report.status,
      "valid_pass_test_and_hook_pending",
      report.failures.join("\n"),
    );
    assert.equal(report.precisionOutcomes.f16.passed, true);
    assert.equal(report.precisionOutcomes.q8_0.passed, false);
    assert.equal(report.qualified, false);
    assert.equal(report.heldOutTestRead, false);
  });
});

test("final C11 accepts a genuine in-flight monitor row after guard worker exit; guardian does not prove monitor exit", async () => {
  await withFinal(async (f) => {
    f.finalJournal.push({
      ...f.finalJournal.at(-1),
      time_unix: 15,
      elapsed_seconds: 5,
    });
    f.memory.samples = 3;
    await f.seal();
    const manifest = await f.assemble();
    const report = await evaluateC11(
      manifest,
      resolve(f.temp, "inflight"),
      f.evaluator,
    );
    assert.equal(
      report.status,
      "valid_pass_test_and_hook_pending",
      report.failures.join("\n"),
    );
  });
});

test("final C11 rejects nonfinal/unfinished/missing exit or identity and journal/budget changes before native calls", async () => {
  const mutations = [
    (f) => {
      f.handoff.checkpoint = 512;
    },
    (f) => {
      f.finalExit.ok = false;
    },
    (f) => {
      f.finalExit.steps_completed = 512;
    },
    (f) => {
      f.finalExit.elapsed_seconds = null;
    },
    (f) => {
      f.checkpointExit.steps_completed = 512;
    },
    (f) => {
      f.checkpointExit.completed_time_unix = 15;
    },
    (f) => {
      f.launch.worker_command[1] = "/other/worker.py";
    },
    (f) => {
      f.launch.watchdog_command[1] = "/other/monitor.py";
    },
    (f) => {
      f.launch.launcher_sha256 = "a".repeat(64);
    },
    (f) => {
      f.launch.started_at = "1970-01-01T00:00:10";
    },
    (f) => {
      f.memory.worker_pid = true;
    },
    (f) => {
      f.memory.samples = 3;
    },
    (f) => {
      f.memory.peak_shared_delta_bytes = 99;
    },
    (f) => {
      f.memory.stop_total_dedicated_bytes = 16e9 + 1;
    },
    (f) => {
      f.guardian[0].worker_start_ticks = 0;
    },
    (f) => {
      f.guardian[0].watchdog_pid = f.launch.worker_pid;
    },
    (f) => {
      f.guardian[1].status = "stop";
    },
    (f) => {
      f.guardian[1].sample = { ...f.finalJournal[1], dedicated_bytes: 999 };
    },
    (f) => {
      f.guardian[2].worker_pid = 999;
    },
    (f) => {
      f.guardian.push({ ...f.guardian[2], time_unix: 15 });
    },
    (f) => {
      f.finalJournal[1].elapsed_seconds = 0;
    },
    (f) => {
      f.finalJournal[1].shared_bytes = null;
    },
    (f) => {
      f.finalJournal[1].monitor_error = "synthetic";
    },
    (f) => {
      for (const row of f.finalJournal) {
        row.dedicated_bytes = 16e9;
        row.dedicated_delta_bytes = 16e9 - 500;
      }
      f.memory.peak_total_dedicated_bytes = 16e9;
      f.memory.peak_dedicated_delta_bytes = 16e9 - 500;
    },
  ];
  for (const mutate of mutations)
    await withFinal(async (f) => {
      mutate(f);
      await f.seal();
      await assert.rejects(
        f.assemble(),
        /C11|checkpoint|identity|changed|genuine|worker_exit/,
      );
      assert.equal(f.counters().nativeCalls, 0);
    });
  for (const name of [
    "sourceGuardian",
    "sourceMemoryJournal",
    "sourceCheckpointExit",
    "sourceExit",
  ])
    await withFinal(async (f) => {
      f.buffers.delete(f.finalPaths[name]);
      f.documents.delete(f.finalPaths[name]);
      await assert.rejects(f.assemble(), /Unexpected synthetic/);
    });
});

test("final imported digest links reject missing/type-invalid or otherwise-valid repinned evidence before scoring", async () => {
  for (const name of [
    "sourceLaunch",
    "sourceExit",
    "sourceCheckpointExit",
    "sourceMemory",
    "sourceMemoryJournal",
    "sourceGuardian",
  ])
    await withFinal(async (f) => {
      const manifest = await f.assemble();
      const original = f.buffers.get(f.finalPaths[name]);
      f.put(f.finalPaths[name], Buffer.concat([original, Buffer.from("\n")]));
      manifest.files[name].sha256 = f.pins.get(f.finalPaths[name]);
      const report = await evaluateC11(
        manifest,
        resolve(f.temp, "repinned"),
        f.evaluator,
      );
      assert.equal(report.status, "failed");
      assert.match(report.failures[0], /digest links/);
      assert.equal(f.counters().nativeCalls, 0);
    });
  for (const value of [undefined, {}, false, { sourceGuardian: 1 }])
    await withFinal(async (f) => {
      if (value === undefined) {
        delete f.imported.final_envelope_sha256;
        delete f.run.training.final_envelope_sha256;
      } else {
        f.imported.final_envelope_sha256 = value;
        f.run.training.final_envelope_sha256 = value;
      }
      await assert.rejects(f.assemble(), /digest links/);
    });
  await withFinal(async (f) => {
    const manifest = await f.assemble();
    f.guardian[0].worker_start_ticks++;
    f.persist();
    manifest.files.sourceGuardian.sha256 = f.pins.get(
      f.finalPaths.sourceGuardian,
    );
    const report = await evaluateC11(
      manifest,
      resolve(f.temp, "birth-drift"),
      f.evaluator,
    );
    assert.equal(report.status, "failed");
    assert.match(report.failures[0], /digest links/);
  });
});
