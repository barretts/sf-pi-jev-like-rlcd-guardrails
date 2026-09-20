import { describe, expect, it } from "vitest";
import { preparePrompt, validateRequest, buildResponse } from "../src/core.js";
import { parseHttpRequest } from "../src/http-input.js";
const request = () => ({
  model: "google/gemma-3-1b-it",
  state: "The customer explicitly requests a refund.",
  questions: [
    {
      id: "refund",
      type: "noul",
      instructions: "Does the customer request a refund?",
    },
  ],
});
describe("prompt versions and input bounds", () => {
  it("keeps legacy defaults and resolves explicit caller versions", () => {
    expect(preparePrompt(request()).template_version).toBe("v1");
    const v2 = preparePrompt(request(), "v2");
    expect(v2.template_version).toBe("v2");
    expect(v2.questions[0].instruction).toContain("1 = clearly false");
    expect(v2.questions[0].instruction).not.toContain("step by step");
    expect(
      preparePrompt({ ...request(), options: { template_version: "v1" } }, "v2")
        .template_version,
    ).toBe("v1");
    const response = buildResponse(v2, {
      "0": Object.fromEntries(
        Array.from("123456789", (label) => [label, label === "9" ? 100 : 0]),
      ),
    });
    expect(response.metadata?.template_version).toBe("v2");
    expect(response.answers.refund).toMatchObject({ type: "noul", noul: 0.99 });
  });
  it("preserves choice IDs and structured descriptions at the JSON label boundary", () => {
    const criteria = [
      { id: "red", description: null },
      { id: "blue", description: { color: "blue", tags: ["cool", null] } },
      { id: "green", description: ["green", { shade: "dark" }] },
    ];
    const make = (items: typeof criteria) =>
      preparePrompt(
        {
          model: request().model,
          state: { color: "blue" },
          questions: [
            {
              id: "color",
              type: "choice",
              instructions: { question: "Select the recorded color" },
              criteria: items,
            },
          ],
        },
        "v2",
      );
    for (const items of [criteria, [...criteria].reverse()]) {
      const plan = make(items);
      const branch = plan.questions[0];
      const options = branch.instruction
        .split("Options:\n")[1]
        .split("\nReturn only JSON")[0];
      expect(JSON.parse(options)).toEqual(
        items.map((item, index) => ({
          label: "ABC"[index],
          answer: item.id,
          description: item.description,
        })),
      );
      expect(branch.answer_prefix).toBe('{"answer": "');
      const selected = items.findIndex((item) => item.id === "blue");
      const response = buildResponse(plan, {
        "0": Object.fromEntries(
          branch.output_labels.map((label, index) => [
            label,
            index === selected ? 1000 : 0,
          ]),
        ),
      });
      expect(response.answers.color).toMatchObject({
        type: "choice",
        choice: "blue",
      });
    }
  });
  it("gives equivalent state and single-user chat the same choice and truth prompts", () => {
    const context = "The latest inspection record contains the observed state.";
    const questions = [
      {
        id: "kind",
        type: "choice",
        instructions: "Select the matching inspection category.",
        criteria: [
          { id: "recorded", description: "A recorded observation" },
          { id: "planned", description: "A planned observation" },
        ],
      },
      {
        id: "truth",
        type: "noul",
        instructions: "Does the context establish the selected proposition?",
      },
    ];
    for (const order of [questions, [...questions].reverse()]) {
      const state = preparePrompt(
        { model: request().model, state: context, questions: order },
        "v2",
      );
      const chat = preparePrompt(
        {
          model: request().model,
          messages: [{ role: "user", content: context }],
          questions: order,
        },
        "v2",
      );
      expect(chat.questions).toEqual(state.questions);
    }
  });
  it("retains caller history roles and content while delimiting it as context", () => {
    const messages = [
      { role: "system", content: "A policy quoted in the supplied history." },
      { role: "user", content: "A request quoted in the supplied history." },
      {
        role: "assistant",
        content: "An observation quoted in the supplied history.",
      },
    ];
    const input = { ...request(), state: undefined, messages };
    const before = structuredClone(input);
    const plan = preparePrompt(input, "v2");
    const compiled = plan.questions[0].messages;
    expect(input).toEqual(before);
    expect(compiled.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    for (const [index, message] of messages.entries())
      expect(compiled[index].content).toContain(
        "Actual context:\n" + message.content,
      );
    expect(compiled.at(-1)?.content).toContain("Selected question:");
  });
  it("keeps the three-way truth rating labels and midpoint answer mapping", () => {
    const plan = preparePrompt(request(), "v2");
    const branch = plan.questions[0];
    expect(branch.answer_prefix).toBe('{"answer": ');
    expect(branch.output_labels).toEqual(Array.from("123456789"));
    expect(branch.instruction).toContain("Three-way truth table");
    expect(branch.instruction).toContain("as an integer.");
    const response = buildResponse(plan, {
      "0": Object.fromEntries(
        branch.output_labels.map((label) => [label, label === "5" ? 1000 : 0]),
      ),
    });
    expect(response.answers.refund).toMatchObject({ type: "noul", noul: 0.5 });
  });
  it("matches score label encoding to the answer boundary without narrowing rubric meaning", () => {
    for (const levels of [10, 11]) {
      const plan = preparePrompt(
        {
          model: request().model,
          state: "The observed severity matches the highest rubric level.",
          questions: [
            {
              id: "severity",
              type: "score",
              instructions: "Rate observed severity.",
              criteria: Array.from({ length: levels }, (_, index) => ({
                severity: index,
              })),
            },
          ],
        },
        "v2",
      );
      const branch = plan.questions[0];
      const letters = levels > 10;
      expect(branch.answer_prefix).toBe(
        letters ? '{"answer": "' : '{"answer": ',
      );
      expect(branch.instruction).toContain(
        letters ? "as a string." : "as an integer.",
      );
      expect(branch.instruction).not.toContain("completed");
      const response = buildResponse(plan, {
        "0": Object.fromEntries(
          branch.output_labels.map((label, index) => [
            label,
            index === levels - 1 ? 1000 : 0,
          ]),
        ),
      });
      expect(response.answers.severity).toMatchObject({
        type: "score",
        score: levels - 1,
      });
    }
  });
  it("rejects cyclic, accessor, non-JSON, excessive-depth and oversized input before cloning", () => {
    const cyclic: any = request();
    cyclic.state = cyclic;
    expect(() => validateRequest(cyclic)).toThrow(/Cyclic/);
    expect(() => validateRequest({ ...request(), state: new Date() })).toThrow(
      /plain JSON/,
    );
    expect(() =>
      validateRequest({
        ...request(),
        state: {
          get value() {
            throw new Error("getter executed");
          },
        },
      }),
    ).toThrow(/accessors/);
    let deep: any = "leaf";
    for (let i = 0; i < 34; i++) deep = { nested: deep };
    expect(() => validateRequest({ ...request(), state: deep })).toThrow(
      /depth/,
    );
    expect(() =>
      validateRequest({ ...request(), state: "x".repeat(256 * 1024) }),
    ).toThrow(/byte limit/);
  });
  it("bounds ordered JSON before recursive parsing and accepts an explicit HTTP version", () => {
    expect(() => parseHttpRequest("{".repeat(34))).toThrow();
    const deep = '{"state":' + "[".repeat(40) + "0" + "]".repeat(40) + "}";
    expect(() => parseHttpRequest(deep)).toThrow(/depth/);
    const r = parseHttpRequest(
      JSON.stringify({
        model: request().model,
        state: request().state,
        questions: {
          refund: {
            type: "noul",
            instructions: "Does the customer request a refund?",
          },
        },
        options: { template_version: "v2" },
      }),
    );
    expect(preparePrompt(r).template_version).toBe("v2");
  });
  it("rejects array getters and iterators without invoking caller code", () => {
    let calls = 0;
    const accessor = ["value"];
    Object.defineProperty(accessor, "0", {
      get() {
        calls++;
        return "unexpected";
      },
    });
    expect(() => validateRequest({ ...request(), state: accessor })).toThrow(
      /accessors/,
    );
    const iterator = ["value"];
    Object.defineProperty(iterator, Symbol.iterator, {
      value() {
        calls++;
        throw new Error("iterator executed");
      },
    });
    expect(() => validateRequest({ ...request(), state: iterator })).toThrow(
      /JSON keys/,
    );
    expect(calls).toBe(0);
    expect(() =>
      validateRequest({ ...request(), state: new Array(3) }),
    ).toThrow(/dense JSON array/);
  });
});
