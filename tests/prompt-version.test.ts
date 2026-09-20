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
