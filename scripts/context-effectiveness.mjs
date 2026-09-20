import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
export const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");
export function scoreExactAnswer(answer, expected) {
  let value;
  try {
    value = JSON.parse(answer);
  } catch {
    return {
      accepted: false,
      validJson: false,
      matchedFields: 0,
      totalFields: Object.keys(expected).length,
    };
  }
  const keys = Object.keys(expected);
  const object =
    value !== null && typeof value === "object" && !Array.isArray(value);
  const matchedFields = object
    ? keys.filter(
        (key) =>
          Object.hasOwn(value, key) &&
          typeof value[key] === typeof expected[key] &&
          JSON.stringify(value[key]) === JSON.stringify(expected[key]),
      ).length
    : 0;
  return {
    accepted:
      object &&
      Object.keys(value).length === keys.length &&
      matchedFields === keys.length,
    validJson: true,
    matchedFields,
    totalFields: keys.length,
  };
}
export function effectivenessCases(author) {
  assert.equal(author.version, 1);
  assert.equal(author.cases.length, 24);
  return author.cases.flatMap((row) => {
    assert.match(row.id, /^v3-\d{2}$/);
    assert.ok(
      row.expected &&
        typeof row.question === "string" &&
        typeof row.trace === "string",
    );
    const short = {
      id: "quality-" + row.id + "-short",
      family: row.family,
      stratum: "native-short",
      question: row.question,
      toolText: row.trace,
      expected: row.expected,
    };
    const noise = Array.from(
      { length: 300 },
      (_, i) =>
        "UNRELATED " +
        sha256(row.id + ":" + i) +
        " " +
        sha256("padding:" + row.id + ":" + i),
    ).join("\n");
    const start = "BEGIN_EVALUATED_TRACE_" + row.id,
      end = "END_EVALUATED_TRACE_" + row.id;
    const long = {
      ...short,
      id: "quality-" + row.id + "-long",
      stratum: "scoped-long",
      question:
        "Evaluate ONLY the exact text between the standalone delimiter lines " +
        start +
        " and " +
        end +
        ". Exclude both delimiters and the single separator newline immediately after the opening delimiter and immediately before the closing delimiter. All uses of trace, records, lines and counts in the following task refer exclusively to that text. Outside it is unrelated padding. " +
        row.question,
      toolText:
        noise +
        "\n" +
        start +
        "\n" +
        row.trace +
        "\n" +
        end +
        "\n" +
        noise.slice(0, 300),
    };
    // Exact byte-preserving scope extraction independently protects count/CRLF/Unicode gold.
    const recovered = long.toolText.slice(
      long.toolText.indexOf(start + "\n") + start.length + 1,
      long.toolText.indexOf("\n" + end),
    );
    assert.equal(recovered, row.trace);
    return [short, long].map((record) => ({
      ...record,
      toolSha256: sha256(record.toolText),
    }));
  });
}
export async function loadEffectivenessCases(path) {
  const bytes = await readFile(path);
  const fixture = JSON.parse(bytes);
  assert.equal(fixture.kind, "jev_answer_effectiveness_fixture");
  assert.equal(fixture.cases.length, 48);
  for (const row of fixture.cases) {
    assert.match(row.id, /^quality-v3-\d{2}-(short|long)$/);
    assert.equal(sha256(row.toolText), row.toolSha256);
    assert.ok(row.expected && typeof row.question === "string");
  }
  assert.equal(new Set(fixture.cases.map((row) => row.id)).size, 48);
  return fixture.cases;
}

export function summarizeEffectiveness(protocol, runs) {
  const slots = protocol.schedule;
  const accepted = (run) =>
    run?.status === "completed" &&
    run.cleanup?.affirmative === true &&
    run.answerScore?.accepted === true;
  const arms = Object.fromEntries(
    ["raw", "compressed"].map((arm) => {
      const planned = slots.filter((slot) => slot.arm === arm);
      const observed = planned.map((slot) =>
        runs.find((run) => run.id === slot.id),
      );
      return [
        arm,
        {
          scheduled: planned.length,
          observed: observed.filter(Boolean).length,
          accepted: observed.filter(accepted).length,
          errors: observed.filter((run) => run && run.status !== "completed")
            .length,
          unrun: observed.filter((run) => !run).length,
          acceptanceFraction: observed.filter(accepted).length / planned.length,
        },
      ];
    }),
  );
  const pairs = [...new Set(slots.map((slot) => slot.pairId))].map((pairId) => {
    const raw = runs.find((run) => run.id === pairId + "__raw"),
      compressed = runs.find((run) => run.id === pairId + "__compressed");
    return {
      pairId,
      rawAccepted: accepted(raw),
      compressedAccepted: accepted(compressed),
      compressionApplied: compressed?.compressionApplied === true,
      complete:
        raw?.status === "completed" && compressed?.status === "completed",
    };
  });
  const countPairs = (rows) => ({
    scheduled: rows.length,
    complete: rows.filter((row) => row.complete).length,
    bothAccepted: rows.filter(
      (row) => row.rawAccepted && row.compressedAccepted,
    ).length,
    regressions: rows.filter(
      (row) => row.rawAccepted && !row.compressedAccepted,
    ).length,
    improvements: rows.filter(
      (row) => !row.rawAccepted && row.compressedAccepted,
    ).length,
    bothFailed: rows.filter(
      (row) => !row.rawAccepted && !row.compressedAccepted,
    ).length,
  });
  return {
    arms,
    judges: Object.fromEntries(
      ["raw", "compressed"].map((arm) => {
        const planned = slots.filter(
          (slot) => slot.arm === arm && slot.repetition === 1,
        );
        const observed = planned.map(
          (slot) => runs.find((run) => run.id === slot.id)?.judgeResult,
        );
        return [
          arm,
          {
            scheduled: planned.length,
            observed: observed.filter(Boolean).length,
            completed: observed.filter((row) => row?.completed).length,
            supported: observed.filter(
              (row) => row?.completed && row.formatValid && row.supported,
            ).length,
            invalidOrFailed: observed.filter(
              (row) => row && (!row.completed || !row.formatValid),
            ).length,
            unrun: observed.filter((row) => !row).length,
          },
        ];
      }),
    ),
    allPairs: countPairs(pairs),
    appliedPairs: countPairs(pairs.filter((row) => row.compressionApplied)),
    nativeShortPairs: countPairs(
      pairs.filter((row) => row.pairId.includes("-short__")),
    ),
    scopedLongPairs: countPairs(
      pairs.filter((row) => row.pairId.includes("-long__")),
    ),
    pairs,
    productionQualified: false,
    scope:
      "Invented source-blind V3 tasks and exact scoped long variants. Two repetitions do not establish population noninferiority.",
  };
}
