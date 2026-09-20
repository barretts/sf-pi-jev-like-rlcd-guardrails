import { it, expect } from "vitest";
import fixtures from "./python-fixtures.json";
import { parseHttpRequest } from "../src/http-input.js";
import { preparePrompt, buildResponse } from "../src/core.js";
function compare(actual: any, expected: any, path = "root") {
  if (typeof expected === "number") {
    expect(Math.abs(actual - expected), path).toBeLessThanOrEqual(1e-6);
  } else if (Array.isArray(expected)) {
    expect(actual.length, path).toBe(expected.length);
    expected.forEach((v, i) => compare(actual[i], v, path + "." + i));
  } else if (expected && typeof expected === "object") {
    expect(Object.keys(actual).sort(), path).toEqual(
      Object.keys(expected).sort(),
    );
    for (const k of Object.keys(expected))
      compare(actual[k], expected[k], path + "." + k);
  } else expect(actual, path).toEqual(expected);
}
for (const [i, f] of fixtures.cases.entries())
  it(`matches Python baseline prompt and scoring fixture ${i}`, () => {
    const p = preparePrompt(parseHttpRequest(f.request_json));
    expect(p.system_prompt_prefix).toBe(f.plan.system_prompt_prefix);
    expect(p.prefix_instruction).toBe(f.plan.prefix_instruction);
    expect(p.suffix_instruction).toBe(f.plan.suffix_instruction);
    expect(p.questions.map(({ messages, ...q }) => q)).toEqual(
      f.plan.questions,
    );
    const r = buildResponse(p, f.logits as any, 123, true);
    compare(r.answers, f.response.answers);
    compare(r.usage, f.response.usage);
  });
