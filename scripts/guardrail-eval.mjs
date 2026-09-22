import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Classifier, NativeBackend, configFromEnv } from "../dist/backend.js";
import { canonical } from "../dist/core.js";
import { verifyArtifact, hashArtifact } from "../dist/models.js";
import {
  classifyGuardrailRisk,
  GUARDRAIL_PROTOCOL_SHA256,
} from "../dist/guardrail.js";
import {
  qualifyGuardrail,
  freezeGuardrailCandidate,
  assertGuardrailFreeze,
  guardrailBridgeProvenance,
  GUARDRAIL_BRIDGE_EXPORTER_SOURCE,
} from "../dist/guardrail-evaluation.js";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    bundle: { type: "string" },
    registry: { type: "string" },
    model: { type: "string" },
    file: { type: "string" },
    output: { type: "string" },
    split: { type: "string", default: "validation" },
    freeze: { type: "string" },
    validation: { type: "string" },
    sfRoot: { type: "string" },
  },
});
const save = async (path, value, exclusive = true) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    ...(exclusive ? { flag: "wx" } : {}),
  });
};
const digest = (value) =>
  createHash("sha256").update(canonical(value)).digest("hex");
if (!values.bundle || !values.output)
  throw new Error("--bundle and --output required");
const bundle = JSON.parse(await readFile(resolve(values.bundle)));
const bridgeProvenance = async () => {
  if (!values.sfRoot)
    throw new Error(
      "--sfRoot SF_PI_ROOT is required to verify the bridge exporter source",
    );
  const exporter = resolve(values.sfRoot, GUARDRAIL_BRIDGE_EXPORTER_SOURCE);
  return guardrailBridgeProvenance(
    bundle,
    (await hashArtifact(exporter)).sha256,
  );
};
const inventory = bundle.records.map((r) => ({
  id: r.id,
  groupId: r.groupId,
  family: r.family,
  split: r.split,
  expected: r.expected,
  baseline: r.baseline,
  policyFloor: r.policyFloor,
  modelEligible: r.modelEligible,
  ...(r.fallbackReason ? { fallbackReason: r.fallbackReason } : {}),
  inputSha256: digest(r.riskInput),
}));
if (positionals[0] === "freeze") {
  if (!values.validation)
    throw new Error(
      "freeze requires --validation FILE from the real SF bridge evaluation",
    );
  const validation = JSON.parse(await readFile(resolve(values.validation)));
  const frozen = freezeGuardrailCandidate(
    validation,
    inventory,
    await bridgeProvenance(),
  );
  await save(resolve(values.output), frozen);
  console.log(
    JSON.stringify({
      phase: "frozen",
      sha256: frozen.sha256,
      modelSha256: frozen.modelSha256,
    }),
  );
} else {
  if (!["validation", "test"].includes(values.split))
    throw new Error("Evaluation split must be validation or test");
  const frozen = values.freeze
    ? JSON.parse(await readFile(resolve(values.freeze)))
    : undefined;
  if (values.split === "test" && !frozen)
    throw new Error(
      "TEST requires prospective --freeze FILE selected with passing validation",
    );
  const config = configFromEnv({
    JEV_DEVICE: "metal",
    JEV_MODEL_ID: values.model ?? "google/gemma-3-1b-it",
    JEV_MODEL_FILE: resolve(
      values.file ?? resolve(root, "models/gemma-3-1b-it-f16.gguf"),
    ),
    JEV_TEMPLATE_VERSION: "v2",
  });
  config.artifactRegistryPath = values.registry
    ? resolve(values.registry)
    : undefined;
  config.requestTimeoutMs = 500;
  config.queueTimeoutMs = 500;
  const artifact = await verifyArtifact(
    config.modelFile,
    "classifier",
    config.modelId,
    { registryPath: config.artifactRegistryPath },
  );
  const nativeBinarySha256 = (await hashArtifact(config.binary)).sha256;
  if (
    frozen &&
    (frozen.modelSha256 !== artifact.sha256 ||
      frozen.protocolSha256 !== GUARDRAIL_PROTOCOL_SHA256 ||
      frozen.corpusSha256 !== bundle.corpusSha256 ||
      frozen.baselineSourceSha256 !== bundle.baselineSourceSha256)
  )
    throw new Error("Frozen candidate or corpus changed");
  const currentBridgeProvenance = frozen ? await bridgeProvenance() : undefined;
  if (frozen)
    assertGuardrailFreeze(
      frozen,
      {
        modelSha256: artifact.sha256,
        corpusSha256: bundle.corpusSha256,
        baselineSourceSha256: bundle.baselineSourceSha256,
        nativeBinarySha256,
      },
      inventory,
      currentBridgeProvenance,
    );
  const backend = new NativeBackend(config),
    classifier = new Classifier(config, backend);
  const cold = performance.now();
  const records = [],
    predictions = [];
  try {
    await backend.warmup();
    const coldInitializationMs = performance.now() - cold;
    for (const row of bundle.records.filter((r) => r.split === values.split)) {
      const started = performance.now();
      let prediction, error;
      if (row.modelEligible)
        try {
          prediction = await classifyGuardrailRisk(
            classifier,
            row.riskInput,
            config.modelId,
          );
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
      const actual =
        row.policyFloor || !row.modelEligible || error
          ? row.baseline
          : prediction.action === "allow"
            ? "allow"
            : "confirm";
      const record = {
        ...inventory.find((r) => r.id === row.id),
        actual,
        modelAnswered: !!prediction,
        elapsedMs: performance.now() - started,
        ...(error ? { error } : {}),
      };
      delete record.split;
      records.push(record);
      predictions.push({
        id: row.id,
        ...prediction,
        ...(error ? { error } : {}),
      });
      if (records.length % 20 === 0)
        console.log(
          JSON.stringify({
            phase: "evaluation",
            split: values.split,
            completed: records.length,
          }),
        );
    }
    const report = qualifyGuardrail(records, {
      split: values.split,
      modelSha256: artifact.sha256,
      corpusSha256: bundle.corpusSha256,
      baselineSourceSha256: bundle.baselineSourceSha256,
      bridgeProvenance: currentBridgeProvenance,
      nativeBinarySha256,
      freeze: frozen,
    });
    // Direct inference is a diagnostic. Enforcement qualification must also run the real SF bridge.
    report.qualified = false;
    report.limitations +=
      " Direct classifier diagnostic: SF bridge preparation, approvals and complete workflows require separate evaluation.";
    await save(resolve(values.output), {
      ...report,
      executionSurface: "direct_classifier",
      coldInitializationMs,
      predictions,
    });
    console.log(
      JSON.stringify({
        phase: "evaluated",
        split: values.split,
        coldInitializationMs,
        metrics: report.metrics,
        gates: report.gates,
        qualified: false,
      }),
    );
  } finally {
    await classifier.dispose();
  }
}
