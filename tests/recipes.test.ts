import { describe, expect, it } from "vitest";
import {
  buildDeveloperRecipeRequest,
  formatDeveloperRecipeResult,
  renderDeveloperRecipeResult,
  type DeveloperRecipeInput,
} from "../src/recipes.js";
import { buildResponse, preparePrompt } from "../src/core.js";

const input: DeveloperRecipeInput = {
  task: "Diagnose the build failure before suggesting a repair.",
  evidence: {
    command: "tsc --noEmit",
    exit_code: 2,
    diagnostic:
      "src/task.ts(12,5): TS2322: Type 'string' is not assignable to type 'number'.",
  },
};

function response(value = input, winners = [0, 2, 4]) {
  const plan = preparePrompt(buildDeveloperRecipeRequest(value));
  const logits = Object.fromEntries(
    plan.questions.map((question, index) => [
      question.branch_id,
      Object.fromEntries(
        question.output_labels.map((label, candidate) => [
          label,
          candidate === winners[index] ? 0 : -1000,
        ]),
      ),
    ]),
  );
  return buildResponse(plan, logits, 321, true, {
    metadata: { model_revision: "fixture", artifact: { sha256: "fixture" } },
    metrics: { computed_prompt_tokens: 341, engine_forwards: 2 },
  });
}

describe("developer recipe", () => {
  it("uses all three existing answer types with an explicit unknown and multiple-cause option", () => {
    const request = buildDeveloperRecipeRequest(input);
    expect(request.options).toEqual({ template_version: "v2" });
    expect(request.questions.map((question) => question.type)).toEqual([
      "choice",
      "score",
      "noul",
    ]);
    const diagnosis = request.questions[0];
    expect(
      diagnosis.type === "choice" &&
        diagnosis.criteria.map((candidate) => candidate.id),
    ).toEqual([
      "type-contract",
      "async-lifecycle",
      "iteration-boundary",
      "configuration",
      "test-expectation",
      "insufficient-evidence",
      "multiple-causes",
    ]);
    expect(request.state).toEqual({
      user_task: input.task,
      evidence: input.evidence,
    });
  });

  it("preserves curated candidate order and text evidence without mutating the caller", () => {
    const value = {
      task: "Select the relevant inspection.",
      evidence: "A failed assertion at the empty-input boundary.",
      candidates: [
        { id: "inspect-end", description: "Inspect the final loop index." },
        { id: "insufficient-evidence", description: null },
      ],
    };
    const original = structuredClone(value);
    const request = buildDeveloperRecipeRequest(value, "google/gemma-3-4b-it");
    expect(request.model).toBe("google/gemma-3-4b-it");
    expect(request.questions[0]).toMatchObject({ criteria: value.candidates });
    (request.state as any).evidence = "changed";
    expect(value).toEqual(original);
  });

  it("requires observed original-case reruns for the repair proposition and preserves unknown", () => {
    const value: DeveloperRecipeInput = {
      task: "Assess whether the original failure was fixed.",
      evidence: { patch_proposed: true, rerun: null },
      proposition: {
        kind: "verified_repair",
        statement: "The original failing test passed after the patch.",
      },
    };
    const request = buildDeveloperRecipeRequest(value);
    expect(request.questions[2].instructions).toContain(
      "Missing observations are unknown rather than false",
    );
    expect(request.questions[2].instructions).toContain(
      "successful rerun covering the original failing case",
    );
    const rendered = renderDeveloperRecipeResult(value, response(value));
    expect(rendered.evidence_status).toMatchObject({
      kind: "verified_repair",
      estimate: 0.5,
      unknown_reference: 0.5,
      interpretation: "uncalibrated estimate; not verification",
    });
    expect(rendered).not.toHaveProperty("verified");
    expect(rendered).not.toHaveProperty("execute");
  });

  it("retains actual numerical answers, raw distributions, metadata, and zero-output usage", () => {
    const result = response();
    const original = structuredClone(result);
    const rendered = renderDeveloperRecipeResult(input, result);
    expect(rendered.answers).toEqual(result.answers);
    expect(rendered.metadata).toEqual(result.metadata);
    expect(rendered.metrics).toEqual(result.metrics);
    expect(rendered.usage).toEqual({ input_tokens: 321, output_tokens: 0 });
    expect(rendered.evidence_sufficiency.estimate).toBe(2);
    expect(rendered.diagnosis.candidate).toBe("type-contract");
    expect(rendered.calibrated).toBe(false);
    expect(JSON.parse(formatDeveloperRecipeResult(rendered))).toMatchObject({
      model: result.model,
      answers: {
        diagnosis: { type: "choice", choice: "type-contract" },
        evidence_sufficiency: { type: "score", score: 2 },
        evidence_status: { type: "noul", noul: 0.5 },
      },
      provenance: rendered.provenance,
      metrics: result.metrics,
    });
    rendered.answers.diagnosis = { type: "noul", noul: 0.01 };
    expect(result).toEqual(original);
  });

  it("renders the expected ordinal score rather than replacing it with the most likely rubric level", () => {
    const plan = preparePrompt(buildDeveloperRecipeRequest(input));
    const logits = Object.fromEntries(
      plan.questions.map((question, index) => [
        question.branch_id,
        Object.fromEntries(
          question.output_labels.map((label, candidate) => [
            label,
            index === 1 ? Math.log([0.1, 0.2, 0.7][candidate]) : 0,
          ]),
        ),
      ]),
    );
    const actual = buildResponse(plan, logits, 321, true);
    const rendered = renderDeveloperRecipeResult(input, actual);
    expect(rendered.evidence_sufficiency.estimate).toBeCloseTo(1.6, 12);
    expect(
      JSON.parse(formatDeveloperRecipeResult(rendered)).answers
        .evidence_sufficiency.score,
    ).toBe(rendered.evidence_sufficiency.estimate);
    expect(rendered.evidence_sufficiency.estimate).not.toBe(2);
  });

  it("binds provenance to evidence, task, candidate order, proposition, and model", () => {
    const render = (
      value: DeveloperRecipeInput,
      model = "google/gemma-3-1b-it",
    ) =>
      renderDeveloperRecipeResult(value, { ...response(value), model })
        .provenance;
    const first = render(input);
    expect(first.request_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(render(structuredClone(input))).toEqual(first);
    expect(
      render({
        ...input,
        evidence: { ...(input.evidence as object), exit_code: 0 },
      }).evidence_sha256,
    ).not.toBe(first.evidence_sha256);
    expect(
      render({ ...input, task: "Different task" }).request_sha256,
    ).not.toBe(first.request_sha256);
    expect(render(input, "google/gemma-3-4b-it").request_sha256).not.toBe(
      first.request_sha256,
    );
    const candidates = [
      { id: "one", description: "One cause" },
      { id: "two", description: "Another cause" },
    ];
    expect(render({ ...input, candidates }).request_sha256).not.toBe(
      render({ ...input, candidates: candidates.slice().reverse() })
        .request_sha256,
    );
    expect(
      render({
        ...input,
        proposition: {
          kind: "verified_repair",
          statement: "The original case passed after repair.",
        },
      }).request_sha256,
    ).not.toBe(first.request_sha256);
  });

  it("rejects unsafe or malformed evidence before invoking its accessors", () => {
    let invoked = false;
    const evidence = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        invoked = true;
        return "value";
      },
    });
    expect(() => buildDeveloperRecipeRequest({ ...input, evidence })).toThrow(
      "accessors",
    );
    expect(invoked).toBe(false);
    for (const value of [
      { ...input, task: " " },
      { ...input, evidence: Infinity },
      { ...input, extra: true },
      {
        ...input,
        candidates: [
          { id: "same", description: null },
          { id: "same", description: null },
        ],
      },
      { ...input, proposition: { kind: "verified_repair", statement: "" } },
    ])
      expect(() =>
        buildDeveloperRecipeRequest(value as DeveloperRecipeInput),
      ).toThrow();
  });

  it("does not render a fabricated candidate, mismatched template, missing answer, or invalid estimate", () => {
    const result = response();
    for (const candidate of [
      {
        ...result,
        answers: {
          ...result.answers,
          diagnosis: { ...result.answers.diagnosis, choice: "invented" },
        },
      },
      { ...result, metadata: { ...result.metadata, template_version: "v1" } },
      { ...result, metadata: undefined },
      { ...result, model: "" },
      { ...result, answers: { ...result.answers, evidence_status: undefined } },
      {
        ...result,
        answers: {
          ...result.answers,
          evidence_status: { type: "noul", noul: 1 },
        },
      },
    ])
      expect(() =>
        renderDeveloperRecipeResult(input, candidate as any),
      ).toThrow();
  });
});
