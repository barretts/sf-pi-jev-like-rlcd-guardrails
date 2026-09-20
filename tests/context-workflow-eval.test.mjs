import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import {
  GATEWAY_ORIGIN,
  GATEWAY_MODEL,
  GROK_WORKFLOW_COMPATIBILITY,
  taskPrompt,
  validateCorpus,
  workflowSchedule,
  selectedGrokRegistration,
  prepareWorkflow,
  executeWorkflow,
  createSdkFetch,
  aggregateUsage,
  sseObservation,
  redactEvidence,
  summarizeWorkflow,
  verifyLiveCompression,
  safeRetryAfter,
  createRequestPacer,
  createPacedGatewayFetch,
  workflowConsoleProjection,
  safeExtensionFailure,
  cleanupOwnedSession,
} from "../scripts/context-workflow-eval.mjs";

const root = resolve(import.meta.dirname, "..");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const record = {
  id: "cpu-case",
  family: "invented-cpu",
  question: 'Return {"state":string}.',
  toolText: "state=ok\n".repeat(200),
  expected: { state: "ok" },
};
const configuredModels = {
  providers: {
    llmgw: {
      api: "openai-completions",
      baseUrl: `${GATEWAY_ORIGIN}/v1`,
      apiKey: "!never-execute-this-command",
      headers: { Authorization: "private-test-placeholder" },
      models: [
        {
          id: GATEWAY_MODEL,
          name: "private name is not projected",
          reasoning: false,
          contextWindow: 500_000,
          maxTokens: 500_000,
        },
        { id: "unrelated-model", secret: "unrelated-private-placeholder" },
      ],
    },
    unrelated: { apiKey: "unrelated-private-placeholder" },
  },
};
const testCodec = {
  compactToolText(text) {
    return {
      format: "identity",
      applied: false,
      originalSha256: hash(text),
      compressedSha256: hash(text),
      originalBytes: Buffer.byteLength(text),
      compressedBytes: Buffer.byteLength(text),
      originalLineCount: text.split("\n").length - 1,
      modelVisibleText: text,
    };
  },
  expandCompactToolText(encoded) {
    return encoded.modelVisibleText;
  },
};

async function withTemporaryFiles(fn) {
  await mkdir(join(root, ".build"), { recursive: true });
  const dir = await mkdtemp(join(root, ".build/context-workflow-cpu-"));
  try {
    const fixture = join(dir, "fixture.json");
    const modelsFile = join(dir, "models.json");
    const sourceFile = join(dir, "source.txt");
    await writeFile(fixture, JSON.stringify({ cases: [record] }));
    await writeFile(modelsFile, JSON.stringify(configuredModels));
    await writeFile(sourceFile, "invented CPU-only source identity\n");
    await fn({ dir, fixture, modelsFile, sourceFile });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function requestBody(extra = {}) {
  return JSON.stringify({
    model: GATEWAY_MODEL,
    stream: true,
    max_tokens: 4096,
    messages: [{ role: "user", content: "CPU-only request" }],
    tools: [{ type: "function", function: { name: "read" } }],
    ...extra,
  });
}

function wireResponse(
  usage = {
    prompt_tokens: 10,
    completion_tokens: 2,
    total_tokens: 12,
    prompt_tokens_details: { cached_tokens: 3 },
  },
) {
  return `data: ${JSON.stringify({ model: GATEWAY_MODEL, choices: [{ index: 0, finish_reason: "stop", delta: { content: "{}" } }] })}\n\ndata: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`;
}

test("fresh corpus rejects duplicate IDs and malformed host gold", () => {
  assert.deepEqual(validateCorpus({ cases: [record] }), [record]);
  assert.throws(() => validateCorpus([record, record]), /Duplicate/);
  assert.throws(
    () => validateCorpus([{ ...record, expected: [] }]),
    /expected/,
  );
  assert.throws(() => validateCorpus([{ ...record, id: "../escape" }]));
});

test("each pair has both arms and opposite repetition order", () => {
  const schedule = workflowSchedule([record, { ...record, id: "second" }], 2);
  assert.equal(schedule.length, 4);
  assert.deepEqual(
    schedule.map((pair) => pair.arms.map((arm) => arm.arm)),
    [
      ["baseline", "compact"],
      ["compact", "baseline"],
      ["compact", "baseline"],
      ["baseline", "compact"],
    ],
  );
  assert.equal(
    new Set(schedule.flatMap((pair) => pair.arms.map((arm) => arm.id))).size,
    8,
  );
  assert.throws(() => workflowSchedule([record], 1), /even/);
});

test("provider projection excludes credentials, commands and unrelated catalog", async () => {
  await withTemporaryFiles(async ({ modelsFile }) => {
    const projected = await selectedGrokRegistration(modelsFile);
    const serialized = JSON.stringify(projected);
    assert.equal(projected.id, GATEWAY_MODEL);
    assert.deepEqual(projected.effectiveCompatibility, {
      maxTokensField: "max_tokens",
      supportsStore: false,
      supportsStrictMode: false,
    });
    for (const forbidden of [
      "never-execute",
      "Authorization",
      "private-test",
      "unrelated",
      "private name",
    ])
      assert.ok(!serialized.includes(forbidden));
  });
});

test("offline preparation freezes host gold and prompts without resolving auth or fetching", async () => {
  await withTemporaryFiles(async ({ dir, fixture, modelsFile, sourceFile }) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("Unexpected network action in preparation");
    };
    try {
      const prepared = await prepareWorkflow({
        fixture,
        modelsFile,
        output: join(dir, "run"),
        testCodec,
        testSourceFiles: [sourceFile],
      });
      assert.equal(prepared.protocol.evidenceMode, "injected-cpu-test");
      assert.equal(
        prepared.protocol.schedule.flatMap((pair) => pair.arms).length,
        8,
      );
      assert.equal(prepared.protocol.parameters.concurrency, 4);
      assert.ok(!taskPrompt(record).includes(JSON.stringify(record.expected)));
      assert.ok(!taskPrompt(record).includes(record.toolText));
      const protocol = await readFile(
        join(prepared.directory, "protocol.json"),
        "utf8",
      );
      assert.ok(!protocol.includes("never-execute"));
      assert.ok(!protocol.includes("unrelated-private"));
      assert.equal(hash(protocol), prepared.protocolSha256);
      assert.deepEqual(
        JSON.parse(
          await readFile(join(prepared.directory, "fixture.freeze.json")),
        ).cases[0].expected,
        record.expected,
      );
      await assert.rejects(
        prepareWorkflow({
          fixture,
          modelsFile,
          output: prepared.directory,
          testCodec,
          testSourceFiles: [sourceFile],
        }),
        /EEXIST/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("SSE observations require complete numeric usage and retain cache", () => {
  const observed = sseObservation(wireResponse());
  assert.equal(observed.done, true);
  assert.deepEqual(observed.finishReasons, ["stop"]);
  assert.equal(observed.usage.complete, true);
  assert.equal(observed.usage.uncachedPromptTokens, 7);
  assert.equal(
    sseObservation(
      wireResponse({
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
      }),
    ).usage.complete,
    false,
  );
  assert.equal(
    sseObservation(
      wireResponse({
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        prompt_tokens_details: { cached_tokens: 20 },
      }),
    ).usage.complete,
    false,
  );
  assert.equal(sseObservation("data: invalid\n\n").protocolError, true);
});

test("strict streamed terminal identity rejects duplicate keys and incomplete or drifting models", () => {
  assert.equal(
    sseObservation(
      wireResponse().replace('"finish_reason":"stop"', '"finish_reason":null'),
    ).protocolError,
    true,
  );
  assert.equal(
    sseObservation(
      wireResponse().replace(
        '"model":"grok-4.6"',
        '"model":"grok-4.6","model":"grok-4.6"',
      ),
    ).protocolError,
    true,
  );
  assert.equal(
    sseObservation(
      wireResponse().replace(
        '"model":"grok-4.6"',
        '"model":"unapproved-other"',
      ),
    ).protocolError,
    true,
  );
  assert.equal(
    sseObservation(wireResponse().replace('"model":"grok-4.6",', ""))
      .protocolError,
    true,
  );
  assert.equal(
    sseObservation(wireResponse() + "data: [DONE]\n\n").protocolError,
    true,
  );
  assert.equal(
    sseObservation(wireResponse() + 'data: {"choices":[]}\n\n').protocolError,
    true,
  );
  assert.equal(
    sseObservation(
      wireResponse().replace(
        '"choices":[{"index":0,',
        '"choices":[{"index":0,"delta":{}},{"index":0,',
      ),
    ).protocolError,
    true,
  );
  const terminal = wireResponse().replace(
    "data: [DONE]\n\n",
    'data: {"choices":[{"index":0,"delta":{"content":"late unauthorized content"}}]}\n\ndata: [DONE]\n\n',
  );
  assert.equal(sseObservation(terminal).protocolError, true);
});

test("SDK adapter keeps streamed bytes unchanged and safe receipts never contain auth", async () => {
  const receipts = [];
  let seen;
  const credential = "cpu-placeholder-credential-value";
  const wire = wireResponse();
  const fetch = createSdkFetch({
    receipts,
    maxTokens: 4096,
    maxTurns: 4,
    timeoutMs: 1000,
    credential,
    fetchImpl: async (_input, init) => {
      seen = init;
      return new Response(wire, { status: 200 });
    },
  });
  const response = await fetch(`${GATEWAY_ORIGIN}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${credential}` },
    body: requestBody({ messages: [{ role: "user", content: credential }] }),
  });
  assert.equal(await response.text(), wire);
  assert.equal(seen.redirect, "error");
  assert.equal(receipts[0].completed, true);
  assert.equal(receipts[0].responseSha256, hash(wire));
  assert.ok(!JSON.stringify(receipts).includes(credential));
  assert.equal(aggregateUsage(receipts).totals.promptTokens, 10);
});

test("SDK adapter rejects redirect destinations, model drift and temperature before fetch", async () => {
  let calls = 0;
  for (const [url, body] of [
    ["https://example.invalid/v1/chat/completions", requestBody()],
    [`${GATEWAY_ORIGIN}/v1/chat/completions?x=1`, requestBody()],
    [`${GATEWAY_ORIGIN}/v1/chat/completions`, requestBody({ model: "other" })],
    [`${GATEWAY_ORIGIN}/v1/chat/completions`, requestBody({ temperature: 0 })],
    [`${GATEWAY_ORIGIN}/v1/chat/completions`, requestBody({ store: false })],
    [
      `${GATEWAY_ORIGIN}/v1/chat/completions`,
      requestBody({
        tools: [
          { type: "function", function: { name: "read", strict: false } },
        ],
      }),
    ],
  ]) {
    const receipts = [];
    const fetch = createSdkFetch({
      receipts,
      maxTokens: 4096,
      maxTurns: 4,
      timeoutMs: 1000,
      fetchImpl: async () => {
        calls++;
        return new Response(wireResponse());
      },
    });
    await assert.rejects(
      fetch(url, { method: "POST", body }),
      /private details withheld/,
    );
    assert.equal(receipts[0].completed, false);
    assert.equal(receipts[0].usage, null);
  }
  assert.equal(calls, 0);
});

test("HTTP error bodies stay unread and the failure is unknown usage", async () => {
  const receipts = [];
  const fetch = createSdkFetch({
    receipts,
    maxTokens: 4096,
    maxTurns: 4,
    timeoutMs: 1000,
    fetchImpl: async () =>
      new Response("private response must not escape", { status: 401 }),
  });
  await assert.rejects(
    fetch(`${GATEWAY_ORIGIN}/v1/chat/completions`, {
      method: "POST",
      body: requestBody(),
    }),
    /private details withheld/,
  );
  assert.ok(!JSON.stringify(receipts).includes("private response"));
  assert.equal(aggregateUsage(receipts).complete, false);
  assert.equal(aggregateUsage(receipts).totals, null);
});

test("fetch deadline races transports ignoring signal and cancels late bodies", async () => {
  const receipts = [];
  let release;
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
  );
  const fetch = createSdkFetch({
    receipts,
    maxTokens: 4096,
    maxTurns: 4,
    timeoutMs: 5,
    fetchImpl: () =>
      new Promise((resolvePromise) => {
        release = resolvePromise;
      }),
  });
  await assert.rejects(
    fetch(`${GATEWAY_ORIGIN}/v1/chat/completions`, {
      method: "POST",
      body: requestBody(),
    }),
    /private details withheld/,
  );
  assert.equal(receipts[0].error, "timeout_unknown_usage");
  release(response);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(cancelled, true);
});

test("stream deadline races a reader that never produces any data", async () => {
  const receipts = [];
  const fetch = createSdkFetch({
    receipts,
    maxTokens: 4096,
    maxTurns: 4,
    timeoutMs: 5,
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          pull() {
            return new Promise(() => {});
          },
        }),
      ),
  });
  const response = await fetch(`${GATEWAY_ORIGIN}/v1/chat/completions`, {
    method: "POST",
    body: requestBody(),
  });
  await assert.rejects(response.text(), /stream failed/);
  assert.equal(receipts[0].completed, false);
  assert.equal(receipts[0].error, "aborted_or_timeout_unknown_usage");
});

test("turn budget includes failed attempts and blocks extra model requests", async () => {
  let calls = 0;
  const receipts = [];
  const fetch = createSdkFetch({
    receipts,
    maxTokens: 4096,
    maxTurns: 2,
    timeoutMs: 1000,
    fetchImpl: async () => {
      calls++;
      return new Response(wireResponse());
    },
  });
  for (let index = 0; index < 2; index++)
    await (
      await fetch(`${GATEWAY_ORIGIN}/v1/chat/completions`, {
        method: "POST",
        body: requestBody(),
      })
    ).text();
  await assert.rejects(
    fetch(`${GATEWAY_ORIGIN}/v1/chat/completions`, {
      method: "POST",
      body: requestBody(),
    }),
    /private details withheld/,
  );
  assert.equal(calls, 2);
  assert.equal(receipts.length, 3);
  assert.equal(aggregateUsage(receipts).complete, false);
});

test("bounded body failure cannot become complete zero-usage evidence", async () => {
  const receipts = [];
  const fetch = createSdkFetch({
    receipts,
    maxTokens: 4096,
    maxTurns: 4,
    timeoutMs: 1000,
    maxResponseBytes: 10,
    fetchImpl: async () => new Response(wireResponse()),
  });
  const response = await fetch(`${GATEWAY_ORIGIN}/v1/chat/completions`, {
    method: "POST",
    body: requestBody(),
  });
  await assert.rejects(response.text(), /stream failed/);
  assert.equal(receipts[0].completed, false);
  assert.equal(aggregateUsage(receipts).complete, false);
});

test("invalid streamed UTF-8 fails without replacement characters hiding corruption", async () => {
  const receipts = [];
  const wire = Buffer.concat([
    Buffer.from(wireResponse()),
    Buffer.from([0xc3, 0x28]),
  ]);
  const fetch = createSdkFetch({
    receipts,
    maxTokens: 4096,
    maxTurns: 4,
    timeoutMs: 1000,
    fetchImpl: async () => new Response(wire),
  });
  const response = await fetch(`${GATEWAY_ORIGIN}/v1/chat/completions`, {
    method: "POST",
    body: requestBody(),
  });
  await assert.rejects(response.text(), /stream failed/);
  assert.equal(receipts[0].completed, false);
});

test("no DONE marker keeps completed usage as unknown for that request", async () => {
  const receipts = [];
  const fetch = createSdkFetch({
    receipts,
    maxTokens: 4096,
    maxTurns: 4,
    timeoutMs: 1000,
    fetchImpl: async () =>
      new Response(wireResponse().replace("data: [DONE]\n\n", "")),
  });
  await (
    await fetch(`${GATEWAY_ORIGIN}/v1/chat/completions`, {
      method: "POST",
      body: requestBody(),
    })
  ).text();
  assert.equal(receipts[0].completed, false);
  assert.equal(receipts[0].error, "incomplete_or_malformed_provider_stream");
  assert.equal(aggregateUsage(receipts).totals, null);
});

test("failed and unrun population stays in qualification denominators", () => {
  const protocol = { schedule: workflowSchedule([record], 2) };
  const receipt = {
    completed: true,
    usage: sseObservation(wireResponse()).usage,
  };
  const run = {
    id: protocol.schedule[0].arms[0].id,
    arm: "baseline",
    status: "completed",
    passed: true,
    answerAccepted: true,
    acceptedAnswerTimeMs: 12,
    workflowElapsedMs: 14,
    usage: aggregateUsage([receipt]),
  };
  const summary = summarizeWorkflow(protocol, [run]);
  assert.equal(summary.scheduledSessions, 4);
  assert.equal(summary.unrunSessions, 3);
  assert.equal(summary.arms.baseline.acceptanceRateFullPopulation, 0.5);
  assert.equal(summary.arms.compact.acceptanceRateFullPopulation, 0);
  assert.equal(summary.arms.baseline.usageComplete, false);
  assert.equal(summary.passed, false);
  assert.equal(summary.productionImprovementQualified, false);
  assert.throws(() => summarizeWorkflow(protocol, [run, run]), /Duplicate/);
});

test("correct answers from failed workflows cannot count as accepted work or full performance evidence", () => {
  const protocol = {
    schedule: workflowSchedule([record], 2),
    cases: [{ id: record.id, compression: { applied: true } }],
  };
  const usage = aggregateUsage([
    { completed: true, usage: sseObservation(wireResponse()).usage },
  ]);
  const runs = protocol.schedule.flatMap((pair, repetition) =>
    pair.arms.map((slot) => ({
      id: slot.id,
      arm: slot.arm,
      status: repetition === 0 ? "completed" : "error",
      // Deliberately stale booleans exercise old result interpretation.
      passed: true,
      answerCorrect: true,
      answerAccepted: true,
      acceptedAnswerTimeMs: repetition === 0 ? 10 : 9999,
      workflowElapsedMs: repetition === 0 ? 12 : 10001,
      usage,
      liveCompression: { passed: true },
    })),
  );
  const summary = summarizeWorkflow(protocol, runs);
  for (const arm of ["baseline", "compact"]) {
    const measured = summary.arms[arm];
    assert.equal(measured.scheduled, 2);
    assert.equal(measured.completed, 1);
    assert.equal(measured.errors, 1);
    assert.equal(measured.acceptedAnswers, 1);
    assert.equal(measured.acceptanceRateFullPopulation, 0.5);
    assert.equal(measured.correctFinalAnswerObservations, 2);
    assert.equal(measured.correctAnswersInFailedWorkflows, 1);
    assert.equal(measured.acceptedAnswerTimeP50Ms, 10);
    assert.equal(measured.acceptedAnswerTimeP95Ms, 10);
    assert.equal(measured.usageComplete, true);
    assert.equal(measured.usage.totalTokens, 24);
    assert.equal(summary.eligibilityUsage[arm].complete, false);
    assert.equal(summary.eligibilityUsage[arm].promptTokens, null);
    assert.equal(
      summary.eligibilityUsage[arm].observedPromptTokensLowerBound,
      20,
    );
  }
  assert.equal(summary.fullCoverage, false);
  assert.equal(summary.passed, false);
  assert.equal(summary.strata[0].observedPairs, 2);
  assert.equal(summary.strata[0].completedPairs, 1);
  assert.equal(summary.strata[0].acceptedPairs, 1);
  assert.equal(summary.measuredChanges.acceptedPairs, 1);
  for (const metric of [
    "promptTokenReductionFraction",
    "completionTokenChangeFraction",
    "totalTokenChangeFraction",
    "uncachedPromptTokenChangeFraction",
    "eligiblePromptTokenReductionFraction",
    "medianPairedWorkflowElapsedRatio",
    "aggregateWorkflowElapsedRatio",
    "pairedAcceptedAnswerTimeDeltaSumMs",
  ])
    assert.equal(summary.measuredChanges[metric], null, metric);
});

test("extension failure attribution uses only known basenames, events, classes and fixed categories", () => {
  const sfPath = "/invented/private-source/extensions/sf-devbar/index.ts";
  const failure = safeExtensionFailure(
    {
      extensionPath: sfPath,
      event: "agent_end",
      error: "ctx.ui.setStatus is not a function: invented-private-placeholder",
      stack:
        "TypeError: invented-private-placeholder\n at /invented/private-source/secret-file.ts:12",
    },
    [{ path: sfPath }],
  );
  assert.deepEqual(failure, {
    phase: "sdk_extension_callback",
    extension: "sf-devbar",
    event: "agent_end",
    exceptionClass: "TypeError",
    errorCode: "ui_api_missing",
  });
  const unknown = safeExtensionFailure(
    {
      extensionPath: "/invented/private-source/unknown-secret.ts",
      event: "invented_private_placeholder",
      error: "invented-private-placeholder",
      stack: "PrivateException: invented-private-placeholder",
    },
    [{ path: sfPath }],
  );
  assert.deepEqual(unknown, {
    phase: "sdk_extension_callback",
    extension: "inline-or-unknown",
    event: "unknown",
    exceptionClass: "unknown",
    errorCode: "extension_callback_error",
  });
  assert.equal(
    safeExtensionFailure({
      error: "Unapproved workflow network action blocked",
    }).errorCode,
    "network_fetch_denied",
  );
  const text = JSON.stringify([failure, unknown]);
  for (const forbidden of [
    "private-placeholder",
    "private-source",
    "secret-file",
    "unknown-secret",
    "PrivateException",
    "stack",
    "extensionPath",
  ])
    assert.ok(!text.includes(forbidden));
});

test("owned session cleanup preserves disposal after hung, throwing or reported-error shutdown", async () => {
  for (const mode of ["hang", "throw", "reported-error", "abort-throw"]) {
    const events = [];
    let reportedErrors = 0;
    let active = true;
    const cleanup = await cleanupOwnedSession(
      {
        abort() {
          events.push("abort");
          if (mode === "abort-throw") throw new Error("Invented abort failure");
        },
        extensionRunner: {
          emit(event) {
            assert.equal(event.type, "session_shutdown");
            assert.equal(
              active,
              true,
              "Shutdown must run before context invalidation",
            );
            events.push("shutdown");
            if (mode === "hang") return new Promise(() => {});
            if (mode === "throw") throw new Error("Invented shutdown failure");
            if (mode === "reported-error") reportedErrors++;
          },
        },
        dispose() {
          events.push("dispose");
          active = false;
        },
      },
      { timeoutMs: 5, extensionErrorCount: () => reportedErrors },
    );
    assert.deepEqual(events, ["abort", "shutdown", "dispose"], mode);
    assert.equal(cleanup.shutdownAttempted, true, mode);
    assert.equal(cleanup.dispose, "completed", mode);
    assert.equal(cleanup.affirmative, false, mode);
    assert.equal(
      cleanup.shutdownExtensionErrors,
      mode === "reported-error" ? 1 : 0,
      mode,
    );
    assert.equal(
      cleanup.shutdown,
      mode === "abort-throw" ? "completed" : "failed_or_unresolved",
      mode,
    );
  }
});

test("credential redaction applies recursively and strips provider headers", () => {
  const value = {
    a: [
      "secret-value",
      {
        headers: { authorization: "secret-value" },
        apiKey: "secret-value",
        normal: "quoted secret-value text",
      },
    ],
  };
  assert.deepEqual(redactEvidence(value, "secret-value"), {
    a: [
      "[credential withheld]",
      { normal: "quoted [credential withheld] text" },
    ],
  });
});

function actualSdkFakeResponse(body, toolCallId = "cpu-read-call") {
  const hasToolResult = body.messages.some(
    (message) => message.role === "tool",
  );
  const delta = hasToolResult
    ? { role: "assistant", content: JSON.stringify(record.expected) }
    : {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: toolCallId,
            type: "function",
            function: { name: "read", arguments: '{"path":"trace.txt"}' },
          },
        ],
      };
  const chunks = [
    {
      id: "cpu-response",
      object: "chat.completion.chunk",
      created: 1,
      model: GATEWAY_MODEL,
      choices: [{ index: 0, delta, finish_reason: null }],
    },
    {
      id: "cpu-response",
      object: "chat.completion.chunk",
      created: 1,
      model: GATEWAY_MODEL,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: hasToolResult ? "stop" : "tool_calls",
        },
      ],
    },
    {
      id: "cpu-response",
      object: "chat.completion.chunk",
      created: 1,
      model: GATEWAY_MODEL,
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 110,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    },
  ];
  return new Response(
    chunks.map((chunk) => "data: " + JSON.stringify(chunk) + "\n\n").join("") +
      "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

test("actual installed SDK scopes omission of store and strict while preserving tools, output bound and streamed usage", async () => {
  const { streamSimple } =
    await import("../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js");
  const model = {
    id: GATEWAY_MODEL,
    name: "Public synthetic CPU compatibility probe",
    provider: "llmgw",
    api: "openai-completions",
    baseUrl: `${GATEWAY_ORIGIN}/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 500_000,
    maxTokens: 4096,
  };
  const context = {
    systemPrompt: "Public synthetic CPU serialization test.",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Read the public synthetic file trace.txt." },
        ],
        timestamp: 1,
      },
    ],
    tools: [
      {
        name: "read",
        description: "Read the public synthetic file.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    ],
  };
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("CPU serialization test prohibits real network");
  };
  try {
    for (const compat of [
      { maxTokensField: "max_tokens" },
      GROK_WORKFLOW_COMPATIBILITY,
    ]) {
      const result = await streamSimple({ ...model, compat }, context, {
        apiKey: "benign-invented-cpu-credential",
        maxTokens: 4096,
        fetch: async (_input, init) => {
          const body = JSON.parse(init.body);
          requests.push(body);
          return actualSdkFakeResponse(body);
        },
      }).result();
      assert.equal(result.stopReason, "toolUse");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  const [detectedDefaults, selectedOverrides] = requests;
  assert.equal(
    detectedDefaults.store,
    false,
    "Unknown proxy is detected as supporting optional store",
  );
  assert.equal(
    detectedDefaults.tools[0].function.strict,
    false,
    "Detected standard SDK tool path emits strict:false",
  );
  assert.ok(!("store" in selectedOverrides));
  assert.ok(!("strict" in selectedOverrides.tools[0].function));
  const withoutOptionalFields = structuredClone(detectedDefaults);
  delete withoutOptionalFields.store;
  delete withoutOptionalFields.tools[0].function.strict;
  assert.deepEqual(
    selectedOverrides,
    withoutOptionalFields,
    "Only the two declared optional fields may differ",
  );
  assert.equal(selectedOverrides.model, GATEWAY_MODEL);
  assert.equal(selectedOverrides.max_tokens, 4096);
  assert.deepEqual(selectedOverrides.stream_options, { include_usage: true });
  assert.ok(!("temperature" in selectedOverrides));
});

test("actual Pi SDK fake transport exercises read, live hook, canonical preservation and continuation", async () => {
  await withTemporaryFiles(async ({ dir, fixture, modelsFile }) => {
    const modules = ["context-compact", "context-extension", "gateway"];
    const testSourceFiles = modules.flatMap((name) => [
      join(root, "src", name + ".ts"),
      join(root, "dist", name + ".js"),
    ]);
    const codec = await import("../dist/context-compact.js");
    const output = join(dir, "actual-sdk-cpu");
    await prepareWorkflow({
      fixture,
      modelsFile,
      output,
      testCodec: codec,
      testSourceFiles,
      concurrency: 2,
    });
    const apiKeyFile = join(dir, "cpu-key.txt");
    await writeFile(apiKeyFile, "benign-invented-cpu-credential");
    const requests = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("No real network is permitted in CPU integration");
    };
    try {
      const result = await executeWorkflow({
        output,
        modelsFile,
        apiKeyFile,
        testFetch: async (_input, init) => {
          const body = JSON.parse(init.body);
          requests.push(body);
          assert.ok(
            !("store" in body),
            "Scoped Grok SDK compatibility must omit store",
          );
          assert.ok(
            body.tools.every((tool) => !("strict" in tool.function)),
            "Scoped Grok SDK compatibility must omit function.strict",
          );
          assert.deepEqual(
            body.stream_options,
            { include_usage: true },
            "Actual streamed usage remains requested",
          );
          assert.ok(
            !JSON.stringify(body).includes(JSON.stringify(record.expected)),
            "Host gold must not enter provider requests",
          );
          return actualSdkFakeResponse(body);
        },
      });
      assert.equal(result.evidenceMode, "injected-cpu-test");
      assert.equal(result.runs.length, 8);
      assert.equal(
        result.summary.functionalAndJudgeAcceptance,
        true,
        JSON.stringify(
          result.runs.map((run) => ({
            id: run.id,
            errors: run.errors,
            toolCalls: run.toolCalls,
            requests: run.providerRequests.map((request) => ({
              error: request.error,
              status: request.status,
            })),
          })),
        ),
      );
      assert.equal(requests.length, 16);
      assert.ok(
        result.runs.every((run) =>
          run.canonicalToolResults.every((tool) => tool.originalTextExact),
        ),
      );
      assert.ok(
        result.runs
          .filter((run) => run.arm === "compact")
          .every((run) => run.controllerStatus.compressedBlocks >= 1),
      );
      assert.ok(
        result.runs
          .filter((run) => run.arm === "baseline")
          .every((run) => run.controllerStatus.compressedBlocks === 0),
      );
      assert.ok(
        result.runs.every(
          (run) => run.usage.complete && run.usage.totals.totalTokens === 220,
        ),
      );
      const firstPair = result.runs.slice(0, 2);
      const systemCwd = firstPair.map(
        (run) =>
          run.providerRequests[0].request.messages
            .find((message) => message.role === "system")
            .content.match(/Current working directory: (.*)/)?.[1],
      );
      assert.equal(
        systemCwd[0],
        systemCwd[1],
        "Paired arms must share workspace path",
      );
      await assert.rejects(
        executeWorkflow({
          output,
          modelsFile,
          apiKeyFile,
          testFetch: async () => {
            throw new Error("Should never replay");
          },
        }),
        /EEXIST/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("default network deny covers SF session-start fetches before any model call", async () => {
  await withTemporaryFiles(async ({ dir, fixture, modelsFile }) => {
    const sfRoot = join(dir, "invented-sf-factories");
    await mkdir(sfRoot);
    const factories = Array.from(
      { length: 23 },
      (_, index) => `extension-${index}.mjs`,
    );
    await writeFile(
      join(sfRoot, "package.json"),
      JSON.stringify({ pi: { extensions: factories } }),
    );
    for (const [index, name] of factories.entries())
      await writeFile(
        join(sfRoot, name),
        index === 0
          ? 'export default function(pi) { pi.on("session_start", async () => { await fetch("https://example.invalid/unapproved-startup"); }); }\n'
          : "export default function() {}\n",
      );
    const modules = ["context-compact", "context-extension", "gateway"];
    const testSourceFiles = modules.flatMap((name) => [
      join(root, "src", name + ".ts"),
      join(root, "dist", name + ".js"),
    ]);
    const codec = await import("../dist/context-compact.js");
    const output = join(dir, "startup-deny-cpu");
    await prepareWorkflow({
      fixture,
      modelsFile,
      output,
      sfPiPath: sfRoot,
      testCodec: codec,
      testSourceFiles,
      concurrency: 1,
      repetitions: 2,
    });
    const apiKeyFile = join(dir, "cpu-key.txt");
    await writeFile(apiKeyFile, "benign-invented-cpu-credential");
    let outsideCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      outsideCalls++;
      throw new Error("No outside network in CPU test");
    };
    let providerCalls = 0;
    try {
      const result = await executeWorkflow({
        output,
        modelsFile,
        apiKeyFile,
        testFetch: async (_input, init) => {
          providerCalls++;
          return actualSdkFakeResponse(JSON.parse(init.body));
        },
      });
      assert.equal(
        outsideCalls,
        0,
        "Startup fetch must encounter fixed deny guard rather than captured network transport",
      );
      assert.equal(result.summary.functionalAndJudgeAcceptance, false);
      assert.ok(
        result.runs.every((run) =>
          run.errors.some((message) => message.includes("Extension failure")),
        ),
      );
      assert.ok(
        result.runs.every((run) => run.answerCorrect && !run.answerAccepted),
        "Correct final answers in failed extension workflows remain diagnostics, not accepted work",
      );
      assert.ok(
        result.runs.every((run) =>
          run.extensionFailures.some(
            (failure) =>
              failure.extension === "extension-0.mjs" &&
              failure.event === "session_start" &&
              failure.errorCode === "network_fetch_denied",
          ),
        ),
      );
      for (const arm of ["baseline", "compact"]) {
        assert.equal(result.summary.arms[arm].acceptedAnswers, 0);
        assert.equal(result.summary.arms[arm].acceptanceRateFullPopulation, 0);
        assert.equal(
          result.summary.arms[arm].correctAnswersInFailedWorkflows,
          2,
        );
        assert.equal(
          result.summary.arms[arm].usageComplete,
          true,
          "Known full physical response usage remains measured despite local extension failure",
        );
      }
      assert.equal(
        result.summary.measuredChanges.promptTokenReductionFraction,
        null,
      );
      assert.equal(
        result.summary.measuredChanges.eligiblePromptTokenReductionFraction,
        null,
      );
      assert.equal(
        result.summary.measuredChanges.aggregateWorkflowElapsedRatio,
        null,
      );
      assert.ok(
        result.runs.every((run) => run.controlledSfFactoryCount === 23),
      );
      assert.equal(
        providerCalls,
        8,
        "The real Pi error is retained, while completed provider requests stay attributable",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

for (const shutdownMode of ["clear", "throw"])
  test(`actual SDK paired singleton lifecycle retains ${shutdownMode} shutdown outcomes before captured contexts become stale`, async () => {
    await withTemporaryFiles(async ({ dir, fixture, modelsFile }) => {
      const sfRoot = join(dir, "invented-singleton-factories");
      await mkdir(sfRoot);
      const factories = Array.from(
        { length: 23 },
        (_, index) => `extension-${index}.mjs`,
      );
      await writeFile(
        join(sfRoot, "package.json"),
        JSON.stringify({ pi: { extensions: factories } }),
      );
      const ledgerKey = "invented-singleton-lifecycle-" + hash(dir);
      const ledgerSymbol = Symbol.for(ledgerKey);
      const ledger = { events: [], retiredListeners: [] };
      globalThis[ledgerSymbol] = ledger;
      const originalFetch = globalThis.fetch;
      let outsideCalls = 0;
      globalThis.fetch = async () => {
        outsideCalls++;
        throw new Error("No outside network in CPU test");
      };
      try {
        for (const [index, name] of factories.entries())
          await writeFile(
            join(sfRoot, name),
            index === 0
              ? `
        const ledger = globalThis[Symbol.for(${JSON.stringify(ledgerKey)})];
        let onChange;
        function resetStats() { if (onChange) onChange(); }
        export default function(pi) {
          pi.on("session_start", (_event, ctx) => {
            ledger.events.push({ event: "start", cwd: ctx.cwd, listenerPresent: typeof onChange === "function" });
            resetStats();
            onChange = () => ctx.hasUI;
          });
          pi.on("session_shutdown", (_event, ctx) => {
            ledger.events.push({ event: "shutdown", cwd: ctx.cwd, contextActive: typeof ctx.hasUI === "boolean", listenerPresent: typeof onChange === "function" });
            ledger.retiredListeners.push(onChange);
            onChange = undefined;
            ${shutdownMode === "throw" ? 'throw new Error("Invented shutdown callback failure");' : ""}
          });
        }
      `
              : "export default function() {}\n",
          );
        const modules = ["context-compact", "context-extension", "gateway"];
        const testSourceFiles = modules.flatMap((name) => [
          join(root, "src", name + ".ts"),
          join(root, "dist", name + ".js"),
        ]);
        const codec = await import("../dist/context-compact.js");
        const output = join(dir, "singleton-lifecycle-cpu");
        await prepareWorkflow({
          fixture,
          modelsFile,
          output,
          sfPiPath: sfRoot,
          testCodec: codec,
          testSourceFiles,
          concurrency: 1,
          repetitions: 2,
        });
        const apiKeyFile = join(dir, "cpu-key.txt");
        await writeFile(apiKeyFile, "benign-invented-cpu-credential");
        let providerCalls = 0;
        const result = await executeWorkflow({
          output,
          modelsFile,
          apiKeyFile,
          testFetch: async (_input, init) => {
            providerCalls++;
            return actualSdkFakeResponse(JSON.parse(init.body));
          },
        });
        assert.equal(outsideCalls, 0);
        assert.equal(providerCalls, 8);
        assert.equal(
          result.summary.functionalAndJudgeAcceptance,
          shutdownMode === "clear",
        );
        assert.ok(
          result.runs.every(
            (run) =>
              run.passed === (shutdownMode === "clear") &&
              run.answerCorrect &&
              run.answerAccepted === (shutdownMode === "clear") &&
              run.controlledSfFactoryCount === 23,
          ),
        );
        assert.ok(
          result.runs.every(
            (run) =>
              run.cleanup.shutdownAttempted &&
              run.cleanup.shutdown ===
                (shutdownMode === "clear"
                  ? "completed"
                  : "failed_or_unresolved") &&
              run.cleanup.shutdownExtensionErrors ===
                (shutdownMode === "clear" ? 0 : 1) &&
              run.cleanup.affirmative === (shutdownMode === "clear") &&
              run.cleanup.dispose === "completed",
          ),
        );
        if (shutdownMode === "throw") {
          assert.ok(
            result.runs.every(
              (run) =>
                run.status === "error" &&
                run.extensionFailures.some(
                  (failure) =>
                    failure.event === "session_shutdown" &&
                    failure.extension === "extension-0.mjs",
                ),
            ),
          );
          assert.equal(result.summary.arms.baseline.acceptedAnswers, 0);
          assert.equal(result.summary.arms.compact.acceptedAnswers, 0);
          assert.equal(
            result.summary.measuredChanges.aggregateWorkflowElapsedRatio,
            null,
          );
        }
        assert.deepEqual(
          ledger.events.map((event) => event.event),
          [
            "start",
            "shutdown",
            "start",
            "shutdown",
            "start",
            "shutdown",
            "start",
            "shutdown",
          ],
        );
        assert.ok(
          ledger.events
            .filter((event) => event.event === "start")
            .every((event) => !event.listenerPresent),
          "The prior module singleton listener must be cleared before the next factory reset",
        );
        assert.ok(
          ledger.events
            .filter((event) => event.event === "shutdown")
            .every((event) => event.contextActive && event.listenerPresent),
          "Shutdown observes an active context and an installed singleton listener",
        );
        assert.equal(ledger.events[0].cwd, ledger.events[2].cwd);
        assert.equal(ledger.events[4].cwd, ledger.events[6].cwd);
        assert.equal(ledger.retiredListeners.length, 4);
        // These are the actual captured SDK getters resetStats would call if shutdown
        // failed to clear the module listener. After dispose they reproduce the fault.
        for (const listener of ledger.retiredListeners)
          assert.throws(listener, /ctx is stale/);
      } finally {
        globalThis.fetch = originalFetch;
        delete globalThis[ledgerSymbol];
      }
    });
  });

test("a completed negative Grok judge invalidates joint acceptance without changing host task gold", async () => {
  await withTemporaryFiles(async ({ dir, fixture, modelsFile }) => {
    const modules = ["context-compact", "context-extension", "gateway"];
    const testSourceFiles = modules.flatMap((name) => [
      join(root, "src", name + ".ts"),
      join(root, "dist", name + ".js"),
    ]);
    const codec = await import("../dist/context-compact.js");
    const output = join(dir, "negative-judge-cpu");
    await prepareWorkflow({
      fixture,
      modelsFile,
      output,
      testCodec: codec,
      testSourceFiles,
      concurrency: 1,
      repetitions: 2,
      judges: true,
    });
    const apiKeyFile = join(dir, "cpu-key.txt");
    await writeFile(apiKeyFile, "benign-invented-cpu-credential");
    let judges = 0;
    const result = await executeWorkflow({
      output,
      modelsFile,
      apiKeyFile,
      testFetch: async (_input, init) => {
        const body = JSON.parse(init.body);
        if (body.stream) return actualSdkFakeResponse(body);
        judges++;
        assert.equal(body.max_tokens, 32768);
        assert.ok(
          !JSON.stringify(body.messages).includes(
            JSON.stringify(record.expected),
          ),
          "Judge must never receive host gold",
        );
        return new Response(
          JSON.stringify({
            model: GATEWAY_MODEL,
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    preserved: false,
                    facts: true,
                    errors_and_uncertainty: true,
                    order_and_multiplicity: false,
                    task_answerable: true,
                    issues: ["Invented CPU negative multiplicity finding"],
                  }),
                },
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 10,
              total_tokens: 110,
              prompt_tokens_details: { cached_tokens: 0 },
            },
          }),
        );
      },
    });
    assert.equal(result.summary.passed, true);
    assert.equal(result.summary.functionalAndJudgeAcceptance, false);
    assert.equal(result.judgeSummary.errors, 0);
    assert.equal(result.judgeSummary.completed, 1);
    assert.equal(result.judgeSummary.passed, 0);
    assert.equal(result.judgeSummary.qualified, false);
    assert.equal(judges, 1);
    assert.equal(result.cleanup.affirmative, true);
    assert.equal(
      result.requestPacing.physicalAttemptCount,
      9,
      "Eight actual SDK task requests and one judge share the single physical scheduler",
    );
    assert.deepEqual(
      result.requestPacing.physicalRequests.map(
        (request) => request.dispatchIndex,
      ),
      [0, 1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.equal(result.judges[0].physicalRequests.length, 1);
    assert.equal(result.judges[0].physicalRequests[0].dispatchIndex, 8);
  });
});

test("eligible codec plus conservative runtime skip cannot qualify live compression", async () => {
  await withTemporaryFiles(async ({ dir, fixture, modelsFile }) => {
    const modules = ["context-compact", "context-extension", "gateway"];
    const testSourceFiles = modules.flatMap((name) => [
      join(root, "src", name + ".ts"),
      join(root, "dist", name + ".js"),
    ]);
    const codec = await import("../dist/context-compact.js");
    const output = join(dir, "runtime-skip-cpu");
    const prepared = await prepareWorkflow({
      fixture,
      modelsFile,
      output,
      testCodec: codec,
      testSourceFiles,
      concurrency: 1,
      repetitions: 2,
    });
    assert.equal(prepared.protocol.cases[0].compression.applied, true);
    const apiKeyFile = join(dir, "cpu-key.txt");
    await writeFile(apiKeyFile, "benign-invented-cpu-credential");
    const result = await executeWorkflow({
      output,
      modelsFile,
      apiKeyFile,
      testFetch: async (_input, init) =>
        actualSdkFakeResponse(
          JSON.parse(init.body),
          "overlong-cpu-read-" + "x".repeat(60),
        ),
    });
    assert.ok(
      result.runs.every((run) => run.answerCorrect && run.usage.complete),
    );
    assert.ok(
      result.runs
        .filter((run) => run.arm === "baseline")
        .every((run) => run.passed),
    );
    const compact = result.runs.filter((run) => run.arm === "compact");
    assert.ok(
      compact.every(
        (run) => !run.passed && run.status === "integration_failed",
      ),
    );
    assert.ok(
      compact.every(
        (run) =>
          run.liveCompression.required &&
          !run.liveCompression.passed &&
          run.liveCompression.validatedRequests === 0,
      ),
    );
    assert.equal(result.summary.liveCompressionQualified, false);
    assert.equal(result.summary.functionalAndJudgeAcceptance, false);
    assert.equal(result.summary.arms.compact.errors, 2);
  });
});

test("wire audit rejects missing nonce, altered encoded text, moved manifest and stale host attestations", () => {
  const encoded = '[[200,"state=ok\\n"]]';
  const nonce = "0123456789abcdef01234567";
  const manifest = `Jev context manifest ${nonce}\n{"generation":1,"blocks":[[2,0,1]]}`;
  const frozen = {
    compression: {
      applied: true,
      compressedBytes: Buffer.byteLength(encoded),
      compressedSha256: hash(encoded),
    },
  };
  const run = {
    arm: "compact",
    controllerStatus: { validatedProviderRequests: 1 },
    providerRequests: [
      {
        completed: true,
        error: null,
        requestSha256: hash("CPU-only body"),
        request: {
          messages: [
            {
              role: "system",
              content: `Caller begins exactly Jev context manifest ${nonce}\\n`,
            },
            { role: "tool", tool_call_id: "cpu-read", content: encoded },
            { role: "user", content: manifest },
          ],
        },
      },
    ],
    providerContexts: [
      {
        messages: [
          { role: "user", content: "CPU task" },
          { role: "assistant", content: [] },
          {
            role: "toolResult",
            toolCallId: "cpu-read",
            content: [{ type: "text", text: encoded }],
          },
          {
            role: "custom",
            customType: "jev-context-compression-manifest",
            content: manifest,
          },
        ],
      },
    ],
  };
  assert.equal(verifyLiveCompression(run, frozen).passed, true);
  for (const mutate of [
    (value) => {
      value.controllerStatus.validatedProviderRequests = 0;
    },
    (value) => {
      value.providerRequests[0].request.messages[0].content =
        "No trusted current nonce";
    },
    (value) => {
      value.providerRequests[0].request.messages[1].content =
        '[[199,"state=ok\\n"]]';
    },
    (value) => {
      value.providerRequests[0].request.messages.push({
        role: "user",
        content: "Manifest moved",
      });
    },
    (value) => {
      value.providerContexts[0].messages.at(-1).content = manifest.replace(
        nonce,
        "fedcba987654321001234567",
      );
    },
  ]) {
    const altered = structuredClone(run);
    mutate(altered);
    assert.equal(verifyLiveCompression(altered, frozen).passed, false);
  }
  assert.equal(
    verifyLiveCompression({ ...run, arm: "baseline" }, frozen).required,
    false,
  );
  assert.equal(
    verifyLiveCompression(run, { compression: { applied: false } }).passed,
    true,
  );
});

const pacingSettings = {
  minRequestIntervalMs: 10,
  rateLimitCooldownMs: 20,
  maxRateLimitCooldownMs: 30,
  maxConsecutive429: 3,
};

function fakeClock() {
  let now = 0;
  let index = 0;
  const epoch = Date.UTC(2026, 8, 20, 0, 0, 0);
  const timers = new Map();
  const clock = {
    now: () => now,
    epochNow: () => epoch + now,
    setTimer(callback, delay) {
      const id = ++index;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
  };
  async function flush() {
    for (let step = 0; step < 40; step++) await Promise.resolve();
  }
  async function advance(milliseconds) {
    const target = now + milliseconds;
    await flush();
    while (true) {
      const earliest = [...timers.entries()].sort(
        (a, b) => a[1].at - b[1].at,
      )[0];
      if (!earliest || earliest[1].at > target) break;
      now = earliest[1].at;
      timers.delete(earliest[0]);
      earliest[1].callback();
      await flush();
    }
    now = target;
    await flush();
  }
  return { clock, advance, flush, pendingTimers: () => timers.size };
}

test("one fake-clock pacer schedules concurrent SDK and judge requests together", async () => {
  const time = fakeClock();
  const physicalRequests = [];
  const dispatches = [];
  const fetch = createPacedGatewayFetch({
    settings: pacingSettings,
    physicalRequests,
    clock: time.clock,
    fetchImpl: async (_input, init) => {
      dispatches.push({ time: time.clock.now(), body: JSON.parse(init.body) });
      return new Response("public CPU response");
    },
  });
  const requests = [true, true, false].map((stream) =>
    fetch(`${GATEWAY_ORIGIN}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: GATEWAY_MODEL, stream }),
    }),
  );
  await time.flush();
  assert.equal(dispatches.length, 1);
  await time.advance(9);
  assert.equal(dispatches.length, 1);
  await time.advance(1);
  assert.equal(dispatches.length, 2);
  await time.advance(10);
  await Promise.all(requests);
  assert.deepEqual(
    dispatches.map((request) => request.time),
    [0, 10, 20],
  );
  assert.deepEqual(
    dispatches.map((request) => request.body.stream),
    [true, true, false],
  );
  assert.deepEqual(
    physicalRequests.map((request) => request.queuedRateWaitMs),
    [0, 10, 20],
  );
  assert.equal(time.pendingTimers(), 0);
});

test("safe Retry-After parsing records only bounded numbers and declared truncation", () => {
  const epoch = Date.UTC(2026, 8, 20, 0, 0, 0);
  assert.equal(
    safeRetryAfter("2", epoch, 60_000, 120_000).appliedCooldownMs,
    2000,
  );
  assert.equal(
    safeRetryAfter("0", epoch, 60_000, 120_000).appliedCooldownMs,
    0,
  );
  const date = new Date(epoch + 3000).toUTCString();
  assert.equal(
    safeRetryAfter(date, epoch, 60_000, 120_000).appliedCooldownMs,
    3000,
  );
  const capped = safeRetryAfter("999", epoch, 60_000, 120_000);
  assert.equal(capped.retryAfterMs, 999_000);
  assert.equal(capped.appliedCooldownMs, 120_000);
  assert.equal(capped.retryAfterCapped, true);
  const overflow = safeRetryAfter("9".repeat(100), epoch, 60_000, 120_000);
  assert.equal(overflow.retryAfterMs, null);
  assert.equal(overflow.appliedCooldownMs, 120_000);
  assert.equal(overflow.retryAfterCapped, true);
  for (const invalid of [
    null,
    "-1",
    "1.5",
    "credential-like-header-must-not-be-retained",
    "9".repeat(129),
  ]) {
    const parsed = safeRetryAfter(invalid, epoch, 60_000, 120_000);
    assert.equal(parsed.retryAfterValid, false);
    assert.equal(parsed.appliedCooldownMs, 60_000);
    assert.ok(!JSON.stringify(parsed).includes("credential-like"));
  }
});

test("429 updates every queued request's shared cooldown without reading error bodies or other headers", async () => {
  const time = fakeClock();
  const physicalRequests = [];
  const dispatches = [];
  let calls = 0;
  const fetch = createPacedGatewayFetch({
    settings: pacingSettings,
    physicalRequests,
    clock: time.clock,
    fetchImpl: async () => {
      dispatches.push(time.clock.now());
      if (calls++ > 0) return new Response("public success");
      const response = new Response("error body must remain unread", {
        status: 429,
      });
      response.text = () => {
        throw new Error("Error body must not be read");
      };
      response.json = response.text;
      Object.defineProperty(response, "headers", {
        value: {
          get(name) {
            assert.equal(name, "Retry-After");
            return "1";
          },
          entries() {
            throw new Error("No other headers may be inspected");
          },
        },
      });
      return response;
    },
  });
  const first = fetch(`${GATEWAY_ORIGIN}/v1/chat/completions`, {
    method: "POST",
    body: "public task",
  });
  const second = fetch(`${GATEWAY_ORIGIN}/v1/chat/completions`, {
    method: "POST",
    body: "public judge",
  });
  assert.equal((await first).status, 429);
  await time.flush();
  await time.advance(29);
  assert.equal(dispatches.length, 1);
  await time.advance(1);
  assert.equal((await second).status, 200);
  assert.deepEqual(dispatches, [0, 30]);
  assert.equal(physicalRequests[0].rateLimit.retryAfterCapped, true);
  assert.equal(physicalRequests[0].rateLimit.appliedCooldownMs, 30);
  assert.equal(fetch.pacer.status().consecutive429, 0);
  assert.ok(!JSON.stringify(physicalRequests).includes("error body"));
});

test("cancelled queued reservations cannot advance later callers or leave timers running", async () => {
  const time = fakeClock();
  const physicalRequests = [];
  const dispatchedAt = [];
  const fetch = createPacedGatewayFetch({
    settings: pacingSettings,
    physicalRequests,
    clock: time.clock,
    fetchImpl: async () => {
      dispatchedAt.push(time.clock.now());
      return new Response("public success");
    },
  });
  await fetch(`${GATEWAY_ORIGIN}/v1/chat/completions`, {
    method: "POST",
    body: "first",
  });
  const controller = new AbortController();
  const cancelled = fetch(`${GATEWAY_ORIGIN}/v1/chat/completions`, {
    method: "POST",
    body: "cancelled",
    signal: controller.signal,
  });
  const rejection = assert.rejects(
    cancelled,
    (error) => error.code === "cancelled_before_dispatch",
  );
  const third = fetch(`${GATEWAY_ORIGIN}/v1/chat/completions`, {
    method: "POST",
    body: "third",
  });
  await time.flush();
  controller.abort();
  await rejection;
  await time.flush();
  assert.deepEqual(dispatchedAt, [0]);
  await time.advance(10);
  await third;
  assert.deepEqual(dispatchedAt, [0, 10]);
  assert.equal(physicalRequests[1].physical, false);
  assert.equal(physicalRequests[1].error, "cancelled_before_dispatch");
  assert.equal(time.pendingTimers(), 0);
});

test("consecutive-429 circuit interrupts pending cooldown without dispatching or retrying", async () => {
  const time = fakeClock();
  const physicalRequests = [];
  let calls = 0;
  const fetch = createPacedGatewayFetch({
    settings: { ...pacingSettings, maxConsecutive429: 1 },
    physicalRequests,
    clock: time.clock,
    fetchImpl: async () => {
      calls++;
      return new Response("public rate-limit response", { status: 429 });
    },
  });
  const first = fetch(`${GATEWAY_ORIGIN}/v1/chat/completions`, {
    method: "POST",
    body: "first",
  });
  const second = fetch(`${GATEWAY_ORIGIN}/v1/chat/completions`, {
    method: "POST",
    body: "second",
  });
  const rejection = assert.rejects(
    second,
    (error) => error.code === "rate_circuit_open_before_dispatch",
  );
  await first;
  await rejection;
  assert.equal(calls, 1);
  assert.equal(fetch.pacer.status().circuitOpen, true);
  assert.equal(physicalRequests[0].httpStatus, 429);
  assert.equal(physicalRequests[1].physical, false);
  assert.equal(time.pendingTimers(), 0);
  await assert.rejects(
    fetch(`${GATEWAY_ORIGIN}/v1/chat/completions`, {
      method: "POST",
      body: "third",
    }),
    (error) => error.code === "rate_circuit_open_before_dispatch",
  );
  assert.equal(calls, 1);
});

test("pacing rejects invalid settings and an unapproved destination before a physical call", async () => {
  assert.throws(() =>
    createRequestPacer({ ...pacingSettings, minRequestIntervalMs: -1 }),
  );
  assert.throws(() =>
    createRequestPacer({ ...pacingSettings, rateLimitCooldownMs: 100 }),
  );
  let calls = 0;
  const physicalRequests = [];
  const fetch = createPacedGatewayFetch({
    settings: pacingSettings,
    physicalRequests,
    fetchImpl: async () => {
      calls++;
      return new Response("never called");
    },
  });
  await assert.rejects(
    fetch("https://example.invalid/v1/chat/completions", {
      method: "POST",
      body: "public synthetic",
    }),
  );
  assert.equal(calls, 0);
  assert.equal(physicalRequests[0].physical, false);
});

test("actual SDK 429 remains unknown usage and circuit leaves every remaining task and judge unrun", async () => {
  await withTemporaryFiles(async ({ dir, fixture, modelsFile }) => {
    const modules = ["context-compact", "context-extension", "gateway"];
    const testSourceFiles = modules.flatMap((name) => [
      join(root, "src", name + ".ts"),
      join(root, "dist", name + ".js"),
    ]);
    const codec = await import("../dist/context-compact.js");
    const output = join(dir, "429-circuit-cpu");
    const prepared = await prepareWorkflow({
      fixture,
      modelsFile,
      output,
      testCodec: codec,
      testSourceFiles,
      concurrency: 1,
      repetitions: 2,
      judges: true,
      maxConsecutive429: 1,
    });
    assert.equal(prepared.protocol.parameters.pacing.maxConsecutive429, 1);
    const apiKeyFile = join(dir, "cpu-key.txt");
    await writeFile(apiKeyFile, "benign-invented-cpu-credential");
    let physicalCalls = 0;
    const result = await executeWorkflow({
      output,
      modelsFile,
      apiKeyFile,
      testFetch: async () => {
        physicalCalls++;
        return new Response("public rate-limit response", {
          status: 429,
          headers: { "Retry-After": "0" },
        });
      },
    });
    assert.equal(
      physicalCalls,
      1,
      "SDK and harness must not silently retry429",
    );
    assert.equal(result.requestPacing.physicalAttemptCount, 1);
    assert.equal(result.requestPacing.http429Count, 1);
    assert.equal(result.requestPacing.status.circuitOpen, true);
    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0].usage.complete, false);
    assert.equal(result.runs[0].usage.totals, null);
    assert.equal(result.runs[0].providerRequests[0].status, 429);
    assert.equal(
      result.runs[0].providerRequests[0].requestPacing.rateLimit.retryAfterMs,
      0,
    );
    assert.equal(result.summary.scheduledSessions, 4);
    assert.equal(result.summary.unrunSessions, 3);
    assert.equal(result.judgeSummary.scheduled, 1);
    assert.equal(result.judgeSummary.unrun, 1);
    assert.equal(result.summary.functionalAndJudgeAcceptance, false);
  });
});

test("observed error pairs never become completed or latency samples in a stratum", () => {
  const protocol = {
    schedule: workflowSchedule([record], 2),
    cases: [{ id: record.id, compression: { applied: true } }],
  };
  const runs = protocol.schedule.flatMap((pair) =>
    pair.arms.map((slot, index) => ({
      id: slot.id,
      arm: slot.arm,
      status: "error",
      passed: false,
      answerAccepted: false,
      workflowElapsedMs: index + 1,
      usage: aggregateUsage([{ completed: false, usage: null }]),
    })),
  );
  const summary = summarizeWorkflow(protocol, runs);
  assert.equal(summary.strata[0].scheduledPairs, 2);
  assert.equal(summary.strata[0].observedPairs, 2);
  assert.equal(summary.strata[0].completedPairs, 0);
  assert.equal(summary.strata[0].acceptedPairs, 0);
  assert.equal(summary.strata[0].latencySamplePairs, 0);
  assert.equal(summary.strata[0].medianWorkflowElapsedRatio, null);
  assert.ok(
    summary.pairs.every(
      (pair) =>
        pair.observed && !pair.complete && pair.workflowElapsedRatio === null,
    ),
  );
  assert.equal(summary.measuredChanges.medianPairedWorkflowElapsedRatio, null);
});

test("stratum timing samples require accepted completed tasks and expose partial sample coverage", () => {
  const protocol = {
    schedule: workflowSchedule([record], 2),
    cases: [{ id: record.id, compression: { applied: true } }],
  };
  const usage = aggregateUsage([
    { completed: true, usage: sseObservation(wireResponse()).usage },
  ]);
  const runs = protocol.schedule.flatMap((pair, repetition) =>
    pair.arms.map((slot) => ({
      id: slot.id,
      arm: slot.arm,
      status: "completed",
      passed: repetition === 0,
      answerAccepted: repetition === 0,
      acceptedAnswerTimeMs: slot.arm === "compact" ? 8 : 10,
      workflowElapsedMs: slot.arm === "compact" ? 8 : 10,
      usage,
      liveCompression: { passed: true },
    })),
  );
  const summary = summarizeWorkflow(protocol, runs);
  assert.equal(summary.strata[0].observedPairs, 2);
  assert.equal(summary.strata[0].completedPairs, 2);
  assert.equal(summary.strata[0].acceptedPairs, 1);
  assert.equal(summary.strata[0].latencySamplePairs, 1);
  assert.equal(summary.strata[0].medianWorkflowElapsedRatio, 0.8);
  assert.equal(
    summary.measuredChanges.medianPairedWorkflowElapsedRatio,
    null,
    "Incomplete accepted population cannot yield a full-suite median",
  );
  assert.equal(summary.passed, false);
});

test("concise console projection omits row arrays, texts and host gold while retaining aggregate unknown accounting", () => {
  const protocol = { schedule: workflowSchedule([record], 2) };
  const summary = summarizeWorkflow(protocol, []);
  summary.functionalAndJudgeAcceptance = false;
  summary.arms.baseline.expected = { secretGold: "must remain host-side" };
  summary.measuredChanges.predictions = [record.expected];
  const result = {
    summary,
    runs: [{ expected: record.expected, toolText: record.toolText }],
    judges: [{ answer: { issues: ["full issue text"] } }],
    judgeSummary: {
      scheduled: 1,
      completed: 0,
      errors: 0,
      unrun: 1,
      preserved: 0,
      passed: 0,
      qualified: false,
      rows: [{ expected: record.expected }],
    },
    cleanup: { affirmative: true },
  };
  const output = workflowConsoleProjection(
    result,
    "/public/synthetic/result.json",
  );
  const text = JSON.stringify(output);
  for (const omitted of [
    "pairs",
    "strata",
    "runs",
    "judges",
    "predictions",
    "secretGold",
    "toolText",
    "must remain host-side",
    "full issue text",
  ])
    assert.ok(!text.includes(omitted));
  assert.ok(!text.includes(JSON.stringify(record.expected)));
  assert.equal(output.summary.unrunSessions, 4);
  assert.equal(output.summary.arms.baseline.usage, null);
  assert.equal(output.summary.arms.baseline.usageComplete, false);
  function noArrays(value) {
    assert.ok(!Array.isArray(value));
    if (value && typeof value === "object")
      for (const child of Object.values(value)) noArrays(child);
  }
  noArrays(output);
});
