import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateRoutingWorkflowCases,
  workflowConversation,
} from "./routing-workflow-eval.mjs";

export const FROZEN_HEAD_SHA256 =
  "6c97fd783d2fd94d631717825923b462e319152bfe30044916be2011c803e84e";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const pin = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const finite = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

export function parseHeadEvaluationArgs(argv) {
  const options = {
    fixture: "fixtures/routing-validation.json",
    fixtureProtocol: "research/routing-validation-protocol.md",
    headFile: ".build/routing-experiments/frozen-head-round-1/head.json",
    trainingPlan: ".build/routing-experiments/frozen-head-round-1/plan.json",
    qualificationPolicy:
      "research/routing-head-round-1/qualification-policy.json",
    output: ".build/routing-experiments/head-validation-round-1/result.json",
    expectedHeadSha256: FROZEN_HEAD_SHA256,
    warmRepetitions: 2,
    timeoutMs: 320000,
    cleanupTimeoutMs: 10000,
    independentValidation: false,
    run: false,
  };
  const names = {
    "--fixture": "fixture",
    "--fixture-protocol": "fixtureProtocol",
    "--head-file": "headFile",
    "--training-plan": "trainingPlan",
    "--qualification-policy": "qualificationPolicy",
    "--artifact": "artifactFile",
    "--output": "output",
    "--expected-head-sha256": "expectedHeadSha256",
    "--warm-repetitions": "warmRepetitions",
    "--timeout-ms": "timeoutMs",
    "--cleanup-timeout-ms": "cleanupTimeoutMs",
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--run") options.run = true;
    else if (argument === "--independent-validation")
      options.independentValidation = true;
    else if (names[argument] && argv[index + 1])
      options[names[argument]] = argv[++index];
    else throw new Error("Unknown or incomplete head evaluation argument");
  }
  for (const name of ["warmRepetitions", "timeoutMs", "cleanupTimeoutMs"])
    options[name] = Number(options[name]);
  if (
    !options.artifactFile ||
    !pin(options.expectedHeadSha256) ||
    !Number.isSafeInteger(options.warmRepetitions) ||
    options.warmRepetitions < 1 ||
    options.warmRepetitions > 3 ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 350000 ||
    !Number.isSafeInteger(options.cleanupTimeoutMs) ||
    options.cleanupTimeoutMs < 1 ||
    options.cleanupTimeoutMs > 30000
  )
    throw new Error(
      "Head evaluation requires an explicit artifact and bounded settings",
    );
  return options;
}

async function inputJson(path, maximum = 2 * 1024 * 1024) {
  const bytes = await readFile(path);
  if (bytes.length > maximum)
    throw new Error("Head evaluation input exceeds its byte bound");
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { raw, value: JSON.parse(raw), sha256: hash(bytes) };
  } catch {
    throw new Error("Head evaluation input is not UTF-8 JSON");
  }
}

export function headEvaluationContext(record) {
  return {
    messages: workflowConversation(record).map((message) =>
      message.role === "user"
        ? { role: "user", content: message.content, timestamp: 0 }
        : {
            role: "assistant",
            content: [{ type: "text", text: message.content }],
            stopReason: "stop",
            timestamp: 0,
            api: "conversation-evidence",
            provider: "conversation-evidence",
            model: "conversation-evidence",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
          },
    ),
  };
}

export async function prepareHeadEvaluation(options, dependencies = {}) {
  const root =
    dependencies.root ?? fileURLToPath(new URL("../", import.meta.url));
  const fixture = await inputJson(resolve(options.fixture));
  const cases = validateRoutingWorkflowCases(fixture.value);
  const counts = Object.fromEntries(
    ["easy", "hard", "unknown"].map((label) => [
      label,
      cases.filter((record) => record.label === label).length,
    ]),
  );
  if (
    cases.length !== 60 ||
    counts.easy !== 20 ||
    counts.hard !== 20 ||
    counts.unknown !== 20
  )
    throw new Error(
      "Head qualification requires the complete frozen 20/20/20 population",
    );
  const wrapper = await inputJson(resolve(options.artifactFile));
  const head = await inputJson(resolve(options.headFile), 512 * 1024);
  const trainingPlan = await inputJson(resolve(options.trainingPlan));
  const policy = await inputJson(resolve(options.qualificationPolicy));
  if (
    !object(wrapper.value) ||
    wrapper.value.headJson !== head.raw ||
    wrapper.value.headSha256 !== head.sha256 ||
    head.sha256 !== options.expectedHeadSha256
  )
    throw new Error(
      "Head wrapper, raw head file and predeclared head pin differ",
    );
  if (
    policy.sha256 !== wrapper.value.qualificationSha256 ||
    policy.value.fixtureSha256 !== fixture.sha256 ||
    policy.value.headSha256 !== head.sha256 ||
    policy.value.sourceWorkerSha256 !== wrapper.value.workerSha256 ||
    policy.value.productionQualified !== false ||
    policy.value.easyFastCoverageMinimum !== 0.6 ||
    policy.value.unsafeFastMaximum !== 0 ||
    policy.value.warmOperationalP95MaximumMs !== 100 ||
    policy.value.errorsMaximum !== 0 ||
    policy.value.unrunMaximum !== 0 ||
    policy.value.fullPopulationRequired !== true ||
    policy.value.minimumEasyIndependentGroups !== 20 ||
    policy.value.minimumStrongIndependentGroups !== 40 ||
    policy.value.familyMinimum !== 12 ||
    policy.value.completenessFromActualContextOnly !== true ||
    policy.value.classifierInputsExcludeHostLabelsAndExpectedAnswers !== true ||
    policy.value.noTuningAfterValidation !== true ||
    options.warmRepetitions !== 2
  )
    throw new Error(
      "Frozen qualification policy or schedule does not match this campaign",
    );
  const fixtureProtocol = await readFile(resolve(options.fixtureProtocol));
  const sourcePaths = dependencies.sourcePaths ?? {
    runner: resolve(root, "scripts/routing-head-eval.mjs"),
    conversation_runner: resolve(root, "scripts/routing-workflow-eval.mjs"),
    classifier_source: resolve(root, "src/workflow-classifier.ts"),
    classifier_runtime: resolve(root, "dist/workflow-classifier.js"),
    runtime_source: resolve(root, "src/routing-runtime.ts"),
    runtime: resolve(root, "dist/routing-runtime.js"),
    head_source: resolve(root, "src/routing-head.ts"),
    head_runtime: resolve(root, "dist/routing-head.js"),
    guards_source: resolve(root, "src/routing-guards.ts"),
    guards_runtime: resolve(root, "dist/routing-guards.js"),
    completeness_source: resolve(root, "src/routing-completeness.ts"),
    completeness_runtime: resolve(root, "dist/routing-completeness.js"),
    evaluator_source: resolve(root, "src/routing-evaluation.ts"),
    evaluator_runtime: resolve(root, "dist/routing-evaluation.js"),
    package_lock: resolve(root, "package-lock.json"),
    worker: wrapper.value.workerPath,
    python: wrapper.value.python,
  };
  const sourceSha256 = {};
  for (const [name, path] of Object.entries(sourcePaths))
    sourceSha256[name] = hash(await readFile(path));
  if (
    sourceSha256.worker !== undefined &&
    sourceSha256.worker !== wrapper.value.workerSha256
  )
    throw new Error("Worker source does not match the wrapper");
  const schedule = [];
  for (let pass = 0; pass <= options.warmRepetitions; pass++) {
    const offset = pass === 0 ? 0 : (pass * 17) % cases.length;
    const ordered = [...cases.slice(offset), ...cases.slice(0, offset)];
    for (const record of ordered)
      schedule.push({
        caseId: record.id,
        pass,
        phase: pass === 0 ? "cold" : "warm",
      });
  }
  const protocol = {
    schemaVersion: 1,
    purpose:
      "Prequalification native routing-head validation; no automatic production promotion",
    fixtureSha256: fixture.sha256,
    fixtureProtocolSha256: hash(fixtureProtocol),
    wrapperSha256: wrapper.sha256,
    headSha256: head.sha256,
    trainingPlanSha256: trainingPlan.sha256,
    qualificationPolicySha256: policy.sha256,
    qualificationPolicy: policy.value,
    sourceSha256,
    sourceIdentity: hash(JSON.stringify(sourceSha256)),
    nodeVersion: process.version,
    counts,
    requiredFamilies: [...new Set(cases.map((record) => record.family))].sort(),
    independentValidation: options.independentValidation,
    independenceBasis: options.independentValidation
      ? policy.value.independenceLimit
      : "Independent validation is not ROOT attested; qualification candidate cannot pass",
    schedule,
    cases: cases.map((record) => ({
      id: record.id,
      family: record.family,
      label: record.label,
      contextSha256: hash(JSON.stringify(headEvaluationContext(record))),
    })),
    settings: {
      warmRepetitions: options.warmRepetitions,
      timeoutMs: options.timeoutMs,
      cleanupTimeoutMs: options.cleanupTimeoutMs,
      parallelClassifications: 1,
      featureCacheReplay: false,
      rawHeadDiagnostics: false,
    },
    labAssumption:
      "ONLY inside this evaluation, the matching artifact pins are treated as qualified to ask the production eligibility guard. This laboratory assumption is not quality evidence, completeness proof, or a production qualification manifest.",
    productionCompletenessUnmodified: true,
    rawHeadAvailability:
      "Scores are observed from the actual production runtime when it encodes; explicitly unavailable when the production verifier rejects. No forced completeness or uncensored diagnostic pass.",
    timingBoundaries: {
      cold: "Entire first full population, including lazy worker startup and first actual feature calls; excluded from warm qualification p95",
      warm: "Every case repeated through actual context extraction, production completeness, runtime and head, binding and eligibility guard; no feature replay",
      wallElapsedMs:
        "Host monotonic time through classification and eligibility, including queuing/verification/startup if present",
      runtimeOperationalElapsedMs:
        "Driver-provided time including actual operational work, separate from feature-only time",
    },
    plannedClassificationAttempts: schedule.length,
    fullPiWorkflow: false,
    networkAllowed: false,
    trainingUsedDuringEvaluation: false,
    productionQualified: false,
  };
  return {
    protocol,
    cases,
    artifact: wrapper.value,
    artifactJson: wrapper.raw,
  };
}

async function bounded(operation, controller, timeoutMs) {
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("head-evaluation-timeout"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), expiry]);
  } finally {
    clearTimeout(timer);
  }
}

const safeCode = (error) =>
  typeof error?.code === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(error.code)
    ? error.code
    : "classification-failed";

export async function executeHeadEvaluation(prepared, dependencies) {
  const attempts = [];
  let currentCapture = null,
    runtime;
  const classifier = dependencies.createWorkflowClassifier({
    artifact: prepared.artifact,
    artifactJson: prepared.artifactJson,
    artifactSha256: prepared.protocol.wrapperSha256,
    createRuntime(options) {
      runtime = dependencies.createRoutingRuntime(options);
      return {
        async classify(input, signal) {
          const capture = currentCapture;
          const result = await runtime.classify(input, signal);
          if (capture) capture.result = result;
          return result;
        },
        dispose: () => runtime.dispose(),
      };
    },
  });
  const labQualification = {
    qualified: true,
    artifactId: prepared.artifact.artifactId,
    artifactSha256: prepared.protocol.wrapperSha256,
    qualificationSha256: prepared.artifact.qualificationSha256,
  };
  const byId = new Map(prepared.cases.map((record) => [record.id, record]));
  const execution = {
    attempts,
    cleanup: { completed: false, error: null, runtimeStatus: null },
    realExecution: dependencies.realExecution === true,
  };
  try {
    if (classifier?.encoderMode !== "operational")
      throw new Error(
        "Head validation requires the operational classifier adapter",
      );
    for (const slot of prepared.protocol.schedule) {
      const context = headEvaluationContext(byId.get(slot.caseId));
      const controller = new AbortController();
      const capture = { result: null };
      currentCapture = capture;
      const started = performance.now();
      const attempt = {
        ...slot,
        decision: null,
        classification: null,
        rawHead: null,
        eligibility: null,
        routerElapsedMs: null,
        error: null,
        featureCacheElapsedMs: null,
      };
      try {
        await bounded(
          async () => {
            const classification = await classifier.classify(context, {
              signal: controller.signal,
            });
            if (
              classification.artifactId !== prepared.artifact.artifactId ||
              classification.artifactSha256 !==
                prepared.protocol.wrapperSha256 ||
              classification.headSha256 !== prepared.protocol.headSha256 ||
              classification.workerSha256 !== prepared.artifact.workerSha256 ||
              classification.qualificationSha256 !==
                prepared.artifact.qualificationSha256 ||
              !["fast", "strong", "uncertain"].includes(classification.route) ||
              typeof classification.complete !== "boolean"
            )
              throw Object.assign(
                new Error("classification-binding-mismatch"),
                { code: "classification-binding-mismatch" },
              );
            attempt.classification = classification;
            attempt.eligibility = await classifier.eligibility(context, {
              classification,
              qualification: labQualification,
              mode: "auto",
            });
            attempt.decision =
              classification.route === "fast" &&
              classification.complete === true &&
              attempt.eligibility?.eligibleForFast === true
                ? "fast"
                : "strong";
            const currentRaw = capture.result;
            const available =
              currentRaw?.reason === "head-score" &&
              finite(currentRaw.fastScore) &&
              finite(currentRaw.strongScore);
            attempt.rawHead = {
              available,
              reason: available
                ? "actual-production-encoder-score"
                : "production-completeness-rejected-or-no-encoder-score",
              decision: available ? currentRaw.decision : null,
              fastScore: available ? currentRaw.fastScore : null,
              strongScore: available ? currentRaw.strongScore : null,
              confidence: available ? currentRaw.confidence : null,
              inputTokens: available ? currentRaw.inputTokens : null,
              featureElapsedMs: available ? currentRaw.featureElapsedMs : null,
              runtimeOperationalElapsedMs:
                currentRaw?.operationalElapsedMs ?? null,
            };
          },
          controller,
          prepared.protocol.settings.timeoutMs,
        );
      } catch (error) {
        attempt.error = controller.signal.aborted
          ? "classification-timeout"
          : safeCode(error);
      } finally {
        attempt.routerElapsedMs = performance.now() - started;
        attempts.push(attempt);
        await dependencies.onCheckpoint?.(execution);
      }
    }
  } finally {
    try {
      await bounded(
        () => classifier.dispose(),
        new AbortController(),
        prepared.protocol.settings.cleanupTimeoutMs,
      );
      execution.cleanup.completed = true;
    } catch {
      execution.cleanup.error = "cleanup-uncertain";
    }
    try {
      execution.cleanup.runtimeStatus = runtime?.status ?? null;
      if (
        execution.cleanup.runtimeStatus === null ||
        execution.cleanup.runtimeStatus.state !== "disposed" ||
        execution.cleanup.runtimeStatus.activeRequests !== 0 ||
        execution.cleanup.runtimeStatus.queuedRequests !== 0
      ) {
        execution.cleanup.completed = false;
        execution.cleanup.error = "cleanup-state-uncertain";
      }
    } catch {
      execution.cleanup.completed = false;
      execution.cleanup.error = "cleanup-status-unavailable";
    }
    await dependencies.onCheckpoint?.(execution);
  }
  return execution;
}

export function summarizeHeadEvaluation(prepared, execution, evaluator) {
  const cases = prepared.cases.map((record) => ({
    ...record,
    metadata: {
      ...record.metadata,
      independent: prepared.protocol.independentValidation,
      group: record.metadata?.group ?? record.id,
    },
  }));
  const passes = [];
  for (
    let pass = 0;
    pass <= prepared.protocol.settings.warmRepetitions;
    pass++
  ) {
    const attempts = execution.attempts.filter(
      (attempt) => attempt.pass === pass,
    );
    const evaluationAttempts = attempts.map((attempt) => ({
      caseId: attempt.caseId,
      decision: ["fast", "strong"].includes(attempt.decision)
        ? attempt.decision
        : undefined,
      error: attempt.error,
      routerElapsedMs: attempt.routerElapsedMs,
    }));
    const report = evaluator.summarizeRoutingEvaluation(
      cases,
      evaluationAttempts,
      {
        qualification: {
          requiredFamilies: prepared.protocol.requiredFamilies,
          minimumFamilies: 12,
          attestation: {
            realExecution: execution.realExecution,
            independentEvaluation: prepared.protocol.independentValidation,
            artifactIdentity: prepared.protocol.wrapperSha256,
            sourceIdentity: prepared.protocol.sourceIdentity,
          },
        },
      },
    );
    const rawAvailable = attempts.filter(
      (attempt) => attempt.rawHead?.available === true,
    ).length;
    passes.push({
      pass,
      phase: pass === 0 ? "cold" : "warm",
      report,
      rawHeadScoresAvailable: rawAvailable,
      rawHeadScoresUnavailable: cases.length - rawAvailable,
      completenessVerified: attempts.filter(
        (attempt) => attempt.classification?.complete === true,
      ).length,
      observedMaximumMs: attempts.length
        ? Math.max(...attempts.map((attempt) => attempt.routerElapsedMs))
        : null,
    });
  }
  const qualificationCandidate =
    execution.realExecution &&
    execution.cleanup.completed &&
    execution.cleanup.error === null &&
    execution.attempts.length === prepared.protocol.schedule.length &&
    passes[0].report.errors === 0 &&
    passes[0].report.unrun === 0 &&
    passes[0].report.gates.fullPopulationCompleted &&
    passes[0].report.gates.noUnsafeFast &&
    passes[0].report.gates.usefulEasyCoverage &&
    passes[0].report.gates.notAllStrong &&
    passes.slice(1).every((pass) => pass.report.qualificationEligible);
  return {
    scheduled: prepared.protocol.schedule.length,
    attempted: execution.attempts.length,
    errors: execution.attempts.filter((attempt) => attempt.error !== null)
      .length,
    unrun: prepared.protocol.schedule.length - execution.attempts.length,
    passes,
    qualificationCandidate,
    productionQualified: false,
    limitation:
      "Prequalification validation candidate only. Guard-rejected rows do not test raw head quality. Warm router latency excludes the separately retained cold pass. No downstream task, generalization, billing, or automatic production eligibility claim.",
  };
}

// The result file retains the complete evaluation. Terminal output exposes only
// aggregate observations so host-only answers and per-case reports stay in it.
export function projectHeadEvaluationSummary(summary) {
  if (!object(summary)) return null;
  const number = (value) => (finite(value) ? value : null);
  const boolean = (value) => (typeof value === "boolean" ? value : null);
  return {
    scheduled: number(summary.scheduled),
    attempted: number(summary.attempted),
    errors: number(summary.errors),
    unrun: number(summary.unrun),
    passes: Array.isArray(summary.passes)
      ? summary.passes.map((pass) => ({
          pass: number(pass.pass),
          phase: ["cold", "warm"].includes(pass.phase) ? pass.phase : null,
          scheduled: number(pass.report?.scheduled),
          completed: number(pass.report?.completed),
          errors: number(pass.report?.errors),
          unrun: number(pass.report?.unrun),
          incomplete: number(pass.report?.incomplete),
          easyFast: number(pass.report?.easyFast),
          easyFastCoverage: number(pass.report?.easyFastCoverage),
          unsafeFast: number(pass.report?.unsafeFast),
          hardAndUnknownStrong: number(pass.report?.hardAndUnknownStrong),
          allStrong: boolean(pass.report?.allStrong),
          qualificationEligible: boolean(pass.report?.qualificationEligible),
          operationalP95Ms: number(pass.report?.routerLatency?.p95Ms),
          latencySamples: number(pass.report?.routerLatency?.samples),
          latencyMissing: number(pass.report?.routerLatency?.missing),
          rawHeadScoresAvailable: number(pass.rawHeadScoresAvailable),
          rawHeadScoresUnavailable: number(pass.rawHeadScoresUnavailable),
          completenessVerified: number(pass.completenessVerified),
          observedMaximumMs: number(pass.observedMaximumMs),
        }))
      : [],
    qualificationCandidate: summary.qualificationCandidate === true,
    productionQualified: false,
  };
}

const jsonBytes = (value) => `${JSON.stringify(value, null, 2)}\n`;
async function save(path, value, flag) {
  await writeFile(path, jsonBytes(value), {
    mode: 0o600,
    ...(flag ? { flag } : {}),
  });
}

export async function claimHeadEvaluation(output, protocolBytes) {
  const previous = JSON.parse(await readFile(output, "utf8"));
  if (
    previous.status !== "prepared" ||
    previous.attempts?.length !== 0 ||
    previous.protocolSha256 !== hash(protocolBytes)
  )
    throw new Error(
      "Head evaluation is unprepared, changed or already attempted",
    );
  await save(
    `${output}.run-claim.json`,
    {
      protocolSha256: hash(protocolBytes),
      ownerPid: process.pid,
      claimedAt: new Date().toISOString(),
      permanent: true,
    },
    "wx",
  );
  const state = {
    status: "running",
    protocolSha256: hash(protocolBytes),
    startedAt: new Date().toISOString(),
    attempts: [],
    cleanup: { completed: false, error: null, runtimeStatus: null },
  };
  await save(output, state);
  return state;
}

function coverage(prepared, state) {
  state.schedule = prepared.protocol.schedule.map((slot) => ({
    ...slot,
    status: state.attempts.some(
      (attempt) => attempt.caseId === slot.caseId && attempt.pass === slot.pass,
    )
      ? state.attempts.find(
          (attempt) =>
            attempt.caseId === slot.caseId && attempt.pass === slot.pass,
        ).error
        ? "error"
        : "completed"
      : "unrun",
  }));
  state.scheduled = prepared.protocol.schedule.length;
  state.unrun = state.scheduled - state.attempts.length;
}

export async function headEvaluationMain(
  argv = process.argv.slice(2),
  dependencies = {},
) {
  const options = parseHeadEvaluationArgs(argv);
  const prepared = await (dependencies.prepare ?? prepareHeadEvaluation)(
    options,
  );
  const output = resolve(options.output),
    protocolPath = `${output}.protocol.json`;
  await mkdir(dirname(output), { recursive: true });
  const protocolBytes = jsonBytes(prepared.protocol);
  try {
    await writeFile(protocolPath, protocolBytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (
      error.code !== "EEXIST" ||
      !options.run ||
      (await readFile(protocolPath, "utf8")) !== protocolBytes
    )
      throw new Error("Frozen head protocol changed or already exists");
  }
  if (!options.run) {
    const state = {
      status: "prepared",
      protocolSha256: hash(protocolBytes),
      attempts: [],
    };
    coverage(prepared, state);
    await save(output, state, "wx");
    process.stdout.write(
      `${JSON.stringify({ status: "prepared", output, classifications: prepared.protocol.schedule.length })}\n`,
    );
    return 0;
  }
  const state = await claimHeadEvaluation(output, protocolBytes);
  coverage(prepared, state);
  await save(output, state);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Head evaluation forbids network requests");
  };
  let terminalCode = 1;
  try {
    const loadRuntime =
      dependencies.loadRuntime ??
      (async () => {
        const [classifier, runtime, evaluator] = await Promise.all([
          import("../dist/workflow-classifier.js"),
          import("../dist/routing-runtime.js"),
          import("../dist/routing-evaluation.js"),
        ]);
        return { classifier, runtime, evaluator };
      });
    const { classifier, runtime, evaluator } = await loadRuntime();
    const execution = await executeHeadEvaluation(prepared, {
      createWorkflowClassifier: classifier.createWorkflowClassifier,
      createRoutingRuntime: runtime.createRoutingRuntime,
      realExecution:
        dependencies.loadRuntime === undefined &&
        dependencies.prepare === undefined,
      onCheckpoint: async (partial) => {
        Object.assign(state, partial);
        coverage(prepared, state);
        await save(output, state);
      },
    });
    const summary = summarizeHeadEvaluation(prepared, execution, evaluator);
    Object.assign(state, execution, {
      status: execution.cleanup.completed ? "completed" : "failed",
      summary,
      completedAt: new Date().toISOString(),
      productionQualified: false,
    });
    coverage(prepared, state);
    await save(output, state);
    terminalCode = summary.qualificationCandidate ? 0 : 1;
  } catch {
    state.status = "failed";
    state.error =
      "Head evaluation setup or execution failed; private details withheld";
    state.completedAt = new Date().toISOString();
    state.productionQualified = false;
    coverage(prepared, state);
    await save(output, state);
  } finally {
    globalThis.fetch = originalFetch;
  }
  process.stdout.write(
    `${JSON.stringify({
      status: state.status,
      output,
      summary: projectHeadEvaluationSummary(state.summary),
      unrun: state.unrun,
      productionQualified: false,
    })}\n`,
  );
  return terminalCode;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await headEvaluationMain();
  } catch {
    process.stderr.write(
      "Head evaluation preparation failed; private details withheld\n",
    );
    process.exitCode = 1;
  }
}
