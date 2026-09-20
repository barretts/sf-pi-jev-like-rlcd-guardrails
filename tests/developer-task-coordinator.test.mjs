import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateQualityRecords } from "../dist/evaluation.js";
import { scoreReviewFinal } from "../scripts/developer-review-scoring.mjs";
import {
  comparisonReport,
  accountObservedProviderUsage,
  approvedGatewayOrigin,
  assertProviderRequest,
  configuredOrigin,
  configuredProviderBinding,
  loadConfiguredProvider,
  localGoogleGemma4Model,
  observeJevWork,
  providerModelProjection,
  providerResourceScope,
  providerSourceBinding,
  redactProviderEvidence,
  reviewImprovementGates,
  reviewSuiteSummary,
  startFetchObservation,
  taskClassifierConfig,
  validateUpstreamProof,
} from "../scripts/developer-task-eval.mjs";

function expectedBatches() {
  let id = 0;
  return Array.from({ length: 13 }, (_, batch) => {
    const records = ["choice", "score", "noul"].flatMap((type) =>
      ["state", "chat"].map((representation) => {
        const question = {
          id: "q",
          type,
          instructions: "Judge only the trusted synthetic evidence.",
          ...(type === "choice"
            ? {
                criteria: [
                  { id: "fresh", description: "Latest request owns state" },
                  { id: "stale", description: "Old request overwrites state" },
                ],
              }
            : type === "score"
              ? {
                  criteria: [
                    "No coverage",
                    "Partial coverage",
                    "Full coverage",
                  ],
                }
              : {}),
        };
        const context =
          "Trusted synthetic trace: latest request owns state; rubric credit is 1.25. Missing observations remain unknown.";
        return {
          id: `r_${String(++id).padStart(4, "0")}`,
          group_id: `context-${type}-${batch}`,
          split: "validation",
          regression: batch === 0,
          request: {
            model: "google/gemma-3-1b-it",
            ...(representation === "state"
              ? { state: context }
              : { messages: [{ role: "user", content: context }] }),
            questions: [question],
          },
          targets: {
            q: {
              answer:
                type === "choice"
                  ? "fresh"
                  : type === "score"
                    ? 1.25
                    : [null, true, false][batch % 3],
            },
          },
        };
      }),
    );
    return {
      id: `review-batch-${String(batch + 1).padStart(2, "0")}`,
      records: validateQualityRecords(records),
    };
  });
}

test("repair advice and extension tools retain the explicit research artifact and selected device", () => {
  const defaults = {
    modelId: "google/gemma-3-1b-it",
    modelFile: "/official/model.gguf",
    artifactRegistryPath: "/official/registry.json",
    templateVersion: "v1",
    device: "metal",
    binary: "/owned/jev-native",
    maxModelLen: 8192,
    maxBatchSize: 8,
  };
  const original = structuredClone(defaults);
  const selection = {
    classifier_model: "jev/gemma-3-1b-research",
    classifier_model_file: "/private/.build/candidate.gguf",
    classifier_registry_path: "/private/.build/research-registry.json",
    classifier_device: "cpu",
  };
  for (const kind of ["repair", "review"]) {
    const scoped = taskClassifierConfig({ ...selection, kind }, defaults);
    assert.deepEqual(scoped, {
      ...defaults,
      modelId: selection.classifier_model,
      modelFile: selection.classifier_model_file,
      artifactRegistryPath: selection.classifier_registry_path,
      device: "cpu",
      templateVersion: "v2",
    });
    assert.notEqual(scoped, defaults);
  }
  assert.deepEqual(defaults, original, "Global defaults remain untouched");
});

test("gateway usage counts each SDK assistant once across redacted journal and raw final state", () => {
  const message = {
    role: "assistant",
    timestamp: 1,
    stopReason: "toolUse",
    provider: "llmgw",
    model: "gpt-5.6-sol",
    usage: {
      input: 12,
      output: 3,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 18,
    },
    content: [
      {
        type: "toolCall",
        id: "bash-1",
        name: "bash",
        arguments: { command: "pwd" },
      },
      {
        type: "text",
        text: "Bearer synthetic-opaque-value sk-synthetic-secret",
      },
    ],
  };
  const events = redactProviderEvidence([
    { type: "message_start", message: { ...message, stopReason: "pending" } },
    {
      type: "message_update",
      assistant_event_type: "text_delta",
      delta: "work",
    },
    { type: "message_end", message },
  ]);
  const result = accountObservedProviderUsage(
    { messages: [message], events },
    "configuredGateway",
  );
  assert.equal(result.complete, true);
  assert.equal(result.messages.length, 1);
  assert.equal(result.generated_tokens, 3);
  assert.deepEqual(result.totals, message.usage);
  assert.deepEqual(result.reported_usage_lower_bound, message.usage);
  assert.equal(message.content[0].arguments.command, "pwd");
  assert.ok(!JSON.stringify(result).includes("synthetic-opaque-value"));
  const second = {
    ...message,
    content: [{ ...message.content[0], id: "bash-2" }],
  };
  const two = accountObservedProviderUsage(
    {
      messages: [message, second],
      events: [
        ...events,
        { type: "message_end", message: redactProviderEvidence(second) },
      ],
    },
    "configuredGateway",
  );
  assert.equal(two.complete, true);
  assert.equal(two.messages.length, 2);
  assert.equal(two.generated_tokens, 6);
});

const ordinaryCatalog = [
  "read",
  "edit",
  "write",
  "bash",
  "sf_local_catalog",
].map((name) => ({ name, description: `Stable ${name}`, parameters: {} }));
const candidateCatalog = [
  ...ordinaryCatalog,
  { name: "jev_classify", description: "Typed classification", parameters: {} },
  {
    name: "jev_classify_loaded",
    description: "Loaded-reference classification",
    parameters: {},
  },
];

function completeRuns(batches, repetitions = 3) {
  const runs = [];
  for (let repetition = 1; repetition <= repetitions; repetition++)
    for (const [index, batch] of batches.entries()) {
      const arms =
        (repetition + index) % 2 === 0
          ? ["candidate", "baseline"]
          : ["baseline", "candidate"];
      for (const arm of arms) {
        const generated = arm === "baseline" ? 200 : 100;
        const model = {
          id: "local-test-agent",
          provider: "local",
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:8081/v1",
        };
        runs.push({
          task: batch.id,
          workflow: "review",
          arm,
          repetition,
          execution_order: runs.length + 1,
          passed: true,
          agent_completed: true,
          total_elapsed_ms: arm === "baseline" ? 1000 : 700,
          prompt_sha256: `matched-prompt-${batch.id}`,
          review_input_sha256: `matched-input-${batch.id}`,
          inventory_sha256: arm,
          tool_catalog:
            arm === "baseline"
              ? structuredClone(ordinaryCatalog)
              : structuredClone(candidateCatalog),
          thinking_level: "medium",
          model,
          generation_config: {
            model: structuredClone(model),
            timeout_ms: 600000,
            tool_choice: "automatic",
            provider_stream: "Pi SDK unmodified",
          },
          settings: {
            compaction: { enabled: false },
            retry: { enabled: false, provider: { maxRetries: 0 } },
          },
          owned_server: {
            state: "ready",
            server: {
              model: {
                id: "local-test-agent",
                sha256: "agent-weight",
                file: "/owned/model.gguf",
              },
              binary: "/owned/llama-server",
              binary_sha256: "binary",
              template_file: "/owned/template.jinja",
              template_sha256: "template",
              native_revision: "pinned",
              context_size: 32768,
              parallel: 1,
              device: "metal",
              actual_device: "metal",
              host: "127.0.0.1",
              port: 8081,
            },
          },
          executed_source: {
            canonical_baseline_commit: "baseline",
            executed_head: "checkpoint",
            files: [{ file: "script", sha256: "same" }],
          },
          sf_factory_sources: [
            { path: "/isolated/sf/factory", sha256: "same" },
          ],
          provider_usage: {
            complete: true,
            generated_tokens: generated,
            generated_tokens_lower_bound: generated,
            totals: {
              input: 1000,
              output: generated,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 1000 + generated,
            },
          },
          acceptance: scoreReviewFinal({
            text: JSON.stringify(
              Object.fromEntries(
                batch.records.map((record) => [record.id, record.targets]),
              ),
            ),
            records: batch.records,
          }),
          ...jevRunFields(arm === "candidate" ? batch.records : []),
        });
      }
    }
  return runs;
}

function nativeResponse() {
  return {
    model: "google/gemma-3-1b-it",
    answers: {},
    usage: { input_tokens: 10, output_tokens: 0 },
    metrics: {
      computed_prompt_tokens: 11,
      computed_output_tokens: 0,
      engine_forwards: 2,
      backend_compute_seconds: 0.02,
    },
    metadata: { template_version: "v2", inference_backend: "llama.cpp" },
  };
}

function loadedReceipt(records, completed = records.length) {
  return {
    model: "google/gemma-3-1b-it",
    total_records: records.length,
    source: { read_tool_call_id: "read-1" },
    results: records.slice(0, completed).map((record) => ({
      id: record.id,
      request_sha256: `request-${record.id}`,
      response: nativeResponse(),
    })),
  };
}

function jevRunFields(records) {
  if (!records.length)
    return { events: [], selected_tools: [], additional_jev_tool_results: [] };
  const details = loadedReceipt(records);
  return {
    advice: null,
    selected_tools: [
      {
        type: "toolCall",
        id: "jev-1",
        name: "jev_classify_loaded",
        arguments: { read_tool_call_id: "read-1" },
      },
    ],
    events: [
      {
        type: "tool_execution_start",
        observed_at_ms: 10,
        toolCallId: "jev-1",
        toolName: "jev_classify_loaded",
      },
      {
        type: "tool_execution_end",
        observed_at_ms: 110,
        toolCallId: "jev-1",
        toolName: "jev_classify_loaded",
        isError: false,
        result: { details },
      },
    ],
    additional_jev_tool_results: [
      {
        role: "toolResult",
        toolName: "jev_classify_loaded",
        toolCallId: "jev-1",
        isError: false,
        details,
      },
    ],
  };
}

test("missing candidate worker acceptance counts all six failed judgments and blocks coverage and improvement", async () => {
  const batches = expectedBatches();
  const runs = completeRuns(batches);
  const missing = runs.find(
    (run) =>
      run.arm === "candidate" &&
      run.repetition === 1 &&
      run.task === batches[0].id,
  );
  missing.passed = false;
  delete missing.acceptance;
  missing.provider_usage = {
    complete: false,
    generated_tokens: null,
    generated_tokens_lower_bound: 0,
  };
  const suite = await reviewSuiteSummary(runs, batches, 3);
  assert.equal(suite.arms.baseline.quality.attempts, 234);
  assert.equal(suite.arms.candidate.quality.attempts, 234);
  assert.equal(suite.arms.candidate.quality.execution_failures, 6);
  assert.equal(suite.arms.candidate.quality.accepted_correct_judgments, 228);
  assert.equal(suite.arms.candidate.quality.gates.passed, false);
  assert.equal(suite.coverage_complete, false);
  assert.equal(suite.full_confirmation_complete, false);
  assert.equal(
    reviewImprovementGates(suite, comparisonReport(runs, "ordinary")).passed,
    false,
  );
});

test("wrong and duplicate opaque record IDs cannot substitute for expected judgments", async () => {
  for (const kind of ["wrong", "duplicate"]) {
    const batches = expectedBatches();
    const runs = completeRuns(batches);
    const altered = runs.find((run) => run.arm === "candidate");
    altered.acceptance.attempts[0].record_id =
      kind === "wrong"
        ? "r_unexpected"
        : altered.acceptance.attempts[1].record_id;
    const suite = await reviewSuiteSummary(runs, batches, 3);
    assert.equal(suite.arms.candidate.quality.attempts, 234, kind);
    assert.equal(suite.coverage_complete, false, kind);
    assert.equal(suite.full_confirmation_complete, false, kind);
    assert.equal(suite.arms.candidate.quality.gates.passed, false, kind);
    assert.equal(
      reviewImprovementGates(suite, comparisonReport(runs, "ordinary")).passed,
      false,
      kind,
    );
  }
});

test("an omitted candidate run still contributes all expected failures", async () => {
  const batches = expectedBatches();
  const runs = completeRuns(batches);
  const omitted = runs.findIndex(
    (run) =>
      run.arm === "candidate" &&
      run.repetition === 2 &&
      run.task === batches[4].id,
  );
  runs.splice(omitted, 1);
  const suite = await reviewSuiteSummary(runs, batches, 3);
  assert.equal(suite.arms.candidate.quality.attempts, 234);
  assert.equal(suite.arms.candidate.quality.execution_failures, 6);
  assert.equal(suite.arms.candidate.coverage.expected_runs, 39);
  assert.equal(suite.arms.candidate.coverage.observed_runs, 38);
  assert.equal(suite.coverage_complete, false);
  assert.equal(suite.full_confirmation_complete, false);
});

test("complete matched confirmation preserves micro counts and the 39 independent quality groups", async () => {
  const batches = expectedBatches();
  const runs = completeRuns(batches);
  const suite = await reviewSuiteSummary(runs, batches, 3);
  const paired = comparisonReport(runs, "ordinary");
  assert.equal(suite.coverage_complete, true);
  assert.equal(suite.full_confirmation_complete, true);
  assert.equal(suite.independent_context_groups, 39);
  assert.match(suite.timing_unit, /batch/);
  for (const arm of ["baseline", "candidate"]) {
    const report = suite.arms[arm];
    assert.equal(report.quality.attempts, 234);
    assert.equal(report.quality.accepted_correct_judgments, 234);
    assert.equal(report.quality.choice.count, 78);
    assert.equal(report.quality.score.count, 78);
    assert.equal(
      report.quality.noul.clear_count + report.quality.noul.uncertain_count,
      78,
    );
    assert.equal(report.quality.gates.passed, true);
    assert.equal(report.coverage.complete, true);
    assert.equal(report.coverage.expected_judgments, 234);
    assert.equal(report.coverage.observed_judgments, 234);
    assert.equal(report.coverage.scored_judgments, 234);
    assert.equal(report.coverage.groups.length, 39);
    for (const group of report.coverage.groups) {
      assert.equal(group.complete, true);
      assert.equal(group.correct_judgment_rate, 1);
      assert.equal(group.record_ids.length, 2);
      assert.equal(group.expected_repetitions, 3);
      assert.equal(group.representations.length, 2);
      for (const representation of group.representations) {
        assert.equal(representation.repetitions.length, 3);
        assert.deepEqual(
          representation.repetitions.map(
            (observation) => observation.repetition,
          ),
          [1, 2, 3],
        );
        assert.ok(
          representation.repetitions.every(
            (observation) =>
              observation.observed && observation.correct_judgment,
          ),
        );
      }
    }
  }
  assert.equal(paired.pairs.length, 39);
  assert.equal(paired.accepted_pairs, 39);
  assert.ok(
    paired.pairs.every((pair) => pair.protocol_passed && pair.both_accepted),
  );
  const gates = reviewImprovementGates(suite, paired);
  assert.equal(gates.quality_passed, true);
  assert.equal(gates.coverage_passed, true);
  assert.equal(gates.functional_workflows_passed, true);
  assert.equal(gates.provider_usage_complete, true);
  assert.equal(gates.jev_usage_complete, true);
  assert.equal(gates.resource_claim_eligible, true);
  assert.equal(gates.elapsed_gain_passed, true);
  assert.equal(gates.generative_gain_passed, true);
  assert.equal(gates.passed, true);
});

test("observed protocol drift or missing binding blocks an otherwise accepted pair's claim", () => {
  const cases = [
    [
      "thinking drift",
      "same_thinking_level",
      (run) => {
        run.thinking_level = "high";
      },
    ],
    [
      "generation model drift",
      "same_generation_config",
      (run) => {
        run.generation_config.model.id = "different-agent";
      },
    ],
    [
      "settings drift",
      "same_settings",
      (run) => {
        run.settings.compaction.enabled = true;
      },
    ],
    [
      "thinking missing",
      "same_thinking_level",
      (run) => {
        delete run.thinking_level;
      },
    ],
    [
      "generation config missing",
      "same_generation_config",
      (run) => {
        delete run.generation_config;
      },
    ],
    [
      "settings missing",
      "same_settings",
      (run) => {
        delete run.settings;
      },
    ],
    [
      "owned server binding missing",
      "same_owned_server_binding",
      (run) => {
        delete run.owned_server;
      },
    ],
    [
      "executed source missing",
      "same_executed_source",
      (run) => {
        delete run.executed_source;
      },
    ],
    [
      "SF factory source missing",
      "same_sf_factory_sources",
      (run) => {
        delete run.sf_factory_sources;
      },
    ],
    [
      "both thinking observations missing",
      "same_thinking_level",
      (run) => {
        delete run.thinking_level;
      },
      true,
    ],
    [
      "both generation observations missing",
      "same_generation_config",
      (run) => {
        delete run.generation_config;
      },
      true,
    ],
    [
      "both settings observations missing",
      "same_settings",
      (run) => {
        delete run.settings;
      },
      true,
    ],
    [
      "both server bindings missing",
      "same_owned_server_binding",
      (run) => {
        delete run.owned_server;
      },
      true,
    ],
    [
      "both source observations missing",
      "same_executed_source",
      (run) => {
        delete run.executed_source;
      },
      true,
    ],
    [
      "both SF source observations missing",
      "same_sf_factory_sources",
      (run) => {
        delete run.sf_factory_sources;
      },
      true,
    ],
    [
      "both generation observations empty",
      "same_generation_config",
      (run) => {
        run.generation_config = {};
      },
      true,
    ],
    [
      "both settings observations empty",
      "same_settings",
      (run) => {
        run.settings = {};
      },
      true,
    ],
    [
      "owned template drift",
      "same_owned_server_binding",
      (run) => {
        run.owned_server.server.template_sha256 = "different";
      },
    ],
    [
      "executed source drift",
      "same_executed_source",
      (run) => {
        run.executed_source.files[0].sha256 = "different";
      },
    ],
    [
      "SF source drift",
      "same_sf_factory_sources",
      (run) => {
        run.sf_factory_sources[0].sha256 = "different";
      },
    ],
  ];
  for (const [name, flag, mutate, bothArms] of cases) {
    const batches = expectedBatches();
    const runs = completeRuns(batches);
    const altered = runs.find((run) => run.arm === "candidate");
    mutate(altered);
    if (bothArms)
      mutate(
        runs.find(
          (run) =>
            run.arm === "baseline" &&
            run.task === altered.task &&
            run.repetition === altered.repetition,
        ),
      );
    const suite = reviewSuiteSummary(runs, batches, 3);
    const paired = comparisonReport(runs, "ordinary");
    const pair = paired.pairs.find(
      (value) =>
        value.task === altered.task && value.repetition === altered.repetition,
    );
    assert.equal(pair.both_accepted, true, name);
    assert.equal(pair.same_raw_user_prompt, true, name);
    assert.equal(pair.same_review_input, true, name);
    assert.equal(pair[flag], false, name);
    assert.equal(pair.protocol_passed, false, name);
    const gates = reviewImprovementGates(suite, paired);
    assert.equal(gates.functional_workflows_passed, true, name);
    assert.equal(gates.protocol_passed, false, name);
    assert.equal(gates.resource_claim_eligible, false, name);
    assert.equal(gates.passed, false, name);
  }
});

test("complete usage labels cannot hide missing counters or inconsistent generated output", () => {
  const cases = [
    [
      "missing totals",
      (run) => {
        delete run.provider_usage.totals;
      },
    ],
    [
      "missing cache counter",
      (run) => {
        delete run.provider_usage.totals.cacheWrite;
      },
    ],
    [
      "inconsistent output",
      (run) => {
        run.provider_usage.totals.output++;
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    const batches = expectedBatches();
    const runs = completeRuns(batches);
    const altered = runs.find((run) => run.arm === "candidate");
    mutate(altered);
    assert.equal(altered.provider_usage.complete, true, name);
    const suite = reviewSuiteSummary(runs, batches, 3);
    const paired = comparisonReport(runs, "ordinary");
    const pair = paired.pairs.find(
      (value) =>
        value.task === altered.task && value.repetition === altered.repetition,
    );
    assert.equal(pair.both_accepted, true, name);
    assert.equal(pair.protocol_passed, true, name);
    assert.equal(pair.exact_generation_comparison_available, false, name);
    assert.equal(pair.candidate_generated_tokens, null, name);
    assert.equal(suite.arms.candidate.usage_complete, false, name);
    assert.equal(suite.arms.candidate.generated_tokens, null, name);
    const gates = reviewImprovementGates(suite, paired);
    assert.equal(gates.functional_workflows_passed, true, name);
    assert.equal(gates.provider_usage_complete, false, name);
    assert.equal(gates.resource_claim_eligible, false, name);
    assert.equal(gates.passed, false, name);
  }
});

test("incomplete provider usage blocks resource claims while functional acceptance remains true", async () => {
  const batches = expectedBatches();
  const runs = completeRuns(batches);
  const incomplete = runs.find((run) => run.arm === "candidate");
  incomplete.provider_usage.complete = false;
  incomplete.provider_usage.generated_tokens = null;
  incomplete.provider_usage.totals = null;
  const suite = await reviewSuiteSummary(runs, batches, 3);
  const gates = reviewImprovementGates(
    suite,
    comparisonReport(runs, "ordinary"),
  );
  assert.equal(suite.coverage_complete, true);
  assert.equal(suite.full_confirmation_complete, true);
  assert.equal(suite.arms.candidate.accepted_batches, 39);
  assert.equal(suite.arms.candidate.quality.gates.passed, true);
  assert.equal(suite.arms.candidate.generated_tokens, null);
  assert.equal(gates.functional_workflows_passed, true);
  assert.equal(gates.provider_usage_complete, false);
  assert.equal(gates.resource_claim_eligible, false);
  assert.equal(gates.passed, false);
});

test("unknown native work blocks a resource claim after an otherwise accepted recovery", async () => {
  const batches = expectedBatches();
  const runs = completeRuns(batches);
  const recovered = runs.find((run) => run.arm === "candidate");
  recovered.additional_jev_tool_results = [];
  recovered.events[1].isError = true;
  recovered.events[1].result = {
    content: [
      {
        type: "text",
        text: "Native request failed; assistant later completed its review independently.",
      },
    ],
  };
  const suite = await reviewSuiteSummary(runs, batches, 3);
  const gates = reviewImprovementGates(
    suite,
    comparisonReport(runs, "ordinary"),
  );
  assert.equal(suite.full_confirmation_complete, true);
  assert.equal(suite.arms.candidate.accepted_batches, 39);
  assert.equal(suite.arms.candidate.quality.gates.passed, true);
  assert.equal(gates.functional_workflows_passed, true);
  assert.equal(gates.provider_usage_complete, true);
  assert.equal(gates.jev_usage_complete, false);
  assert.equal(gates.resource_claim_eligible, false);
  assert.equal(gates.passed, false);
});

test("different review input invalidates a fast accepted pair's improvement claim", async () => {
  const batches = expectedBatches();
  const runs = completeRuns(batches);
  const altered = runs.find((run) => run.arm === "candidate");
  altered.review_input_sha256 = "different-input";
  const suite = await reviewSuiteSummary(runs, batches, 3);
  const paired = comparisonReport(runs, "ordinary");
  const pair = paired.pairs.find(
    (value) =>
      value.task === altered.task && value.repetition === altered.repetition,
  );
  assert.equal(pair.both_accepted, true);
  assert.equal(pair.same_raw_user_prompt, true);
  assert.equal(pair.same_review_input, false);
  assert.equal(pair.protocol_passed, false);
  const gates = reviewImprovementGates(suite, paired);
  assert.equal(gates.functional_workflows_passed, true);
  assert.equal(gates.protocol_passed, false);
  assert.equal(gates.resource_claim_eligible, false);
  assert.equal(gates.passed, false);
});

test("advice-off loaded and generic tool work uses actual intervals and deduplicated native receipts", () => {
  const records = expectedBatches()[0].records;
  const loaded = observeJevWork({
    agent_completed: true,
    ...jevRunFields(records),
  });
  assert.equal(loaded.elapsed_ms, 100);
  assert.equal(loaded.intervals_complete, true);
  assert.equal(loaded.usage_complete, true);
  assert.deepEqual(loaded.usage, { input_tokens: 60, output_tokens: 0 });
  assert.equal(loaded.metrics_complete, true);
  assert.equal(loaded.metrics.computed_prompt_tokens.total, 66);
  assert.equal(loaded.metrics.computed_prompt_tokens.complete, true);
  assert.equal(loaded.metrics.computed_prompt_tokens.measured_responses, 6);
  assert.equal(loaded.calls.length, 1);
  assert.equal(loaded.responses.length, 6);
  const details = nativeResponse();
  const generic = observeJevWork({
    agent_completed: true,
    advice: null,
    selected_tools: [{ id: "jev-generic", name: "jev_classify" }],
    events: [
      {
        type: "tool_execution_start",
        observed_at_ms: 20,
        toolCallId: "jev-generic",
        toolName: "jev_classify",
      },
      {
        type: "tool_execution_end",
        observed_at_ms: 55,
        toolCallId: "jev-generic",
        toolName: "jev_classify",
        isError: false,
        result: { details },
      },
    ],
    additional_jev_tool_results: [
      {
        role: "toolResult",
        toolName: "jev_classify",
        toolCallId: "jev-generic",
        details,
      },
    ],
  });
  assert.equal(generic.elapsed_ms, 35);
  assert.equal(generic.usage_complete, true);
  assert.deepEqual(generic.usage, { input_tokens: 10, output_tokens: 0 });
  assert.equal(generic.responses.length, 1);
});

test("partial loaded failure retains completed native lower bounds while exact work stays unknown", () => {
  const records = expectedBatches()[0].records;
  const details = loadedReceipt(records, 1);
  const work = observeJevWork({
    agent_completed: false,
    advice: null,
    selected_tools: [{ id: "jev-partial", name: "jev_classify_loaded" }],
    events: [
      {
        type: "tool_execution_start",
        observed_at_ms: 10,
        toolCallId: "jev-partial",
        toolName: "jev_classify_loaded",
      },
      {
        type: "tool_execution_update",
        observed_at_ms: 70,
        toolCallId: "jev-partial",
        toolName: "jev_classify_loaded",
        partialResult: { details },
      },
      {
        type: "tool_execution_end",
        observed_at_ms: 100,
        toolCallId: "jev-partial",
        toolName: "jev_classify_loaded",
        isError: true,
        result: { content: [{ type: "text", text: "cancelled" }] },
      },
    ],
    additional_jev_tool_results: [],
  });
  assert.equal(work.elapsed_ms, 90);
  assert.equal(work.intervals_complete, true);
  assert.equal(work.usage_complete, false);
  assert.equal(work.usage, null);
  assert.deepEqual(work.usage_lower_bound, {
    input_tokens: 10,
    output_tokens: 0,
  });
  assert.equal(work.metrics_complete, false);
  assert.equal(work.metrics, null);
  assert.equal(work.responses.length, 1);
});

test("failed, unclosed, and unobserved Jev calls cannot become actual zero work", () => {
  const failed = observeJevWork({
    agent_completed: false,
    selected_tools: [{ id: "jev-error", name: "jev_classify" }],
    events: [
      {
        type: "tool_execution_start",
        observed_at_ms: 10,
        toolCallId: "jev-error",
        toolName: "jev_classify",
      },
      {
        type: "tool_execution_end",
        observed_at_ms: 50,
        toolCallId: "jev-error",
        toolName: "jev_classify",
        isError: true,
        result: { content: [{ type: "text", text: "backend error" }] },
      },
    ],
  });
  assert.equal(failed.elapsed_ms, 40);
  assert.equal(failed.usage, null);
  assert.equal(failed.usage_complete, false);
  assert.equal(failed.metrics, null);
  for (const events of [
    [
      {
        type: "tool_execution_start",
        observed_at_ms: 10,
        toolCallId: "jev-unknown",
        toolName: "jev_classify_loaded",
      },
    ],
    [],
  ]) {
    const unknown = observeJevWork({
      agent_completed: false,
      selected_tools: [{ id: "jev-unknown", name: "jev_classify_loaded" }],
      events,
    });
    assert.equal(unknown.elapsed_ms, null);
    assert.equal(unknown.intervals_complete, false);
    assert.equal(unknown.usage, null);
    assert.equal(unknown.usage_complete, false);
    assert.equal(unknown.metrics, null);
  }
  const noCalls = observeJevWork({
    agent_completed: true,
    advice: null,
    selected_tools: [],
    events: [],
    additional_jev_tool_results: [],
  });
  assert.equal(noCalls.observed_no_calls, true);
  assert.equal(noCalls.elapsed_ms, 0);
  assert.equal(noCalls.usage_complete, true);
  assert.deepEqual(noCalls.usage, { input_tokens: 0, output_tokens: 0 });
});

test("unknown-only batch categories remain diagnostic rather than functional rejection", () => {
  const records = expectedBatches()[0].records.filter(
    (record) => record.request.questions[0].type === "noul",
  );
  const acceptance = scoreReviewFinal({
    text: JSON.stringify(
      Object.fromEntries(
        records.map((record) => [record.id, { q: { answer: null } }]),
      ),
    ),
    records,
  });
  assert.equal(acceptance.passed, true);
  assert.equal(acceptance.summary.gates.passed, false);
  assert.equal(acceptance.summary.noul.uncertain_count, 2);
  assert.equal(acceptance.summary.noul.clear_count, 0);
});

const mockGatewayOrigin = approvedGatewayOrigin;
function mockGatewayModel() {
  return {
    id: "gpt-5.6-sol",
    name: "Synthetic configured model fixture",
    provider: "llmgw",
    api: "openai-completions",
    baseUrl: `${mockGatewayOrigin}/v1`,
    reasoning: true,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 4096,
    cost: { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 },
    compat: {
      supportsReasoningEffort: true,
      maxTokensField: "max_completion_tokens",
    },
  };
}
// In-memory synthetic validation fixtures only. These are never published as
// lineage proofs or actual provider/workflow execution receipts.
function mockReviewedAttribution(binding) {
  return {
    kind: "jev_agent_upstream_attribution",
    schema_version: 1,
    root_clearance: "ROOT_APPROVED",
    reviewed_by: "ROOT",
    verified: true,
    provider: "llmgw",
    alias: "gpt-5.6-sol",
    maker: "OpenAI",
    non_chinese_maker: true,
    model_lineage_reviewed: true,
    non_chinese_lineage: true,
    upstream_model: "synthetic-mock-upstream",
    origin: binding.origin,
    registration_sha256: binding.registration_sha256,
    reviewed_at: "2026-09-20T00:00:00Z",
    evidence: [
      {
        kind: "operator_attestation",
        locator: "synthetic-test-fixture-only",
        sha256: "b".repeat(64),
        statement:
          "Synthetic test fixture only; this does not assert actual alias-to-upstream lineage.",
      },
    ],
  };
}
function mockConfiguredRuns(batches, repetitions = 3) {
  const model = mockGatewayModel();
  const binding = configuredProviderBinding(model, mockGatewayOrigin);
  const attribution = mockReviewedAttribution(binding);
  const runs = completeRuns(batches, repetitions);
  for (const run of runs) {
    run.provider_lane = "configuredGateway";
    run.model = structuredClone(model);
    run.generation_config.model = structuredClone(model);
    run.source_binding = {
      ...structuredClone(binding),
      upstream_verification: "ROOT-reviewed frozen evidence",
      upstream_proof_sha256: "c".repeat(64),
      upstream_attribution: structuredClone(attribution),
    };
    run.resource_scope = providerResourceScope("configuredGateway");
    delete run.owned_server;
  }
  return runs;
}

test("configured request policy bounds exact HTTPS origin, path and POST without changing the local lane", () => {
  const config = {
    provider_lane: "configuredGateway",
    provider_origin: mockGatewayOrigin,
    base_url: `${mockGatewayOrigin}/v1`,
    model: mockGatewayModel(),
  };
  assert.deepEqual(
    assertProviderRequest(config, `${mockGatewayOrigin}/v1/chat/completions`, {
      method: "POST",
    }),
    {
      url: new URL(`${mockGatewayOrigin}/v1/chat/completions`),
      method: "POST",
    },
  );
  for (const [url, method] of [
    [`${mockGatewayOrigin}/v1/models`, "GET"],
    [`${mockGatewayOrigin}/v1/chat/completions`, "GET"],
    [`${mockGatewayOrigin}/v1/chat/completions/`, "POST"],
    [`${mockGatewayOrigin}/v1/chat/completions?key=synthetic`, "POST"],
    [`${mockGatewayOrigin}/v1/chat/completions#fragment`, "POST"],
    ["https://other.example/v1/chat/completions", "POST"],
    ["https://synthetic-gateway.example:8443/v1/chat/completions", "POST"],
    ["http://synthetic-gateway.example/v1/chat/completions", "POST"],
    [
      "https://synthetic:password@synthetic-gateway.example/v1/chat/completions",
      "POST",
    ],
  ])
    assert.throws(() => assertProviderRequest(config, url, { method }));
  for (const origin of [
    "http://synthetic-gateway.example",
    "https://other.example",
    `${mockGatewayOrigin}/v1`,
    `${mockGatewayOrigin}?x=1`,
    "https://user:password@synthetic-gateway.example",
  ])
    assert.throws(() => configuredOrigin(origin));
  const local = { base_url: "http://127.0.0.1:8081/v1" };
  for (const path of ["/health", "/v1/models"])
    assertProviderRequest(local, `http://127.0.0.1:8081${path}`, {
      method: "GET",
    });
  assertProviderRequest(local, "http://127.0.0.1:8081/v1/chat/completions", {
    method: "POST",
  });
  assert.throws(() =>
    assertProviderRequest(
      local,
      "https://synthetic-gateway.example/v1/chat/completions",
      { method: "POST" },
    ),
  );
});

test("gateway fetch observation rejects before fetch, preserves stream/body and disables redirects with credential-redacted evidence", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "jev-provider-transport-mock-"),
  );
  const original = globalThis.fetch;
  let transport;
  const calls = [];
  let responseStatus = 200,
    mockResponse;
  try {
    const sse =
      'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"apiKey":"synthetic-opaque-value"},"timings":{"predicted_n":3,"predicted_ms":20,"headers":{"authorization":"synthetic-opaque-value"},"env":{"API_KEY":"synthetic-opaque-value"}},"headers":{"authorization":"synthetic-opaque-value"}}\n\ndata: [DONE]\n\n';
    mockResponse = sse;
    globalThis.fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response(mockResponse, {
        status: responseStatus,
        headers: {
          "content-type": "text/event-stream",
          authorization: "synthetic-opaque-value",
        },
      });
    };
    const observation = { fetches: [] };
    const config = {
      directory,
      provider_lane: "configuredGateway",
      provider_origin: mockGatewayOrigin,
      base_url: `${mockGatewayOrigin}/v1`,
      model: mockGatewayModel(),
    };
    transport = await startFetchObservation(config, observation);
    await assert.rejects(
      globalThis.fetch(`${mockGatewayOrigin}/v1/models`, { method: "GET" }),
    );
    assert.equal(calls.length, 0);
    const body = JSON.stringify({
      model: "gpt-5.6-sol",
      stream: true,
      tool_choice: "auto",
      messages: [{ role: "user", content: "Synthetic ordinary task prompt" }],
      metadata: {
        apiKey: "synthetic-opaque-value",
        headers: { authorization: "synthetic-opaque-value" },
      },
    });
    const response = await globalThis.fetch(
      `${mockGatewayOrigin}/v1/chat/completions`,
      {
        method: "POST",
        body,
        redirect: "follow",
        headers: { authorization: "Bearer synthetic-opaque-value" },
      },
    );
    assert.equal(
      await response.text(),
      sse,
      "The provider receives its unmodified response stream",
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.body, body);
    assert.equal(calls[0].init.redirect, "error");
    assert.equal(
      calls[0].init.headers.authorization,
      "Bearer synthetic-opaque-value",
      "Authentication is forwarded but never recorded",
    );
    await transport.finish();
    transport = null;
    const entry = observation.fetches[1];
    assert.equal(
      entry.request_body_sha256,
      createHash("sha256").update(body).digest("hex"),
    );
    assert.deepEqual(entry.server_usage, {
      prompt_tokens: 12,
      completion_tokens: 3,
    });
    assert.deepEqual(entry.server_timings, {
      predicted_n: 3,
      predicted_ms: 20,
    });
    assert.equal(entry.response_capture_complete, true);
    for (const path of ["2.request.json", "2.response.txt", "2.capture.json"])
      assert.ok(
        !(await readFile(join(directory, "transport", path), "utf8")).includes(
          "synthetic-opaque-value",
        ),
      );
    assert.ok(!JSON.stringify(observation).includes("synthetic-opaque-value"));
    responseStatus = 403;
    mockResponse =
      "Unstructured synthetic auth failure: synthetic-opaque-value";
    const failedObservation = { fetches: [] };
    transport = await startFetchObservation(config, failedObservation);
    const failedResponse = await globalThis.fetch(
      `${mockGatewayOrigin}/v1/chat/completions`,
      { method: "POST", body },
    );
    assert.equal(
      await failedResponse.text(),
      mockResponse,
      "Error stream remains unmodified for Pi",
    );
    await transport.finish();
    transport = null;
    assert.equal(failedObservation.fetches[0].status, 403);
    assert.ok(
      !(
        await readFile(join(directory, "transport", "1.response.txt"), "utf8")
      ).includes("synthetic-opaque-value"),
    );
    assert.ok(
      !JSON.stringify(failedObservation).includes("synthetic-opaque-value"),
    );
    responseStatus = 200;
    mockResponse = sse;
    for (const changed of [
      { model: "other", stream: true },
      { model: "gpt-5.6-sol", stream: false },
      { model: "gpt-5.6-sol", stream: true, tool_choice: "required" },
      {
        model: "gpt-5.6-sol",
        stream: true,
        chat_template_kwargs: { enable_thinking: true },
      },
    ]) {
      const before = calls.length;
      // Restore the bounded wrapper for each body check using a fresh observation.
      transport = await startFetchObservation(config, { fetches: [] });
      await assert.rejects(
        globalThis.fetch(`${mockGatewayOrigin}/v1/chat/completions`, {
          method: "POST",
          body: JSON.stringify(changed),
        }),
      );
      assert.equal(calls.length, before);
      await transport.finish();
      transport = null;
    }
  } finally {
    await transport?.finish();
    globalThis.fetch = original;
    await rm(directory, { recursive: true, force: true });
  }
});

test("provider projection excludes credential commands, key literals and all auth headers while retaining effective model metadata", () => {
  const model = {
    ...mockGatewayModel(),
    apiKey: "!synthetic-command-only",
    key: "synthetic-secret-only",
    headers: { authorization: "Bearer synthetic-secret-only" },
    env: { PRIVATE_KEY: "synthetic-secret-only" },
  };
  assert.deepEqual(providerModelProjection(model), mockGatewayModel());
  const safe = redactProviderEvidence({
    headers: { authorization: "opaque" },
    nested: {
      apiKey: "opaque",
      key: "opaque",
      command: "!synthetic-command-only",
      env: { PRIVATE: "opaque" },
      responseHeaders: { "set-cookie": "opaque" },
      error: { message: "opaque" },
      note: "Bearer synthetic-secret-only",
      output: 3,
      cacheRead: 2,
    },
  });
  assert.deepEqual(safe, {
    nested: { note: "Bearer [REDACTED]", output: 3, cacheRead: 2 },
  });
  const binding = configuredProviderBinding(model, mockGatewayOrigin);
  assert.ok(!JSON.stringify(binding).includes("synthetic-secret-only"));
  for (const field of [
    "api",
    "compat",
    "contextWindow",
    "maxTokens",
    "cost",
    "thinkingLevelMap",
  ]) {
    const changed = mockGatewayModel();
    if (field === "api") {
      changed.api = "openai-responses";
      assert.throws(() =>
        configuredProviderBinding(changed, mockGatewayOrigin),
      );
      continue;
    }
    if (field === "compat") changed.compat.supportsReasoningEffort = false;
    if (field === "contextWindow") changed.contextWindow -= 1;
    if (field === "maxTokens") changed.maxTokens -= 1;
    if (field === "cost") changed.cost.output += 1;
    if (field === "thinkingLevelMap")
      changed.thinkingLevelMap = { medium: "low" };
    assert.notEqual(
      configuredProviderBinding(changed, mockGatewayOrigin).registration_sha256,
      binding.registration_sha256,
      field,
    );
  }
  const incompatible = mockGatewayModel();
  incompatible.compat = localGoogleGemma4Model(
    "http://127.0.0.1:8081/v1",
  ).compat;
  assert.throws(() =>
    configuredProviderBinding(incompatible, mockGatewayOrigin),
  );
});

test("upstream execution proof cannot be inferred from alias/owner and must bind exact origin, registration and reviewed lineage", () => {
  const binding = configuredProviderBinding(
    mockGatewayModel(),
    mockGatewayOrigin,
  );
  assert.equal(binding.upstream_verification, "pending");
  assert.equal(binding.upstream_proof_sha256, null);
  assert.throws(() =>
    validateUpstreamProof({ id: "gpt-5.6-sol", owned_by: "openai" }, binding),
  );
  const proof = mockReviewedAttribution(binding);
  assert.deepEqual(validateUpstreamProof(proof, binding), proof);
  for (const mutate of [
    (p) => {
      p.origin = "https://other.example";
    },
    (p) => {
      p.registration_sha256 = "d".repeat(64);
    },
    (p) => {
      p.upstream_model = "unknown";
    },
    (p) => {
      p.non_chinese_lineage = false;
    },
    (p) => {
      p.model_lineage_reviewed = false;
    },
    (p) => {
      p.reviewed_by = "not-ROOT";
    },
    (p) => {
      p.root_clearance = "pending";
    },
    (p) => {
      p.evidence = [];
    },
    (p) => {
      p.evidence[0].statement = "";
    },
    (p) => {
      p.apiKey = "synthetic-secret-only";
    },
    (p) => {
      p.maker = "Other synthetic maker";
    },
  ]) {
    const altered = structuredClone(proof);
    mutate(altered);
    assert.throws(() => validateUpstreamProof(altered, binding));
  }
  const reviewedOther = {
    ...proof,
    maker: "Other synthetic maker",
    maker_reviewed_non_chinese: true,
  };
  assert.deepEqual(
    validateUpstreamProof(reviewedOther, binding),
    reviewedOther,
  );
});

test("offline configured runtime uses actual Pi ModelRuntime/ModelRegistry registration without auth or catalog-network calls", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "jev-provider-registration-mock-"),
  );
  const modelsPath = join(directory, "models.json");
  const originalFetch = globalThis.fetch;
  try {
    const model = mockGatewayModel();
    const { provider: _provider, baseUrl: _baseUrl, ...definition } = model;
    await writeFile(
      modelsPath,
      JSON.stringify({
        providers: {
          llmgw: {
            api: model.api,
            baseUrl: model.baseUrl,
            // Metadata-only registration: this deliberately failing synthetic command
            // must never be resolved by preparation.
            apiKey: "!never-execute-synthetic-command",
            models: [definition],
          },
        },
      }),
    );
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches++;
      throw new Error("Network is forbidden in this CPU proof");
    };
    const configured = await loadConfiguredProvider({
      provider_models_path: modelsPath,
      provider_origin: mockGatewayOrigin,
    });
    assert.equal(configured.runtime.constructor.name, "ModelRuntime");
    assert.equal(configured.registry.constructor.name, "ModelRegistry");
    assert.deepEqual(
      configured.registry.find("llmgw", "gpt-5.6-sol"),
      configured.model,
    );
    assert.deepEqual(providerModelProjection(configured.model), model);
    assert.equal(configured.auth_status.configured, true);
    assert.equal(configured.auth_status.source, "models_json_command");
    assert.equal(configured.binding.upstream_verification, "pending");
    assert.equal(fetches, 0);
    assert.ok(
      !JSON.stringify(configured.binding).includes(
        "never-execute-synthetic-command",
      ),
    );
    assert.equal(configured.catalog.length, 1);
    assert.deepEqual(
      JSON.parse(await readFile(modelsPath, "utf8")).providers.llmgw.apiKey,
      "!never-execute-synthetic-command",
      "Registration/auth source remains unchanged",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("preparation creates an in-memory offline catalog and rejects every credential read or mutation", async () => {
  let options,
    readonlyAuthConstructed = false,
    metadataReads = 0;
  const model = mockGatewayModel();
  const runtime = {
    getError: () => undefined,
    getModel: () => model,
    getModels: () => [model],
    getProviderAuthStatus: () => {
      metadataReads++;
      return {
        configured: true,
        source: "models_json_command",
        label: "!synthetic-private-command",
      };
    },
  };
  class MockModelsStore {}
  class MockRegistry {
    constructor(value) {
      assert.equal(value, runtime);
    }
    find(provider, id) {
      assert.equal(provider, "llmgw");
      assert.equal(id, "gpt-5.6-sol");
      return model;
    }
  }
  const result = await loadConfiguredProvider(
    {
      provider_models_path: "/synthetic/models.json",
      provider_origin: mockGatewayOrigin,
      provider_auth_path: "/synthetic/never-read-auth.json",
    },
    false,
    {
      ModelRuntime: {
        create: async (value) => {
          options = value;
          return runtime;
        },
      },
      ModelRegistry: MockRegistry,
      InMemoryCodingAgentModelsStore: MockModelsStore,
      ReadOnlyAuthStorage: class {
        constructor() {
          readonlyAuthConstructed = true;
        }
      },
    },
  );
  assert.equal(options.allowModelNetwork, false);
  assert.equal(options.refreshOnCreate, false);
  assert.ok(options.modelsStore instanceof MockModelsStore);
  assert.equal(
    readonlyAuthConstructed,
    false,
    "Preparation never constructs a credential-reading auth store",
  );
  assert.equal(metadataReads, 1);
  for (const method of ["read", "list", "modify", "delete"])
    await assert.rejects(options.credentials[method]("llmgw"));
  assert.ok(
    !JSON.stringify(result.binding).includes("synthetic-private-command"),
  );
  assert.ok(
    !JSON.stringify(result.auth_status).includes("synthetic-private-command"),
  );
  let runtimeCreated = false;
  await assert.rejects(
    loadConfiguredProvider(
      {
        provider_models_path: "/synthetic/models.json",
        provider_origin: "https://other.example",
      },
      false,
      {
        ModelRuntime: {
          create: async () => {
            runtimeCreated = true;
            return runtime;
          },
        },
      },
    ),
  );
  assert.equal(
    runtimeCreated,
    false,
    "Unauthorized origins fail before runtime/auth creation",
  );
});

test("configured CPU mock confirmation retains 13 batches, 3 reps, 234 judgments, 39 groups, receipts and all existing gain gates", async () => {
  const batches = expectedBatches();
  const runs = mockConfiguredRuns(batches);
  const suite = await reviewSuiteSummary(runs, batches, 3);
  const paired = comparisonReport(runs, "ordinary");
  assert.equal(suite.full_confirmation_complete, true);
  assert.equal(suite.independent_context_groups, 39);
  assert.equal(paired.pairs.length, 39);
  for (const arm of ["baseline", "candidate"]) {
    assert.equal(suite.arms[arm].quality.attempts, 234);
    assert.equal(suite.arms[arm].coverage.expected_runs, 39);
    assert.equal(suite.arms[arm].coverage.groups.length, 39);
  }
  assert.ok(
    paired.pairs.every(
      (pair) =>
        pair.protocol_passed &&
        pair.same_provider_source_binding &&
        pair.same_owned_server_binding === null &&
        pair.same_settings &&
        pair.same_generation_config &&
        pair.same_thinking_level &&
        pair.same_executed_source &&
        pair.same_sf_factory_sources &&
        pair.same_existing_sf_and_builtin_tools,
    ),
  );
  const gates = reviewImprovementGates(suite, paired);
  assert.equal(gates.passed, true);
  assert.equal(gates.provider_usage_complete, true);
  assert.equal(gates.jev_usage_complete, true);
  assert.deepEqual(runs[0].resource_scope, {
    server_rss_bytes: null,
    server_gpu_bytes: null,
    server_energy_joules: null,
    remote_server_observation:
      "unknown; cloud server resources are not measured",
    client_scope:
      "Evaluator Node RSS/CPU and workspace disk only; SDK usage/cache, Jev native receipts and wall time are separate observations",
  });
  for (const mutate of [
    (r) => {
      r.source_binding.registration_sha256 = "d".repeat(64);
    },
    (r) => {
      r.source_binding.upstream_proof_sha256 = null;
    },
    (r) => {
      r.source_binding.upstream_attribution.non_chinese_lineage = false;
    },
    (r) => {
      r.generation_config.model.maxTokens -= 1;
    },
    (r) => {
      r.settings.retry.provider.maxRetries = 1;
    },
    (r) => {
      r.thinking_level = "high";
    },
    (r) => {
      r.sf_factory_sources[0].sha256 = "changed";
    },
    (r) => {
      r.provider_usage.complete = false;
    },
  ]) {
    const altered = mockConfiguredRuns(batches);
    mutate(altered.find((run) => run.arm === "candidate"));
    const alteredSuite = await reviewSuiteSummary(altered, batches, 3);
    assert.equal(
      reviewImprovementGates(
        alteredSuite,
        comparisonReport(altered, "ordinary"),
      ).passed,
      false,
    );
  }
  const omitted = runs.filter(
    (run) =>
      !(
        run.arm === "candidate" &&
        run.task === batches[0].id &&
        run.repetition === 1
      ),
  );
  const incomplete = await reviewSuiteSummary(omitted, batches, 3);
  assert.equal(incomplete.arms.candidate.quality.attempts, 234);
  assert.equal(incomplete.arms.candidate.quality.execution_failures, 6);
  assert.equal(
    reviewImprovementGates(incomplete, comparisonReport(omitted, "ordinary"))
      .passed,
    false,
  );
});

test("old local model/settings and required repair contracts stay intact beside the explicit configured switch", async () => {
  const local = localGoogleGemma4Model("http://127.0.0.1:8081/v1");
  assert.equal(local.id, "google/gemma-4-31B-it-qat-q4_0");
  assert.equal(local.contextWindow, 32768);
  assert.equal(local.maxTokens, 4096);
  assert.equal(local.compat.thinkingFormat, "chat-template");
  assert.deepEqual(local.compat.chatTemplateKwargs, {
    enable_thinking: { $var: "thinking.enabled" },
  });
  const runs = completeRuns(expectedBatches());
  assert.equal(providerSourceBinding(runs[0]).kind, "localGoogleGemma4");
  assert.ok(
    comparisonReport(runs, "ordinary").pairs.every(
      (pair) => pair.same_owned_server_binding && pair.protocol_passed,
    ),
  );
  assert.ok(
    runs.every(
      (run) =>
        run.settings.compaction.enabled === false &&
        run.settings.retry.enabled === false &&
        run.settings.retry.provider.maxRetries === 0 &&
        run.thinking_level === "medium",
    ),
  );
  for (const contract of [
    "nullable-contact",
    "abortable-refresh",
    "exclusive-window",
    "latest-request",
  ]) {
    const manifest = JSON.parse(
      await readFile(
        new URL(
          `../fixtures/developer-tasks/${contract}/manifest.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
    assert.equal(manifest.id, contract);
    assert.ok(
      manifest.commands.acceptance.some((item) => item.id === "compile"),
    );
    const acceptance = manifest.commands.acceptance.find(
      (item) => item.id === "test",
    );
    assert.ok(acceptance, contract);
    assert.ok(
      !manifest.allowed_edit_files.includes(acceptance.argv.at(-1)),
      "Independent repair acceptance stays outside agent edit permission",
    );
  }
});
