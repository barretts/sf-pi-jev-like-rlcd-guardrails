import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) =>
  JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.keys(entry)
            .sort()
            .map((key) => [key, entry[key]]),
        )
      : entry,
  );
export const FROZEN_HEAD_SHA256 =
  "6c97fd783d2fd94d631717825923b462e319152bfe30044916be2011c803e84e";
export const LAB_ATTRIBUTION_SHA256 = hash(
  "raw-head LAB diagnostic; not qualification; productionQualified:false",
);
export const DIAGNOSTIC_OPTIONS = Object.freeze({
  population: 60,
  phases: Object.freeze(["cold", "warm-1", "warm-2"]),
  coldRequestMs: 321000,
  warmRequestMs: 15000,
  cleanupMs: 10000,
  jobMs: 1800000,
  serialization: "production-feature-text-v1",
});
const error = (code) => {
  throw new Error(code);
};
const code = (value) =>
  /^[a-z0-9_-]{1,100}$/i.test(value?.code ?? value?.message ?? "")
    ? (value.code ?? value.message)
    : "diagnostic_failed";
const save = (path, value, exclusive = false) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: exclusive ? "wx" : "w",
  });
const sourcePaths = (python) => [
  fileURLToPath(import.meta.url),
  resolve(root, "routing/feature_worker.py"),
  resolve(root, "src/routing-runtime.ts"),
  resolve(root, "dist/routing-runtime.js"),
  resolve(root, "src/routing-head.ts"),
  resolve(root, "dist/routing-head.js"),
  resolve(root, "package-lock.json"),
  python,
];
const hostRuntime = () => ({
  node: process.version,
  platform: process.platform,
  arch: process.arch,
});
const safeStatus = (runtime) => {
  try {
    return JSON.parse(JSON.stringify(runtime.status));
  } catch {
    return null;
  }
};

/** Exactly the production feature text; host metadata, label and gold are excluded. */
export function diagnosticText(row) {
  if (
    typeof row?.prompt !== "string" ||
    !row.prompt.trim() ||
    !row.prompt.isWellFormed()
  )
    error("invalid_prompt");
  const prior = row.previousExchange;
  if (
    prior !== undefined &&
    (!prior ||
      typeof prior.user !== "string" ||
      typeof prior.assistant !== "string" ||
      !prior.user.isWellFormed() ||
      !prior.assistant.isWellFormed())
  )
    error("invalid_previous_exchange");
  const text = prior
    ? `Previous exchange:\nUser: ${prior.user}\nAssistant: ${prior.assistant}\n\nCurrent request:\n${row.prompt}`
    : row.prompt;
  if (
    Buffer.byteLength(text) > 32768 ||
    Buffer.byteLength(JSON.stringify({ id: 4096, text })) + 1 > 65536
  )
    error("encoder_text_limit");
  return text;
}
export function diagnosticRows(fixture) {
  if (
    fixture?.version !== 1 ||
    !Array.isArray(fixture.cases) ||
    fixture.cases.length !== DIAGNOSTIC_OPTIONS.population
  )
    error("invalid_fixture_population");
  const ids = new Set();
  return fixture.cases.map((row) => {
    if (
      typeof row?.id !== "string" ||
      !row.id ||
      row.id.length > 256 ||
      ids.has(row.id) ||
      !["easy", "hard", "unknown"].includes(row.label)
    )
      error("invalid_host_case");
    ids.add(row.id);
    const text = diagnosticText(row);
    return { id: row.id, label: row.label, text, sourceSha256: hash(text) };
  });
}
const schedule = (rows) =>
  DIAGNOSTIC_OPTIONS.phases.flatMap((phase) =>
    rows.map((row, index) => ({
      phase,
      index,
      id: row.id,
      sourceSha256: row.sourceSha256,
    })),
  );
const requiredFlag = (flag) => {
  if (flag !== true) error("explicit_lab_encoder_flag_required");
};
const headSettings = (head) => ({
  version: head.version,
  dimension: head.dimension,
  threshold: head.threshold,
  minMargin: head.minMargin,
  calibration: head.calibration,
});

/** Test head pins are accessible only through dependency injection, never CLI. */
export async function prepareDiagnostic(
  {
    output,
    forceEncoderCall = false,
    fixture = resolve(root, "fixtures/routing-validation-v2.json"),
    headFile = resolve(root, "research/routing-head-round-1/head.json"),
    python = resolve(root, ".build/rfdt-venv/bin/python"),
  },
  test = {},
) {
  requiredFlag(forceEncoderCall);
  output = resolve(output);
  fixture = resolve(fixture);
  headFile = resolve(headFile);
  python = resolve(python);
  await mkdir(output, { recursive: true, mode: 0o700 });
  await save(
    resolve(output, "prepare-claim.json"),
    { startedAt: new Date().toISOString() },
    true,
  );
  const [fixtureBytes, headBytes] = await Promise.all([
    readFile(fixture),
    readFile(headFile),
  ]);
  if (fixtureBytes.length > 2 * 1024 * 1024 || headBytes.length > 512 * 1024)
    error("input_size_limit");
  const fixedHeadSha256 = test.testHeadSha256 ?? FROZEN_HEAD_SHA256;
  if (hash(headBytes) !== fixedHeadSha256) error("frozen_head_mismatch");
  const rows = diagnosticRows(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fixtureBytes)),
  );
  const head = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(headBytes),
  );
  if (
    head.version !== 1 ||
    head.dimension !== 1152 ||
    head.calibration !== "uncalibrated"
  )
    error("invalid_head_settings");
  const sources = [];
  for (const path of sourcePaths(python)) {
    const bytes = await readFile(path);
    sources.push({ path, bytes: bytes.length, sha256: hash(bytes) });
  }
  const plan = {
    version: 1,
    purpose:
      "LAB raw head scores; forced encoder input is not completeness proof or production classification",
    productionQualified: false,
    promoted: false,
    forceEncoderCall: true,
    testOnlyInputs: test.testHeadSha256 !== undefined,
    options: DIAGNOSTIC_OPTIONS,
    hostRuntime: hostRuntime(),
    labAttributionSha256: LAB_ATTRIBUTION_SHA256,
    fixture: { path: fixture, sha256: hash(fixtureBytes) },
    head: { path: headFile, sha256: fixedHeadSha256, ...headSettings(head) },
    python,
    workerPath: resolve(root, "routing/feature_worker.py"),
    sources,
    rows,
    schedule: schedule(rows),
    featureCacheUsed: false,
    generationCallsPlanned: 0,
  };
  await save(resolve(output, "plan.json"), plan, true);
  await writeFile(
    resolve(output, "plan.sha256"),
    hash(await readFile(resolve(output, "plan.json"))) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  return plan;
}

export function validateDiagnosticPlan(
  plan,
  fixtureBytes,
  headBytes,
  test = {},
) {
  if (
    plan?.version !== 1 ||
    plan.productionQualified !== false ||
    plan.promoted !== false ||
    plan.forceEncoderCall !== true ||
    plan.featureCacheUsed !== false ||
    plan.generationCallsPlanned !== 0 ||
    canonical(plan.options) !== canonical(DIAGNOSTIC_OPTIONS) ||
    canonical(plan.hostRuntime) !== canonical(hostRuntime()) ||
    plan.labAttributionSha256 !== LAB_ATTRIBUTION_SHA256
  )
    error("plan_policy_drift");
  if (
    plan.testOnlyInputs !== (test.testHeadSha256 !== undefined) ||
    hash(headBytes) !== (test.testHeadSha256 ?? FROZEN_HEAD_SHA256) ||
    plan.head?.sha256 !== hash(headBytes)
  )
    error("frozen_head_mismatch");
  const actualSettings = headSettings(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(headBytes)),
  );
  if (canonical(headSettings(plan.head)) !== canonical(actualSettings))
    error("head_settings_drift");
  if (hash(fixtureBytes) !== plan.fixture?.sha256) error("fixture_drift");
  const rows = diagnosticRows(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fixtureBytes)),
  );
  if (
    canonical(rows) !== canonical(plan.rows) ||
    canonical(schedule(rows)) !== canonical(plan.schedule)
  )
    error("schedule_binding_mismatch");
  const paths = sourcePaths(resolve(plan.python));
  if (
    plan.workerPath !== resolve(root, "routing/feature_worker.py") ||
    plan.sources?.length !== paths.length ||
    plan.sources.some(
      (entry, i) =>
        entry.path !== paths[i] ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 1 ||
        !/^[a-f0-9]{64}$/.test(entry.sha256),
    )
  )
    error("source_inventory_drift");
  return rows;
}
async function verifySources(plan) {
  for (const entry of plan.sources) {
    const bytes = await readFile(entry.path);
    if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256)
      error("source_drift");
  }
}
function bounded(promise, milliseconds, onTimeout, signal) {
  let timer, abort;
  const stopped = new Promise((_resolve, reject) => {
    abort = () => reject(new Error("diagnostic_cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    timer = setTimeout(() => {
      reject(new Error("diagnostic_timeout"));
      onTimeout();
    }, milliseconds);
  });
  return Promise.race([promise, stopped]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  });
}
function validateResult(result, plan, expected) {
  if (
    result?.reason !== "head-score" ||
    result.artifactId !== "lab.raw-head-round-1-diagnostic" ||
    result.artifactSha256 !== plan.head.sha256 ||
    result.workerSha256 !==
      plan.sources.find((entry) => entry.path === plan.workerPath).sha256 ||
    result.qualificationSha256 !== LAB_ATTRIBUTION_SHA256 ||
    result.calibration !== "uncalibrated" ||
    !["fast", "strong", "uncertain"].includes(result.decision) ||
    canonical(result.provenance) !== canonical(expected)
  )
    error("runtime_result_binding_mismatch");
  for (const key of ["confidence", "fastScore", "strongScore"])
    if (
      typeof result[key] !== "number" ||
      !Number.isFinite(result[key]) ||
      result[key] < 0 ||
      result[key] > 1
    )
      error("missing_raw_head_score");
  if (
    Math.abs(result.fastScore + result.strongScore - 1) > 1e-8 ||
    !Number.isSafeInteger(result.inputTokens) ||
    result.inputTokens < 1 ||
    result.inputTokens > 2048 ||
    !["featureElapsedMs", "operationalElapsedMs"].every(
      (key) =>
        typeof result[key] === "number" &&
        Number.isFinite(result[key]) &&
        result[key] >= 0,
    )
  )
    error("invalid_runtime_measurement");
}
const latencies = (rows) => {
  const values = rows
    .filter((row) => row.status === "completed")
    .map((row) => row.operationalElapsedMs)
    .sort((a, b) => a - b);
  return {
    samples: values.length,
    p50: values.length ? values[Math.ceil(values.length * 0.5) - 1] : null,
    p95: values.length ? values[Math.ceil(values.length * 0.95) - 1] : null,
    max: values.length ? values.at(-1) : null,
  };
};
export function summarizeDiagnostic(plan, records) {
  const phases = Object.fromEntries(
    DIAGNOSTIC_OPTIONS.phases.map((phase) => {
      const rows = records.filter((row) => row.phase === phase),
        completed = rows.filter((row) => row.status === "completed");
      return [
        phase,
        {
          scheduled: plan.rows.length,
          scheduledByHostLabel: Object.fromEntries(
            ["easy", "hard", "unknown"].map((label) => [
              label,
              plan.rows.filter((row) => row.label === label).length,
            ]),
          ),
          completed: completed.length,
          errors: rows.filter((row) => row.status === "error").length,
          unrun: rows.filter((row) => row.status === "unrun").length,
          rawRoutes: Object.fromEntries(
            ["fast", "strong", "uncertain"].map((route) => [
              route,
              completed.filter((row) => row.decision === route).length,
            ]),
          ),
          rawEasyFast: completed.filter(
            (row) => row.label === "easy" && row.decision === "fast",
          ).length,
          rawHardFast: completed.filter(
            (row) => row.label === "hard" && row.decision === "fast",
          ).length,
          rawUnknownFast: completed.filter(
            (row) => row.label === "unknown" && row.decision === "fast",
          ).length,
          operationalLatenciesMs: latencies(rows),
        },
      ];
    }),
  );
  return {
    populationCases: plan.rows.length,
    scheduledCalls: plan.schedule.length,
    phases,
    coldStartupOperationalMs: latencies(records.filter((row) => row.coldStart)),
    initialPassNonStartupOperationalMs: latencies(
      records.filter((row) => row.phase === "cold" && !row.coldStart),
    ),
    warmDescriptiveOperationalMs: latencies(
      records.filter((row) => row.phase !== "cold"),
    ),
    productionQualified: false,
    promoted: false,
    completenessProof: false,
    featureCacheUsed: false,
  };
}

/** ROOT invokes actual run; tests must inject both runtime factory and provenance. */
export async function runDiagnostic(
  output,
  {
    forceEncoderCall = false,
    signal,
    createRuntime,
    expectedProvenance,
    testHeadSha256,
  } = {},
) {
  requiredFlag(forceEncoderCall);
  const started = performance.now();
  output = resolve(output);
  const planBytes = await readFile(resolve(output, "plan.json")),
    plan = JSON.parse(planBytes);
  if (
    (await readFile(resolve(output, "plan.sha256"), "utf8")).trim() !==
    hash(planBytes)
  )
    error("plan_hash_drift");
  const [fixtureBytes, headBytes] = await Promise.all([
    readFile(plan.fixture.path),
    readFile(plan.head.path),
  ]);
  validateDiagnosticPlan(plan, fixtureBytes, headBytes, { testHeadSha256 });
  if (plan.testOnlyInputs && (!createRuntime || !expectedProvenance))
    error("test_runtime_injection_required");
  await verifySources(plan);
  await save(
    resolve(output, "run-claim.json"),
    { startedAt: new Date().toISOString(), planSha256: hash(planBytes) },
    true,
  );
  const journal = {
    version: 1,
    planSha256: hash(planBytes),
    status: "lab_running",
    purpose: plan.purpose,
    forcedEncoderCall: true,
    essentialFactsAvailableIsForced: true,
    completenessProof: false,
    productionQualified: false,
    promoted: false,
    featureCacheUsed: false,
    qualificationSha256IsAttributionOnly: true,
    records: plan.schedule.map((item) => ({
      ...item,
      label: plan.rows[item.index].label,
      status: "unrun",
    })),
    errors: [],
    cleanup: null,
  };
  const controller = new AbortController(),
    abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const jobTimer = setTimeout(abort, DIAGNOSTIC_OPTIONS.jobMs),
    originalFetch = globalThis.fetch;
  globalThis.fetch = async () => error("diagnostic_network_forbidden");
  let runtime,
    resultOwned = false;
  try {
    await save(resolve(output, "result.json"), journal, true);
    resultOwned = true;
    if (!createRuntime) {
      const module = await import("../dist/routing-runtime.js");
      createRuntime = module.createRoutingRuntime;
      expectedProvenance = module.routingFeatureProvenance;
    }
    await verifySources(plan);
    const workerSha256 = plan.sources.find(
      (entry) => entry.path === plan.workerPath,
    ).sha256;
    const provenance = expectedProvenance(workerSha256);
    runtime = createRuntime({
      python: plan.python,
      workerPath: plan.workerPath,
      workerSha256,
      headArtifact: headBytes,
      artifactId: "lab.raw-head-round-1-diagnostic",
      artifactSha256: plan.head.sha256,
      qualificationSha256: LAB_ATTRIBUTION_SHA256,
    });
    for (let i = 0; i < journal.records.length; i++) {
      const record = journal.records[i],
        row = plan.rows[record.index];
      if (controller.signal.aborted) error("diagnostic_cancelled");
      record.coldStart = runtime.status.modelReady !== true;
      const callStarted = performance.now();
      try {
        const result = await bounded(
          runtime.classify(
            { text: row.text, essentialFactsAvailable: true },
            controller.signal,
          ),
          record.coldStart
            ? DIAGNOSTIC_OPTIONS.coldRequestMs
            : DIAGNOSTIC_OPTIONS.warmRequestMs,
          abort,
          controller.signal,
        );
        validateResult(result, plan, provenance);
        Object.assign(record, result, {
          status: "completed",
          diagnosticElapsedMs: performance.now() - callStarted,
          completenessProof: false,
          essentialFactsAvailableIsForced: true,
        });
      } catch (failure) {
        Object.assign(record, {
          status: "error",
          error: code(failure),
          diagnosticElapsedMs: performance.now() - callStarted,
        });
        throw failure;
      }
      await save(resolve(output, "result.json"), journal);
    }
    journal.status = "lab_completed";
  } catch (failure) {
    journal.status = "lab_failed";
    journal.errors.push({
      code: code(failure),
      completed: journal.records.filter((row) => row.status === "completed")
        .length,
    });
    controller.abort();
  } finally {
    if (runtime) {
      let disposeAwaited = false;
      try {
        await bounded(
          Promise.resolve().then(() => runtime.dispose()),
          DIAGNOSTIC_OPTIONS.cleanupMs,
          () => {},
        );
        disposeAwaited = true;
        const status = safeStatus(runtime);
        journal.cleanup = { awaited: true, confirmed: true, status };
        if (
          !status ||
          status.state !== "disposed" ||
          status.activeRequests !== 0 ||
          status.queuedRequests !== 0
        )
          error("runtime_cleanup_unconfirmed");
      } catch (failure) {
        journal.cleanup = {
          awaited: disposeAwaited,
          confirmed: false,
          status: safeStatus(runtime),
          error: code(failure),
        };
        journal.status = "lab_failed";
        journal.errors.push({ code: code(failure) });
      }
    }
    clearTimeout(jobTimer);
    signal?.removeEventListener("abort", abort);
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    globalThis.fetch = originalFetch;
    journal.elapsedMs = performance.now() - started;
    journal.summary = summarizeDiagnostic(plan, journal.records);
    if (resultOwned) await save(resolve(output, "result.json"), journal);
  }
  return journal;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const { values } = parseArgs({
    options: {
      output: { type: "string" },
      fixture: { type: "string" },
      "head-file": { type: "string" },
      python: { type: "string" },
      prepare: { type: "boolean" },
      run: { type: "boolean" },
      "force-encoder-for-lab": { type: "boolean" },
    },
  });
  if (!values.output || !!values.prepare === !!values.run)
    error("Usage: --output DIRECTORY --prepare|--run --force-encoder-for-lab");
  const options = {
    output: values.output,
    forceEncoderCall: values["force-encoder-for-lab"],
    fixture: values.fixture,
    headFile: values["head-file"],
    python: values.python,
  };
  const result = values.prepare
    ? await prepareDiagnostic(options)
    : await runDiagnostic(values.output, options);
  process.stdout.write(
    JSON.stringify(
      values.prepare
        ? {
            prepared: true,
            scheduledCalls: result.schedule.length,
            productionQualified: false,
            headSha256: result.head.sha256,
          }
        : {
            status: result.status,
            summary: result.summary,
            errors: result.errors,
            cleanup: result.cleanup,
          },
      null,
      2,
    ) + "\n",
  );
  if (values.run && result.status !== "lab_completed") process.exitCode = 1;
}
