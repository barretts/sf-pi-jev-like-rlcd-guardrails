import assert from "node:assert/strict";
import test from "node:test";
import { validateQualityRecords } from "../dist/evaluation.js";
import {
  accountProviderUsage,
  scoreReviewFinal,
  summarizeReviewAttempts,
} from "../scripts/developer-review-scoring.mjs";

const questions = {
  choice: {
    id: "route",
    type: "choice",
    instructions: "Choose the evidenced failure.",
    criteria: [
      { id: "abort", description: "Abort listener leak" },
      { id: "stale", description: "Stale request overwrite" },
    ],
  },
  score: {
    id: "coverage",
    type: "score",
    instructions: "Apply the declared fractional coverage rubric.",
    criteria: ["No checks", "Partial checks", "Complete checks"],
  },
  unknown: {
    id: "established",
    type: "noul",
    instructions: "The omitted trace proves cleanup.",
  },
  clear: {
    id: "visible",
    type: "noul",
    instructions: "The visible code removes the listener.",
  },
};
const records = validateQualityRecords([
  {
    id: "opaque-a",
    group_id: "group-a",
    split: "validation",
    regression: true,
    request: {
      model: "google/gemma-3-1b-it",
      state: "An old response overwrites a newer state.",
      questions: [questions.choice],
    },
    targets: { route: { answer: "stale" } },
  },
  {
    id: "opaque-b",
    group_id: "group-b",
    split: "validation",
    request: {
      model: "google/gemma-3-1b-it",
      state: "Trusted rubric result: 1.25 of 2.",
      questions: [questions.score],
    },
    targets: { coverage: { answer: 1.25 } },
  },
  {
    id: "opaque-c",
    group_id: "group-c",
    split: "validation",
    request: {
      model: "google/gemma-3-1b-it",
      state: "Visible listener removal; cleanup execution trace is absent.",
      questions: [questions.unknown, questions.clear],
    },
    targets: { established: { answer: null }, visible: { answer: true } },
  },
]);
const final = () => ({
  "opaque-a": { route: { answer: "stale" } },
  "opaque-b": { coverage: { answer: 1.25 } },
  "opaque-c": { established: { answer: null }, visible: { answer: true } },
});
const score = (value, selected = records) =>
  scoreReviewFinal({ text: JSON.stringify(value), records: selected });
const noulProbabilities = (center = "5") =>
  Object.fromEntries(
    Array.from({ length: 9 }, (_, index) => [
      String(index + 1),
      Number(String(index + 1) === center),
    ]),
  );

test("complete actual final JSON preserves fractional scores, unknowns, and generated answer kinds", () => {
  const before = structuredClone(records);
  const result = score(final());
  assert.equal(result.passed, true);
  assert.deepEqual(result.validation_errors, []);
  assert.equal(result.summary.attempts, 3);
  assert.equal(result.summary.gates.passed, true);
  assert.equal(result.summary.choice.count, 1);
  assert.equal(result.summary.score.count, 1);
  assert.equal(result.summary.score.normalized_mae, 0);
  assert.equal(result.summary.noul.uncertain_count, 1);
  assert.equal(result.summary.noul.clear_count, 1);
  assert.equal(result.summary.accepted_correct_judgments, 3);
  assert.equal(result.summary.completed_clear_decisions, 2);
  assert.equal(result.summary.abstaining_attempts, 1);
  assert.match(
    result.summary.timing_scope,
    /actual end-to-end time belongs to harness/,
  );
  assert.equal(result.summary.elapsed_all_attempts_ms, null);
  assert.equal(
    result.summary.elapsed_all_attempts_per_accepted_judgment_ms,
    null,
  );
  assert.equal(result.summary.latency_all_attempts_ms, null);
  assert.equal(result.attempts[0].elapsed_ms, null);
  assert.equal(
    result.attempts[0].answers[0].prediction_kind,
    "actual_generated_choice_answer_no_confidence",
  );
  assert.equal(result.attempts[1].answers[0].predicted, 1.25);
  assert.equal(
    result.attempts[2].answers[0].prediction_kind,
    "actual_generated_unknown_answer",
  );
  assert.equal(
    result.attempts[2].answers[1].prediction_kind,
    "actual_generated_boolean_endpoint_for_error_scoring",
  );
  assert.deepEqual(records, before);
});

test("a correct one-type batch is accepted without pretending absent full-suite gates passed", () => {
  const result = score({ "opaque-b": final()["opaque-b"] }, [records[1]]);
  assert.equal(result.passed, true);
  assert.equal(result.summary.gates.passed, false);
  assert.equal(result.summary.gates.choice_accuracy, false);
});

test("numeric Noul and exact native probability maps retain actual generated semantics", () => {
  const response = final();
  response["opaque-a"].route = { probabilities: { abort: 0.1, stale: 0.9 } };
  response["opaque-b"].coverage = { probabilities: { 0: 0, 1: 0.75, 2: 0.25 } };
  response["opaque-c"].established = { answer: 0.55 };
  response["opaque-c"].visible = { probabilities: noulProbabilities("9") };
  const result = score(response);
  assert.equal(result.passed, true);
  assert.equal(
    result.attempts[0].answers[0].prediction_kind,
    "actual_generated_probability_map",
  );
  assert.equal(
    result.attempts[2].answers[0].prediction_kind,
    "actual_generated_numeric_probability_estimate",
  );
  assert.equal(result.attempts[2].answers[0].abstention, true);
  assert.equal(result.attempts[2].answers[1].predicted, 0.99);
  const unknownMap = final();
  unknownMap["opaque-c"].established = { probabilities: noulProbabilities() };
  assert.equal(score(unknownMap).passed, true);
});

test("wrong but well-formed judgments fail without becoming validation errors", () => {
  const response = final();
  response["opaque-a"].route.answer = "abort";
  response["opaque-c"].established.answer = true;
  const result = score(response);
  assert.equal(result.passed, false);
  assert.deepEqual(result.validation_errors, []);
  assert.equal(result.summary.execution_failures, 0);
  assert.equal(result.summary.regressions.passed, 0);
  assert.equal(result.summary.noul.uncertainty_mae, 0.5);
});

test("malformed JSON, fences, prose, non-object roots, and duplicate keys fail all expected records", () => {
  for (const text of [
    "{",
    "```json\n{}\n```",
    "The answer is {}",
    "null",
    "[]",
    '{"opaque-a":{},"opaque-a":{}}',
    '{"opaque-a":{"route":{"answer":"stale","answer":"abort"}}}',
  ]) {
    const result = scoreReviewFinal({ text, records });
    assert.equal(result.passed, false, text);
    assert.equal(result.summary.attempts, 3);
    assert.equal(result.summary.execution_failures, 3);
    assert.equal(result.summary.choice.count, 1);
    assert.equal(result.summary.score.count, 1);
    assert.equal(result.summary.noul.uncertain_count, 1);
    assert.equal(result.summary.noul.clear_count, 1);
    assert.equal(
      result.attempts.flatMap((attempt) => attempt.answers).length,
      4,
    );
    assert.equal(result.summary.score.normalized_mae, null);
    assert.equal(result.summary.noul.brier, null);
    assert.equal(result.summary.noul.uncertainty_mae, null);
    assert.ok(result.validation_errors.length);
  }
});

test("partial record and question omissions remain counted failures alongside valid answers", () => {
  const response = final();
  delete response["opaque-b"];
  delete response["opaque-c"].visible;
  const result = score(response);
  assert.equal(result.passed, false);
  assert.equal(result.summary.attempts, 3);
  assert.equal(result.summary.execution_failures, 2);
  assert.equal(result.summary.accepted_correct_judgments, 1);
  assert.equal(result.summary.score.count, 1);
  assert.equal(result.summary.noul.clear_count, 1);
  assert.equal(result.attempts[2].answers.length, 2);
  assert.equal(result.attempts[2].answers[0].correct_judgment, true);
  assert.equal(
    result.attempts[2].answers[1].prediction_kind,
    "invalid_or_missing_generated_answer",
  );
  assert.equal(
    Object.hasOwn(result.attempts[2].answers[1], "predicted"),
    false,
  );
  assert.equal(result.summary.gates.no_failures, false);
});

test("full-suite aggregation keeps invalid measurements unavailable and workflow time separate", () => {
  const first = score({ "opaque-a": final()["opaque-a"] }, [records[0]]);
  const second = score({ "opaque-b": {} }, [records[1]]);
  const third = score({ "opaque-c": final()["opaque-c"] }, [records[2]]);
  const summary = summarizeReviewAttempts([
    ...first.attempts,
    ...second.attempts,
    ...third.attempts,
  ]);
  assert.equal(summary.attempts, 3);
  assert.equal(summary.execution_failures, 1);
  assert.equal(summary.choice.count, 1);
  assert.equal(summary.score.count, 1);
  assert.equal(summary.noul.uncertain_count, 1);
  assert.equal(summary.score.normalized_mae, null);
  assert.equal(summary.gates.passed, false);
  assert.equal(summary.elapsed_all_attempts_per_accepted_judgment_ms, null);
});

test("record/question sets and target objects are exact", () => {
  for (const mutate of [
    (value) => {
      value.extra = {};
    },
    (value) => {
      value["opaque-a"].extra = { answer: "stale" };
    },
    (value) => {
      value["opaque-a"].route.confidence = 1;
    },
    (value) => {
      value["opaque-a"].route.probabilities = { abort: 0, stale: 1 };
    },
    (value) => {
      value["opaque-b"].coverage = 1.25;
    },
    (value) => {
      value["opaque-c"] = [];
    },
  ]) {
    const response = final();
    mutate(response);
    const result = score(response);
    assert.equal(result.passed, false);
    assert.ok(result.validation_errors.length);
  }
});

test("numeric answers and probability maps reject range, finite, label, and sum violations", () => {
  for (const [record, question, target] of [
    ["opaque-a", "route", { answer: "fabricated" }],
    ["opaque-b", "coverage", { answer: -0.01 }],
    ["opaque-b", "coverage", { answer: 2.01 }],
    ["opaque-c", "established", { answer: 1.01 }],
    ["opaque-c", "established", { answer: -0.01 }],
    ["opaque-c", "established", { answer: "unknown" }],
    ["opaque-a", "route", { probabilities: { stale: 1 } }],
    [
      "opaque-a",
      "route",
      { probabilities: { abort: 0, stale: 1, fabricated: 0 } },
    ],
    ["opaque-a", "route", { probabilities: { abort: 0.4, stale: 0.4 } }],
    ["opaque-a", "route", { probabilities: { abort: -0.1, stale: 1.1 } }],
    [
      "opaque-b",
      "coverage",
      { probabilities: { 0: 0, 1: 0.75, 2: 0.25, 3: 0 } },
    ],
    ["opaque-c", "established", { probabilities: { false: 0.5, true: 0.5 } }],
  ]) {
    const response = final();
    response[record][question] = target;
    const result = score(response);
    assert.equal(result.passed, false, JSON.stringify(target));
    assert.ok(
      result.validation_errors.some(
        (problem) =>
          problem.record_id === record && problem.question_id === question,
      ),
    );
  }
  const text = JSON.stringify(final()).replace(
    '"answer":1.25',
    '"answer":1e999',
  );
  assert.equal(scoreReviewFinal({ text, records }).passed, false);
});

const usage = (output = 0) => ({
  input: 100,
  output,
  cacheRead: 2,
  cacheWrite: 0,
  totalTokens: 102 + output,
});
const assistant = (output = 7, stopReason = "stop", text = "Complete") => ({
  role: "assistant",
  timestamp: 1,
  stopReason,
  usage: usage(output),
  content: [{ type: "text", text }],
});
const delta = (type, text) => ({
  type: "message_update",
  assistant_event_type: type,
  delta: text,
});

test("normally finished provider usage is summed as actual reported generated tokens", () => {
  const message = assistant();
  const result = accountProviderUsage(
    [message],
    [
      { type: "message_start", message: { ...message, stopReason: "pending" } },
      delta("text_delta", "Complete"),
      { type: "message_end", message },
    ],
  );
  assert.equal(result.complete, true);
  assert.equal(result.generated_tokens, 7);
  assert.deepEqual(result.totals, usage(7));
  assert.equal(result.messages.length, 1);
  assert.equal(result.streamed_delta_events, 1);
  assert.equal(result.emitted_text_chars, 8);
});

test("actual SDK abort shape with missing final message and zero usage cannot imply zero generation", () => {
  const aborted = {
    role: "assistant",
    stopReason: "aborted",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    content: [],
  };
  const events = [
    { type: "message_start", message: { ...aborted, stopReason: "pending" } },
    ...Array.from({ length: 1201 }, () => delta("thinking_delta", "work")),
    delta("text_delta", "partial"),
    { type: "message_end", message: aborted },
  ];
  const result = accountProviderUsage([], events);
  assert.equal(result.complete, false);
  assert.equal(result.generated_tokens, null);
  assert.equal(result.totals, null);
  assert.equal(result.generated_tokens_lower_bound, 0);
  assert.equal(result.streamed_delta_events, 1202);
  assert.equal(result.emitted_thinking_chars, 4804);
  assert.equal(result.emitted_text_chars, 7);
  assert.equal(result.messages[0].source, "message_end_event");
  assert.deepEqual(result.messages[0].usage, aborted.usage);
});

test("completed tool turns retain a lower bound when a later stream aborts", () => {
  const completed = assistant(20, "toolUse", "Inspecting source");
  const aborted = { ...assistant(0, "aborted", ""), timestamp: 2 };
  const result = accountProviderUsage(
    [completed, aborted],
    [delta("thinking_delta", "continuing")],
  );
  assert.equal(result.complete, false);
  assert.equal(result.generated_tokens, null);
  assert.equal(result.totals, null);
  assert.equal(result.generated_tokens_lower_bound, 20);
  assert.deepEqual(result.reported_usage_lower_bound, usage(20));
  assert.equal(result.messages[0].complete, true);
  assert.equal(result.messages[1].complete, false);
});

test("missing counters, incomplete stops, unfinished streams, and suspicious output zero stay unknown", () => {
  for (const message of [
    assistant(0),
    assistant(7, "error"),
    assistant(7, "length"),
    assistant(7, "pending"),
    { ...assistant(), usage: undefined },
    { ...assistant(), usage: { ...usage(7), input: NaN } },
    { ...assistant(), usage: { output: 7 } },
  ]) {
    const result = accountProviderUsage([message]);
    assert.equal(result.complete, false);
    assert.equal(result.generated_tokens, null);
    assert.equal(result.totals, null);
    assert.equal(result.generated_tokens_lower_bound, 0);
  }
  const unfinished = accountProviderUsage(
    [assistant()],
    [
      { type: "message_start", message: { role: "assistant" } },
      { type: "thinking_delta", delta: "ongoing" },
    ],
  );
  assert.equal(unfinished.complete, false);
  assert.equal(unfinished.generated_tokens_lower_bound, 7);
  assert.equal(unfinished.emitted_thinking_chars, 7);
  assert.equal(accountProviderUsage([]).complete, false);
});

test("event-only normal end usage and raw nested deltas are retained without token inference", () => {
  const message = assistant(7);
  const result = accountProviderUsage(
    [],
    [
      { type: "message_start", message: { role: "assistant" } },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Complete" },
      },
      { type: "message_end", message },
    ],
  );
  assert.equal(result.complete, true);
  assert.equal(result.generated_tokens, 7);
  assert.equal(result.messages[0].source, "message_end_event");
  assert.equal(result.emitted_text_chars, 8);
});
