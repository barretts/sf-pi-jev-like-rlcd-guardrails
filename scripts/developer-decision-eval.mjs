import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, parseArgs } from "node:util";
import { Classifier, NativeBackend, configFromEnv } from "../dist/backend.js";
import { canonical, validateRequest } from "../dist/core.js";
import {
  evaluateRecords,
  loadQualityRecords,
  QUALITY_GATES,
} from "../dist/evaluation.js";
import { AGENT_MODEL_ID, modelDescriptor } from "../dist/models.js";
import { labelRfdt, normalizeRfdtTarget } from "../dist/rfdt.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = fileURLToPath(import.meta.url);
const exec = promisify(execFile);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const mean = (values) =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
const sum = (values) => values.reduce((total, value) => total + value, 0);
const quantile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  return (
    sorted[lower] +
    (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower)
  );
};
const distribution = (values) => ({
  count: values.length,
  minimum: values.length ? Math.min(...values) : null,
  median: quantile(values, 0.5),
  p95: quantile(values, 0.95),
  maximum: values.length ? Math.max(...values) : null,
});

export function jsonWireRequest(request) {
  // Public validation adds absent optional fields as undefined. Hash and send
  // their JSON wire representation, while rejecting invalid numbers before
  // JSON serialization could silently turn them into null.
  return JSON.parse(JSON.stringify(validateRequest(request)));
}

async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function privateJson(file, value, exclusive = false) {
  const bytes = JSON.stringify(value, null, 2) + "\n";
  if (exclusive) {
    await writeFile(file, bytes, { mode: 0o600, flag: "wx" });
  } else {
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, bytes, { mode: 0o600, flag: "wx" });
    await rename(temp, file);
  }
}
async function privateOutput(file) {
  const lexical = relative(join(root, ".build"), dirname(file));
  assert.ok(
    !isAbsolute(lexical) && lexical !== ".." && !lexical.startsWith(`..${sep}`),
    "Reports and captures must stay in this project's private .build directory",
  );
  await mkdir(join(root, ".build"), { recursive: true, mode: 0o700 });
  const build = await realpath(join(root, ".build"));
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const parent = await realpath(dirname(file));
  const path = relative(build, parent);
  assert.ok(
    !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`),
    "Reports and captures must stay in this project's private .build directory",
  );
  const handle = await open(file, "wx", 0o600);
  await handle.close();
}
function integer(value, name, minimum, maximum) {
  const number = Number(value);
  assert.ok(
    Number.isSafeInteger(number) && number >= minimum && number <= maximum,
    `${name} must be an integer from ${minimum} to ${maximum}`,
  );
  return number;
}
export function shuffled(records, seed) {
  let state = seed >>> 0;
  const random = () => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const result = [...records];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
function answerValue(question, target) {
  normalizeRfdtTarget(question, target);
  if (Object.hasOwn(target, "answer")) {
    if (question.type !== "noul") return target.answer;
    return target.answer === null
      ? 0.5
      : typeof target.answer === "boolean"
        ? Number(target.answer)
        : target.answer;
  }
  if (question.type === "choice") {
    return question.criteria.reduce(
      (winner, criterion) =>
        target.probabilities[criterion.id] > target.probabilities[winner]
          ? criterion.id
          : winner,
      question.criteria[0].id,
    );
  }
  return sum(
    Object.entries(target.probabilities).map(
      ([label, probability]) =>
        probability *
        (question.type === "noul"
          ? 0.01 + ((Number(label) - 1) / 8) * 0.98
          : Number(label)),
    ),
  );
}
export function scoreAnswer(question, gold, returned, method) {
  const expected = answerValue(question, gold);
  let predicted, kind;
  if (method === "native") {
    assert.equal(
      returned.type,
      question.type,
      "Native returned a different answer type",
    );
    predicted =
      question.type === "choice"
        ? returned.choice
        : question.type === "score"
          ? returned.score
          : returned.noul;
    kind = "actual_native_typed_answer";
  } else {
    predicted = answerValue(question, returned);
    kind = Object.hasOwn(returned, "probabilities")
      ? "actual_generated_probability_map"
      : question.type === "choice"
        ? "actual_generated_choice_answer_no_confidence"
        : question.type === "score"
          ? "actual_generated_numeric_rubric_answer"
          : returned.answer === null
            ? "actual_generated_unknown_answer"
            : typeof returned.answer === "boolean"
              ? "actual_generated_boolean_endpoint_for_error_scoring"
              : "actual_generated_numeric_probability_estimate";
  }
  if (question.type === "choice") {
    assert.ok(
      question.criteria.some((criterion) => criterion.id === predicted),
    );
    return {
      question_id: question.id,
      type: question.type,
      expected,
      predicted,
      prediction_kind: kind,
      correct_judgment: predicted === expected,
      abstention: false,
      completed_clear_decision: predicted === expected,
    };
  }
  assert.ok(Number.isFinite(predicted), "Nonfinite numeric answer");
  assert.ok(
    predicted >= 0 &&
      predicted <=
        (question.type === "score" ? question.criteria.length - 1 : 1),
    "Numeric answer is outside its declared range",
  );
  const error =
    Math.abs(predicted - expected) /
    (question.type === "score" ? question.criteria.length - 1 : 1);
  const uncertain =
    question.type === "noul" &&
    (!Object.hasOwn(gold, "answer") || gold.answer === null);
  const correct =
    question.type === "score" || uncertain
      ? error <= 0.1
      : expected === 1
        ? predicted > 0.5
        : predicted < 0.5;
  const abstention =
    question.type === "noul" && Math.abs(predicted - 0.5) <= 0.1;
  return {
    question_id: question.id,
    type: question.type,
    expected,
    predicted,
    prediction_kind: kind,
    normalized_absolute_error: error,
    ...(question.type === "noul"
      ? { uncertain, squared_error: (predicted - expected) ** 2 }
      : {}),
    correct_judgment: correct,
    abstention,
    completed_clear_decision: correct && !uncertain && !abstention,
  };
}
export function summarize(attempts) {
  const answers = attempts.flatMap((attempt) => attempt.answers ?? []);
  const choices = answers.filter((answer) => answer.type === "choice");
  const clear = answers.filter(
    (answer) => answer.type === "noul" && !answer.uncertain,
  );
  const unknown = answers.filter(
    (answer) => answer.type === "noul" && answer.uncertain,
  );
  const scores = answers.filter((answer) => answer.type === "score");
  const total = sum(attempts.map((attempt) => attempt.elapsed_ms));
  const accepted = attempts.filter(
    (attempt) => attempt.correct_judgment,
  ).length;
  const completed = attempts.filter(
    (attempt) => attempt.completed_clear_decision,
  ).length;
  const failures = attempts.filter((attempt) => attempt.error).length;
  const regressions = attempts.filter((attempt) => attempt.regression);
  const result = {
    attempts: attempts.length,
    execution_failures: failures,
    incorrect_or_failed_attempts: attempts.length - accepted,
    accepted_correct_judgments: accepted,
    completed_clear_decisions: completed,
    abstaining_attempts: attempts.filter((attempt) => attempt.abstention)
      .length,
    correct_judgment_rate: attempts.length ? accepted / attempts.length : null,
    completed_clear_decision_rate: attempts.length
      ? completed / attempts.length
      : null,
    elapsed_all_attempts_ms: total,
    elapsed_all_attempts_per_accepted_judgment_ms: accepted
      ? total / accepted
      : null,
    elapsed_all_attempts_per_completed_clear_decision_ms: completed
      ? total / completed
      : null,
    latency_all_attempts_ms: distribution(
      attempts.map((attempt) => attempt.elapsed_ms),
    ),
    latency_first_method_call_ms: distribution(
      attempts
        .filter((attempt) => attempt.method_call_index === 1)
        .map((attempt) => attempt.elapsed_ms),
    ),
    latency_later_method_calls_ms: distribution(
      attempts
        .filter((attempt) => attempt.method_call_index > 1)
        .map((attempt) => attempt.elapsed_ms),
    ),
    choice: {
      count: choices.length,
      accuracy: mean(choices.map((answer) => Number(answer.correct_judgment))),
    },
    noul: {
      clear_count: clear.length,
      clear_accuracy: mean(
        clear.map((answer) => Number(answer.correct_judgment)),
      ),
      brier: mean(clear.map((answer) => answer.squared_error)),
      uncertain_count: unknown.length,
      uncertainty_mae: mean(
        unknown.map((answer) => answer.normalized_absolute_error),
      ),
    },
    score: {
      count: scores.length,
      normalized_mae: mean(
        scores.map((answer) => answer.normalized_absolute_error),
      ),
    },
    regressions: {
      attempts: regressions.length,
      passed: regressions.filter((attempt) => attempt.correct_judgment).length,
    },
  };
  result.gates = {
    no_failures: failures === 0 && attempts.length > 0,
    choice_accuracy:
      result.choice.accuracy !== null &&
      result.choice.accuracy >= QUALITY_GATES.choice_accuracy,
    noul_clear_accuracy:
      result.noul.clear_accuracy !== null &&
      result.noul.clear_accuracy >= QUALITY_GATES.noul_clear_accuracy,
    noul_brier:
      result.noul.brier !== null &&
      result.noul.brier <= QUALITY_GATES.noul_brier,
    uncertainty_mae:
      result.noul.uncertainty_mae !== null &&
      result.noul.uncertainty_mae <= 0.1,
    normalized_score_mae:
      result.score.normalized_mae !== null &&
      result.score.normalized_mae <= QUALITY_GATES.normalized_score_mae,
    known_regressions: result.regressions.passed === regressions.length,
  };
  result.gates.passed = Object.values(result.gates).every(Boolean);
  const nativeMetrics = [
    "computed_prompt_tokens",
    "computed_output_tokens",
    "engine_forwards",
  ];
  result.work = Object.fromEntries(
    nativeMetrics.map((key) => {
      const measured = attempts.filter((attempt) =>
        Number.isFinite(attempt.native_response?.metrics?.[key]),
      );
      const value = measured.length
        ? sum(measured.map((attempt) => attempt.native_response.metrics[key]))
        : null;
      return [
        key,
        {
          measured_attempts: measured.length,
          total: value,
          complete_accounting: measured.length === attempts.length,
          all_attempts_per_accepted_judgment:
            value !== null && accepted && measured.length === attempts.length
              ? value / accepted
              : null,
          all_attempts_per_completed_clear_decision:
            value !== null && completed && measured.length === attempts.length
              ? value / completed
              : null,
        },
      ];
    }),
  );
  const posts = attempts.flatMap((attempt) => attempt.transport ?? []);
  for (const [name, getter] of [
    ["provider_prompt_tokens", (post) => post.provider_usage?.prompt_tokens],
    [
      "provider_completion_tokens",
      (post) => post.provider_usage?.completion_tokens,
    ],
    ["provider_total_tokens", (post) => post.provider_usage?.total_tokens],
    ["server_computed_prefill_tokens", (post) => post.server_timings?.prompt_n],
    ["server_generated_tokens", (post) => post.server_timings?.predicted_n],
    ["server_prefill_ms", (post) => post.server_timings?.prompt_ms],
    ["server_generation_ms", (post) => post.server_timings?.predicted_ms],
  ]) {
    const values = posts.map(getter).filter(Number.isFinite);
    const value = values.length ? sum(values) : null;
    result.work[name] = {
      measured_posts: values.length,
      total: value,
      complete_accounting: values.length === posts.length,
      all_attempts_per_accepted_judgment:
        value !== null && accepted && values.length === posts.length
          ? value / accepted
          : null,
      all_attempts_per_completed_clear_decision:
        value !== null && completed && values.length === posts.length
          ? value / completed
          : null,
    };
  }
  result.work.actual_provider_posts = posts.length;
  result.work.http_or_transport_failed_provider_posts = posts.filter(
    (post) => post.error || !post.ok,
  ).length;
  result.work.production_retry_posts = sum(
    attempts.map((attempt) =>
      Math.max(0, (attempt.transport?.length ?? 0) - 1),
    ),
  );
  result.process_rss_observed_bytes = Object.fromEntries(
    ["evaluator", "native", "generative_server"].map((processName) => [
      processName,
      distribution(
        attempts
          .flatMap((attempt) => [
            attempt.process_rss_before?.[processName],
            attempt.process_rss_after?.[processName],
          ])
          .filter(Number.isFinite),
      ),
    ]),
  );
  return result;
}
export function pairedSummary(attempts, nativeInitializationMs = 0) {
  const pairs = new Map();
  for (const attempt of attempts) {
    const pair = pairs.get(attempt.pair_key) ?? {};
    pair[attempt.method] = attempt;
    pairs.set(attempt.pair_key, pair);
  }
  const both = [...pairs.values()].filter(
    (pair) => pair.native && pair.generative,
  );
  const clearEligible = both.filter(
    (pair) => pair.native.expected_clear_decision,
  );
  const complete = both.filter(
    (pair) =>
      pair.native.completed_clear_decision &&
      pair.generative.completed_clear_decision,
  );
  const byRecord = new Map();
  for (const attempt of attempts) {
    const key = `${attempt.method}:${attempt.record_id}`;
    const row = byRecord.get(key) ?? {
      method: attempt.method,
      record_id: attempt.record_id,
      group_id: attempt.group_id,
      spent_all_attempts_ms: 0,
      attempted: 0,
      time_to_first_correct_judgment_ms: null,
      time_to_first_completed_clear_decision_ms: null,
    };
    row.spent_all_attempts_ms += attempt.elapsed_ms;
    row.attempted++;
    if (
      attempt.correct_judgment &&
      row.time_to_first_correct_judgment_ms === null
    )
      row.time_to_first_correct_judgment_ms = row.spent_all_attempts_ms;
    if (
      attempt.completed_clear_decision &&
      row.time_to_first_completed_clear_decision_ms === null
    )
      row.time_to_first_completed_clear_decision_ms = row.spent_all_attempts_ms;
    byRecord.set(key, row);
  }
  const methods = Object.fromEntries(
    ["native", "generative"].map((method) => [
      method,
      summarize(attempts.filter((attempt) => attempt.method === method)),
    ]),
  );
  methods.native.elapsed_including_initialization_ms =
    methods.native.elapsed_all_attempts_ms + nativeInitializationMs;
  methods.native.elapsed_including_initialization_per_accepted_judgment_ms =
    methods.native.accepted_correct_judgments
      ? methods.native.elapsed_including_initialization_ms /
        methods.native.accepted_correct_judgments
      : null;
  methods.native.initialization_ms = nativeInitializationMs;
  const ratios = complete.map(
    (pair) => pair.generative.elapsed_ms / pair.native.elapsed_ms,
  );
  const speed = distribution(ratios);
  const unconditionalGain =
    methods.native.elapsed_all_attempts_per_accepted_judgment_ms &&
    methods.generative.elapsed_all_attempts_per_accepted_judgment_ms
      ? methods.generative.elapsed_all_attempts_per_accepted_judgment_ms /
        methods.native.elapsed_all_attempts_per_accepted_judgment_ms
      : null;
  return {
    methods,
    paired: {
      attempted_pairs: both.length,
      eligible_clear_decision_pairs: clearEligible.length,
      uncertainty_judgment_pairs: both.length - clearEligible.length,
      both_completed_correctly: complete.length,
      excluded_incorrect_failed_or_abstaining_pairs:
        both.length - complete.length,
      completed_pair_coverage: both.length
        ? complete.length / both.length
        : null,
      eligible_clear_pair_completion_coverage: clearEligible.length
        ? complete.length / clearEligible.length
        : null,
      conditional_both_correct_generative_over_native_latency: speed,
      all_attempts_elapsed_per_accepted_judgment_generative_over_native:
        unconditionalGain,
      conditional_ratio_is_not_an_unconditional_workflow_speedup: true,
      quality_gates_both_passed:
        methods.native.gates.passed && methods.generative.gates.passed,
      comparable_correctness:
        methods.native.correct_judgment_rate !== null &&
        methods.generative.correct_judgment_rate !== null &&
        methods.native.correct_judgment_rate >=
          methods.generative.correct_judgment_rate,
      median_twofold_speed_condition:
        speed.median !== null && speed.median >= 2,
      improvement_claim_permitted:
        methods.native.gates.passed &&
        methods.generative.gates.passed &&
        methods.native.correct_judgment_rate >=
          methods.generative.correct_judgment_rate &&
        methods.native.completed_clear_decision_rate >=
          methods.generative.completed_clear_decision_rate &&
        complete.length / clearEligible.length >= 0.9 &&
        clearEligible.length > 0 &&
        both.length > 0 &&
        unconditionalGain !== null &&
        unconditionalGain >= 2 &&
        speed.median >= 2,
    },
    time_to_correct_by_record: [...byRecord.values()],
    per_group: [...new Set(attempts.map((attempt) => attempt.group_id))].map(
      (group_id) => ({
        group_id,
        methods: Object.fromEntries(
          ["native", "generative"].map((method) => [
            method,
            summarize(
              attempts.filter(
                (attempt) =>
                  attempt.group_id === group_id && attempt.method === method,
              ),
            ),
          ]),
        ),
      }),
    ),
  };
}

async function rss(pid) {
  if (!pid) return null;
  try {
    const output = (
      await exec("ps", ["-p", String(pid), "-o", "rss="])
    ).stdout.trim();
    const value = Number(output);
    return Number.isFinite(value) && output ? value * 1024 : null;
  } catch {
    return null;
  }
}
async function ownedServer(file, descriptor) {
  const state = JSON.parse(await readFile(file, "utf8"));
  assert.equal(state.version, 1);
  assert.equal(state.host, "127.0.0.1");
  assert.equal(
    state.native_revision,
    "f072b103714dfa1eee531f80b24512faf38e3dd2",
  );
  assert.equal(state.parallel, 1);
  assert.equal(state.actual_device, "metal");
  assert.ok(
    Number.isSafeInteger(state.port) && state.port >= 1 && state.port <= 65535,
  );
  for (const key of ["id", "revision", "sha256", "size"])
    assert.equal(state.model[key], descriptor[key], `Owned teacher ${key}`);
  assert.ok(state.model.roles.includes("teacher"));
  assert.equal((await stat(state.model.file)).size, descriptor.size);
  assert.equal(await hashFile(state.binary), state.binary_sha256);
  assert.equal(
    await hashFile(state.template_file),
    descriptor.chat_template.sha256,
  );
  assert.equal(state.template_sha256, descriptor.chat_template.sha256);
  assert.equal(
    (
      await exec("ps", ["-p", String(state.pid), "-o", "lstart="])
    ).stdout.trim(),
    state.process_started,
  );
  const command = (
    await exec("ps", ["-p", String(state.pid), "-o", "command="])
  ).stdout.trim();
  for (const value of [
    state.binary,
    state.model.file,
    state.template_file,
    `--alias ${AGENT_MODEL_ID}`,
    "--host 127.0.0.1",
    `--port ${state.port}`,
  ])
    assert.ok(command.includes(value), `Owned command lacks ${value}`);
  assert.ok(!/--api-key(?:[ =]|$)/.test(command));
  return {
    state,
    command,
    model_hash_verification:
      "AgentServer.start verified complete GGUF before loading; exact registry state identity and file size rechecked here",
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      dataset: {
        type: "string",
        default: join(root, "fixtures/developer-workflows.jsonl"),
      },
      split: { type: "string", default: "validation" },
      version: { type: "string", default: "v2" },
      methods: { type: "string", default: "both" },
      repetitions: { type: "string", default: "3" },
      limit: { type: "string" },
      seed: { type: "string", default: "42" },
      context: { type: "string", default: "8192" },
      "timeout-ms": { type: "string", default: "600000" },
      output: { type: "string" },
      "prepare-only": { type: "boolean", default: false },
      "state-file": {
        type: "string",
        default: join(
          root,
          ".build/improvement-experiments/agent-server-state.json",
        ),
      },
      "artifact-registry": { type: "string" },
      "corpus-freeze": { type: "string" },
      "final-protocol": { type: "string" },
    },
  });
  assert.ok(["train", "validation", "test"].includes(values.split));
  assert.ok(["v1", "v2"].includes(values.version));
  assert.ok(["native", "generative", "both"].includes(values.methods));
  if (values.split === "test")
    assert.ok(
      values["final-protocol"],
      "Test inference and preparation require an explicit root-frozen --final-protocol",
    );
  const repetitions = integer(values.repetitions, "--repetitions", 1, 100);
  const seed = integer(values.seed, "--seed", 0, 0xffffffff);
  const context = integer(values.context, "--context", 256, 32768);
  const timeout = integer(values["timeout-ms"], "--timeout-ms", 1, 2147483647);
  const dataset = resolve(values.dataset);
  const raw = await readFile(dataset);
  // Other splits are parsed/validated for isolation, but never selected for inference.
  const allRecords = await loadQualityRecords(dataset);
  const splitRecords = allRecords.filter(
    (record) => record.split === values.split,
  );
  assert.ok(splitRecords.length, "Selected split contains no records");
  const limit =
    values.limit === undefined
      ? null
      : integer(values.limit, "--limit", 1, splitRecords.length);
  const records = shuffled(splitRecords, seed).slice(
    0,
    limit ?? splitRecords.length,
  );
  const config = configFromEnv();
  config.templateVersion = values.version;
  config.maxModelLen = context;
  config.advanced = true;
  if (values["artifact-registry"])
    config.artifactRegistryPath = resolve(values["artifact-registry"]);
  for (const record of records)
    validateRequest({
      ...record.request,
      model: config.modelId,
      options: { ...record.request.options, template_version: values.version },
    });
  const executedFiles = Object.fromEntries(
    await Promise.all(
      ["backend", "core", "evaluation", "models", "rfdt", "agent-server"].map(
        async (name) => [
          `dist/${name}.js`,
          await hashFile(join(root, `dist/${name}.js`)),
        ],
      ),
    ),
  );
  const methods =
    values.methods === "both" ? ["native", "generative"] : [values.methods];
  const conditions = {
    split: values.split,
    methods: values.methods,
    repetitions,
    limit,
    seed,
    template_version: values.version,
    context,
    timeout_ms: timeout,
    order_policy:
      "seeded shuffle per repetition; alternate method order by pair index",
    cache_policy:
      "new label cache each trial; native model kept loaded; native and server prefix policies unchanged and observed",
    record_ids: records.map((record) => record.id),
  };
  const output = resolve(
    values.output ??
      join(
        root,
        ".build/improvement-experiments",
        `decision-eval-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.json`,
      ),
  );
  await privateOutput(output);
  const artifactDir = output + ".artifacts";
  await mkdir(artifactDir, { mode: 0o700 });
  const report = {
    schema_version: 1,
    kind: "actual_paired_developer_decision_workflow",
    status: "preparing",
    started_at: new Date().toISOString(),
    output,
    artifact_directory: artifactDir,
    scope:
      "Direct structured developer judgments; this does not establish completed pi task improvement or live Salesforce behavior",
    script_sha256: await hashFile(script),
    dataset: {
      file: dataset,
      sha256: sha(raw),
      selected_records: records.length,
      selected_groups: new Set(records.map((record) => record.group_id)).size,
    },
    executed_files: executedFiles,
    executed_files_sha256: sha(canonical(executedFiles)),
    conditions,
    native_config: config,
    attempts: [],
    acceptance_policy: {
      numeric_gates: QUALITY_GATES,
      uncertain_noul_mae: 0.1,
      correct_uncertainty_is_a_judgment_not_a_completed_clear_decision: true,
      abstention_band_noul: [0.4, 0.6],
      score_accepted_normalized_error: 0.1,
      all_failures_wrong_answers_abstentions_retained: true,
      cost_per_accepted_outcome_includes_all_attempts: true,
      no_evaluator_retries: true,
      production_label_retries:
        "Up to three invalid/failed teacher attempts; every POST captured",
      confidence_from_generated_hard_choices: false,
      boolean_noul_brier_is_endpoint_coded_hard_answer_loss_not_model_calibration: true,
      improvement_requires_quality_gates_in_both_arms: true,
      improvement_requires_no_accepted_judgment_or_clear_completion_rate_regression: true,
      improvement_minimum_eligible_clear_pair_completion_coverage: 0.9,
      improvement_minimum_conditional_median_and_all_attempts_cost_gain: 2,
    },
    cache_policy: {
      native_process: "Kept loaded after separately measured initialization",
      native_prefix:
        "Production policy unchanged; actual computed tokens and engine work recorded",
      generative_label_disk_cache:
        "Unique empty directory for each trial; expected zero disk-cache hits",
      generative_server_prefix:
        "Already running owned server; production prefix cache retained, actual prefill counts recorded when exposed",
      engine_cache_policies_are_not_identical: true,
      server_startup_measured_by_this_evaluator: false,
      first_method_call_does_not_imply_cold_model_or_empty_server_cache: true,
    },
    instrumentation: {
      provider_output_override: false,
      transparent_response_clone_capture: true,
      provider_capture_overhead_included_in_arm_latency: true,
      process_rss_is_not_gpu_memory_or_energy_cost: true,
    },
  };
  let reservation;
  if (values["corpus-freeze"]) {
    const freeze = JSON.parse(
      await readFile(resolve(values["corpus-freeze"]), "utf8"),
    );
    assert.equal(freeze.kind, "jev_developer_workflow_corpus_freeze");
    assert.equal(freeze.status, "frozen");
    assert.equal(freeze.authorized_by, "root");
    assert.equal(freeze.dataset_sha256, report.dataset.sha256);
    report.corpus_freeze = {
      file: resolve(values["corpus-freeze"]),
      sha256: sha(canonical(freeze)),
    };
  }
  if (values["final-protocol"]) {
    const protocolPath = resolve(values["final-protocol"]);
    const protocol = JSON.parse(await readFile(protocolPath, "utf8"));
    assert.equal(protocol.kind, "jev_developer_decision_final_protocol");
    assert.equal(protocol.schema_version, 1);
    assert.equal(protocol.status, "frozen");
    assert.equal(protocol.authorized_by, "root");
    assert.ok(
      typeof protocol.candidate_frozen_at === "string" &&
        Number.isFinite(Date.parse(protocol.candidate_frozen_at)),
    );
    assert.equal(protocol.dataset_sha256, report.dataset.sha256);
    assert.equal(protocol.evaluator_sha256, report.script_sha256);
    assert.equal(protocol.executed_files_sha256, report.executed_files_sha256);
    assert.deepEqual(protocol.conditions, conditions);
    if (values.split === "test") {
      assert.equal(values.methods, "both");
      assert.equal(limit, null, "Final test must use every frozen test record");
    }
    report.final_protocol = {
      file: protocolPath,
      sha256: sha(canonical(protocol)),
      protocol,
    };
    reservation = protocolPath + ".decision-evaluation-reservation.json";
  }
  await privateJson(join(artifactDir, "selected-records.json"), records, true);
  if (values["prepare-only"]) {
    report.status = "prepared";
    report.actual_native_model_calls = 0;
    report.actual_provider_calls = 0;
    report.native_identity_requires_runtime_verification = true;
    report.generative_identity_requires_owned_server_verification = true;
    await privateJson(output, report);
    console.log(
      JSON.stringify({
        status: report.status,
        output,
        selected_records: records.length,
        dataset_sha256: report.dataset.sha256,
        actual_model_calls: 0,
        conditions,
      }),
    );
    return;
  }
  assert.ok(
    values["corpus-freeze"] || report.final_protocol,
    "Actual inference requires --corpus-freeze or a root-frozen --final-protocol; use --prepare-only while the corpus is being authored",
  );
  if (reservation) {
    await privateOutput(reservation);
    await privateJson(reservation, {
      version: 1,
      claimed_at: new Date().toISOString(),
      protocol_sha256: report.final_protocol.sha256,
      output,
      candidate_frozen: true,
      permanent_once_only: true,
    });
    report.permanent_final_test_reservation = reservation;
  }
  await privateJson(output, report);
  const descriptor = await modelDescriptor(AGENT_MODEL_ID);
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const interrupted = () =>
    controller.abort(new Error("Developer evaluator interrupted"));
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  let owned, endpoint, currentAttempt;
  let classifier, backend;
  let nativeStartupFailed;
  let nativeClassifyInvocations = 0;
  const counts = { native: 0, generative: 0 };
  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof globalThis.Request ? input.url : String(input);
    assert.ok(
      owned,
      "Network unavailable until an owned loopback server identity is checked",
    );
    const health = `http://127.0.0.1:${owned.state.port}/health`;
    const modelsUrl = `http://127.0.0.1:${owned.state.port}/v1/models`;
    assert.ok(
      [health, modelsUrl, endpoint].includes(url),
      "Only the exact owned loopback URLs are permitted",
    );
    const headers = new Headers(init.headers);
    assert.ok(!headers.has("authorization") && !headers.has("cookie"));
    if (url !== endpoint)
      return originalFetch(input, { ...init, redirect: "error" });
    assert.ok(
      currentAttempt?.method === "generative",
      "No provider call outside a generative trial",
    );
    assert.equal(init.method, "POST");
    assert.equal(typeof init.body, "string");
    const body = JSON.parse(init.body);
    assert.equal(body.model, AGENT_MODEL_ID);
    assert.equal(body.temperature, 0);
    assert.equal(body.response_format?.type, "json_schema");
    const user = JSON.parse(body.messages[1].content);
    assert.deepEqual(
      user,
      {
        context:
          currentAttempt.request.state ?? currentAttempt.request.messages,
        questions: currentAttempt.request.questions,
      },
      "Baseline must receive exactly the same context/questions, without targets",
    );
    const post = {
      index: currentAttempt.transport.length + 1,
      url,
      started_at: new Date().toISOString(),
      request_sha256: sha(init.body),
      request: body,
      request_text: init.body,
    };
    currentAttempt.transport.push(post);
    const start = performance.now();
    try {
      const response = await originalFetch(input, {
        ...init,
        redirect: "error",
      });
      post.headers_received_ms = performance.now() - start;
      const bytes = Buffer.from(await response.clone().arrayBuffer());
      post.elapsed_ms = performance.now() - start;
      post.ok = response.ok;
      post.status = response.status;
      post.response_sha256 = sha(bytes);
      post.response_bytes = bytes;
      post.response_text = bytes.toString("utf8");
      post.response_headers = Object.fromEntries(response.headers);
      let parsed;
      try {
        parsed = JSON.parse(post.response_text);
      } catch {
        /* Raw response is retained. */
      }
      post.provider_usage = parsed?.usage ?? null;
      post.server_timings = parsed?.timings ?? null;
      post.returned_model = parsed?.model ?? null;
      if (parsed?.model !== undefined)
        assert.equal(parsed.model, AGENT_MODEL_ID);
      return response;
    } catch (error) {
      post.elapsed_ms = performance.now() - start;
      post.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };
  try {
    if (methods.includes("generative")) {
      owned = await ownedServer(resolve(values["state-file"]), descriptor);
      endpoint = `http://127.0.0.1:${owned.state.port}/v1/chat/completions`;
      report.owned_server = owned;
      const health = await fetch(
        `http://127.0.0.1:${owned.state.port}/health`,
        {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(5000),
          ]),
        },
      );
      assert.ok(health.ok, "Root-owned server must already be ready");
      const modelsReply = await fetch(
        `http://127.0.0.1:${owned.state.port}/v1/models`,
        {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(5000),
          ]),
        },
      );
      assert.ok(modelsReply.ok);
      report.server_models = await modelsReply.json();
      assert.ok(
        report.server_models.data?.some((model) => model.id === AGENT_MODEL_ID),
      );
      if (report.final_protocol) {
        assert.deepEqual(report.final_protocol.protocol.generative, {
          id: descriptor.id,
          revision: descriptor.revision,
          artifact_sha256: descriptor.sha256,
          binary_sha256: owned.state.binary_sha256,
          native_revision: owned.state.native_revision,
          template_sha256: owned.state.template_sha256,
        });
      }
    }
    if (methods.includes("native")) {
      backend = new NativeBackend(config);
      classifier = new Classifier(config, backend);
      const start = performance.now();
      try {
        await backend.warmup();
      } catch (error) {
        nativeStartupFailed = error;
      }
      report.native_initialization = {
        elapsed_ms: performance.now() - start,
        status: backend.status,
        error: nativeStartupFailed?.message ?? null,
        measured_separately_from_decision_arm_latency: true,
      };
      if (report.final_protocol && !nativeStartupFailed) {
        assert.deepEqual(report.final_protocol.protocol.native, {
          id: config.modelId,
          artifact_sha256: backend.status.artifact.sha256,
          template_version: values.version,
          binary_sha256: await hashFile(config.binary),
        });
      }
    }
    report.status = "running";
    await privateJson(output, report);
    let pairIndex = 0;
    for (let repetition = 0; repetition < repetitions; repetition++) {
      for (const record of shuffled(
        records,
        (seed + repetition * 104729) >>> 0,
      )) {
        controller.signal.throwIfAborted();
        const order = pairIndex % 2 === 0 ? methods : [...methods].reverse();
        const pairKey = `${repetition}:${record.id}`;
        for (const method of order) {
          const request = jsonWireRequest({
            ...structuredClone(record.request),
            model: config.modelId,
            options: {
              ...record.request.options,
              template_version: values.version,
            },
          });
          const attempt = {
            method,
            repetition: repetition + 1,
            record_id: record.id,
            group_id: record.group_id,
            regression: record.regression === true,
            expected_clear_decision: record.request.questions.every(
              (question) =>
                question.type !== "noul" ||
                (Object.hasOwn(record.targets[question.id], "answer") &&
                  record.targets[question.id].answer !== null),
            ),
            pair_key: pairKey,
            pair_index: pairIndex,
            pair_order: [...order],
            method_call_index: ++counts[method],
            started_at: new Date().toISOString(),
            request,
            request_sha256: sha(canonical(request)),
            answers: [],
            transport: [],
            correct_judgment: false,
            completed_clear_decision: false,
            abstention: false,
          };
          currentAttempt = attempt;
          const directory = join(
            artifactDir,
            `trial-${String(report.attempts.length + 1).padStart(6, "0")}`,
          );
          await mkdir(directory, { mode: 0o700 });
          attempt.artifact_directory = directory;
          attempt.process_rss_before = {
            evaluator: process.memoryUsage().rss,
            native: await rss(backend?.status.process_id),
            generative_server: await rss(owned?.state.pid),
          };
          const signal = AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(timeout),
          ]);
          const start = performance.now();
          try {
            let returned;
            if (method === "native") {
              if (nativeStartupFailed) throw nativeStartupFailed;
              nativeClassifyInvocations++;
              returned = await classifier.classify(request, signal);
              attempt.native_response = returned;
              assert.equal(returned.metadata?.template_version, values.version);
            } else {
              const source = {
                id: `decision-${randomUUID()}`,
                group_id: record.group_id,
                split: record.split,
                request,
                targets: {},
              };
              const inputPath = join(directory, "unlabeled.jsonl");
              const outputPath = join(directory, "labeled.jsonl");
              const cacheDir = join(directory, "fresh-label-cache");
              await writeFile(inputPath, JSON.stringify(source) + "\n", {
                mode: 0o600,
                flag: "wx",
              });
              await mkdir(cacheDir, { mode: 0o700 });
              attempt.label_summary = await labelRfdt(inputPath, {
                outputPath,
                cacheDir,
                teacherUrl: `http://127.0.0.1:${owned.state.port}/v1`,
                teacherModel: AGENT_MODEL_ID,
                teacherRevision: descriptor.revision,
                signal,
              });
              assert.equal(
                attempt.label_summary.cache_hits,
                0,
                "Every generative label cache must be fresh",
              );
              const labeled = JSON.parse(
                (await readFile(outputPath, "utf8")).trim(),
              );
              assert.deepEqual(labeled.request, jsonWireRequest(request));
              attempt.actual_generated_targets = labeled.targets;
              attempt.target_provenance = labeled.target_provenance;
              returned = labeled.targets;
            }
            attempt.answers = record.request.questions.map((question) =>
              scoreAnswer(
                question,
                record.targets[question.id],
                method === "native"
                  ? returned.answers[question.id]
                  : returned[question.id],
                method,
              ),
            );
            attempt.correct_judgment = attempt.answers.every(
              (answer) => answer.correct_judgment,
            );
            attempt.completed_clear_decision = attempt.answers.every(
              (answer) => answer.completed_clear_decision,
            );
            attempt.abstention = attempt.answers.some(
              (answer) => answer.abstention,
            );
          } catch (error) {
            attempt.error =
              error instanceof Error ? error.message : String(error);
          } finally {
            attempt.elapsed_ms = performance.now() - start;
            attempt.completed_at = new Date().toISOString();
            currentAttempt = undefined;
          }
          attempt.process_rss_after = {
            evaluator: process.memoryUsage().rss,
            native: await rss(backend?.status.process_id),
            generative_server: await rss(owned?.state.pid),
          };
          for (const post of attempt.transport) {
            const prefix = join(directory, `post-${post.index}`);
            post.request_file = prefix + ".request.json";
            post.response_file = prefix + ".response.txt";
            await writeFile(post.request_file, post.request_text, {
              mode: 0o600,
              flag: "wx",
            });
            if (post.response_bytes !== undefined)
              await writeFile(post.response_file, post.response_bytes, {
                mode: 0o600,
                flag: "wx",
              });
            delete post.request;
            delete post.request_text;
            delete post.response_text;
            delete post.response_bytes;
          }
          await privateJson(join(directory, "attempt.json"), attempt, true);
          report.attempts.push(attempt);
          report.summary = pairedSummary(
            report.attempts,
            report.native_initialization?.elapsed_ms ?? 0,
          );
          await privateJson(output, report);
          console.log(
            JSON.stringify({
              method,
              repetition: repetition + 1,
              record_id: record.id,
              correct_judgment: attempt.correct_judgment,
              completed_clear_decision: attempt.completed_clear_decision,
              elapsed_ms: attempt.elapsed_ms,
              actual_posts: attempt.transport.length,
              error: attempt.error ?? null,
            }),
          );
        }
        pairIndex++;
      }
    }
    // Pure scoring replay through the public quality helper: no additional model calls.
    if (
      report.attempts.some(
        (attempt) => attempt.method === "native" && !attempt.error,
      )
    ) {
      report.native_quality_reports = [];
      for (let repetition = 0; repetition < repetitions; repetition++) {
        const unique = new Map();
        // Match the exact captured response for each repetition, without duplicate ids.
        for (const attempt of report.attempts.filter(
          (attempt) =>
            attempt.method === "native" &&
            attempt.repetition === repetition + 1 &&
            !attempt.error,
        ))
          unique.set(attempt.record_id, attempt.native_response);
        const selected = records.filter((record) => unique.has(record.id));
        if (selected.length) {
          let responseIndex = 0;
          const quality = await evaluateRecords(
            {
              classify: async (request) => {
                const candidate = selected[responseIndex++];
                assert.equal(
                  canonical(
                    jsonWireRequest({
                      ...candidate.request,
                      model: config.modelId,
                      options: {
                        ...candidate.request.options,
                        template_version: values.version,
                      },
                    }),
                  ),
                  canonical(jsonWireRequest(request)),
                  "Scoring replay must match an actual captured request",
                );
                return unique.get(candidate.id);
              },
            },
            selected,
            values.version,
            { modelId: config.modelId },
          );
          report.native_quality_reports.push({
            repetition: repetition + 1,
            scoring_only_no_inference: true,
            failed_attempts_excluded_from_helper_but_retained_in_overall_gates:
              records.length - selected.length,
            report: quality,
          });
        }
      }
    }
    assert.equal(
      await hashFile(dataset),
      report.dataset.sha256,
      "Dataset changed during evaluation",
    );
    assert.equal(
      await hashFile(script),
      report.script_sha256,
      "Evaluator changed during evaluation",
    );
    for (const [file, expected] of Object.entries(executedFiles))
      assert.equal(
        await hashFile(join(root, file)),
        expected,
        "Executed dist changed during evaluation",
      );
    if (owned) {
      const after = await ownedServer(
        resolve(values["state-file"]),
        descriptor,
      );
      assert.equal(after.state.pid, owned.state.pid);
      assert.equal(after.state.process_started, owned.state.process_started);
    }
    report.status = "completed";
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    globalThis.fetch = originalFetch;
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    const cleanupIdentity = {
      pid: backend?.status.process_id ?? null,
      temporary_directory: backend?.status.temporary_directory ?? null,
    };
    try {
      await classifier?.dispose();
    } catch (error) {
      report.native_cleanup_error =
        error instanceof Error ? error.message : String(error);
      report.status = "failed";
      process.exitCode = 1;
    }
    report.native_cleanup_status = backend?.status ?? null;
    report.native_cleanup_owned_identity = cleanupIdentity;
    report.actual_native_classify_invocations = nativeClassifyInvocations;
    report.actual_provider_posts = sum(
      report.attempts.map((attempt) => attempt.transport.length),
    );
    report.root_owned_generative_server_stopped_by_evaluator = false;
    report.completed_at = new Date().toISOString();
    report.observed_evaluator_wall_ms =
      Date.parse(report.completed_at) - Date.parse(report.started_at);
    report.observed_wall_includes_readiness_initialization_capture_reporting_and_cleanup = true;
    report.summary = pairedSummary(
      report.attempts,
      report.native_initialization?.elapsed_ms ?? 0,
    );
    report.quality_gates_passed_for_selected_methods = methods.every(
      (method) => report.summary.methods[method].gates.passed,
    );
    await privateJson(output, report);
  }
  console.log(
    JSON.stringify({
      status: report.status,
      output,
      summary: report.summary.methods,
      paired: report.summary.paired,
      error: report.error ?? null,
    }),
  );
  if (
    report.status !== "completed" ||
    report.attempts.some((attempt) => attempt.error) ||
    !report.quality_gates_passed_for_selected_methods
  )
    process.exitCode = 1;
}

if (process.argv[1] && (await realpath(process.argv[1])) === script) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
