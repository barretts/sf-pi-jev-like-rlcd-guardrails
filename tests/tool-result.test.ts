import { expect, it } from "vitest";
import { buildResponse, preparePrompt, type Request } from "../src/core.js";
import {
  compactClassifierToolResult,
  compactClassifierBatchToolResult,
  serializeClassifierToolResult,
  serializeClassifierBatchToolResult,
} from "../src/tool-result.js";

const request: Request = {
  model: "google/gemma-3-1b-it",
  state: "The supplied evidence is incomplete.",
  questions: [
    {
      id: "10",
      type: "choice",
      instructions: "Select a cause.",
      criteria: [
        { id: "__proto__", description: "A cause" },
        { id: "other", description: "Another cause" },
      ],
    },
    {
      id: "2",
      type: "score",
      instructions: "Score support.",
      criteria: ["Unsupported", "Partial", "Supported"],
    },
    {
      id: "status",
      type: "noul",
      instructions: "The repair passed its original failing test.",
    },
  ],
  options: { template_version: "v2" },
};

function actualResponse(
  value = request,
  advanced = true,
  noulLogits?: Record<string, number>,
) {
  const plan = preparePrompt(value);
  return buildResponse(
    plan,
    {
      "0": { A: Math.log(0.6), B: Math.log(0.4) },
      "1": { "0": Math.log(0.1), "1": Math.log(0.2), "2": Math.log(0.7) },
      "2":
        noulLogits ??
        Object.fromEntries(
          Array.from({ length: 9 }, (_, index) => [
            String(index + 1),
            index === 4 ? 0 : -5,
          ]),
        ),
    },
    123,
    advanced,
    {
      metadata: {
        model_revision: "fixture-revision",
        artifact: {
          id: value.model,
          revision: "fixture-revision",
          sha256: "a".repeat(64),
          size: 1234,
          base_model: value.model,
        },
        device: "fixture",
        native_build: {
          commit: "b".repeat(40),
          target: "fixture",
          compiler: "fixture",
        },
      },
      metrics: {
        backend_seconds: 0.1,
        computed_prompt_tokens: 234,
        engine_forwards: 2,
      },
    },
  );
}

it("preserves ordered answer IDs, exact fractional scores, confidence and probability distributions", () => {
  const result = actualResponse();
  const compact = compactClassifierToolResult(request, result);
  expect(compact.answers.map((answer) => answer.id)).toEqual([
    "10",
    "2",
    "status",
  ]);
  expect(compact.answers[0]).toMatchObject({
    type: "choice",
    choice: "__proto__",
    confidence:
      result.answers["10"].type === "choice" && result.answers["10"].confidence,
    probabilities:
      result.answers["10"].type === "choice" &&
      result.answers["10"].probabilities,
  });
  expect(compact.answers[1]).toMatchObject({
    type: "score",
    score: result.answers["2"].type === "score" && result.answers["2"].score,
    range: [0, 2],
    legend: { "0": "Unsupported", "1": "Partial", "2": "Supported" },
  });
  expect(
    compact.answers[1].type === "score" && compact.answers[1].score,
  ).toBeCloseTo(1.6, 12);
  expect(compact.calibrated).toBe(false);
  expect(compact.answers[1]).not.toHaveProperty("scoring");
  expect(compact.answers[1]).not.toHaveProperty("variance");
});

it("retains the Noul distribution so unknown and conflicting evidence remain distinguishable", () => {
  const response = actualResponse();
  const compact = compactClassifierToolResult(request, response);
  expect(compact.answers[2]).toMatchObject({
    type: "noul",
    noul:
      response.answers.status.type === "noul" && response.answers.status.noul,
    scale: { false: 0.01, unknown: 0.5, true: 0.99 },
    rating: response.answers.status.type === "noul" && {
      bins: response.answers.status.rating!.bins,
      probabilities: response.answers.status.rating!.probabilities,
      expected_score: response.answers.status.rating!.expected_score,
    },
  });
  expect(compact.answers[2]).not.toHaveProperty("confidence");
  expect(compact.answers[2]).not.toHaveProperty("verified");
  expect(compact.answers[2]).not.toHaveProperty("rating.entropy");
  const conflicting = actualResponse(
    request,
    true,
    Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [
        String(index + 1),
        index === 0 || index === 8 ? 0 : -1000,
      ]),
    ),
  );
  const conflictingCompact = compactClassifierToolResult(request, conflicting);
  expect(
    conflictingCompact.answers[2].type === "noul" &&
      conflictingCompact.answers[2].noul,
  ).toBeCloseTo(0.5, 12);
  expect(
    compact.answers[2].type === "noul" &&
      compact.answers[2].rating!.probabilities[4],
  ).toBeGreaterThan(0.9);
  expect(
    conflictingCompact.answers[2].type === "noul" &&
      conflictingCompact.answers[2].rating!.probabilities[4],
  ).toBe(0);
});

it("retains requested raw logits and all actual raw answer fields without inventing an absent raw field", () => {
  const value = {
    ...request,
    options: { ...request.options, raw_logits: true },
  };
  for (const advanced of [true, false]) {
    const response = actualResponse(value, advanced);
    const compact = compactClassifierToolResult(value, response);
    for (const answer of compact.answers)
      expect(answer).toMatchObject(response.answers[answer.id]);
    if (advanced) {
      expect(compact.answers[0]).toHaveProperty("logits");
      expect(compact.answers[2]).toHaveProperty("rating.logits");
    } else {
      expect(compact.answers[0]).not.toHaveProperty("logits");
      expect(compact.answers[2]).not.toHaveProperty("rating");
    }
  }
  expect(() =>
    compactClassifierToolResult(
      { ...request, options: { distributions: true } } as any,
      actualResponse(),
    ),
  ).toThrow("Unknown field");
});

it("preserves usage and actual artifact/template/native provenance while omitting execution diagnostics", () => {
  const response = actualResponse();
  const compact = compactClassifierToolResult(request, response);
  expect(compact.usage).toEqual(response.usage);
  expect(compact.provenance).toEqual({
    backend: "llama.cpp",
    device: "fixture",
    model_revision: "fixture-revision",
    template_version: "v2",
    usage_accounting: "unique_token_prefixes_and_engine_leaf_outputs",
    artifact: response.metadata!.artifact,
    native_commit: "b".repeat(40),
  });
  expect(compact).not.toHaveProperty("metrics");
  expect(compact).not.toHaveProperty("metadata.device");
});

it("preserves an actual tie instead of implying a unique supported choice", () => {
  const response = actualResponse();
  const plan = preparePrompt({ ...request, questions: [request.questions[0]] });
  const tied = buildResponse(plan, { "0": { A: 0, B: 0 } }, 10, true);
  const compact = compactClassifierToolResult(request, {
    ...response,
    answers: { ...response.answers, "10": tied.answers["10"] },
  });
  expect(compact.answers[0]).toMatchObject({
    confidence: 0.5,
    choice: "__proto__",
    ties: ["__proto__", "other"],
  });
});

it("does not invent artifact or template identity when optional provenance is absent", () => {
  const response = actualResponse();
  const { metadata: _metadata, ...withoutMetadata } = response;
  const compact = compactClassifierToolResult(
    { ...request, options: undefined },
    withoutMetadata,
  );
  expect(compact.provenance).toEqual({
    backend: null,
    device: null,
    model_revision: null,
    template_version: null,
    usage_accounting: null,
  });
});

it("leaves full details and caller input unchanged and serializes deterministically", () => {
  const response = actualResponse();
  const originalRequest = structuredClone(request);
  const originalResponse = structuredClone(response);
  const first = serializeClassifierToolResult(request, response);
  expect(serializeClassifierToolResult(request, response)).toBe(first);
  const compact = compactClassifierToolResult(request, response);
  compact.answers[0].id = "changed";
  compact.provenance.artifact = null;
  compact.usage.input_tokens = 0;
  if (compact.answers[0].type === "choice")
    compact.answers[0].probabilities.other = 0;
  expect(request).toEqual(originalRequest);
  expect(response).toEqual(originalResponse);
});

it("rejects model, answer-ID, type, template, candidate and score-legend mismatches", () => {
  const response = actualResponse();
  const malformed = [
    { ...response, model: "another-model" },
    {
      ...response,
      answers: { ...response.answers, extra: response.answers.status },
    },
    { ...response, answers: { ...response.answers, "10": undefined } },
    {
      ...response,
      answers: { ...response.answers, "10": { type: "noul", noul: 0.5 } },
    },
    { ...response, metadata: { ...response.metadata, template_version: "v1" } },
    {
      ...response,
      metadata: { ...response.metadata, artifact: { id: "another-model" } },
    },
    {
      ...response,
      answers: {
        ...response.answers,
        "10": { ...response.answers["10"], choice: "invented" },
      },
    },
    {
      ...response,
      answers: {
        ...response.answers,
        "2": { ...response.answers["2"], legend: { "0": "changed" } },
      },
    },
  ];
  for (const result of malformed)
    expect(() => compactClassifierToolResult(request, result as any)).toThrow();
});

it("rejects accessors before execution and malformed probability or usage values", () => {
  let invoked = false;
  const response = actualResponse();
  const accessor = Object.defineProperty({ ...response }, "metadata", {
    enumerable: true,
    get() {
      invoked = true;
      return response.metadata;
    },
  });
  expect(() => compactClassifierToolResult(request, accessor)).toThrow(
    "accessors",
  );
  expect(invoked).toBe(false);
  for (const result of [
    { ...response, usage: { input_tokens: -1, output_tokens: 0 } },
    {
      ...response,
      answers: {
        ...response.answers,
        "10": { ...response.answers["10"], confidence: 0.99 },
      },
    },
    {
      ...response,
      answers: {
        ...response.answers,
        "2": { ...response.answers["2"], score: 2 },
      },
    },
    {
      ...response,
      answers: { ...response.answers, status: { type: "noul", noul: NaN } },
    },
  ])
    expect(() => compactClassifierToolResult(request, result as any)).toThrow();
});

it("shares identical batch provenance once while preserving order, per-record answers, raw fields and logical usage", () => {
  const rawRequest = {
    ...request,
    options: { ...request.options, raw_logits: true },
  };
  const records = [
    { id: "10", request: rawRequest, response: actualResponse(rawRequest) },
    { id: "2", request, response: actualResponse() },
  ];
  const original = structuredClone(records);
  const compact = compactClassifierBatchToolResult(records);
  expect(compact).toMatchObject({
    model: request.model,
    advisory: true,
    calibrated: false,
    usage: { input_tokens: 246, output_tokens: 0 },
  });
  expect(compact.records.map((record) => record.id)).toEqual(["10", "2"]);
  expect(compact.provenance).toEqual(
    compactClassifierToolResult(rawRequest, records[0].response).provenance,
  );
  expect(
    compact.records.every((record) => !Object.hasOwn(record, "provenance")),
  ).toBe(true);
  expect(compact.records[0].answers[0]).toHaveProperty("logits");
  expect(compact.records[0].answers[2]).toHaveProperty("rating.logits");
  expect(compact.records[1].answers[0]).not.toHaveProperty("logits");
  expect(compact.records.map((record) => record.usage.input_tokens)).toEqual([
    123, 123,
  ]);
  expect(serializeClassifierBatchToolResult(records)).toBe(
    JSON.stringify(compact),
  );
  compact.records[0].usage.input_tokens = 0;
  if (compact.records[0].answers[0].type === "choice")
    compact.records[0].answers[0].probabilities.other = 0;
  expect(records).toEqual(original);
});

it("keeps differing device or runtime provenance on each batch record instead of inventing one shared identity", () => {
  const first = actualResponse();
  const second = actualResponse();
  second.metadata!.device = "cpu";
  second.metadata!.native_build = { commit: "c".repeat(40) };
  const compact = compactClassifierBatchToolResult([
    { id: "first", request, response: first },
    { id: "second", request, response: second },
  ]);
  expect(compact).not.toHaveProperty("provenance");
  expect(compact.records[0].provenance).toMatchObject({
    device: "fixture",
    native_commit: "b".repeat(40),
  });
  expect(compact.records[1].provenance).toMatchObject({
    device: "cpu",
    native_commit: "c".repeat(40),
  });
  expect(compact.usage).toEqual({ input_tokens: 246, output_tokens: 0 });
});

it("rejects empty or duplicate batch IDs, mixed models and accessors before invoking them", () => {
  const record = { id: "one", request, response: actualResponse() };
  const otherRequest = { ...request, model: "google/gemma-3-4b-it" };
  for (const records of [
    [],
    [{ ...record, id: " " }],
    [record, record],
    [
      record,
      {
        id: "two",
        request: otherRequest,
        response: actualResponse(otherRequest),
      },
    ],
  ])
    expect(() => compactClassifierBatchToolResult(records)).toThrow();
  let invoked = false;
  const accessor = Object.defineProperty({ ...record }, "id", {
    enumerable: true,
    get() {
      invoked = true;
      return "one";
    },
  });
  expect(() => compactClassifierBatchToolResult([accessor])).toThrow(
    "accessors",
  );
  expect(invoked).toBe(false);
});
