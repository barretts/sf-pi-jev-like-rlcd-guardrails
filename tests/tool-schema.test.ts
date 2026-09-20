import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { validateToolArguments } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/validation.js";
import { ToolSchema } from "../src/extension.js";
import { validateRequest } from "../src/core.js";

// The original public tool contract, frozen independently of the compact form.
const originalJson = Type.Cyclic(
  {
    Json: Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String(),
      Type.Array(Type.Ref("Json")),
      Type.Record(Type.String(), Type.Ref("Json")),
    ]),
  },
  "Json",
);
const originalEntry = Type.Union([
  Type.Null(),
  Type.String(),
  Type.Array(originalJson),
  Type.Record(Type.String(), originalJson),
]);
const common = {
  id: Type.String({ minLength: 1 }),
  instructions: originalEntry,
};
const originalTool = Type.Object(
  {
    state: Type.Optional(originalEntry),
    messages: Type.Optional(
      Type.Union([
        Type.Null(),
        Type.Array(
          Type.Object(
            {
              role: Type.Union(
                ["system", "developer", "user", "assistant"].map((role) =>
                  Type.Literal(role),
                ),
              ),
              content: Type.String(),
            },
            { additionalProperties: false },
          ),
          { minItems: 1 },
        ),
      ]),
    ),
    questions: Type.Array(
      Type.Union([
        Type.Object(
          {
            ...common,
            type: Type.Literal("choice"),
            criteria: Type.Array(
              Type.Object(
                { id: Type.String(), description: originalEntry },
                { additionalProperties: false },
              ),
              { minItems: 2, maxItems: 50 },
            ),
          },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            ...common,
            type: Type.Literal("score"),
            criteria: Type.Array(originalEntry, {
              minItems: 2,
              maxItems: 50,
            }),
          },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            ...common,
            type: Type.Literal("noul"),
            criteria: Type.Optional(
              Type.Union([
                Type.Null(),
                Type.Object(
                  {
                    true: Type.Optional(originalEntry),
                    false: Type.Optional(originalEntry),
                  },
                  { additionalProperties: false },
                ),
              ]),
            ),
          },
          { additionalProperties: false },
        ),
      ]),
      { minItems: 1, maxItems: 256 },
    ),
    options: Type.Optional(
      Type.Object(
        {
          raw_logits: Type.Optional(Type.Boolean()),
          template_version: Type.Optional(
            Type.Union([Type.Literal("v1"), Type.Literal("v2")]),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

function choice(): any {
  return {
    state: "source",
    questions: [
      {
        id: "q",
        type: "choice",
        instructions: "route",
        criteria: [
          { id: "a", description: "A" },
          { id: "b", description: "B" },
        ],
      },
    ],
  };
}
function score(): any {
  return {
    state: "source",
    questions: [
      {
        id: "s",
        type: "score",
        instructions: "score",
        criteria: ["bad", "good"],
      },
    ],
  };
}
function noul(): any {
  return {
    state: "source",
    questions: [{ id: "n", type: "noul", instructions: "true?" }],
  };
}
function outcome(schema: typeof ToolSchema | typeof originalTool, value: any) {
  try {
    return {
      accepted: true,
      arguments: validateToolArguments(
        { name: "jev_classify", description: "", parameters: schema },
        {
          type: "toolCall",
          id: "schema-test",
          name: "jev_classify",
          arguments: value,
        },
      ),
    };
  } catch (error) {
    return {
      accepted: false,
      error: (error as Error).message.split("\n")[0],
    };
  }
}
function vectors() {
  const inputs: { name: string; value: any }[] = [];
  const add = (name: string, value: any) => inputs.push({ name, value });
  for (const entry of [
    null,
    "",
    [],
    {},
    [null, true, false, 0, 1, -2.5, "text", { a: [1, { b: null }] }],
    { "": "x", nested: { arr: [false, null, 3.25] } },
  ]) {
    const state = choice();
    state.state = entry;
    add(`state:${JSON.stringify(entry)}`, state);
    for (const field of ["instructions", "description"]) {
      const value = choice();
      if (field === "instructions") value.questions[0].instructions = entry;
      else value.questions[0].criteria[0].description = entry;
      add(`${field}:${JSON.stringify(entry)}`, value);
    }
    const rubric = score();
    rubric.questions[0].criteria = [entry, entry];
    add(`score:${JSON.stringify(entry)}`, rubric);
    const truth = noul();
    truth.questions[0].criteria = { true: entry, false: entry };
    add(`noul:${JSON.stringify(entry)}`, truth);
  }
  for (const entry of [true, false, 0, 1, 2, NaN, Infinity, undefined]) {
    for (const field of ["state", "instructions", "description"]) {
      const value = choice();
      if (field === "state") value.state = entry;
      else if (field === "instructions")
        value.questions[0].instructions = entry;
      else value.questions[0].criteria[0].description = entry;
      add(`coercion:${field}:${String(entry)}`, value);
    }
  }
  for (const count of [0, 1, 2, 50, 51]) {
    const rubric = score();
    rubric.questions[0].criteria = Array.from({ length: count }, () => null);
    add(`score-count:${count}`, rubric);
    const candidates = choice();
    candidates.questions[0].criteria = Array.from(
      { length: count },
      (_, i) => ({
        id: String(i),
        description: null,
      }),
    );
    add(`choice-count:${count}`, candidates);
  }
  for (const count of [0, 1, 256, 257]) {
    const value = choice();
    value.questions = Array.from({ length: count }, (_, i) => ({
      ...value.questions[0],
      id: String(i),
    }));
    add(`question-count:${count}`, value);
  }
  for (const options of [
    undefined,
    null,
    {},
    { raw_logits: true },
    { raw_logits: "false" },
    { template_version: "v1" },
    { template_version: "v2" },
    { template_version: null },
    { raw_logits: null },
    { template_version: "v3" },
    { extra: true },
  ]) {
    const value = choice();
    value.options = options;
    add(`options:${JSON.stringify(options)}`, value);
  }
  for (const messages of [
    null,
    [],
    [
      { role: "system", content: "s" },
      { role: "developer", content: "d" },
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
    ],
    [{ role: "tool", content: "bad" }],
    [{ role: "user", content: 0 }],
    [{ role: "user", content: null }],
    [{ role: "user", content: "ok", extra: 1 }],
  ]) {
    const value = choice();
    delete value.state;
    value.messages = messages;
    add(`messages:${JSON.stringify(messages)}`, value);
  }
  for (const field of ["root", "question", "candidate", "options", "noul"]) {
    const value = field === "noul" ? noul() : choice();
    if (field === "root") value.extra = 1;
    else if (field === "question") value.questions[0].extra = 1;
    else if (field === "candidate") value.questions[0].criteria[0].extra = 1;
    else if (field === "options") value.options = { extra: 1 };
    else value.questions[0].criteria = { unknown: "bad" };
    add(`unknown:${field}`, value);
  }
  for (const field of ["id", "instructions", "type", "criteria"]) {
    const value = choice();
    delete value.questions[0][field];
    add(`missing:${field}`, value);
  }
  for (const depth of [30, 32, 34]) {
    let nested: any = "leaf";
    for (let level = 0; level < depth; level++) nested = { nested };
    const value = choice();
    value.state = nested;
    add(`depth:${depth}`, value);
  }
  return inputs;
}

describe("compact tool schema", () => {
  it("reduces serialized schema size while freezing the original contract", () => {
    const original = JSON.stringify(originalTool);
    expect(original.length).toBe(6380);
    expect(createHash("sha256").update(original).digest("hex")).toBe(
      "62b08e0332bb2dc94578f1ba544dbc54e45ec939a6ca385dca4ecd41aef27e22",
    );
    expect(JSON.stringify(ToolSchema).length).toBeLessThan(
      original.length * 0.8,
    );
  });

  it("preserves strict schema acceptance for nested JSON, limits and unknown fields", () => {
    const before = Compile(originalTool),
      after = Compile(ToolSchema);
    const inputs = vectors();
    expect(inputs).toHaveLength(98);
    for (const input of inputs)
      expect(after.Check(input.value), input.name).toBe(
        before.Check(input.value),
      );
    for (const field of ["root", "question", "candidate", "options", "noul"])
      expect(
        after.Check(
          inputs.find((input) => input.name === `unknown:${field}`)!.value,
        ),
      ).toBe(false);
  });

  it("preserves actual pi normalization, conversion and validation outcomes", () => {
    for (const input of vectors())
      expect(outcome(ToolSchema, input.value), input.name).toEqual(
        outcome(originalTool, input.value),
      );
  }, 15000);

  it("retains complete recursive definitions inside each rendered question entry", () => {
    const schema = JSON.parse(JSON.stringify(ToolSchema));
    expect(schema.$defs).toBeUndefined();
    const check = (node: any, inherited: Record<string, any> = {}) => {
      if (!node || typeof node !== "object") return;
      const scope = { ...inherited, ...node.$defs };
      if (typeof node.$ref === "string")
        expect(
          scope[node.$ref],
          `unresolved reference ${node.$ref}`,
        ).toBeDefined();
      for (const value of Object.values(node)) check(value, scope);
    };
    check(schema.properties.questions.items);
    const branch = schema.properties.questions.items.anyOf[0];
    expect(branch.properties.instructions.$defs.Json).toBeDefined();
    expect(branch.properties.instructions.$defs.Entry).toBeDefined();
    expect(branch.properties.instructions.$ref).toBe("Entry");
  });

  it("leaves authoritative request invariants and nesting limits in place", () => {
    const valid = outcome(ToolSchema, choice());
    expect(valid.accepted).toBe(true);
    expect(() =>
      validateRequest({ model: "google/gemma-3-1b-it", ...valid.arguments }),
    ).not.toThrow();
    const duplicates = choice();
    duplicates.questions.push({ ...duplicates.questions[0] });
    const duplicated = outcome(ToolSchema, duplicates);
    expect(duplicated.accepted).toBe(true);
    expect(() =>
      validateRequest({
        model: "google/gemma-3-1b-it",
        ...duplicated.arguments,
      }),
    ).toThrow("Empty or duplicate question ID");
    const deep = outcome(
      ToolSchema,
      vectors().find((input) => input.name === "depth:34")!.value,
    );
    expect(deep.accepted).toBe(true);
    expect(() =>
      validateRequest({ model: "google/gemma-3-1b-it", ...deep.arguments }),
    ).toThrow("Request exceeds nesting depth limit");
  });
});
