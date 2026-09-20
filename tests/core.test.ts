import { describe, it, expect } from "vitest";
import {
  canonical,
  preparePrompt,
  buildResponse,
  validateRequest,
  InvalidRequest,
} from "../src/core.js";
import { parseHttpRequest } from "../src/http-input.js";
const choice = {
  id: "color",
  type: "choice",
  instructions: "Color?",
  criteria: [
    { id: "red", description: null },
    { id: "blue", description: null },
  ],
} as const;
const request = () => ({
  model: "gemma",
  state: "A red bicycle.",
  questions: structuredClone([choice]),
});
describe("request contract", () => {
  it("preserves numeric-looking lexical IDs and candidates", () => {
    const r = parseHttpRequest(
      '{"model":"gemma","state":"","questions":{"10":{"type":"choice","instructions":null,"criteria":{"10":null,"2":null}},"2":{"type":"noul","instructions":null}}}',
    );
    expect(r.questions.map((q) => q.id)).toEqual(["10", "2"]);
    const p = preparePrompt(r);
    expect(p.questions[0].answer_labels).toEqual(["10", "2"]);
  });
  it.each(["", "{}", "[]"])("accepts empty state %s", (s) =>
    expect(() =>
      parseHttpRequest(
        `{"model":"gemma","state":${s === "" ? '""' : s},"questions":{"x":{"type":"noul","instructions":null}}}`,
      ),
    ).not.toThrow(),
  );
  it("ignores completion controls but rejects nested misspellings", () => {
    expect(
      validateRequest({ ...request(), stream: true }).questions,
    ).toHaveLength(1);
    expect(() =>
      validateRequest({ ...request(), options: { temperature: 1 } }),
    ).toThrow("Unknown field");
  });
  it("rejects duplicate IDs, unsupported message data, missing instructions and bad criteria", () => {
    for (const value of [
      { ...request(), questions: [choice, choice] },
      { ...request(), state: null, messages: [{ role: "tool", content: "x" }] },
      {
        ...request(),
        state: null,
        messages: [{ role: "user", content: "x", name: "n" }],
      },
      { ...request(), questions: [{ ...choice, instructions: undefined }] },
      {
        ...request(),
        questions: [{ ...choice, criteria: [choice.criteria[0]] }],
      },
      { ...request(), state: 42 },
      { ...request(), state: null },
      { ...request(), messages: [{ role: "user", content: "x" }] },
    ])
      expect(() => validateRequest(value)).toThrow(InvalidRequest);
  });
  it("rejects duplicate JSON keys and malformed JSON", () => {
    expect(() => parseHttpRequest('{"model":"a","model":"b"}')).toThrow();
    expect(() => parseHttpRequest("{bad")).toThrow();
  });
  it("rejects nonfinite nested data", () =>
    expect(() =>
      validateRequest({ ...request(), state: { bad: Infinity } }),
    ).toThrow());
  it("canonicalizes numeric keys lexically and unicode by codepoint", () =>
    expect(canonical({ "10": 1, "2": 2, é: "猫", a: [true, null] })).toBe(
      '{"10":1,"2":2,"a":[true,null],"é":"猫"}',
    ));
});
describe("prompt and scoring contract", () => {
  it("quotes state and keeps incomplete answer prefix", () => {
    const p = preparePrompt(request());
    expect(p.questions[0].messages[1].content).toContain(
      'State:\n"A red bicycle."\n\n',
    );
    expect(p.questions[0].answer_prefix).toBe('{"answer": "');
    expect(p.system_prompt_prefix.endsWith('Answer: {"answer": 1}')).toBe(true);
  });
  it("merges initial system with exactly one extra LF", () => {
    const p = preparePrompt({
      ...request(),
      state: null,
      messages: [
        { role: "system", content: "extra" },
        { role: "user", content: "history" },
      ],
    });
    expect(p.questions[0].messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "user",
    ]);
    expect(p.questions[0].messages[0].content.endsWith("\n\nextra")).toBe(true);
  });
  it.each([2, 10, 11, 50])("maps %i score levels", (n) => {
    const p = preparePrompt({
      ...request(),
      questions: [
        {
          id: "s",
          type: "score",
          instructions: null,
          criteria: Array(n).fill(null),
        },
      ],
    });
    expect(p.questions[0].output_labels[0]).toBe(n > 10 ? "A" : "0");
    expect(p.questions[0].answer_labels.at(-1)).toBe(String(n - 1));
  });
  it("uses stable softmax and first candidate for exact ties", () => {
    const p = preparePrompt(request());
    const a = buildResponse(p, { "0": { A: 10000, B: 10000 } }).answers.color;
    expect(a.choice).toBe("red");
    expect(a.confidence).toBe(0.5);
    expect(
      buildResponse(p, { "0": { A: 10000, B: -10000 } }).answers.color
        .confidence,
    ).toBe(1);
  });
  it("gates raw logits without altering answers", () => {
    const p = preparePrompt({ ...request(), options: { raw_logits: true } });
    const row = { "0": { A: 3, B: 1 } };
    expect(buildResponse(p, row).answers.color.logits).toBeUndefined();
    expect(buildResponse(p, row, 0, true).answers.color.logits).toEqual({
      red: 3,
      blue: 1,
    });
  });
  it("handles prototype-shaped IDs without mutation", () => {
    const r = request();
    r.questions = [
      {
        ...choice,
        id: "__proto__",
        criteria: [
          { id: "__proto__", description: null },
          { id: "constructor", description: null },
        ],
      },
    ] as any;
    const a = buildResponse(preparePrompt(r), { "0": { A: 0, B: 0 } }).answers;
    expect(Object.hasOwn(a, "__proto__")).toBe(true);
    expect(a.__proto__.choice).toBe("__proto__");
  });
  it("rejects missing, extra and nonfinite logits", () => {
    const p = preparePrompt(request());
    for (const row of [{ A: NaN, B: 0 }, { A: 0 }, { A: 0, B: 0, C: 0 }])
      expect(() => buildResponse(p, { "0": row } as any)).toThrow();
  });
  it("maps uniform Noul to midpoint and endpoint mass correctly", () => {
    const p = preparePrompt({
      ...request(),
      questions: [{ id: "n", type: "noul", instructions: null }],
    });
    for (const [winner, target] of [
      [null, 0.5],
      ["1", 0.01],
      ["9", 0.99],
    ] as const) {
      const row = Object.fromEntries(
        p.questions[0].output_labels.map((l) => [
          l,
          winner === null ? 0 : l === winner ? 0 : -1000,
        ]),
      );
      expect(buildResponse(p, { "0": row }).answers.n.noul).toBeCloseTo(
        target,
        12,
      );
    }
  });
});
