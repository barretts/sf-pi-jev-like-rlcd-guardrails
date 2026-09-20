import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  scoreExactAnswer,
  loadEffectivenessCases,
  summarizeEffectiveness,
} from "../scripts/context-effectiveness.mjs";
test("strict answer scoring rejects coercion, extra fields, prose and missing evidence", () => {
  const gold = { count: 3, state: "failed" };
  for (const answer of [
    '{"count":"3","state":"failed"}',
    '{"count":3,"state":"failed","extra":1}',
    '```json\n{"count":3,"state":"failed"}\n```',
    '{"count":3}',
  ])
    assert.equal(scoreExactAnswer(answer, gold).accepted, false);
  assert.equal(
    scoreExactAnswer('{"state":"failed","count":3}', gold).accepted,
    true,
  );
});
test("frozen short/long pairs preserve gold and exact scoped Unicode/line endings", async () => {
  const rows = await loadEffectivenessCases(
    new URL("../fixtures/context-effectiveness/v1.json", import.meta.url),
  );
  assert.equal(rows.length, 48);
  for (let i = 0; i < rows.length; i += 2) {
    const short = rows[i],
      long = rows[i + 1];
    assert.deepEqual(long.expected, short.expected);
    const id = short.id.slice(8, -6);
    const start = "BEGIN_EVALUATED_TRACE_" + id + "\n",
      end = "\nEND_EVALUATED_TRACE_" + id;
    const content = long.toolText.slice(
      long.toolText.indexOf(start) + start.length,
      long.toolText.indexOf(end),
    );
    assert.equal(content, short.toolText);
    assert.ok(Buffer.byteLength(long.toolText) > 40000);
    assert.ok(long.toolText.split("\n").length < 2000);
  }
});
test("unrun and failed compressed slots remain regressions and in the full denominator", () => {
  const schedule = ["raw", "compressed"].map((arm) => ({
    id: "quality-v3-01-long__r1__" + arm,
    pairId: "quality-v3-01-long__r1",
    arm,
  }));
  const raw = {
    ...schedule[0],
    status: "completed",
    cleanup: { affirmative: true },
    answerScore: { accepted: true },
  };
  const result = summarizeEffectiveness({ schedule }, [raw]);
  assert.equal(result.arms.compressed.unrun, 1);
  assert.equal(result.arms.compressed.acceptanceFraction, 0);
  assert.equal(result.allPairs.regressions, 1);
  assert.equal(result.appliedPairs.scheduled, 0);
  assert.equal(result.productionQualified, false);
});
