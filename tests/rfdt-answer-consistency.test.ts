import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  buildResponse,
  preparePrompt,
  type Answer,
  type Logits,
} from "../src/core.js";
import { evaluateRecords } from "../src/evaluation.js";
import {
  approveTrainedArtifact,
  assertRfdtQualityIsolation,
  loadRfdtQualitySuite,
  verifyNativeRfdtAcceptance,
} from "../src/models.js";
import { rfdtFixture } from "./rfdt-fixture.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "jev-rfdt-answer-"));
  directories.push(directory);
  return rfdtFixture(directory);
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function answer(f: Fixture, type: Answer["type"]) {
  const result = f.reports
    .test!.results.flatMap((record) => record.answers)
    .find((result) => result.prediction.type === type);
  if (!result) throw new Error(`Missing ${type} fixture answer`);
  return result;
}

it("accepts complete native-core answers on both fixed acceptance splits", async () => {
  const f = await fixture();
  expect(f.reports.validation!.results).toHaveLength(60);
  expect(f.reports.test!.results).toHaveLength(60);
  await expect(verifyNativeRfdtAcceptance(f.artifact)).resolves.toBeUndefined();
});

it.each(["choice", "score", "noul"] as const)(
  "rejects approval when a passing %s value contradicts its distribution",
  async (type) => {
    const f = await fixture();
    const prediction = answer(f, type).prediction;
    if (prediction.type === "choice") {
      const labels = Object.keys(prediction.probabilities);
      const wrong = labels.find((label) => label !== prediction.choice)!;
      prediction.probabilities = Object.fromEntries(
        labels.map((label) => [label, Number(label === wrong)]),
      );
    } else if (prediction.type === "score") {
      const labels = Object.keys(prediction.probabilities);
      const wrong =
        prediction.score > (labels.length - 1) / 2 ? labels[0] : labels.at(-1)!;
      prediction.probabilities = Object.fromEntries(
        labels.map((label) => [label, Number(label === wrong)]),
      );
    } else {
      const wrongBin = prediction.noul > 0.5 ? 0 : 8;
      prediction.rating!.probabilities = Array.from({ length: 9 }, (_, index) =>
        Number(index === wrongBin),
      );
    }
    expect(f.reports.test!.summary.gates.passed).toBe(true);
    await f.writeReport("test");
    await expect(
      approveTrainedArtifact(f.artifact, { registryPath: f.registryPath }),
    ).rejects.toThrow(/native answer fields do not match their probabilities/);
    await expect(readFile(f.registryPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it.each([
  [
    "choice",
    "missing probability label",
    (p: any) => {
      delete p.probabilities[p.choice];
    },
  ],
  [
    "choice",
    "unexpected probability label",
    (p: any) => {
      p.probabilities.unexpected = 0;
    },
  ],
  [
    "score",
    "probability map replaced by an array",
    (p: any) => {
      p.probabilities = Object.values(p.probabilities);
    },
  ],
  [
    "choice",
    "unnormalized probabilities",
    (p: any) => {
      p.probabilities[p.choice] = 0.5;
    },
  ],
  [
    "score",
    "negative probability",
    (p: any) => {
      p.probabilities["0"] = -0.01;
    },
  ],
  [
    "noul",
    "missing advanced rating",
    (p: any) => {
      delete p.rating;
    },
  ],
  [
    "noul",
    "eight probability bins",
    (p: any) => {
      p.rating.probabilities.pop();
    },
  ],
  [
    "noul",
    "probability array replaced by an object",
    (p: any) => {
      p.rating.probabilities = { ...p.rating.probabilities };
    },
  ],
  [
    "noul",
    "non-numeric probability",
    (p: any) => {
      p.rating.probabilities[0] = "0";
    },
  ],
  [
    "choice",
    "incorrect confidence",
    (p: any) => {
      p.confidence = 0;
    },
  ],
  [
    "score",
    "incorrect legend",
    (p: any) => {
      p.legend["0"] = "fabricated";
    },
  ],
  [
    "noul",
    "incorrect expected rating",
    (p: any) => {
      p.rating.expected_score = 5;
    },
  ],
  [
    "choice",
    "tie array replaced by an object",
    (p: any) => {
      p.ties = { ...p.ties };
    },
  ],
  [
    "choice",
    "missing intrinsic field",
    (p: any) => {
      delete p.scoring;
    },
  ],
] as const)(
  "rejects %s predictions with %s even after report rehashing",
  async (type, _description, mutate) => {
    const f = await fixture();
    mutate(answer(f, type).prediction);
    await f.writeReport("test");
    await expect(verifyNativeRfdtAcceptance(f.artifact)).rejects.toThrow(
      /Native RFDT acceptance:.*quality gates or derived scores/,
    );
  },
);

it("allows numeric roundoff while recomputing answer and summary fields", async () => {
  const f = await fixture();
  const score = answer(f, "score");
  if (score.prediction.type !== "score") throw new Error("Expected score");
  score.prediction.score += 5e-10;
  score.prediction.variance! += 5e-10;
  score.normalized_absolute_error! += 5e-10;
  const noul = answer(f, "noul").prediction;
  if (noul.type !== "noul") throw new Error("Expected Noul");
  noul.rating!.expected_score += 5e-10;
  noul.rating!.entropy += 5e-10;
  f.reports.test!.summary.score.normalized_mae! += 5e-10;
  f.reports.test!.summary.noul.brier! += 5e-10;
  await f.writeReport("test");
  await expect(verifyNativeRfdtAcceptance(f.artifact)).resolves.toBeUndefined();
});

it("accepts native softmax roundtrips with spread scores and underflowed probabilities", async () => {
  const f = await fixture();
  const records = (await loadRfdtQualitySuite()).filter(
    (record) => record.split === "test",
  );
  const original = f.reports.test!;
  const scoreIndex = records.findIndex(
    (record) => record.request.questions[0].type === "score",
  );
  const choiceIndex = records.findIndex(
    (record) => record.request.questions[0].type === "choice",
  );
  let index = 0;
  const report = await evaluateRecords(
    {
      classify: async () => {
        const current = index++;
        const result = original.results[current];
        if (current !== scoreIndex && current !== choiceIndex)
          return {
            model: result.model!,
            answers: Object.fromEntries(
              result.answers.map((answer) => [
                answer.question_id,
                answer.prediction,
              ]),
            ),
            metadata: result.metadata,
            usage: result.usage!,
          };
        const plan = preparePrompt(
          { ...records[current].request, model: f.artifact.id },
          "v2",
        );
        const logits: Logits = Object.fromEntries(
          plan.questions.map((branch) => [
            branch.branch_id,
            Object.fromEntries(
              branch.output_labels.map((label, labelIndex) => [
                label,
                current === scoreIndex
                  ? (labelIndex + 1) / 10
                  : branch.answer_labels[labelIndex] ===
                      (
                        result.answers[0].prediction as Extract<
                          Answer,
                          { type: "choice" }
                        >
                      ).choice
                    ? 0
                    : -1000,
              ]),
            ),
          ]),
        );
        return buildResponse(plan, logits, 3, true, {
          metadata: result.metadata,
        });
      },
    },
    records,
    "v2",
    { modelId: f.artifact.id },
  );
  expect(report.summary.gates.passed).toBe(true);
  const choice = report.results[choiceIndex].answers[0].prediction;
  if (choice.type !== "choice") throw new Error("Expected choice");
  expect(Object.values(choice.probabilities)).toContain(0);
  f.reports.test = { ...report, rfdt: original.rfdt };
  await f.writeReport("test");
  await expect(verifyNativeRfdtAcceptance(f.artifact)).resolves.toBeUndefined();
});

it.each(["gate", "correctness"])(
  "requires boolean %s fields despite numeric tolerance",
  async (field) => {
    const f = await fixture();
    if (field === "gate")
      (f.reports.test!.summary.gates as any).no_failures = 1;
    else (answer(f, "choice") as any).correct = 1;
    await f.writeReport("test");
    await expect(verifyNativeRfdtAcceptance(f.artifact)).rejects.toThrow(
      /quality gates or derived scores/,
    );
  },
);

it("rejects training or validation reuse of reserved groups and state/chat contexts", async () => {
  const suite = await loadRfdtQualitySuite();
  const test = suite.find(
    (record) =>
      record.split === "test" && typeof record.request.state === "string",
  )!;
  const validation = suite.find((record) => record.split === "validation")!;
  await expect(
    assertRfdtQualityIsolation([{ ...test, split: "train" }]),
  ).rejects.toThrow(/reserved quality suite group or context/);
  await expect(
    assertRfdtQualityIsolation([{ ...validation, split: "train" }]),
  ).rejects.toThrow(/reserved quality suite group or context/);
  await expect(
    assertRfdtQualityIsolation([{ ...test, split: "validation" }]),
  ).rejects.toThrow(/reserved quality suite group or context/);
  await expect(
    assertRfdtQualityIsolation([
      {
        group_id: "different-group",
        split: "train",
        request: {
          ...test.request,
          state: undefined,
          messages: [{ role: "user", content: test.request.state as string }],
        },
      },
    ]),
  ).rejects.toThrow(/reserved quality suite group or context/);
  await expect(
    assertRfdtQualityIsolation([
      { ...validation, split: "validation" },
      ...suite.filter((record) => record.split === "train"),
    ]),
  ).resolves.toBeUndefined();
});
