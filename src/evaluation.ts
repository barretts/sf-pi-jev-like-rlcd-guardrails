import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  preparePrompt,
  validateRequest,
  type Answer,
  type ClassifierResponse,
  type Question,
  type Request,
  type TemplateVersion,
} from "./core.js";

export type QualitySplit = "train" | "validation" | "test";
export type QualityTarget =
  | { answer: string | number | boolean | null }
  | { probabilities: Record<string, number> };
export interface QualityRecord {
  id: string;
  group_id: string;
  split: QualitySplit;
  request: Request;
  targets: Record<string, QualityTarget>;
  regression?: boolean;
}
export interface QualityClassifier {
  classify(request: unknown, signal?: AbortSignal): Promise<ClassifierResponse>;
}
export interface QualityAnswerResult {
  question_id: string;
  type: Question["type"];
  target: QualityTarget;
  prediction: Answer;
  correct?: boolean;
  squared_error?: number;
  normalized_absolute_error?: number;
  uncertain?: boolean;
}
export interface QualityRecordResult {
  id: string;
  group_id: string;
  split: QualitySplit;
  regression: boolean;
  answers: QualityAnswerResult[];
  error?: string;
  elapsed_ms: number;
  logical_prompt_sha256?: string;
  model?: string;
  metadata?: ClassifierResponse["metadata"];
  usage?: ClassifierResponse["usage"];
}
export interface QualitySummary {
  records: number;
  failures: number;
  choice: { count: number; correct: number; accuracy: number | null };
  noul: {
    clear_count: number;
    clear_correct: number;
    clear_accuracy: number | null;
    brier: number | null;
    uncertain_count: number;
    uncertainty_mae: number | null;
  };
  score: { count: number; normalized_mae: number | null };
  regressions: { count: number; passed: number };
  gates: {
    no_failures: boolean;
    choice_accuracy: boolean;
    noul_clear_accuracy: boolean;
    noul_brier: boolean;
    normalized_score_mae: boolean;
    known_regressions: boolean;
    passed: boolean;
  };
}
export interface QualityReport {
  schema_version: 1;
  template_version: TemplateVersion;
  created_at: string;
  dataset_sha256: string;
  prompt_manifest_sha256: string;
  splits: QualitySplit[];
  summary: QualitySummary;
  results: QualityRecordResult[];
}

export const QUALITY_GATES = Object.freeze({
  choice_accuracy: 0.9,
  noul_clear_accuracy: 0.95,
  noul_brier: 0.1,
  normalized_score_mae: 0.1,
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function allowedLabels(question: Question): string[] {
  if (question.type === "choice") return question.criteria.map((c) => c.id);
  if (question.type === "score")
    return question.criteria.map((_, index) => String(index));
  return Array.from({ length: 9 }, (_, index) => String(index + 1));
}

/** Validate labels before any inference. No labels are inferred from a model. */
export function validateQualityRecords(values: unknown[]): QualityRecord[] {
  const ids = new Set<string>();
  const groups = new Map<string, QualitySplit>();
  return values.map((value, index) => {
    const location = `quality record ${index + 1}`;
    if (!isObject(value)) throw new Error(`${location}: expected object`);
    for (const key of ["id", "group_id"])
      if (typeof value[key] !== "string" || !value[key])
        throw new Error(`${location}: expected nonempty ${key}`);
    const id = value.id as string;
    const group = value.group_id as string;
    if (ids.has(id)) throw new Error(`${location}: duplicate id ${id}`);
    ids.add(id);
    if (!["train", "validation", "test"].includes(value.split as string))
      throw new Error(`${location}: unsupported split`);
    const split = value.split as QualitySplit;
    if (groups.has(group) && groups.get(group) !== split)
      throw new Error(`${location}: context group spans multiple splits`);
    groups.set(group, split);
    if (value.regression !== undefined && typeof value.regression !== "boolean")
      throw new Error(`${location}: regression must be boolean`);
    const request = validateRequest(value.request);
    if (!isObject(value.targets))
      throw new Error(`${location}: expected targets object`);
    const targets = value.targets;
    const questionIds = new Set(
      request.questions.map((question) => question.id),
    );
    if (
      Object.keys(targets).length !== questionIds.size ||
      Object.keys(targets).some((key) => !questionIds.has(key))
    )
      throw new Error(`${location}: targets must match question IDs`);
    for (const question of request.questions) {
      const target = targets[question.id];
      if (!isObject(target))
        throw new Error(`${location}: expected target for ${question.id}`);
      if (Object.keys(target).length !== 1)
        throw new Error(
          `${location}: exactly one answer or probabilities target`,
        );
      const labels = allowedLabels(question);
      if ("probabilities" in target) {
        if (!isObject(target.probabilities))
          throw new Error(`${location}: expected probabilities object`);
        let total = 0;
        for (const [label, probability] of Object.entries(
          target.probabilities,
        )) {
          if (
            !labels.includes(label) ||
            typeof probability !== "number" ||
            !Number.isFinite(probability) ||
            probability < 0
          )
            throw new Error(`${location}: invalid target probability`);
          total += probability;
        }
        if (Math.abs(total - 1) > 1e-6)
          throw new Error(`${location}: target probabilities must sum to one`);
      } else if ("answer" in target) {
        const answer = target.answer;
        if (
          question.type === "choice"
            ? typeof answer !== "string" || !labels.includes(answer)
            : question.type === "score"
              ? typeof answer !== "number" ||
                !Number.isFinite(answer) ||
                answer < 0 ||
                answer > question.criteria.length - 1
              : answer !== null && typeof answer !== "boolean"
        )
          throw new Error(`${location}: invalid ${question.type} target`);
      } else throw new Error(`${location}: unknown target field`);
    }
    return {
      id,
      group_id: group,
      split,
      request,
      targets: targets as Record<string, QualityTarget>,
      ...(value.regression === undefined
        ? {}
        : { regression: value.regression }),
    };
  });
}

export async function loadQualityRecords(
  path: string | URL = new URL("../fixtures/quality.jsonl", import.meta.url),
): Promise<QualityRecord[]> {
  const text = await readFile(path, "utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  return validateQualityRecords(
    lines.map((line, index) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        throw new Error(`quality line ${index + 1}: invalid JSON`);
      }
    }),
  );
}

export function qualityDatasetDigest(records: QualityRecord[]): string {
  return createHash("sha256")
    .update(records.map((record) => JSON.stringify(record)).join("\n") + "\n")
    .digest("hex");
}

function targetNumber(target: QualityTarget, question: Question): number {
  if ("answer" in target) {
    if (question.type === "noul")
      return target.answer === null ? 0.5 : target.answer === true ? 1 : 0;
    return target.answer as number;
  }
  return Object.entries(target.probabilities).reduce(
    (sum, [label, probability]) =>
      sum +
      probability *
        (question.type === "noul"
          ? 0.01 + ((Number(label) - 1) / 8) * 0.98
          : Number(label)),
    0,
  );
}

function scorePrediction(
  question: Question,
  target: QualityTarget,
  prediction: Answer,
): QualityAnswerResult {
  if (prediction.type !== question.type)
    throw new Error(`Incorrect answer type for ${question.id}`);
  const base = {
    question_id: question.id,
    type: question.type,
    target,
    prediction,
  };
  if (question.type === "choice" && prediction.type === "choice") {
    const expected =
      "answer" in target
        ? target.answer
        : allowedLabels(question).reduce((winner, label) =>
            (target.probabilities[label] ?? 0) >
            (target.probabilities[winner] ?? 0)
              ? label
              : winner,
          );
    return { ...base, correct: prediction.choice === expected };
  }
  if (question.type === "score" && prediction.type === "score") {
    if (!Number.isFinite(prediction.score))
      throw new Error(`Nonfinite score for ${question.id}`);
    const error =
      Math.abs(prediction.score - targetNumber(target, question)) /
      (question.criteria.length - 1);
    return { ...base, normalized_absolute_error: error, correct: error <= 0.1 };
  }
  if (question.type === "noul" && prediction.type === "noul") {
    if (
      !Number.isFinite(prediction.noul) ||
      prediction.noul < 0 ||
      prediction.noul > 1
    )
      throw new Error(`Invalid Noul probability for ${question.id}`);
    const expected = targetNumber(target, question);
    const uncertain = "answer" in target ? target.answer === null : true;
    const error = prediction.noul - expected;
    return {
      ...base,
      uncertain,
      squared_error: error * error,
      normalized_absolute_error: Math.abs(error),
      ...(uncertain
        ? {}
        : {
            correct:
              expected === 1 ? prediction.noul > 0.5 : prediction.noul < 0.5,
          }),
    };
  }
  throw new Error(`Unsupported prediction for ${question.id}`);
}

export function summarizeQuality(
  results: QualityRecordResult[],
): QualitySummary {
  const answers = results.flatMap((result) => result.answers);
  const choices = answers.filter((answer) => answer.type === "choice");
  const scores = answers.filter((answer) => answer.type === "score");
  const clear = answers.filter(
    (answer) => answer.type === "noul" && !answer.uncertain,
  );
  const uncertain = answers.filter(
    (answer) => answer.type === "noul" && answer.uncertain,
  );
  const mean = (values: number[]) =>
    values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null;
  const accuracy = (items: QualityAnswerResult[]) =>
    items.length
      ? items.filter((answer) => answer.correct).length / items.length
      : null;
  const regressions = results.filter((result) => result.regression);
  const regressionPassed = regressions.filter(
    (result) =>
      !result.error &&
      result.answers.length > 0 &&
      result.answers.every((answer) =>
        answer.uncertain
          ? (answer.normalized_absolute_error ?? Infinity) <= 0.1
          : answer.correct,
      ),
  ).length;
  const summary: Omit<QualitySummary, "gates"> = {
    records: results.length,
    failures: results.filter((result) => result.error).length,
    choice: {
      count: choices.length,
      correct: choices.filter((answer) => answer.correct).length,
      accuracy: accuracy(choices),
    },
    noul: {
      clear_count: clear.length,
      clear_correct: clear.filter((answer) => answer.correct).length,
      clear_accuracy: accuracy(clear),
      brier: mean(clear.map((answer) => answer.squared_error!)),
      uncertain_count: uncertain.length,
      uncertainty_mae: mean(
        uncertain.map((answer) => answer.normalized_absolute_error!),
      ),
    },
    score: {
      count: scores.length,
      normalized_mae: mean(
        scores.map((answer) => answer.normalized_absolute_error!),
      ),
    },
    regressions: { count: regressions.length, passed: regressionPassed },
  };
  const gates = {
    no_failures: summary.failures === 0 && results.length > 0,
    choice_accuracy:
      summary.choice.accuracy !== null &&
      summary.choice.accuracy >= QUALITY_GATES.choice_accuracy,
    noul_clear_accuracy:
      summary.noul.clear_accuracy !== null &&
      summary.noul.clear_accuracy >= QUALITY_GATES.noul_clear_accuracy,
    noul_brier:
      summary.noul.brier !== null &&
      summary.noul.brier <= QUALITY_GATES.noul_brier,
    normalized_score_mae:
      summary.score.normalized_mae !== null &&
      summary.score.normalized_mae <= QUALITY_GATES.normalized_score_mae,
    known_regressions: regressionPassed === regressions.length,
  };
  return {
    ...summary,
    gates: { ...gates, passed: Object.values(gates).every(Boolean) },
  };
}

/** Sequential native calls keep paired runs comparable and avoid queue overload. */
export async function evaluateRecords(
  classifier: QualityClassifier,
  records: QualityRecord[],
  version: TemplateVersion,
  options: { modelId?: string; signal?: AbortSignal } = {},
): Promise<QualityReport> {
  if (version !== "v1" && version !== "v2")
    throw new Error("Unsupported template version");
  validateQualityRecords(records);
  const results: QualityRecordResult[] = [];
  for (const record of records) {
    options.signal?.throwIfAborted();
    const start = performance.now();
    const result: QualityRecordResult = {
      id: record.id,
      group_id: record.group_id,
      split: record.split,
      regression: record.regression === true,
      answers: [],
      elapsed_ms: 0,
    };
    try {
      const request = {
        ...structuredClone(record.request),
        ...(options.modelId ? { model: options.modelId } : {}),
        options: { ...record.request.options, template_version: version },
      };
      const plan = preparePrompt(request, version);
      result.logical_prompt_sha256 = createHash("sha256")
        .update(JSON.stringify(plan.questions))
        .digest("hex");
      const response = await classifier.classify(request, options.signal);
      if (response.metadata && response.metadata.template_version !== version)
        throw new Error("Classifier returned a different template version");
      const answers = record.request.questions.map((question) => {
        if (!Object.hasOwn(response.answers, question.id))
          throw new Error(`Missing answer for ${question.id}`);
        return scorePrediction(
          question,
          record.targets[question.id],
          response.answers[question.id],
        );
      });
      result.answers = answers;
      result.model = response.model;
      result.metadata = response.metadata;
      result.usage = response.usage;
    } catch (error) {
      options.signal?.throwIfAborted();
      result.error = error instanceof Error ? error.message : String(error);
    }
    result.elapsed_ms = performance.now() - start;
    results.push(result);
  }
  return {
    schema_version: 1,
    template_version: version,
    created_at: new Date().toISOString(),
    dataset_sha256: qualityDatasetDigest(records),
    prompt_manifest_sha256: createHash("sha256")
      .update(
        JSON.stringify(
          results.map((result) => [
            result.id,
            result.logical_prompt_sha256 ?? null,
          ]),
        ),
      )
      .digest("hex"),
    splits: [...new Set(records.map((record) => record.split))],
    summary: summarizeQuality(results),
    results,
  };
}

export async function writeQualityReport(path: string, report: QualityReport) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
}
