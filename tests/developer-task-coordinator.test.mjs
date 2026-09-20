import assert from "node:assert/strict";
import test from "node:test";
import { validateQualityRecords } from "../dist/evaluation.js";
import { scoreReviewFinal } from "../scripts/developer-review-scoring.mjs";
import {
  comparisonReport,
  observeJevWork,
  reviewImprovementGates,
  reviewSuiteSummary,
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
