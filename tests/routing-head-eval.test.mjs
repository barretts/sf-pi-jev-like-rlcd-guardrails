import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  claimHeadEvaluation,
  executeHeadEvaluation,
  FROZEN_HEAD_SHA256,
  headEvaluationContext,
  headEvaluationMain,
  parseHeadEvaluationArgs,
  prepareHeadEvaluation,
  projectHeadEvaluationSummary,
  summarizeHeadEvaluation,
} from "../scripts/routing-head-eval.mjs";
import { createWorkflowClassifier } from "../dist/workflow-classifier.js";
import * as evaluator from "../src/routing-evaluation.ts";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const headRaw = '{"invented_cpu_head":true}\n';
const workerSha256 = "c".repeat(64);
const records = () =>
  Array.from({ length: 60 }, (_, index) => ({
    id: `invented-case-${index}`,
    family: `invented-family-${Math.floor(index / 5)}`,
    label: index < 20 ? "easy" : index < 40 ? "hard" : "unknown",
    prompt:
      index < 20
        ? `What is ${index + 1} + 11? Return only the integer.`
        : index < 40
          ? `Review the concurrent transaction design with test marker ${index}.`
          : `Determine the earlier absent benchmark result with test marker ${index}. No observation is supplied.`,
    // Intentionally contrary on easy rows: these flags must never affect actual
    // production completeness. The source verifier sees only conversation text.
    essentialFactsAvailable: false,
    expected: { privateOracle: "SYNTHETIC_HOST_GOLD_NEVER_CLASSIFIER_INPUT" },
  }));

function policy(fixtureSha256) {
  return {
    schemaVersion: 1,
    fixtureSha256,
    headSha256: hash(headRaw),
    sourceWorkerSha256: workerSha256,
    productionQualified: false,
    minimumEasyIndependentGroups: 20,
    minimumStrongIndependentGroups: 40,
    easyFastCoverageMinimum: 0.6,
    unsafeFastMaximum: 0,
    warmOperationalP95MaximumMs: 100,
    fullPopulationRequired: true,
    errorsMaximum: 0,
    unrunMaximum: 0,
    completenessFromActualContextOnly: true,
    classifierInputsExcludeHostLabelsAndExpectedAnswers: true,
    noTuningAfterValidation: true,
    familyMinimum: 12,
    independenceLimit:
      "Invented CPU gate test; not independently measured model evidence",
  };
}

async function sandbox(t) {
  const directory = await mkdtemp(join(tmpdir(), "jev-head-eval-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = {
    fixture: join(directory, "fixture.json"),
    fixtureProtocol: join(directory, "fixture-protocol.md"),
    headFile: join(directory, "head.json"),
    trainingPlan: join(directory, "training-plan.json"),
    qualificationPolicy: join(directory, "policy.json"),
    artifactFile: join(directory, "wrapper.json"),
    output: join(directory, "result.json"),
    expectedHeadSha256: hash(headRaw),
    warmRepetitions: 2,
    timeoutMs: 1000,
    cleanupTimeoutMs: 100,
    independentValidation: true,
    run: false,
  };
  const fixtureRaw = JSON.stringify({ version: 1, cases: records() });
  const policyRaw = `${JSON.stringify(policy(hash(fixtureRaw)))}\n`;
  const artifact = {
    schemaVersion: 1,
    artifactId: "invented-cpu-head-evaluation",
    headJson: headRaw,
    headSha256: hash(headRaw),
    python: join(directory, "unused-python"),
    workerPath: join(directory, "unused-worker.py"),
    workerSha256,
    qualificationSha256: hash(policyRaw),
  };
  await writeFile(options.fixture, fixtureRaw);
  await writeFile(
    options.fixtureProtocol,
    "Invented CPU-only fixture protocol.\n",
  );
  await writeFile(options.headFile, headRaw);
  await writeFile(options.trainingPlan, '{"invented_training_plan":true}\n');
  await writeFile(options.qualificationPolicy, policyRaw);
  await writeFile(
    options.artifactFile,
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  return { directory, options, artifact };
}

function fakeRuntime({
  calls = [],
  error = false,
  cleanupError = false,
  hangingFirst = false,
  pendingAfterDispose = false,
} = {}) {
  let count = 0,
    submitted = 0,
    completed = 0,
    fallbacks = 0,
    state = "cold";
  return {
    createRoutingRuntime(options) {
      return {
        async classify(input, signal) {
          calls.push(structuredClone(input));
          assert.ok(!input.text.includes("SYNTHETIC_HOST_GOLD"));
          assert.ok(!input.text.includes("invented-family"));
          assert.ok(signal instanceof AbortSignal);
          if (error && count++ === 0)
            throw new Error("SYNTHETIC_PRIVATE_MODEL_ERROR");
          if (hangingFirst && count++ === 0) return await new Promise(() => {});
          const verified = input.essentialFactsAvailable === true;
          if (verified) {
            state = "ready";
            submitted++;
            completed++;
          } else fallbacks++;
          return {
            decision: verified ? "fast" : "strong",
            confidence: verified ? 0.99 : 0,
            calibration: "uncalibrated",
            reason: verified ? "head-score" : "essential-facts-not-verified",
            fastScore: verified ? 0.99 : null,
            strongScore: verified ? 0.01 : null,
            artifactId: options.artifactId,
            artifactSha256: options.artifactSha256,
            qualificationSha256: options.qualificationSha256,
            workerSha256: options.workerSha256,
            inputTokens: verified ? 12 : 0,
            featureElapsedMs: verified ? 2 : 0,
            operationalElapsedMs: verified ? 4 : 0.01,
            provenance: null,
          };
        },
        async dispose() {
          state = "disposed";
          if (cleanupError) throw new Error("SYNTHETIC_PRIVATE_CLEANUP_ERROR");
        },
        get status() {
          return {
            state,
            activeRequests: pendingAfterDispose ? 1 : 0,
            queuedRequests: 0,
            submittedRequests: submitted,
            completedRequests: completed,
            fallbackRequests: fallbacks,
          };
        },
      };
    },
  };
}

async function snapshot(t) {
  const state = await sandbox(t);
  const prepared = await prepareHeadEvaluation(state.options, {
    sourcePaths: {},
  });
  return { ...state, prepared };
}

const flags = (options, run = false) => [
  "--fixture",
  options.fixture,
  "--fixture-protocol",
  options.fixtureProtocol,
  "--head-file",
  options.headFile,
  "--training-plan",
  options.trainingPlan,
  "--qualification-policy",
  options.qualificationPolicy,
  "--artifact",
  options.artifactFile,
  "--expected-head-sha256",
  options.expectedHeadSha256,
  "--output",
  options.output,
  "--timeout-ms",
  "1000",
  "--cleanup-timeout-ms",
  "100",
  "--independent-validation",
  ...(run ? ["--run"] : []),
];

async function quietMain(args, dependencies) {
  const stdout = process.stdout.write;
  let emitted = "";
  process.stdout.write = (chunk) => {
    emitted += chunk;
    return true;
  };
  try {
    return { code: await headEvaluationMain(args, dependencies), emitted };
  } finally {
    process.stdout.write = stdout;
  }
}

test("CLI requires artifact identity and rejects budget, credentials, models and tuning flags", () => {
  assert.throws(() => parseHeadEvaluationArgs([]));
  const value = parseHeadEvaluationArgs(["--artifact", "wrapper.json"]);
  assert.equal(value.warmRepetitions, 2);
  assert.equal(value.independentValidation, false);
  for (const args of [
    ["--warm-repetitions", "0"],
    ["--api-key-file", "private"],
    ["--model", "unapproved"],
    ["--threshold", "0.5"],
  ])
    assert.throws(() =>
      parseHeadEvaluationArgs(["--artifact", "wrapper.json", ...args]),
    );
});

test("explicit fresh fixture, protocol, wrapper and policy paths preserve the frozen head", () => {
  const options = parseHeadEvaluationArgs([
    "--fixture",
    "invented-fresh-fixture.json",
    "--fixture-protocol",
    "invented-fresh-protocol.md",
    "--artifact",
    "invented-fresh-wrapper.json",
    "--qualification-policy",
    "invented-fresh-policy.json",
  ]);
  assert.equal(options.fixture, "invented-fresh-fixture.json");
  assert.equal(options.fixtureProtocol, "invented-fresh-protocol.md");
  assert.equal(options.artifactFile, "invented-fresh-wrapper.json");
  assert.equal(options.qualificationPolicy, "invented-fresh-policy.json");
  assert.equal(options.expectedHeadSha256, FROZEN_HEAD_SHA256);
  assert.equal(options.warmRepetitions, 2);
});

test("terminal projection excludes full reports and retains missing observations as null", () => {
  const full = {
    scheduled: 180,
    attempted: 0,
    errors: 0,
    unrun: 180,
    qualificationCandidate: false,
    productionQualified: true,
    passes: [
      {
        pass: 0,
        phase: "cold",
        report: {
          rows: [{ expected: "SYNTHETIC_HOST_GOLD_NEVER_CLASSIFIER_INPUT" }],
          routerLatency: { p95Ms: null, samples: 0, missing: 60 },
        },
      },
    ],
  };
  const projected = projectHeadEvaluationSummary(full);
  assert.equal(projected.productionQualified, false);
  assert.equal(projected.passes[0].operationalP95Ms, null);
  assert.equal(projected.passes[0].rawHeadScoresAvailable, null);
  assert.equal(projected.passes[0].latencySamples, 0);
  assert.equal(projected.passes[0].latencyMissing, 60);
  assert.equal(projected.passes[0].qualificationEligible, null);
  assert.ok(!JSON.stringify(projected).includes("SYNTHETIC_HOST_GOLD"));
  assert.ok(!("report" in projected.passes[0]));
  assert.equal(full.passes[0].report.rows.length, 1);
  assert.equal(projectHeadEvaluationSummary(undefined), null);
});

test("prepare freezes raw wrapper/head/policy/plan identity and complete cold/warm populations", async (t) => {
  const { options, prepared } = await snapshot(t);
  assert.equal(prepared.protocol.schedule.length, 180);
  assert.equal(prepared.protocol.productionQualified, false);
  assert.equal(prepared.protocol.networkAllowed, false);
  assert.equal(prepared.protocol.headSha256, hash(headRaw));
  assert.equal(
    prepared.protocol.wrapperSha256,
    hash(await readFile(options.artifactFile)),
  );
  assert.equal(
    prepared.artifactJson,
    await readFile(options.artifactFile, "utf8"),
  );
  assert.equal(
    prepared.protocol.qualificationPolicySha256,
    prepared.artifact.qualificationSha256,
  );
  assert.equal(prepared.protocol.requiredFamilies.length, 12);
  for (let pass = 0; pass < 3; pass++) {
    const scheduled = prepared.protocol.schedule.filter(
      (slot) => slot.pass === pass,
    );
    assert.equal(scheduled.length, 60);
    assert.equal(new Set(scheduled.map((slot) => slot.caseId)).size, 60);
  }
});

test("partial population or changed head bytes cannot prepare a qualification run", async (t) => {
  const { options } = await sandbox(t);
  const fixture = JSON.parse(await readFile(options.fixture, "utf8"));
  fixture.cases.pop();
  await writeFile(options.fixture, JSON.stringify(fixture));
  await assert.rejects(prepareHeadEvaluation(options, { sourcePaths: {} }));
  await writeFile(
    options.fixture,
    JSON.stringify({ version: 1, cases: records() }),
  );
  await writeFile(options.headFile, `${headRaw} `);
  await assert.rejects(prepareHeadEvaluation(options, { sourcePaths: {} }));
});

test("changed policy or post-validation schedule cannot silently alter acceptance", async (t) => {
  const { options } = await sandbox(t);
  await assert.rejects(
    prepareHeadEvaluation(
      { ...options, warmRepetitions: 1 },
      { sourcePaths: {} },
    ),
  );
  const policy = JSON.parse(
    await readFile(options.qualificationPolicy, "utf8"),
  );
  policy.easyFastCoverageMinimum = 0;
  await writeFile(options.qualificationPolicy, JSON.stringify(policy));
  await assert.rejects(prepareHeadEvaluation(options, { sourcePaths: {} }));
});

test("context boundary preserves supplied previous roles and excludes all evaluator metadata", () => {
  const record = {
    ...records()[0],
    previousExchange: {
      user: "Previous request",
      assistant: "Observed answer",
    },
  };
  const context = headEvaluationContext(record);
  assert.deepEqual(
    context.messages.map((message) => message.role),
    ["user", "assistant", "user"],
  );
  assert.equal(context.messages[1].stopReason, "stop");
  const payload = JSON.stringify(context);
  for (const excluded of [
    "SYNTHETIC_HOST_GOLD",
    "invented-family",
    '"label"',
    "essentialFactsAvailable",
    '"expected"',
  ])
    assert.ok(!payload.includes(excluded));
});

test("actual production adapter recomputes completeness and observes uncensored scores only when encoded", async (t) => {
  const { prepared } = await snapshot(t);
  const calls = [];
  const execution = await executeHeadEvaluation(prepared, {
    createWorkflowClassifier,
    ...fakeRuntime({ calls }),
    realExecution: false,
  });
  assert.equal(calls.length, 180);
  assert.equal(
    calls.filter((input) => input.essentialFactsAvailable).length,
    60,
  );
  assert.equal(
    execution.attempts.filter((attempt) => attempt.rawHead.available).length,
    60,
  );
  assert.equal(
    execution.attempts.filter((attempt) => attempt.classification.complete)
      .length,
    60,
  );
  assert.equal(
    execution.attempts.filter((attempt) => attempt.decision === "fast").length,
    60,
  );
  assert.equal(execution.cleanup.completed, true);
  const summary = summarizeHeadEvaluation(prepared, execution, evaluator);
  assert.equal(summary.qualificationCandidate, false); // CPU injection is not real model evidence.
  assert.equal(summary.productionQualified, false);
  assert.equal(summary.passes.length, 3);
  assert.ok(summary.passes.every((pass) => pass.report.easyFastCoverage === 1));
  assert.ok(
    summary.passes.every((pass) => pass.rawHeadScoresUnavailable === 40),
  );
});

test("safe all-strong handling is functional but cannot satisfy useful routing coverage", async (t) => {
  const { prepared } = await snapshot(t);
  const original = fakeRuntime();
  const createRoutingRuntime = (options) => {
    const runtime = original.createRoutingRuntime(options);
    return {
      ...runtime,
      async classify(...args) {
        const result = await runtime.classify(...args);
        return {
          ...result,
          decision: "strong",
          confidence: 0.99,
          fastScore: 0.01,
          strongScore: 0.99,
        };
      },
      get status() {
        return runtime.status;
      },
    };
  };
  const execution = await executeHeadEvaluation(prepared, {
    createWorkflowClassifier,
    createRoutingRuntime,
    realExecution: true,
  });
  const summary = summarizeHeadEvaluation(prepared, execution, evaluator);
  assert.ok(summary.passes.every((pass) => pass.report.allStrong));
  assert.equal(summary.qualificationCandidate, false);
});

test("cold quality and complete warm cohorts qualify only a candidate and never production", async (t) => {
  const { prepared } = await snapshot(t);
  const execution = await executeHeadEvaluation(prepared, {
    createWorkflowClassifier,
    ...fakeRuntime(),
    realExecution: false,
  });
  execution.realExecution = true; // Explicitly invented qualification-gate test only.
  const summary = summarizeHeadEvaluation(prepared, execution, evaluator);
  assert.equal(summary.qualificationCandidate, true);
  assert.equal(summary.productionQualified, false);
  const missing = { ...execution, attempts: execution.attempts.slice(1) };
  assert.equal(
    summarizeHeadEvaluation(prepared, missing, evaluator)
      .qualificationCandidate,
    false,
  );
  execution.attempts[0].decision = "strong";
  execution.attempts[20].decision = "fast";
  assert.equal(
    summarizeHeadEvaluation(prepared, execution, evaluator)
      .qualificationCandidate,
    false,
  );
});

test("private classification errors remain safe, attributed and in full denominators", async (t) => {
  const { prepared } = await snapshot(t);
  const execution = await executeHeadEvaluation(prepared, {
    createWorkflowClassifier,
    ...fakeRuntime({ error: true }),
    realExecution: false,
  });
  assert.equal(execution.attempts.length, 180);
  assert.equal(execution.attempts[0].error, "classification-failed");
  assert.ok(
    !JSON.stringify(execution).includes("SYNTHETIC_PRIVATE_MODEL_ERROR"),
  );
  const summary = summarizeHeadEvaluation(prepared, execution, evaluator);
  assert.equal(summary.errors, 1);
  assert.equal(summary.unrun, 0);
  assert.equal(summary.passes[0].report.scheduled, 60);
});

test("a hanging call is bounded and every remaining case is still recorded", async (t) => {
  const { prepared } = await snapshot(t);
  prepared.protocol.settings.timeoutMs = 5;
  const execution = await executeHeadEvaluation(prepared, {
    createWorkflowClassifier,
    ...fakeRuntime({ hangingFirst: true }),
    realExecution: false,
  });
  assert.equal(execution.attempts.length, 180);
  assert.equal(execution.attempts[0].error, "classification-timeout");
  assert.equal(execution.cleanup.completed, true);
});

test("cleanup failure or remaining pending work cannot leave a passing candidate", async (t) => {
  const { prepared } = await snapshot(t);
  for (const settings of [
    { cleanupError: true },
    { pendingAfterDispose: true },
  ]) {
    const execution = await executeHeadEvaluation(prepared, {
      createWorkflowClassifier,
      ...fakeRuntime(settings),
      realExecution: true,
    });
    assert.equal(execution.cleanup.completed, false);
    assert.equal(
      summarizeHeadEvaluation(prepared, execution, evaluator)
        .qualificationCandidate,
      false,
    );
    assert.ok(
      !JSON.stringify(execution).includes("SYNTHETIC_PRIVATE_CLEANUP_ERROR"),
    );
  }
});

test("execution claims exclude competing invocations and permanently refuse replay", async (t) => {
  const { options } = await sandbox(t);
  const protocolBytes = '{"invented_protocol":true}\n';
  await writeFile(
    options.output,
    JSON.stringify({
      status: "prepared",
      protocolSha256: hash(protocolBytes),
      attempts: [],
    }),
  );
  const results = await Promise.allSettled([
    claimHeadEvaluation(options.output, protocolBytes),
    claimHeadEvaluation(options.output, protocolBytes),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    1,
  );
  await assert.rejects(claimHeadEvaluation(options.output, protocolBytes));
});

test("main denies startup networking before worker creation and preserves every unrun slot", async (t) => {
  const { options } = await sandbox(t);
  const originalFetch = globalThis.fetch;
  let requests = 0;
  const deniedUnderlyingFetch = async () => {
    requests++;
    throw new Error("No actual network allowed");
  };
  globalThis.fetch = deniedUnderlyingFetch;
  const deps = {
    prepare: (value) => prepareHeadEvaluation(value, { sourcePaths: {} }),
    async loadRuntime() {
      await globalThis.fetch("https://unapproved.invalid/models");
    },
  };
  try {
    assert.equal((await quietMain(flags(options), deps)).code, 0);
    assert.equal((await quietMain(flags(options, true), deps)).code, 1);
    assert.equal(requests, 0);
    assert.equal(globalThis.fetch, deniedUnderlyingFetch);
    const state = JSON.parse(await readFile(options.output, "utf8"));
    assert.equal(state.status, "failed");
    assert.equal(state.unrun, 180);
    assert.ok(state.schedule.every((slot) => slot.status === "unrun"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("main consumes an unchanged prepared plan with actual adapter/fake runtime and cannot promote production", async (t) => {
  const { options } = await sandbox(t);
  const deps = {
    prepare: (value) => prepareHeadEvaluation(value, { sourcePaths: {} }),
    async loadRuntime() {
      return {
        classifier: { createWorkflowClassifier },
        runtime: fakeRuntime(),
        evaluator,
      };
    },
  };
  assert.equal((await quietMain(flags(options), deps)).code, 0);
  const frozen = await readFile(`${options.output}.protocol.json`, "utf8");
  const run = await quietMain(flags(options, true), deps);
  assert.equal(run.code, 1); // Fake runtime injection is not real qualification evidence.
  const state = JSON.parse(await readFile(options.output, "utf8"));
  assert.equal(state.status, "completed");
  assert.equal(state.attempts.length, 180);
  assert.equal(state.unrun, 0);
  assert.equal(state.summary.productionQualified, false);
  assert.equal(state.summary.qualificationCandidate, false);
  assert.equal(state.realExecution, false);
  const terminal = JSON.parse(run.emitted);
  assert.equal(terminal.status, state.status);
  assert.deepEqual(
    terminal.summary,
    projectHeadEvaluationSummary(state.summary),
  );
  assert.equal(terminal.summary.scheduled, 180);
  assert.equal(terminal.summary.attempted, 180);
  assert.equal(terminal.summary.errors, 0);
  assert.equal(terminal.summary.passes.length, 3);
  assert.ok(
    terminal.summary.passes.every((pass) => pass.rawHeadScoresAvailable === 20),
  );
  assert.ok(
    terminal.summary.passes.every(
      (pass) => pass.rawHeadScoresUnavailable === 40,
    ),
  );
  assert.ok(run.emitted.length < 5000);
  assert.ok(!run.emitted.includes("SYNTHETIC_HOST_GOLD"));
  assert.ok(!run.emitted.includes('"rows"'));
  assert.ok(!run.emitted.includes('"expected"'));
  assert.equal(state.summary.passes[0].report.rows.length, 60);
  assert.ok(JSON.stringify(state.summary).includes("SYNTHETIC_HOST_GOLD"));
  assert.equal(
    await readFile(`${options.output}.protocol.json`, "utf8"),
    frozen,
  );
  await assert.rejects(quietMain(flags(options, true), deps));
});
