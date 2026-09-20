import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonical, validateRequest } from "../dist/core.js";
import { loadQualityRecords } from "../dist/evaluation.js";
import { jsonWireRequest } from "../scripts/developer-decision-eval.mjs";

const model = "google/gemma-3-1b-it";
const questions = [
  {
    id: "score",
    type: "score",
    instructions: { rubric: "Assess observed coverage", weight: 1.25 },
    criteria: [
      "Absent",
      { level: "Partial", threshold: -2.5 },
      ["Complete", null],
    ],
  },
  {
    id: "choice",
    type: "choice",
    instructions: "Select the recorded category.",
    criteria: [
      { id: "2", description: null },
      { id: "10", description: { category: "second", weights: [0, 0.5, 2] } },
    ],
  },
];
const hash = (request) =>
  createHash("sha256").update(canonical(request)).digest("hex");

test("loader-normalized state and chat requests hash exactly the outgoing finite JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-decision-wire-"));
  try {
    const fixtures = [
      {
        id: "state",
        group_id: "state-group",
        split: "validation",
        request: {
          model,
          state: {
            count: 2,
            ratio: 0.125,
            present: false,
            nested: [null, -3.5],
          },
          questions,
          options: { raw_logits: false, template_version: "v2" },
        },
        targets: { score: { answer: 1.25 }, choice: { answer: "10" } },
      },
      {
        id: "chat",
        group_id: "chat-group",
        split: "validation",
        request: {
          model,
          messages: [
            { role: "system", content: "Preserve the original policy text." },
            { role: "user", content: "First observation." },
            { role: "assistant", content: "Recorded observation." },
            { role: "user", content: 'Second observation.\n"Quoted text"' },
          ],
          questions: [...questions].reverse(),
        },
        targets: { score: { answer: 1.25 }, choice: { answer: "10" } },
      },
    ];
    const path = join(directory, "quality.jsonl");
    await writeFile(
      path,
      fixtures.map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    const records = await loadQualityRecords(path);
    for (const [index, record] of records.entries()) {
      const original = structuredClone(record.request);
      assert.throws(
        () => canonical(record.request),
        /Expected finite JSON value/,
      );
      const wire = jsonWireRequest(record.request);
      assert.deepEqual(wire, fixtures[index].request);
      assert.deepEqual(
        record.request,
        original,
        "Wire conversion must not mutate loader output",
      );
      const outgoing = JSON.parse(JSON.stringify(wire));
      assert.deepEqual(outgoing, wire);
      assert.equal(hash(wire), hash(outgoing));
      assert.equal(
        hash(jsonWireRequest(validateRequest(outgoing))),
        hash(wire),
        "Captured-request replay must use the same wire identity",
      );
      assert.equal(
        Object.hasOwn(wire, index === 0 ? "messages" : "state"),
        false,
      );
    }
    const attempt = jsonWireRequest({
      ...records[1].request,
      model,
      options: { ...records[1].request.options, template_version: "v2" },
    });
    assert.deepEqual(attempt.messages, fixtures[1].request.messages);
    assert.deepEqual(attempt.questions, fixtures[1].request.questions);
    assert.deepEqual(attempt.options, { template_version: "v2" });
    assert.equal(hash(attempt), hash(JSON.parse(JSON.stringify(attempt))));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("wire conversion rejects non-finite request data before JSON can replace it", () => {
  for (const invalid of [NaN, Infinity, -Infinity])
    assert.throws(
      () => jsonWireRequest({ model, state: { invalid }, questions }),
      /finite JSON number/,
    );
});
