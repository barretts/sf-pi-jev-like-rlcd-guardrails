import { describe, expect, it } from "vitest";
import {
  evaluateRecords,
  loadQualityRecords,
  qualityDatasetDigest,
  summarizeQuality,
  validateQualityRecords,
  type QualityRecord,
} from "../src/evaluation.js";
import type { Answer, ClassifierResponse, Question } from "../src/core.js";

function record(
  type: Question["type"],
  target: string | number | boolean | null,
): QualityRecord {
  const question: Question =
    type === "choice"
      ? {
          id: "q",
          type,
          instructions: "Which color is the bicycle?",
          criteria: [
            { id: "red", description: "Red" },
            { id: "blue", description: "Blue" },
          ],
        }
      : type === "score"
        ? {
            id: "q",
            type,
            instructions: "How many of the two checks passed?",
            criteria: ["Neither check", "One check", "Both checks"],
          }
        : { id: "q", type, instructions: "Is the bicycle red?" };
  return {
    id: type + String(target),
    group_id: type + String(target),
    split: "validation",
    request: {
      model: "google/gemma-3-1b-it",
      state: "The bicycle is red. Both checks passed.",
      questions: [question],
    },
    targets: { q: { answer: target } },
  };
}

const response = (answer: Answer): ClassifierResponse => ({
  model: "google/gemma-3-1b-it",
  answers: { q: answer },
  usage: { input_tokens: 10, output_tokens: 0 },
});

describe("quality labels and split isolation", () => {
  it("rejects invalid labels, targets, and group leakage before inference", () => {
    const valid = record("choice", "red");
    for (const records of [
      [valid, valid],
      [valid, { ...valid, id: "other", split: "test" }],
      [{ ...valid, targets: { q: { answer: "green" } } }],
      [{ ...valid, targets: {} }],
      [{ ...valid, targets: { q: { probabilities: { red: 0.8 } } } }],
      [{ ...valid, targets: { q: { probabilities: { green: 1 } } } }],
      [{ ...record("noul", true), targets: { q: { answer: "true" } } }],
      [{ ...record("score", 2), targets: { q: { answer: 3 } } }],
    ])
      expect(() => validateQualityRecords(records)).toThrow();
  });

  it("accepts probability targets and explicit uncertain Noul labels", () => {
    const choice = record("choice", "red");
    choice.targets.q = { probabilities: { red: 0.9, blue: 0.1 } };
    expect(validateQualityRecords([choice, record("noul", null)])).toHaveLength(
      2,
    );
  });

  it("loads the frozen 300-record suite with stratified grouped splits", async () => {
    const records = await loadQualityRecords();
    expect(records).toHaveLength(300);
    const groups = new Map<string, string>();
    for (const split of ["train", "validation", "test"] as const) {
      const selected = records.filter((item) => item.split === split);
      const perType = split === "train" ? 60 : 20;
      for (const type of ["choice", "score", "noul"])
        expect(
          selected.filter((item) => item.request.questions[0].type === type),
        ).toHaveLength(perType);
      const noul = selected.filter(
        (item) => item.request.questions[0].type === "noul",
      );
      for (const [target, proportion] of [
        [true, 0.4],
        [false, 0.4],
        [null, 0.2],
      ] as const)
        expect(
          noul.filter(
            (item) =>
              "answer" in item.targets.q && item.targets.q.answer === target,
          ),
        ).toHaveLength(perType * proportion);
    }
    for (const item of records) {
      if (groups.has(item.group_id))
        expect(item.split).toBe(groups.get(item.group_id));
      else groups.set(item.group_id, item.split);
    }
    expect(groups.size).toBe(150);
    expect(records.some((item) => item.request.messages)).toBe(true);
    expect(records.some((item) => item.request.state)).toBe(true);
    expect(
      records
        .filter((item) => item.regression)
        .every((item) => item.split === "validation"),
    ).toBe(true);
    // Frozen before candidate inference; changing labels or splits requires a new suite.
    expect(qualityDatasetDigest(records)).toBe(
      "cd3de2d07db024aeb0f8d22be394ffa9024307680efbe2967569c325bc7af3c9",
    );
  });
});

describe("quality evaluation", () => {
  it("uses the selected template and does not mutate fixed labels or requests", async () => {
    const records = [record("noul", true)];
    const frozen = structuredClone(records);
    let received: any;
    const report = await evaluateRecords(
      {
        async classify(request) {
          received = request;
          return response({ type: "noul", noul: 0.99 });
        },
      },
      records,
      "v2",
      { modelId: "approved-trained-gemma" },
    );
    expect(received.options.template_version).toBe("v2");
    expect(received.model).toBe("approved-trained-gemma");
    expect(records).toEqual(frozen);
    expect(report.summary.noul.clear_accuracy).toBe(1);
    expect(report.summary.noul.brier).toBeCloseTo(0.0001);
    expect(report.summary.gates.passed).toBe(false);
    expect(report.results[0].logical_prompt_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.prompt_manifest_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("separates ambiguous truth cases and normalizes score error", async () => {
    const records = [
      record("noul", false),
      record("noul", null),
      record("score", 2),
    ];
    const answers: Answer[] = [
      { type: "noul", noul: 0.2 },
      { type: "noul", noul: 0.8 },
      {
        type: "score",
        score: 1.6,
        confidence: 0.8,
        probabilities: { "0": 0, "1": 0.4, "2": 0.6 },
        legend: {},
      },
    ];
    const report = await evaluateRecords(
      {
        async classify() {
          return response(answers.shift()!);
        },
      },
      records,
      "v1",
    );
    expect(report.summary.noul.clear_count).toBe(1);
    expect(report.summary.noul.brier).toBeCloseTo(0.04);
    expect(report.summary.noul.uncertain_count).toBe(1);
    expect(report.summary.noul.uncertainty_mae).toBeCloseTo(0.3);
    expect(report.summary.score.normalized_mae).toBeCloseTo(0.2);
  });

  it("fails gates for native failures and incorrect known regressions", async () => {
    const records = [record("noul", true), record("choice", "red")];
    records[0].regression = true;
    let count = 0;
    const report = await evaluateRecords(
      {
        async classify() {
          if (count++) throw new Error("native failed");
          return response({ type: "noul", noul: 0.01 });
        },
      },
      records,
      "v2",
    );
    expect(report.summary.failures).toBe(1);
    expect(report.summary.regressions).toEqual({ count: 1, passed: 0 });
    expect(report.summary.gates.no_failures).toBe(false);
    expect(report.summary.gates.known_regressions).toBe(false);
    expect(report.results[1].error).toBe("native failed");
  });

  it("passes only a complete successful quality report", async () => {
    const records = [
      record("choice", "red"),
      record("score", 2),
      record("noul", true),
    ];
    records[2].regression = true;
    const answers: Answer[] = [
      {
        type: "choice",
        choice: "red",
        confidence: 1,
        probabilities: { red: 1, blue: 0 },
      },
      {
        type: "score",
        score: 2,
        confidence: 1,
        probabilities: { "0": 0, "1": 0, "2": 1 },
        legend: {},
      },
      { type: "noul", noul: 0.99 },
    ];
    const report = await evaluateRecords(
      {
        async classify() {
          return response(answers.shift()!);
        },
      },
      records,
      "v2",
    );
    expect(report.summary.gates.passed).toBe(true);
    expect(summarizeQuality([]).gates.passed).toBe(false);
  });

  it("rejects a response produced with a different template", async () => {
    const report = await evaluateRecords(
      {
        async classify() {
          return {
            ...response({ type: "noul", noul: 0.99 }),
            metadata: {
              backend: "fixture",
              model_revision: null,
              template_version: "v1",
              calibration: "uncalibrated",
              usage_accounting: "fixture",
            },
          };
        },
      },
      [record("noul", true)],
      "v2",
    );
    expect(report.summary.failures).toBe(1);
    expect(report.results[0].error).toContain("different template");
  });

  it("binds report hashes to the resolved logical prompt without storing context", async () => {
    const classifier = {
      async classify() {
        return response({ type: "noul" as const, noul: 0.99 });
      },
    };
    const records = [record("noul", true)];
    const v1 = await evaluateRecords(classifier, records, "v1");
    const v2 = await evaluateRecords(classifier, records, "v2");
    expect(v1.dataset_sha256).toBe(v2.dataset_sha256);
    expect(v1.results[0].logical_prompt_sha256).not.toBe(
      v2.results[0].logical_prompt_sha256,
    );
    expect(v1.prompt_manifest_sha256).not.toBe(v2.prompt_manifest_sha256);
    expect(JSON.stringify(v2)).not.toContain(
      records[0].request.state as string,
    );
  });
});
