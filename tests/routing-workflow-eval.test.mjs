import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ROUTING_WORKFLOW_MODEL,
  ROUTING_WORKFLOW_ORIGIN,
  ROUTING_WORKFLOW_SYSTEM,
  createWorkflowGatewayProvider,
  claimPreparedRoutingWorkflow,
  executeRoutingWorkflow,
  finishRoutingWorkflow,
  gatewayMessagesFromPiContext,
  normalizeWorkflowQualification,
  parseRoutingWorkflowArgs,
  prepareRoutingWorkflow,
  projectRoutingWorkflowRegistration,
  routingWorkflowMain,
  summarizeRoutingWorkflow,
  validateRoutingWorkflowCases,
  workflowConversation,
} from "../scripts/routing-workflow-eval.mjs";
import { createRoutingDispatcher } from "../src/routing-extension.ts";
import {
  GatewayTransportError,
  createGatewayTransport,
  parseStrictJsonObject,
} from "../src/gateway.ts";
import * as evaluator from "../src/routing-evaluation.ts";
import { createAssistantMessageEventStream } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const artifactSha256 = "a".repeat(64);
const qualificationSha256 = "b".repeat(64);
const artifactId = "invented-cpu-head";
const registration = {
  provider: "llmgw",
  origin: ROUTING_WORKFLOW_ORIGIN,
  baseUrl: `${ROUTING_WORKFLOW_ORIGIN}/v1`,
  api: "openai-completions",
  id: ROUTING_WORKFLOW_MODEL,
  reasoning: false,
  contextWindow: 500000,
  maxTokens: 500000,
};
const qualification = {
  qualified: true,
  artifactId,
  artifactSha256,
  qualificationSha256,
};

function cases() {
  return [
    {
      id: "synthetic-easy",
      family: "host-only-family-easy",
      label: "easy",
      prompt: 'Return exactly {"value":7}.',
      essentialFactsAvailable: true,
      expected: { value: 7 },
    },
    {
      id: "synthetic-unknown",
      family: "host-only-family-unknown",
      label: "unknown",
      prompt: 'The required value is unavailable. Return {"value":null}.',
      essentialFactsAvailable: false,
      expected: { value: null },
    },
  ];
}

function prepared(records = cases(), repetitions = 1) {
  const schedule = [];
  for (let repetition = 0; repetition < repetitions; repetition++)
    for (const [index, record] of records.entries())
      for (const arm of (index + repetition) % 2
        ? ["baseline", "selected"]
        : ["selected", "baseline"])
        schedule.push({ caseId: record.id, arm, repetition });
  return {
    cases: records,
    artifact: { fixture: "invented CPU artifact only" },
    protocol: {
      qualification,
      registration,
      schedule,
      settings: { repetitions, max_tokens: 2048, timeout_ms: 1000 },
    },
  };
}

function piContext(record) {
  return {
    systemPrompt: ROUTING_WORKFLOW_SYSTEM,
    messages: workflowConversation(record).map((message) => ({
      ...message,
      content: [{ type: "text", text: message.content }],
      timestamp: 0,
    })),
    tools: [],
  };
}

function fakeTransport({ mode = "success", calls = [] } = {}) {
  let index = 0;
  return {
    async chat(request) {
      calls.push(structuredClone({ ...request, signal: undefined }));
      assert.ok(request.signal instanceof AbortSignal);
      const current = index++;
      if (mode === "private-error" && current === 0)
        throw new Error("SYNTHETIC_PRIVATE_RESPONSE_AND_KEY_NEVER_RETAIN");
      if (mode === "http-error" && current === 0)
        throw new GatewayTransportError("http_error", { httpStatus: 503 });
      if (mode === "incomplete" && current === 0)
        throw new GatewayTransportError("incomplete_completion", {
          usage: {
            promptTokens: 10,
            completionTokens: 20,
            totalTokens: 30,
            cachedPromptTokens: null,
          },
        });
      if (mode === "abort" && current === 0)
        return await new Promise((resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(new GatewayTransportError("aborted")),
            { once: true },
          );
        });
      const unknown = request.messages.at(-1).content.includes("unavailable");
      let assistantText = JSON.stringify({ value: unknown ? null : 7 });
      if (mode === "duplicate" && current === 0)
        assistantText = '{"value":0,"value":7}';
      if (mode === "wrong" && current === 0) assistantText = '{"value":999}';
      return {
        assistantText,
        finishReason: "stop",
        usage:
          mode === "unknown-usage"
            ? {
                promptTokens: null,
                completionTokens: null,
                totalTokens: null,
                cachedPromptTokens: null,
              }
            : {
                promptTokens: 100,
                completionTokens: 10,
                totalTokens: 110,
                cachedPromptTokens: 40,
              },
        elapsedMs: 2,
        responseSha256: hash(assistantText),
      };
    },
  };
}

function dependencies({
  mode,
  classification,
  encoderMode = "operational",
  calls = [],
  seen = [],
  executeTask,
  onCheckpoint,
} = {}) {
  return {
    transport: fakeTransport({ mode, calls }),
    createEventStream: createAssistantMessageEventStream,
    createRoutingDispatcher,
    parseStrictJsonObject,
    classifier: {
      encoderMode,
      eligibility(context, input) {
        assert.equal(input.classification.route, "fast");
        return {
          eligibleForFast: true,
          reason: "Invented CPU completeness evidence",
        };
      },
      async classify(context, { signal }) {
        assert.ok(signal instanceof AbortSignal);
        seen.push(structuredClone(context));
        return (
          classification ?? {
            route: gatewayMessagesFromPiContext(context)
              .at(-1)
              .content.includes("unavailable")
              ? "strong"
              : "fast",
            complete: true,
            artifactId,
            artifactSha256,
            confidence: 1,
          }
        );
      },
    },
    executeTask:
      executeTask ??
      (async ({ record, dispatcher, model, signal }) => ({
        message: await dispatcher
          .streamSimple(model, piContext(record), { signal })
          .result(),
        streamCalls: 1,
        piModel: model.id,
      })),
    onCheckpoint,
  };
}

async function sandbox(t) {
  const directory = await mkdtemp(join(tmpdir(), "jev-routing-workflow-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = {
    fixture: join(directory, "fixture.json"),
    modelsFile: join(directory, "models.json"),
    artifactFile: join(directory, "head.json"),
    qualificationFile: join(directory, "qualification.json"),
    classifierModule: join(directory, "must-not-execute.mjs"),
    output: join(directory, "result.json"),
    apiKeyFile: join(directory, "must-not-read-credential"),
    repetitions: 1,
    maxTokens: 2048,
    timeoutMs: 1000,
  };
  const artifactBytes = '{"fixture":"invented CPU head"}\n';
  await writeFile(paths.fixture, JSON.stringify({ cases: cases() }));
  await writeFile(paths.artifactFile, artifactBytes);
  await writeFile(
    paths.qualificationFile,
    JSON.stringify({ ...qualification, artifactSha256: hash(artifactBytes) }),
  );
  await writeFile(
    paths.classifierModule,
    'throw new Error("Preparation executed a classifier");\n',
  );
  await writeFile(
    paths.modelsFile,
    JSON.stringify({
      providers: {
        llmgw: {
          api: "openai-completions",
          baseUrl: registration.baseUrl,
          apiKey: "SYNTHETIC_CONFIG_PRIVATE_NEVER_PROJECT",
          headers: { authorization: "SYNTHETIC_CONFIG_PRIVATE_HEADER" },
          models: [
            {
              id: registration.id,
              reasoning: false,
              contextWindow: 500000,
              maxTokens: 500000,
              name: "SYNTHETIC_PRIVATE_NAME",
            },
          ],
        },
        unselected: { apiKey: "SYNTHETIC_UNSELECTED_SECRET" },
      },
    }),
  );
  return { directory, paths };
}

const cliFlags = (paths, run = false) => [
  "--fixture",
  paths.fixture,
  "--models-file",
  paths.modelsFile,
  "--artifact",
  paths.artifactFile,
  "--qualification",
  paths.qualificationFile,
  "--classifier-module",
  paths.classifierModule,
  "--output",
  paths.output,
  "--max-tokens",
  "2048",
  "--timeout-ms",
  "1000",
  ...(run ? ["--run", "--api-key-file", paths.apiKeyFile] : []),
];

async function quietMain(args, dependencies) {
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  let emitted = "";
  const capture = (chunk) => {
    emitted += chunk;
    return true;
  };
  process.stdout.write = capture;
  process.stderr.write = capture;
  try {
    return { code: await routingWorkflowMain(args, dependencies), emitted };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

test("CLI freezes bounded settings and requires explicit artifact identity paths", () => {
  const flags = [
    "--artifact",
    "head.json",
    "--qualification",
    "qualification.json",
    "--classifier-module",
    "adapter.mjs",
  ];
  const parsed = parseRoutingWorkflowArgs(flags);
  assert.equal(parsed.run, false);
  assert.equal(parsed.repetitions, 1);
  assert.throws(() => parseRoutingWorkflowArgs([]));
  assert.throws(() => parseRoutingWorkflowArgs([...flags, "--run"]));
  assert.throws(() =>
    parseRoutingWorkflowArgs([...flags, "--repetitions", "0"]),
  );
  assert.throws(() =>
    parseRoutingWorkflowArgs([...flags, "--max-tokens", "32769"]),
  );
  assert.throws(() =>
    parseRoutingWorkflowArgs([...flags, "--model", "unapproved-model"]),
  );
});

test("fixture validation rejects duplicate IDs and malformed previous exchanges", () => {
  const records = cases();
  assert.equal(validateRoutingWorkflowCases({ cases: records }).length, 2);
  assert.throws(() => validateRoutingWorkflowCases([records[0], records[0]]));
  assert.throws(() =>
    validateRoutingWorkflowCases([
      { ...records[0], previousExchange: { user: "hi" } },
    ]),
  );
  assert.throws(() =>
    validateRoutingWorkflowCases([{ ...records[0], prompt: "\ud800" }]),
  );
  assert.throws(() =>
    validateRoutingWorkflowCases([{ ...records[0], expected: [] }]),
  );
});

test("conversation boundary carries only real text and preserves previous user/assistant roles", () => {
  const record = {
    ...cases()[0],
    previousExchange: {
      user: "Earlier question",
      assistant: "Earlier observation",
    },
    expected: { oracle: "HOST_ONLY_ORACLE" },
  };
  assert.deepEqual(workflowConversation(record), [
    { role: "user", content: "Earlier question" },
    { role: "assistant", content: "Earlier observation" },
    { role: "user", content: record.prompt },
  ]);
  const serialized = JSON.stringify(workflowConversation(record));
  assert.ok(!serialized.includes(record.family));
  assert.ok(!serialized.includes("HOST_ONLY_ORACLE"));
  assert.ok(!serialized.includes("essentialFactsAvailable"));
});

test("registration projection contains selected attribution and excludes auth configuration", async (t) => {
  const { paths } = await sandbox(t);
  const projected = await projectRoutingWorkflowRegistration(paths.modelsFile);
  const serialized = JSON.stringify(projected);
  assert.equal(projected.id, ROUTING_WORKFLOW_MODEL);
  assert.ok(!serialized.includes("SYNTHETIC_"));
  assert.ok(!serialized.includes("apiKey"));
  const config = JSON.parse(await readFile(paths.modelsFile, "utf8"));
  config.providers.llmgw.baseUrl = "https://unapproved.example/v1";
  await writeFile(paths.modelsFile, JSON.stringify(config));
  await assert.rejects(projectRoutingWorkflowRegistration(paths.modelsFile));
});

test("prepare performs no inference, authentication resolution, or classifier execution", async (t) => {
  const { paths } = await sandbox(t);
  const snapshot = await prepareRoutingWorkflow(paths, { sourcePaths: {} });
  assert.equal(snapshot.protocol.qualification.qualified, true);
  assert.equal(snapshot.protocol.planned_task_requests, 4);
  assert.equal(snapshot.protocol.full_pi_agent_prompt_path, true);
  assert.equal(
    snapshot.protocol.fixed_model_control_establishes_model_routing_benefit,
    false,
  );
  assert.deepEqual(
    snapshot.protocol.schedule.map((entry) => entry.arm),
    ["selected", "baseline", "baseline", "selected"],
  );
  assert.equal(
    snapshot.protocol.source_sha256.classifier_module,
    hash(await readFile(paths.classifierModule)),
  );
  assert.equal(
    snapshot.protocol.artifact_sha256,
    hash(await readFile(paths.artifactFile)),
  );
  assert.equal(
    snapshot.artifactJson,
    await readFile(paths.artifactFile, "utf8"),
  );
  assert.equal(hash(snapshot.artifactJson), snapshot.protocol.artifact_sha256);
  assert.notEqual(
    hash(JSON.stringify(snapshot.artifact)),
    snapshot.protocol.artifact_sha256,
  );
  assert.equal(
    snapshot.protocol.registration_sha256,
    hash(JSON.stringify(snapshot.protocol.registration)),
  );
});

test("validation independence and family coverage are frozen host attestations for this exact fixture", async (t) => {
  const { paths } = await sandbox(t);
  const declaration = JSON.parse(
    await readFile(paths.qualificationFile, "utf8"),
  );
  declaration.independentEvaluation = true;
  declaration.fixtureSha256 = hash(await readFile(paths.fixture));
  declaration.requiredFamilies = cases().map((record) => record.family);
  await writeFile(paths.qualificationFile, JSON.stringify(declaration));
  const snapshot = await prepareRoutingWorkflow(paths, { sourcePaths: {} });
  assert.equal(
    snapshot.protocol.workflow_qualification.independentEvaluation,
    true,
  );
  assert.deepEqual(
    snapshot.protocol.workflow_qualification.requiredFamilies,
    declaration.requiredFamilies,
  );
  declaration.fixtureSha256 = "c".repeat(64);
  await writeFile(paths.qualificationFile, JSON.stringify(declaration));
  assert.equal(
    (await prepareRoutingWorkflow(paths, { sourcePaths: {} })).protocol
      .workflow_qualification.independentEvaluation,
    false,
  );
});

test("real main denies every default startup fetch before classifier or credential resolution", async (t) => {
  const { paths } = await sandbox(t);
  let defaultCalls = 0;
  const originalFetch = globalThis.fetch;
  const syntheticDefaultFetch = async () => {
    defaultCalls++;
    throw new Error("CPU test must never reach this default transport");
  };
  globalThis.fetch = syntheticDefaultFetch;
  const deps = {
    prepare: (options) => prepareRoutingWorkflow(options, { sourcePaths: {} }),
    async loadRuntime() {
      await globalThis.fetch("https://unapproved.invalid/model-catalog");
      throw new Error("The deny boundary must reject before this line");
    },
  };
  try {
    assert.equal((await quietMain(cliFlags(paths), deps)).code, 0);
    const run = await quietMain(cliFlags(paths, true), deps);
    assert.equal(run.code, 1);
    assert.equal(defaultCalls, 0);
    assert.equal(globalThis.fetch, syntheticDefaultFetch);
    const state = JSON.parse(await readFile(paths.output, "utf8"));
    assert.equal(state.status, "failed");
    assert.equal(state.coverage.unrunTaskAttempts, 4);
    assert.equal(state.coverage.unrunRoutingAttempts, 2);
    assert.ok(state.scheduledTasks.every((slot) => slot.status === "unrun"));
    await assert.rejects(readFile(paths.apiKeyFile));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("main transports only approved Grok calls through captured fetch while default fetch stays denied", async (t) => {
  const { paths } = await sandbox(t);
  const declaration = JSON.parse(
    await readFile(paths.qualificationFile, "utf8"),
  );
  declaration.qualified = false;
  await writeFile(paths.qualificationFile, JSON.stringify(declaration));
  await writeFile(paths.apiKeyFile, "SYNTHETIC_EXISTING_GATEWAY_KEY", {
    mode: 0o600,
  });
  const sdk = await import("@earendil-works/pi-coding-agent");
  const originalFetch = globalThis.fetch;
  const requests = [];
  const approvedFetch = async (url, options) => {
    assert.equal(url, `${ROUTING_WORKFLOW_ORIGIN}/v1/chat/completions`);
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.equal(
      options.headers.authorization,
      "Bearer SYNTHETIC_EXISTING_GATEWAY_KEY",
    );
    const body = JSON.parse(options.body);
    assert.equal(body.model, ROUTING_WORKFLOW_MODEL);
    assert.equal(Object.hasOwn(body, "temperature"), false);
    requests.push(body);
    const value = body.messages.at(-1).content.includes("unavailable")
      ? null
      : 7;
    return new Response(
      JSON.stringify({
        model: ROUTING_WORKFLOW_MODEL,
        choices: [
          {
            message: { role: "assistant", content: JSON.stringify({ value }) },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          total_tokens: 105,
          prompt_tokens_details: { cached_tokens: 40 },
        },
      }),
    );
  };
  globalThis.fetch = approvedFetch;
  let deniedStartupFetch = false,
    disposed = false;
  const deps = {
    prepare: (options) => prepareRoutingWorkflow(options, { sourcePaths: {} }),
    async loadRuntime() {
      try {
        await globalThis.fetch("https://unapproved.invalid/startup");
      } catch {
        deniedStartupFetch = true;
      }
      return {
        dispatcher: { createRoutingDispatcher },
        gateway: { createGatewayTransport, parseStrictJsonObject },
        evaluator,
        sdk,
        streams: { createAssistantMessageEventStream },
        classifierModule: {
          async createWorkflowClassifier() {
            return {
              encoderMode: "operational",
              async classify() {
                throw new Error("Unqualified control must not classify");
              },
              async dispose() {
                disposed = true;
              },
            };
          },
        },
      };
    },
  };
  try {
    assert.equal((await quietMain(cliFlags(paths), deps)).code, 0);
    const frozenProtocol = await readFile(
      `${paths.output}.protocol.json`,
      "utf8",
    );
    const run = await quietMain(cliFlags(paths, true), deps);
    assert.equal(run.code, 1); // Functional all-strong control cannot qualify.
    assert.equal(deniedStartupFetch, true);
    assert.equal(disposed, true);
    assert.equal(requests.length, 4);
    assert.equal(globalThis.fetch, approvedFetch);
    const state = JSON.parse(await readFile(paths.output, "utf8"));
    assert.equal(state.status, "completed");
    assert.equal(state.coverage.unrunTaskAttempts, 0);
    assert.equal(state.attempts.filter((attempt) => attempt.passed).length, 4);
    assert.equal(state.summary.passed, false);
    assert.equal(state.realExecution, false);
    assert.ok(
      !JSON.stringify(state).includes("SYNTHETIC_EXISTING_GATEWAY_KEY"),
    );
    assert.equal(
      await readFile(`${paths.output}.protocol.json`, "utf8"),
      frozenProtocol,
    );
    await assert.rejects(quietMain(cliFlags(paths, true), deps));
    assert.equal(requests.length, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("qualification cannot bind a different artifact or infer qualification from absent evidence", () => {
  assert.equal(
    normalizeWorkflowQualification(qualification, artifactSha256).qualified,
    true,
  );
  assert.equal(
    normalizeWorkflowQualification(qualification, "c".repeat(64)).qualified,
    false,
  );
  assert.equal(
    normalizeWorkflowQualification({ artifactId }, artifactSha256).qualified,
    false,
  );
});

test("simultaneous execution claims have one owner before any auth or model work", async (t) => {
  const { paths } = await sandbox(t);
  const protocolBytes = '{"synthetic_protocol":true}\n';
  await writeFile(
    paths.output,
    JSON.stringify({
      status: "prepared",
      protocol_sha256: hash(protocolBytes),
      attempts: [],
      routing: [],
    }),
  );
  const results = await Promise.allSettled([
    claimPreparedRoutingWorkflow(paths.output, protocolBytes),
    claimPreparedRoutingWorkflow(paths.output, protocolBytes),
  ]);
  assert.equal(
    results.filter((entry) => entry.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter((entry) => entry.status === "rejected").length,
    1,
  );
  assert.equal(
    JSON.parse(await readFile(paths.output, "utf8")).status,
    "running",
  );
  assert.equal(
    JSON.parse(await readFile(`${paths.output}.execution-claim.json`, "utf8"))
      .protocol_sha256,
    hash(protocolBytes),
  );
  await assert.rejects(
    claimPreparedRoutingWorkflow(paths.output, protocolBytes),
  );
});

test("a different protocol cannot claim a prepared run", async (t) => {
  const { paths } = await sandbox(t);
  await writeFile(
    paths.output,
    JSON.stringify({
      status: "prepared",
      protocol_sha256: hash("original"),
      attempts: [],
    }),
  );
  await assert.rejects(claimPreparedRoutingWorkflow(paths.output, "modified"));
  await assert.rejects(readFile(`${paths.output}.execution-claim.json`));
});

test("cleanup failure invalidates a success summary and terminal exit without retaining private cause", async (t) => {
  const { paths } = await sandbox(t);
  const state = {
    status: "completed",
    summary: { passed: true },
    attempts: [],
  };
  const terminalCode = await finishRoutingWorkflow({
    state,
    output: paths.output,
    terminalCode: 0,
    classifier: {
      async dispose() {
        throw new Error("SYNTHETIC_PRIVATE_CLEANUP_CAUSE");
      },
    },
  });
  assert.equal(terminalCode, 1);
  assert.equal(state.status, "failed");
  assert.equal(state.summary.passed, false);
  const saved = await readFile(paths.output, "utf8");
  assert.ok(!saved.includes("SYNTHETIC_PRIVATE"));
});

test("provider emits actual Pi start/done protocol and preserves cancellation signal", async () => {
  const controller = new AbortController();
  let observedSignal;
  const provider = createWorkflowGatewayProvider({
    transport: fakeTransport(),
    createEventStream: createAssistantMessageEventStream,
    maxTokens: 2048,
    observe: (event) => {
      if (event.signal) observedSignal = event.signal;
    },
  });
  const model = {
    provider: "jev-workflow-fast",
    id: ROUTING_WORKFLOW_MODEL,
    api: "openai-completions",
  };
  const stream = provider.streamSimple(model, piContext(cases()[0]), {
    signal: controller.signal,
  });
  const events = [];
  for await (const event of stream) events.push(event);
  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "done"],
  );
  assert.equal(observedSignal, controller.signal);
  assert.equal(events[1].message.provider, model.provider);
});

test("fixed-Grok comparison dispatches current selected prompt and preserves full counterbalanced population", async () => {
  const calls = [],
    seen = [],
    checkpoints = [];
  const snapshot = prepared();
  const execution = await executeRoutingWorkflow(
    snapshot,
    dependencies({
      calls,
      seen,
      onCheckpoint: (state) => checkpoints.push(state.attempts.length),
    }),
  );
  assert.equal(execution.attempts.length, 4);
  assert.equal(execution.routing.length, 2);
  assert.deepEqual(
    execution.routing.map((entry) => entry.decision),
    ["fast", "strong"],
  );
  assert.deepEqual(
    execution.attempts.map((entry) => entry.dispatchedModel.provider),
    [
      "jev-workflow-fast",
      "jev-workflow-strong",
      "jev-workflow-strong",
      "jev-workflow-strong",
    ],
  );
  assert.ok(execution.attempts.every((entry) => entry.passed === true));
  assert.equal(seen.length, 2);
  assert.equal(calls.length, 4);
  assert.deepEqual(checkpoints, [1, 2, 3, 4]);
  for (const context of seen) {
    const serialized = JSON.stringify(context);
    assert.ok(!serialized.includes("host-only-family"));
    assert.ok(!serialized.includes("essentialFactsAvailable"));
    assert.ok(!serialized.includes('"expected"'));
  }
  const summary = summarizeRoutingWorkflow(snapshot, execution, evaluator);
  assert.equal(summary.developmentGatesPassed, true);
  assert.equal(summary.passed, false);
  assert.equal(summary.practicalBenefitEstablished, false);
  assert.equal(summary.repetitions[0].routing.qualificationEligible, false);
});

test("all-strong unqualified controls remain functional but cannot pass routing acceptance", async () => {
  const snapshot = prepared();
  snapshot.protocol.qualification = { ...qualification, qualified: false };
  const seen = [];
  const execution = await executeRoutingWorkflow(
    snapshot,
    dependencies({ seen }),
  );
  assert.equal(seen.length, 0);
  assert.ok(execution.routing.every((entry) => entry.decision === "strong"));
  assert.ok(execution.attempts.every((entry) => entry.passed));
  const summary = summarizeRoutingWorkflow(snapshot, execution, evaluator);
  assert.equal(summary.passed, false);
  assert.equal(summary.repetitions[0].routing.allStrong, true);
});

test("cached encoder controls cannot qualify operational router latency", async () => {
  const snapshot = prepared();
  const execution = await executeRoutingWorkflow(
    snapshot,
    dependencies({ encoderMode: "cached" }),
  );
  assert.equal(execution.qualification.qualified, false);
  assert.equal(
    summarizeRoutingWorkflow(snapshot, execution, evaluator).passed,
    false,
  );
});

test("a classifier error falls back safely but remains a routing error when task completion succeeds", async () => {
  const snapshot = prepared();
  const deps = dependencies();
  deps.classifier.classify = async () => {
    throw new Error("SYNTHETIC_PRIVATE_CLASSIFIER_ERROR");
  };
  const execution = await executeRoutingWorkflow(snapshot, deps);
  assert.ok(execution.attempts.every((attempt) => attempt.passed === true));
  assert.ok(
    execution.routing.every(
      (attempt) => attempt.error === "routing_classifier_error",
    ),
  );
  assert.ok(
    execution.routing.every((attempt) => attempt.decision === "strong"),
  );
  assert.ok(!JSON.stringify(execution).includes("SYNTHETIC_PRIVATE"));
  assert.equal(
    summarizeRoutingWorkflow(snapshot, execution, evaluator)
      .developmentGatesPassed,
    false,
  );
});

test("a mismatched classifier artifact cannot be silently qualified after safe strong fallback", async () => {
  const snapshot = prepared();
  const execution = await executeRoutingWorkflow(
    snapshot,
    dependencies({
      classification: {
        route: "fast",
        complete: true,
        artifactId: "different",
        artifactSha256,
        confidence: 1,
      },
    }),
  );
  assert.ok(execution.attempts.every((attempt) => attempt.passed === true));
  assert.ok(
    execution.routing.every(
      (attempt) => attempt.error === "classification-artifact-mismatch",
    ),
  );
  assert.equal(
    summarizeRoutingWorkflow(snapshot, execution, evaluator).passed,
    false,
  );
});

test("reported cached feature replay remains a disqualifying error even under an operational adapter label", async () => {
  const snapshot = prepared();
  const execution = await executeRoutingWorkflow(
    snapshot,
    dependencies({
      classification: {
        route: "strong",
        complete: true,
        artifactId,
        artifactSha256,
        featuresFromCache: true,
        featureCacheElapsedMs: 0.01,
      },
    }),
  );
  assert.ok(
    execution.routing.every(
      (attempt) =>
        attempt.error === "cached_features_do_not_qualify_operational_routing",
    ),
  );
  assert.equal(
    summarizeRoutingWorkflow(snapshot, execution, evaluator).passed,
    false,
  );
});

test("task errors remain in all scheduled denominators and private exceptions are suppressed", async () => {
  const snapshot = prepared();
  const execution = await executeRoutingWorkflow(
    snapshot,
    dependencies({ mode: "private-error" }),
  );
  assert.equal(execution.attempts.length, 4);
  assert.equal(execution.routing.length, 2);
  assert.equal(execution.attempts[0].error.code, "workflow_provider_error");
  assert.equal(execution.attempts[0].usage, null);
  assert.ok(!JSON.stringify(execution).includes("SYNTHETIC_PRIVATE"));
  const summary = summarizeRoutingWorkflow(snapshot, execution, evaluator);
  assert.equal(summary.passed, false);
  assert.equal(summary.repetitions[0].downstream.selected.answers.scheduled, 2);
});

test("known incomplete completion usage is retained while the answer fails", async () => {
  const execution = await executeRoutingWorkflow(
    prepared(),
    dependencies({ mode: "incomplete" }),
  );
  assert.equal(execution.attempts[0].error.code, "incomplete_completion");
  assert.equal(execution.attempts[0].usage.totalTokens, 30);
  assert.equal(execution.attempts[0].passed, null);
});

test("task abort is consumed, records unknown usage, and preserves every remaining scheduled slot", async () => {
  const snapshot = prepared();
  snapshot.protocol.settings.timeout_ms = 15;
  const execution = await executeRoutingWorkflow(
    snapshot,
    dependencies({ mode: "abort" }),
  );
  assert.equal(execution.attempts.length, 4);
  assert.equal(execution.attempts[0].error.code, "aborted");
  assert.equal(execution.attempts[0].usage, null);
  assert.ok(
    execution.attempts.slice(1).every((attempt) => attempt.passed === true),
  );
  assert.equal(
    summarizeRoutingWorkflow(snapshot, execution, evaluator).passed,
    false,
  );
});

test("HTTP status is retained without private response content or invented usage", async () => {
  const execution = await executeRoutingWorkflow(
    prepared(),
    dependencies({ mode: "http-error" }),
  );
  assert.equal(execution.attempts[0].error.code, "http_error");
  assert.equal(execution.attempts[0].error.httpStatus, 503);
  assert.equal(execution.attempts[0].usage, null);
});

test("unknown usage remains unknown instead of becoming Pi compatibility zero counters", async () => {
  const snapshot = prepared();
  const execution = await executeRoutingWorkflow(
    snapshot,
    dependencies({ mode: "unknown-usage" }),
  );
  assert.equal(execution.attempts[0].usage.promptTokens, null);
  assert.equal(execution.attempts[0].usage.cachedPromptTokens, null);
  const summary = summarizeRoutingWorkflow(snapshot, execution, evaluator);
  assert.equal(
    summary.repetitions[0].downstream.selected.usage.metrics.inputTokens.total,
    null,
  );
});

test("duplicate-key JSON and incorrect literal answers cannot silently pass", async () => {
  for (const mode of ["duplicate", "wrong"]) {
    const snapshot = prepared();
    const execution = await executeRoutingWorkflow(
      snapshot,
      dependencies({ mode }),
    );
    assert.equal(execution.attempts.length, 4);
    assert.equal(execution.attempts[0].passed, false);
    assert.equal(
      summarizeRoutingWorkflow(snapshot, execution, evaluator).passed,
      false,
    );
  }
});

test("missing expected target stays an unavailable answer check in full population", async () => {
  const records = cases();
  delete records[0].expected;
  const snapshot = prepared(records);
  const execution = await executeRoutingWorkflow(snapshot, dependencies());
  assert.equal(execution.attempts[0].passed, null);
  const summary = summarizeRoutingWorkflow(snapshot, execution, evaluator);
  assert.equal(summary.passed, false);
  assert.equal(
    summary.repetitions[0].downstream.selected.answers.unavailable,
    1,
  );
});

test("multiple repetitions each retain a complete independent scheduled denominator", async () => {
  const snapshot = prepared(cases(), 2);
  const execution = await executeRoutingWorkflow(snapshot, dependencies());
  const summary = summarizeRoutingWorkflow(snapshot, execution, evaluator);
  assert.equal(execution.attempts.length, 8);
  assert.equal(execution.routing.length, 4);
  assert.equal(summary.repetitions.length, 2);
  assert.ok(
    summary.repetitions.every((entry) => entry.routing.scheduled === 2),
  );
});

test("development success alone cannot establish the full frozen qualification population", async () => {
  const records = Array.from({ length: 60 }, (_, index) => ({
    ...cases()[index < 20 ? 0 : 1],
    id: `invented-control-${index}`,
    family: `invented-family-${index % 4}`,
    label: index < 20 ? "easy" : index < 40 ? "hard" : "unknown",
  }));
  const snapshot = prepared(records);
  snapshot.protocol.workflow_qualification = {
    independentEvaluation: true,
    requiredFamilies: [
      "invented-family-0",
      "invented-family-1",
      "invented-family-2",
      "invented-family-3",
    ],
    sourceIdentity: "invented-source-identity",
    artifactIdentity: artifactSha256,
  };
  const execution = await executeRoutingWorkflow(snapshot, dependencies());
  assert.equal(
    summarizeRoutingWorkflow(snapshot, execution, evaluator)
      .developmentGatesPassed,
    true,
  );
  assert.equal(
    summarizeRoutingWorkflow(snapshot, execution, evaluator).passed,
    false,
  );
  // This is only a synthetic gate test; production sets realExecution after
  // choosing the actual bounded configured-gateway transport and SDK path.
  execution.realExecution = true;
  assert.equal(
    summarizeRoutingWorkflow(snapshot, execution, evaluator).passed,
    true,
  );
  const missingPopulation = {
    ...execution,
    routing: execution.routing.slice(1),
  };
  assert.equal(
    summarizeRoutingWorkflow(snapshot, missingPopulation, evaluator).passed,
    false,
  );
});

test("unexpected tools, images, or non-text messages cannot cross the provider task boundary", () => {
  assert.throws(() =>
    gatewayMessagesFromPiContext({
      messages: [{ role: "toolResult", content: "private" }],
    }),
  );
  assert.throws(() =>
    gatewayMessagesFromPiContext({
      messages: [{ role: "user", content: [{ type: "image", data: "..." }] }],
    }),
  );
});

test("actual Pi SDK prompt executes one current-prompt dispatcher stream without any network", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jev-routing-real-pi-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(directory, { recursive: true });
  const records = [cases()[0]];
  const snapshot = prepared(records);
  const calls = [];
  const realSdk = await import("@earendil-works/pi-coding-agent");
  const setupErrors = [];
  const sdk = {
    ...realSdk,
    ModelRuntime: {
      async create(...args) {
        try {
          return await realSdk.ModelRuntime.create(...args);
        } catch (error) {
          setupErrors.push(error.message);
          throw error;
        }
      },
    },
    async createAgentSession(...args) {
      try {
        return await realSdk.createAgentSession(...args);
      } catch (error) {
        setupErrors.push(error.message);
        throw error;
      }
    },
  };
  const originalFetch = globalThis.fetch;
  let unexpectedRequests = 0;
  globalThis.fetch = async () => {
    unexpectedRequests++;
    throw new Error("CPU test denied every actual network request");
  };
  try {
    const deps = dependencies({ calls });
    delete deps.executeTask;
    deps.sdk = sdk;
    deps.workspace = directory;
    const execution = await executeRoutingWorkflow(snapshot, deps);
    assert.equal(unexpectedRequests, 0);
    assert.equal(
      calls.length,
      2,
      JSON.stringify({ setupErrors, attempts: execution.attempts }),
    );
    assert.ok(
      execution.attempts.every((entry) => entry.passed === true),
      JSON.stringify(execution.attempts),
    );
    assert.ok(execution.attempts.every((entry) => entry.streamCalls === 1));
    assert.equal(
      execution.attempts[0].dispatchedModel.provider,
      "jev-workflow-fast",
    );
    assert.equal(
      execution.attempts[1].dispatchedModel.provider,
      "jev-workflow-strong",
    );
    assert.ok(
      calls.every((call) =>
        call.messages[0].content.startsWith(ROUTING_WORKFLOW_SYSTEM),
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
