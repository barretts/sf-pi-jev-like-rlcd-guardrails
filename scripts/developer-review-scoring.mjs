import assert from "node:assert/strict";
import { canonical } from "../dist/core.js";
import { normalizeRfdtTarget } from "../dist/rfdt.js";
import { scoreAnswer, summarize } from "./developer-decision-eval.mjs";

const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const messageError = (error) =>
  error instanceof Error ? error.message : String(error);

function parseFinal(text) {
  assert.equal(typeof text, "string", "Final answer must be JSON text");
  const result = JSON.parse(text);
  assert.ok(object(result), "Final answer must be a JSON object");
  // JSON.parse alone silently overwrites duplicate keys. Reject that ambiguity.
  const scopes = [];
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === "{") scopes.push(new Set());
    else if (character === "[") scopes.push(null);
    else if (character === "}" || character === "]") scopes.pop();
    else if (character === '"') {
      const start = index++;
      while (text[index] !== '"') {
        if (text[index] === "\\") index++;
        index++;
      }
      let next = index + 1;
      while (/\s/.test(text[next] ?? "") && next < text.length) next++;
      if (text[next] === ":") {
        const key = JSON.parse(text.slice(start, index + 1));
        const keys = scopes.at(-1);
        assert.ok(!keys.has(key), `Duplicate JSON key ${key}`);
        keys.add(key);
      }
    }
  }
  return result;
}

function uncertain(question, gold) {
  return (
    question.type === "noul" &&
    (!Object.hasOwn(gold, "answer") || gold.answer === null)
  );
}

/** Score only the assistant's bare final JSON, never a tool's intermediate answer. */
export function scoreReviewFinal({ text, records }) {
  assert.ok(
    Array.isArray(records) && records.length,
    "Expected review records",
  );
  const ids = new Set(records.map((record) => record.id));
  assert.equal(ids.size, records.length, "Review record IDs must be unique");
  const validation_errors = [];
  const error = (message, record_id = null, question_id = null) => {
    validation_errors.push({ record_id, question_id, message });
    return message;
  };
  let final, globalError;
  try {
    final = parseFinal(text);
    const extra = Object.keys(final).filter((id) => !ids.has(id));
    if (extra.length)
      globalError = error(`Unexpected record IDs: ${extra.join(", ")}`);
  } catch (caught) {
    globalError = error(messageError(caught));
  }
  const attempts = records.map((record) => {
    const recordErrors = globalError ? [globalError] : [];
    const returned =
      final && Object.hasOwn(final, record.id) ? final[record.id] : undefined;
    if (!object(returned))
      recordErrors.push(
        error("Missing or invalid record answer object", record.id),
      );
    else {
      const questions = new Set(
        record.request.questions.map((question) => question.id),
      );
      const extra = Object.keys(returned).filter((id) => !questions.has(id));
      if (extra.length)
        recordErrors.push(
          error(`Unexpected question IDs: ${extra.join(", ")}`, record.id),
        );
    }
    const answers = record.request.questions.map((question) => {
      try {
        assert.ok(
          object(returned) && Object.hasOwn(returned, question.id),
          "Missing question answer",
        );
        const target = returned[question.id];
        normalizeRfdtTarget(question, target);
        return scoreAnswer(
          question,
          record.targets[question.id],
          target,
          "generated",
        );
      } catch (caught) {
        const problem = error(messageError(caught), record.id, question.id);
        recordErrors.push(`${question.id}: ${problem}`);
        return {
          question_id: question.id,
          type: question.type,
          ...(question.type === "noul"
            ? { uncertain: uncertain(question, record.targets[question.id]) }
            : {}),
          prediction_kind: "invalid_or_missing_generated_answer",
          error: problem,
          correct_judgment: false,
          completed_clear_decision: false,
          abstention: false,
        };
      }
    });
    return {
      method: "generated",
      record_id: record.id,
      group_id: record.group_id,
      regression: record.regression === true,
      answers,
      ...(recordErrors.length
        ? { error: [...new Set(recordErrors)].join("; ") }
        : {}),
      correct_judgment:
        recordErrors.length === 0 &&
        answers.every((answer) => answer.correct_judgment),
      completed_clear_decision:
        recordErrors.length === 0 &&
        answers.every((answer) => answer.completed_clear_decision),
      abstention: answers.some((answer) => answer.abstention),
      elapsed_ms: null,
    };
  });
  return {
    passed:
      validation_errors.length === 0 &&
      attempts.every((attempt) => attempt.correct_judgment),
    summary: summarizeReviewAttempts(attempts),
    attempts,
    validation_errors,
  };
}

/** Apply the existing suite gates while retaining malformed questions in counts. */
export function summarizeReviewAttempts(attempts) {
  const summary = summarize(
    attempts.map((attempt) => ({ ...attempt, elapsed_ms: 0 })),
  );
  summary.timing_scope =
    "host-side judgment scoring only; actual end-to-end time belongs to harness workflow timings";
  for (const field of [
    "elapsed_all_attempts_ms",
    "elapsed_all_attempts_per_accepted_judgment_ms",
    "elapsed_all_attempts_per_completed_clear_decision_ms",
    "latency_all_attempts_ms",
    "latency_first_method_call_ms",
    "latency_later_method_calls_ms",
  ])
    summary[field] = null;
  // Invalid answers remain in category counts without invented numeric errors.
  // A mean requiring one of those missing measurements is explicitly unavailable.
  const invalid = attempts
    .flatMap((attempt) => attempt.answers)
    .filter((answer) => answer.error);
  if (invalid.some((answer) => answer.type === "score")) {
    summary.score.normalized_mae = null;
    summary.gates.normalized_score_mae = false;
  }
  if (invalid.some((answer) => answer.type === "noul" && !answer.uncertain)) {
    summary.noul.brier = null;
    summary.gates.noul_brier = false;
  }
  if (invalid.some((answer) => answer.type === "noul" && answer.uncertain)) {
    summary.noul.uncertainty_mae = null;
    summary.gates.uncertainty_mae = false;
  }
  summary.gates.passed = Object.entries(summary.gates)
    .filter(([key]) => key !== "passed")
    .every(([, value]) => value);
  return summary;
}

const usageKeys = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
const emptyUsage = () => Object.fromEntries(usageKeys.map((key) => [key, 0]));
const messageKey = (message) =>
  canonical(
    JSON.parse(
      JSON.stringify(
        {
          timestamp: message.timestamp ?? null,
          stopReason: message.stopReason ?? null,
          usage: message.usage ?? null,
          content: message.content ?? null,
          model: message.model ?? null,
          provider: message.provider ?? null,
        },
        (_, value) =>
          typeof value === "number" && !Number.isFinite(value)
            ? String(value)
            : value,
      ),
    ),
  );

/** Preserve unknown usage after interrupted streams; delta characters are not tokens. */
export function accountProviderUsage(messages, events = []) {
  assert.ok(
    Array.isArray(messages) && Array.isArray(events),
    "Expected message and event arrays",
  );
  const assistants = messages
    .filter((message) => message.role === "assistant")
    .map((message) => ({ message, source: "messages" }));
  const available = new Map();
  for (const { message } of assistants) {
    const key = messageKey(message);
    available.set(key, (available.get(key) ?? 0) + 1);
  }
  const streamGeneration = new Map();
  const incomplete_reasons = [];
  let streamed_delta_events = 0,
    emitted_text_chars = 0,
    emitted_thinking_chars = 0,
    openAssistant;
  for (const event of events) {
    const delta = event.assistantMessageEvent ?? event;
    const type = event.assistant_event_type ?? delta.type;
    if (type?.endsWith("_delta")) {
      streamed_delta_events++;
      if (type === "text_delta")
        emitted_text_chars +=
          typeof delta.delta === "string" ? delta.delta.length : 0;
      if (type === "thinking_delta")
        emitted_thinking_chars +=
          typeof delta.delta === "string" ? delta.delta.length : 0;
      if (openAssistant) openAssistant.generated = true;
    }
    if (event.type === "message_start" && event.message?.role === "assistant") {
      if (openAssistant)
        incomplete_reasons.push(
          "Assistant stream started before the previous stream ended",
        );
      openAssistant = { generated: false };
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const key = messageKey(event.message);
      if (openAssistant?.generated) streamGeneration.set(key, true);
      openAssistant = undefined;
      const count = available.get(key) ?? 0;
      if (count) available.set(key, count - 1);
      else
        assistants.push({
          message: event.message,
          source: "message_end_event",
        });
    }
  }
  if (openAssistant)
    incomplete_reasons.push("Assistant stream has no end event");
  if (!assistants.length) incomplete_reasons.push("No assistant usage record");
  const reported_usage_lower_bound = emptyUsage();
  const details = assistants.map(({ message, source }, index) => {
    const reasons = [];
    if (!["stop", "toolUse"].includes(message.stopReason))
      reasons.push(
        `Incomplete stop reason: ${message.stopReason ?? "missing"}`,
      );
    if (
      !object(message.usage) ||
      usageKeys.some(
        (key) => !Number.isFinite(message.usage[key]) || message.usage[key] < 0,
      )
    )
      reasons.push("Missing or invalid SDK usage counters");
    const visibleGeneration =
      message.content?.some(
        (part) =>
          (part.type === "text" && part.text?.length > 0) ||
          (part.type === "thinking" && part.thinking?.length > 0) ||
          part.type === "toolCall",
      ) || streamGeneration.get(messageKey(message));
    if (message.usage?.output === 0 && visibleGeneration)
      reasons.push("Zero reported output despite visible generation");
    if (!reasons.length)
      for (const key of usageKeys)
        reported_usage_lower_bound[key] += message.usage[key];
    for (const reason of reasons)
      incomplete_reasons.push(`Assistant ${index + 1}: ${reason}`);
    return {
      source,
      stop_reason: message.stopReason ?? null,
      usage: message.usage ?? null,
      complete: reasons.length === 0,
      incomplete_reasons: reasons,
    };
  });
  if (
    streamed_delta_events &&
    assistants.every(({ message }) => message.usage?.output === 0)
  )
    incomplete_reasons.push(
      "Streamed generation is present without trustworthy positive output usage",
    );
  const complete = incomplete_reasons.length === 0;
  return {
    complete,
    totals: complete ? { ...reported_usage_lower_bound } : null,
    generated_tokens: complete ? reported_usage_lower_bound.output : null,
    generated_tokens_lower_bound: reported_usage_lower_bound.output,
    reported_usage_lower_bound,
    messages: details,
    streamed_delta_events,
    emitted_text_chars,
    emitted_thinking_chars,
    incomplete_reasons,
    accounting:
      "SDK usage from normally completed messages; incomplete streams make total tokens unknown. Delta events and emitted characters are observations, not token counts.",
  };
}
