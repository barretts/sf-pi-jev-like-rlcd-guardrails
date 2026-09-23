import { describe, expect, it } from "vitest";
import { canonical, preparePrompt, buildResponse } from "../src/core.js";
import { guardrailRequest } from "../src/guardrail.js";
import { C11 } from "../src/guardrail-selection.js";

const request = () =>
  guardrailRequest(
    {
      version: 2,
      toolName: "bash",
      input: { command: "git status --short" },
      facts: {},
    },
    C11.modelId,
  );

describe("guardrail prompt and logit contract", () => {
  it("canonicalizes fact and operation keys deterministically while preserving array order", () => {
    expect(canonical({ "10": 1, "2": 2, é: "猫", a: [true, null] })).toBe(
      '{"10":1,"2":2,"a":[true,null],"é":"猫"}',
    );
    expect(canonical({ facts: {}, input: { command: "git status" } })).toBe(
      canonical({ input: { command: "git status" }, facts: {} }),
    );
    expect(canonical(["production", "sandbox"])).not.toBe(
      canonical(["sandbox", "production"]),
    );
  });

  it("keeps allow/confirm in their selected-token order and uses the v2 answer boundary", () => {
    const plan = preparePrompt(request());
    expect(plan.template_version).toBe("v2");
    expect(plan.questions).toHaveLength(1);
    expect(plan.questions[0].answer_labels).toEqual(["allow", "confirm"]);
    expect(plan.questions[0].output_labels).toEqual(["A", "B"]);
    expect(plan.questions[0].answer_prefix).toBe('{"answer": "');
  });

  it.each(["score", "noul"])("rejects the removed %s question mode", (type) => {
    const input = request();
    (input.questions[0] as any).type = type;
    expect(() => preparePrompt(input)).toThrow("Unsupported question type");
  });

  it("rejects removed chat requests and mixed state/chat requests", () => {
    const input = request();
    const messages = [{ role: "user", content: "git status --short" }];
    expect(() => preparePrompt({ ...input, messages })).toThrow(
      "Unknown field",
    );
    const { state, ...withoutState } = input;
    expect(state).toBeDefined();
    expect(() => preparePrompt({ ...withoutState, messages })).toThrow(
      "Unknown field",
    );
    expect(() => preparePrompt(withoutState)).toThrow("Provide state");
  });

  it("rejects v1 and removed reserved fields instead of ignoring them", () => {
    const input = request();
    expect(() => preparePrompt(input, "v1" as any)).toThrow(
      "Unsupported template version",
    );
    expect(() =>
      preparePrompt({
        ...input,
        options: { template_version: "v1" },
      }),
    ).toThrow("Unsupported template version");
    for (const field of ["tools", "mm_processor_kwargs", "media_io_kwargs"])
      expect(() => preparePrompt({ ...input, [field]: [] })).toThrow(
        "Unknown field",
      );
  });

  it("maps stable selected logits to risk labels and produces no generated output tokens", () => {
    const plan = preparePrompt(request(), "v2");
    const response = buildResponse(plan, { "0": { A: 10000, B: -10000 } }, 100);
    expect(response.model).toBe(C11.modelId);
    expect(response.answers.risk).toMatchObject({
      type: "choice",
      choice: "allow",
      probabilities: { allow: 1, confirm: 0 },
    });
    expect(response.usage).toEqual({ input_tokens: 100, output_tokens: 0 });
  });

  it("keeps the first selected label for exact ties and supports the confirm winner", () => {
    const plan = preparePrompt(request(), "v2");
    expect(
      buildResponse(plan, { "0": { A: 10000, B: 10000 } }).answers.risk,
    ).toMatchObject({
      choice: "allow",
      probabilities: { allow: 0.5, confirm: 0.5 },
    });
    expect(
      buildResponse(plan, { "0": { A: -10000, B: 10000 } }).answers.risk,
    ).toMatchObject({
      choice: "confirm",
      probabilities: { allow: 0, confirm: 1 },
    });
  });

  it("rejects incomplete, extra, and nonfinite selected logits", () => {
    const plan = preparePrompt(request(), "v2");
    for (const row of [{ A: NaN, B: 0 }, { A: 0 }, { A: 0, B: 0, C: 0 }])
      expect(() => buildResponse(plan, { "0": row } as any)).toThrow();
  });
});
