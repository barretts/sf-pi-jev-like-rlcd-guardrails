import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  REDUCTION_PARAMETERS,
  contextReductionCases,
  contextReductionSchedule,
  parseReductionArgs,
  prepareContextReduction,
  executeContextReduction,
  summarizeContextReduction,
  aggregatePhysicalUsage,
  projectReductionRegistration,
  publicationPhysicalRequest,
  publicationWorkflow,
  observeWireToolProjection,
  createReductionTaskFetch,
  REDUCTION_TOOL_NAMES,
  verifyReductionToolCatalog,
} from "../scripts/context-reduction-smoke.mjs";
import {
  GATEWAY_ORIGIN,
  GROK_WORKFLOW_COMPATIBILITY,
} from "../scripts/context-workflow-eval.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const registration = {
  provider: "llmgw",
  id: "grok-4.6",
  api: "openai-completions",
  baseUrl: GATEWAY_ORIGIN + "/v1",
  reasoning: false,
  contextWindow: 131072,
  maxTokens: 8192,
  effectiveCompatibility: { ...GROK_WORKFLOW_COMPATIBILITY },
};
const cleanup = {
  affirmative: true,
  abort: "completed",
  shutdown: "completed",
  dispose: "completed",
};
const tokenUsage = (prompt, completion = 10, cache = 0) => ({
  promptTokens: prompt,
  completionTokens: completion,
  totalTokens: prompt + completion,
  cachedPromptTokens: cache,
});

test("SDK catalog must contain executable read and recovery tools before advertising either", () => {
  const catalog = {
    getAllTools: () => REDUCTION_TOOL_NAMES.map((name) => ({ name })),
    getToolDefinition: () => ({ execute() {} }),
    getActiveToolNames: () => ["read"],
  };
  verifyReductionToolCatalog(catalog, false, true);
  assert.throws(() => verifyReductionToolCatalog(catalog, true, true));
  catalog.getActiveToolNames = () => [...REDUCTION_TOOL_NAMES];
  verifyReductionToolCatalog(catalog, true, true);
  catalog.getToolDefinition = (name) =>
    name === "read" ? { execute() {} } : undefined;
  assert.throws(() => verifyReductionToolCatalog(catalog, true, true));
  catalog.getAllTools = () => [{ name: "read" }];
  assert.throws(() => verifyReductionToolCatalog(catalog, false));
});
const physical = (workflowId, kind, prompt) => ({
  index: 0,
  workflowId,
  kind,
  physical: true,
  status: "completed",
  completed: true,
  usage: tokenUsage(prompt),
  elapsedMs: 2,
  bodyCleanup: "completed",
});
function population({ compressorPrompt = 0 } = {}) {
  const cases = contextReductionCases(),
    schedule = contextReductionSchedule(cases),
    protocol = { schedule };
  const runs = schedule.map((slot) => ({
    ...slot,
    status: "completed",
    cleanup: { ...cleanup },
    canonicalOriginalVerified: true,
    wireProjectionVerified: true,
    workflowElapsedMs: 10,
  }));
  const requests = schedule.flatMap((slot) => [
    physical(slot.id, "task", slot.arm === "raw" ? 1000 : 400),
    ...(slot.arm === "compressed" && compressorPrompt
      ? [physical(slot.id, "compressor", compressorPrompt)]
      : []),
  ]);
  return { protocol, runs, requests };
}
async function sandbox(t, { withSfPi = false, strategy = "excerpts" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "jev-reduction-cpu-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "invented-source.js");
  await writeFile(source, "// Invented source pin only\n");
  const sfSources = [];
  if (withSfPi)
    for (let i = 0; i < 23; i++) {
      const path = join(root, "invented-sf-" + i + ".js");
      await writeFile(path, "// Invented factory source; never executed\n");
      sfSources.push({ path, factory: true });
    }
  const options = {
    output: join(root, ".build", "campaign"),
    strategy,
    withSfPi,
    modelsFile: join(root, "never-read-private-config"),
  };
  const dependencies = {
    root,
    registration,
    sourcePaths: [source],
    sfSources,
    gitIdentity: {
      commit: "a".repeat(40),
      ref: "refs/heads/invented",
      workingTreeStatus: "invented CPU fixture",
    },
  };
  const prepared = await prepareContextReduction(options, dependencies);
  return {
    root,
    source,
    options: {
      ...options,
      apiKeyFile: join(root, "never-read-key"),
      expectedProtocolSha256: prepared.protocolSha256,
    },
    dependencies,
    prepared,
  };
}
function fakeExecution(
  dependencies,
  { failedCleanup = false, setupFailure = false, onRun } = {},
) {
  const calls = [];
  const runtime = {
    async removeRuntimeApiKey(provider) {
      calls.push("remove:" + provider);
    },
  };
  return {
    calls,
    dependencies: {
      ...dependencies,
      credential: "INVENTED_CPU_KEY",
      fetch: async () => {
        throw new Error("No service calls in CPU tests");
      },
      async buildRuntime() {
        calls.push("build");
        if (setupFailure)
          throw new Error("PRIVATE_SETUP /Users/private hf_FAKE_TOKEN");
        return { runtime, model: { id: "grok-4.6" } };
      },
      async runWorkflow(input) {
        calls.push(input.slot.id);
        await onRun?.(input, calls);
        input.physicalRequests.push(
          physical(
            input.slot.id,
            "task",
            input.slot.arm === "raw" ? 1000 : 400,
          ),
        );
        return {
          ...input.slot,
          status: "completed",
          cleanup: failedCleanup ? { ...cleanup, affirmative: false } : cleanup,
          canonicalOriginalVerified: true,
          wireProjectionVerified: true,
          workflowElapsedMs: 10,
          privateBody: "PRIVATE_SF_SYSTEM PRIVATE_ANSWER hf_FAKE_TOKEN",
        };
      },
    },
  };
}

test("three distinct long files fit genuine builtin full-read bounds with named final facts", () => {
  const cases = contextReductionCases();
  assert.equal(cases.length, 3);
  assert.equal(new Set(cases.map((row) => row.toolSha256)).size, 3);
  for (const row of cases) {
    assert.ok(
      Buffer.byteLength(row.toolText) >= 20 * 1024 &&
        Buffer.byteLength(row.toolText) <= 40 * 1024,
    );
    assert.ok(row.toolText.split("\n").length < 2000);
    assert.equal(row.toolSha256, hash(row.toolText));
    assert.ok(!("expected" in row));
    assert.ok(row.toolText.includes("Final observations"));
  }
});
test("twelve counterbalanced workflows retain both arms for every case and repetition", () => {
  const schedule = contextReductionSchedule(contextReductionCases());
  assert.equal(schedule.length, 12);
  assert.equal(new Set(schedule.map((slot) => slot.id)).size, 12);
  for (const row of contextReductionCases()) {
    const first = schedule
      .filter((slot) => slot.caseId === row.id && slot.repetition === 1)
      .map((slot) => slot.arm);
    const second = schedule
      .filter((slot) => slot.caseId === row.id && slot.repetition === 2)
      .map((slot) => slot.arm);
    assert.deepEqual([...first].reverse(), second);
  }
  assert.equal(REDUCTION_PARAMETERS.maxTokens, 4096);
  assert.equal(REDUCTION_PARAMETERS.compressorMaxTokens, 1024);
  assert.equal(REDUCTION_PARAMETERS.pacing.minRequestIntervalMs, 5000);
});
test("CLI requires frozen SHA and explicit key file for root execution; tuning and judges rejected", () => {
  assert.throws(() => parseReductionArgs(["--run", "--output", "new"]));
  assert.throws(() =>
    parseReductionArgs(["--prepare", "--run", "--output", "new"]),
  );
  assert.throws(() =>
    parseReductionArgs(["--prepare", "--output", "new", "--judge"]),
  );
  const opts = parseReductionArgs([
    "--prepare",
    "--output",
    "new",
    "--strategy",
    "caveman",
    "--with-sf-pi",
  ]);
  assert.equal(opts.strategy, "caveman");
  assert.equal(opts.withSfPi, true);
});
test("registration projection excludes headers, keys and arbitrary private model fields", () => {
  const projected = projectReductionRegistration({
    ...registration,
    apiKey: "PRIVATE_KEY",
    headers: { Authorization: "PRIVATE_KEY" },
    system: "PRIVATE_SF_SYSTEM",
  });
  assert.ok(!JSON.stringify(projected).includes("PRIVATE_"));
  assert.throws(() =>
    projectReductionRegistration({
      ...registration,
      baseUrl: "https://unapproved.invalid/v1",
    }),
  );
});
test("primary reduction uses sums across all six workflows per arm", () => {
  const { protocol, runs, requests } = population();
  const summary = summarizeContextReduction(protocol, runs, requests);
  assert.equal(summary.allPhysicalPromptReductionFraction, 0.6);
  assert.equal(summary.measuredAtLeast50Percent, true);
  assert.equal(summary.arms.raw.allPhysical.totals.promptTokens, 6000);
  assert.equal(summary.arms.compressed.allPhysical.totals.promptTokens, 2400);
  assert.equal(summary.answerQualityTested, false);
  assert.equal(summary.productionImprovementQualified, false);
});
test("compressor input makes task-only win insufficient for whole workflow goal", () => {
  const { protocol, runs, requests } = population({ compressorPrompt: 900 });
  const summary = summarizeContextReduction(protocol, runs, requests);
  assert.equal(summary.taskPromptReductionFraction, 0.6);
  assert.ok(
    Math.abs(summary.allPhysicalPromptReductionFraction - -0.3) < 1e-10,
  );
  assert.equal(summary.measuredAtLeast50Percent, false);
  assert.equal(summary.arms.compressed.compressor.physicalRequests, 6);
});
test("unknown physical usage, unrun slots and unsuccessful cleanup never pass aggregate objective", () => {
  const { protocol, runs, requests } = population();
  requests[0].usage = null;
  assert.equal(
    summarizeContextReduction(protocol, runs, requests)
      .allPhysicalPromptReductionFraction,
    null,
  );
  assert.equal(
    summarizeContextReduction(protocol, runs.slice(1), requests)
      .measuredAtLeast50Percent,
    false,
  );
  requests[0].usage = tokenUsage(1000);
  runs[0].cleanup = { affirmative: false };
  const summary = summarizeContextReduction(protocol, runs, requests);
  assert.equal(summary.executionVerified, false);
  assert.equal(summary.measuredAtLeast50Percent, false);
});
test("missing cache remains null while independently complete prompt counters are measured", () => {
  const stats = aggregatePhysicalUsage([
    { physical: true, usage: tokenUsage(100, 10, null) },
  ]);
  assert.equal(stats.complete, true);
  assert.equal(stats.cacheComplete, false);
  assert.equal(stats.totals.promptTokens, 100);
  assert.equal(stats.totals.cachedPromptTokens, null);
  assert.equal(stats.knownCacheUsageRequests, 0);
});
test("publication whitelists omit system bodies, messages, answers, keys and freeform errors", () => {
  const sentinel = "PRIVATE_SF_SYSTEM PRIVATE_ANSWER PRIVATE_KEY";
  const row = publicationPhysicalRequest({
    ...physical("release-orion__r1__raw", "task", 100),
    request: { messages: [sentinel] },
    requestBody: sentinel,
    answer: sentinel,
    error: sentinel,
    apiKey: sentinel,
  });
  const run = publicationWorkflow({
    id: "release-orion__r1__raw",
    caseId: "release-orion",
    arm: "raw",
    status: "error",
    cleanup,
    messages: [sentinel],
    answer: sentinel,
    errors: [sentinel],
    requestBody: sentinel,
  });
  assert.ok(!JSON.stringify({ row, run }).includes("PRIVATE_"));
  assert.equal(run.errorCode, "workflow_failed_or_cleanup_uncertain");
});
test("actual wire compressed SHA is tied to controller original SHA and tool ordinal", () => {
  const record = contextReductionCases()[0],
    excerpt = "Invented excerpt";
  const status = {
    candidate: {
      blocks: [
        {
          originalSha256: record.toolSha256,
          compressedSha256: hash(excerpt),
          toolResultOrdinal: 1,
        },
      ],
    },
  };
  const body = {
    messages: [
      { role: "system", content: "PRIVATE_SF_SYSTEM" },
      { role: "tool", tool_call_id: "call", content: excerpt },
    ],
  };
  const proof = observeWireToolProjection(body, status, record);
  assert.equal(proof[0].projected, true);
  assert.equal(proof[0].literalOriginal, false);
  assert.ok(!JSON.stringify(proof).includes("PRIVATE_"));
  status.candidate.blocks[0].originalSha256 = "b".repeat(64);
  assert.equal(
    observeWireToolProjection(body, status, record)[0].projected,
    false,
  );
});
test("prepare freezes fixture, source, schedule, parameters and all23 supplied factory pins", async (t) => {
  const { options, prepared } = await sandbox(t, { withSfPi: true });
  const protocol = JSON.parse(
    await readFile(join(options.output, "protocol.json"), "utf8"),
  );
  assert.equal(protocol.schedule.length, 12);
  assert.equal(protocol.sfSources.filter((row) => row.factory).length, 23);
  assert.equal(protocol.evidenceMode, "injected-cpu-test");
  assert.equal(
    hash(await readFile(join(options.output, "fixture.freeze.json"))),
    protocol.fixtureSha256,
  );
  assert.equal(
    hash(await readFile(join(options.output, "protocol.json"))),
    prepared.protocolSha256,
  );
  assert.equal(protocol.parameters.pacing.minRequestIntervalMs, 5000);
});
test("root execution checkpoints each completed workflow before starting the next and strips private fields", async (t) => {
  const { options, dependencies } = await sandbox(t);
  const execution = fakeExecution(dependencies, {
    onRun: async (input, calls) => {
      if (calls.length > 2) {
        const previous = calls.at(-2);
        assert.equal(
          JSON.parse(
            await readFile(join(options.output, previous + ".json"), "utf8"),
          ).status,
          "completed",
        );
        const checkpoint = JSON.parse(
          await readFile(join(options.output, "result.json"), "utf8"),
        );
        assert.ok(checkpoint.runs.some((run) => run.id === previous));
      }
    },
  });
  const result = await executeContextReduction(options, execution.dependencies);
  assert.equal(result.summary.observed, 12);
  assert.equal(result.summary.measuredAtLeast50Percent, true);
  assert.equal(execution.calls.at(-1), "remove:llmgw");
  const serialized = await readFile(
    join(options.output, "result.json"),
    "utf8",
  );
  assert.ok(!serialized.includes("PRIVATE_"));
  assert.equal(result.runtimeCleanup, "completed");
  assert.equal(
    result.schedule.filter((row) => row.status === "unrun").length,
    0,
  );
  await assert.rejects(
    executeContextReduction(options, execution.dependencies),
  ); // permanent exclusive claim
  assert.equal(execution.calls.filter((entry) => entry === "build").length, 1);
});
test("setup failures preserve twelve unrun slots, safe error flag and restored fetch", async (t) => {
  const { options, dependencies } = await sandbox(t),
    execution = fakeExecution(dependencies, { setupFailure: true });
  const fetch = globalThis.fetch,
    stdout = process.stdout.write,
    stderr = process.stderr.write;
  const result = await executeContextReduction(options, execution.dependencies);
  assert.equal(result.status, "error");
  assert.equal(result.summary.unrun, 12);
  assert.equal(result.setupError, true);
  assert.equal(globalThis.fetch, fetch);
  assert.equal(process.stdout.write, stdout);
  assert.equal(process.stderr.write, stderr);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
});
test("uncertain session cleanup stops further scheduled workflows without dropping the remainder", async (t) => {
  const { options, dependencies } = await sandbox(t),
    execution = fakeExecution(dependencies, { failedCleanup: true });
  const result = await executeContextReduction(options, execution.dependencies);
  assert.equal(result.summary.observed, 1);
  assert.equal(result.summary.unrun, 11);
  assert.equal(result.status, "error");
  assert.equal(result.summary.measuredAtLeast50Percent, false);
});
test("changed source or protocol expected SHA rejects before runtime and credential resolution", async (t) => {
  const { options, dependencies, source } = await sandbox(t),
    execution = fakeExecution(dependencies);
  await writeFile(source, "Changed invented source\n");
  await assert.rejects(
    executeContextReduction(options, execution.dependencies),
  );
  assert.equal(execution.calls.length, 0);
  assert.equal(
    await readFile(join(options.output, "run-claim.json")).catch(() => null),
    null,
  );
});
test("foreign result bytes cannot be overwritten or trigger runtime construction", async (t) => {
  const { options, dependencies } = await sandbox(t),
    execution = fakeExecution(dependencies);
  const foreign = Buffer.from("Foreign evidence bytes\n");
  await writeFile(join(options.output, "result.json"), foreign);
  await assert.rejects(
    executeContextReduction(options, execution.dependencies),
  );
  assert.deepEqual(
    await readFile(join(options.output, "result.json")),
    foreign,
  );
  assert.equal(execution.calls.length, 0);
});
test("bounded SSE adapter retains server usage and only hashes private payloads", async () => {
  const record = contextReductionCases()[0],
    slot = contextReductionSchedule([record])[0],
    physicalRequests = [],
    wireProof = [];
  const wire = [
    "data: " +
      JSON.stringify({
        model: "grok-4.6",
        choices: [
          {
            index: 0,
            delta: { content: "PRIVATE_ANSWER" },
            finish_reason: null,
          },
        ],
      }),
    "data: " +
      JSON.stringify({
        model: "grok-4.6",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }),
    "data: " +
      JSON.stringify({
        model: "grok-4.6",
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 2,
          total_tokens: 102,
          prompt_tokens_details: { cached_tokens: 20 },
        },
      }),
    "data: [DONE]",
    "",
  ].join("\n\n");
  const fetchImpl = async (_input, init) => {
    physicalRequests.push({
      index: 0,
      physical: true,
      workflowId: slot.id,
      kind: "task",
      requestSha256: hash(init.body),
      status: "response_received",
    });
    return new Response(wire, { status: 200 });
  };
  const adapter = createReductionTaskFetch({
    fetchImpl,
    physicalRequests,
    slot,
    record,
    controller: { status: () => ({}) },
    wireProof,
    signal: new AbortController().signal,
  });
  const response = await adapter(GATEWAY_ORIGIN + "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "grok-4.6",
      stream: true,
      max_tokens: 4096,
      messages: [{ role: "system", content: "PRIVATE_SF_SYSTEM" }],
      tools: [],
    }),
  });
  await response.text();
  const published = publicationPhysicalRequest(physicalRequests[0]);
  assert.equal(published.usage.promptTokens, 100);
  assert.equal(published.usage.cachedPromptTokens, 20);
  assert.equal(published.completed, true);
  assert.ok(!JSON.stringify(published).includes("PRIVATE_"));
});
