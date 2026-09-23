import assert from "node:assert/strict";
import test from "node:test";
import { classifyC9BaselineRouting } from "../scripts/guardrail-c9-test-baseline.mjs";

const row = Object.freeze({
  id: "synthetic-case",
  operation: Object.freeze({
    tool: "sf_apex",
    input: Object.freeze({ action: "status" }),
  }),
  fixture: Object.freeze({ observations: Object.freeze({}) }),
  expected: Object.freeze({ decision: "allow" }),
});
const ready = Object.freeze({
  sentinelCalls: 0,
  eligible: true,
  policyFloor: false,
});
const browserPressFallback =
  "Jev browser press lacks live page and focus evidence; using Safety Kernel fallback";
const facts = [
  "Jev Salesforce org target is ambiguous; using Safety Kernel fallback",
  "Jev org lookup failed; using Safety Kernel fallback",
  "Jev Salesforce org identity unverified; using Safety Kernel fallback",
  "Browser reference evidence unavailable before model check",
  "Jev browser click lacks matching recent reference and page observations; using Safety Kernel fallback",
  browserPressFallback,
];

test("exact host fact-preparation fallbacks preserve source, reason, and case", () => {
  const before = JSON.stringify(row);
  for (const reason of facts) {
    const comparison = Object.freeze({ source: "rules_fallback", reason });
    assert.equal(
      classifyC9BaselineRouting(row, { ...ready, comparison }),
      "pre_model_fallback",
      reason,
    );
    assert.equal(comparison.source, "rules_fallback");
    assert.equal(comparison.reason, reason);
  }
  assert.equal(JSON.stringify(row), before);
});

test("actual host fact reason is sufficient without an authored fact-gap heuristic", () => {
  const complete = {
    ...row,
    operation: { tool: "bash", input: { command: "printf '%s' ready" } },
    fixture: {
      observations: {
        org: { alias: "fixture", type: "sandbox", guessed: false },
      },
    },
  };
  assert.equal(
    classifyC9BaselineRouting(complete, {
      ...ready,
      comparison: { source: "rules_fallback", reason: facts[0] },
    }),
    "pre_model_fallback",
  );
});

test("provider, model, validation, and deadline failures stay failing with missing authored facts", () => {
  const failures = [
    "provider_unavailable",
    "Jev risk provider missing or duplicated",
    "Invalid Jev risk provider",
    "Jev risk model is not warmed and qualified",
    "C8 TRAIN calibration has no held-out enforcement qualification",
    "C8 calibration does not match the installed model, policy, or baseline",
    "Jev qualification does not match the installed sf-guardrail baseline",
    "Incomplete Jev risk input: missing action",
    "Jev org facts disagree with verified Safety Kernel facts",
    "Jev risk preparation exceeded deadline",
    "Jev risk check was aborted or exceeded the 750 ms deadline",
    "Jev risk evaluation exceeded deadline",
    "Jev risk decision exceeded the 750 ms deadline",
    "The operation was aborted due to timeout",
    "This operation was aborted",
    "Jev risk evaluation unavailable",
    "Invalid, incomplete or late Jev risk prediction",
    "Browser reference or page observation changed during risk evaluation",
    `${facts[0]}: provider error`,
    `${browserPressFallback}: provider error`,
    "Jev browser press lacks live page and focus evidence",
  ];
  for (const reason of failures)
    assert.throws(
      () =>
        classifyC9BaselineRouting(row, {
          ...ready,
          comparison: { source: "rules_fallback", reason },
        }),
      /eligible request did not reach model-free sentinel/,
      reason,
    );
  assert.throws(
    () => classifyC9BaselineRouting(row, ready),
    /eligible request did not reach model-free sentinel/,
  );
});

test("fact exemptions require rules_fallback and zero sentinel calls", () => {
  for (const reason of [facts[0], browserPressFallback]) {
    for (const source of ["jev", undefined, "unknown"])
      assert.throws(
        () =>
          classifyC9BaselineRouting(row, {
            ...ready,
            comparison: { source, reason },
          }),
        /eligible request did not reach model-free sentinel/,
      );
    assert.equal(
      classifyC9BaselineRouting(row, {
        ...ready,
        sentinelCalls: 1,
        comparison: { source: "rules_fallback", reason },
      }),
      "model_prepared",
    );
  }
  assert.equal(
    classifyC9BaselineRouting(row, {
      ...ready,
      sentinelCalls: 1,
      comparison: {
        source: "rules_fallback",
        reason: "Jev risk decision exceeded the 750 ms deadline",
      },
    }),
    "model_prepared",
  );
});

test("exact policies, policy floors, and ineligible operations preserve their routes", () => {
  assert.equal(
    classifyC9BaselineRouting(row, {
      ...ready,
      comparison: { source: "exact_policy", reason: "exact_policy_constraint" },
    }),
    "exact_policy",
  );
  assert.equal(
    classifyC9BaselineRouting(row, { ...ready, policyFloor: true }),
    "rules_fallback",
  );
  assert.equal(
    classifyC9BaselineRouting(row, { ...ready, eligible: false }),
    "rules_fallback",
  );
});
