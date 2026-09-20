import { describe, expect, it } from "vitest";
import {
  evaluateDownstream,
  evaluateRouting,
  percentile95,
  ROUTING_EVALUATION_GATES,
  type RoutingAttempt,
  type RoutingCase,
} from "../src/routing-evaluation.js";

const cases: readonly RoutingCase[] = Object.freeze([
  { id: "easy-a", family: "numeric", label: "easy", expected: 1 },
  { id: "easy-b", family: "numeric", label: "easy", expected: 2 },
  { id: "easy-c", family: "format", label: "easy", expected: "C" },
  { id: "easy-d", family: "format", label: "easy", expected: "D" },
  { id: "easy-e", family: "format", label: "easy", expected: "E" },
  { id: "hard", family: "implementation", label: "hard", expected: "valid" },
  {
    id: "unknown",
    family: "missing-context",
    label: "unknown",
    expected: null,
  },
]);

function attempts(): RoutingAttempt[] {
  return cases.map((item, index) => ({
    caseId: item.id,
    decision: index < 3 ? "fast" : "strong",
    routerElapsedMs: 100,
    passed: true,
    model: index < 3 ? "invented-fast" : "invented-strong",
    elapsedMs: 200,
    error: null,
  }));
}

describe("routing qualification over every scheduled case", () => {
  it("passes the inclusive predeclared coverage and operational latency boundaries", () => {
    const report = evaluateRouting(cases, attempts().reverse());
    expect(ROUTING_EVALUATION_GATES).toEqual({
      minimumEasyFastCoverage: 0.6,
      maximumUnsafeFast: 0,
      maximumRouterP95Ms: 100,
    });
    expect(report.rows.map((row) => row.case.id)).toEqual(
      cases.map((item) => item.id),
    );
    expect(report).toMatchObject({
      scheduled: 7,
      attempted: 7,
      completed: 7,
      errors: 0,
      unrun: 0,
      incomplete: 0,
      easyFast: 3,
      easyFastCoverage: 0.6,
      unsafeFast: 0,
      hardAndUnknownStrong: 2,
      hardAndUnknownStrongCoverage: 1,
      routerLatency: { samples: 7, missing: 0, complete: true, p95Ms: 100 },
      gates: { passed: true },
      scope: "frozen-population-gates-not-independent-qualification",
      qualificationEligible: false,
    });
  });

  it("keeps failed, partial, and unrun easy cases in the coverage denominator", () => {
    const selected = attempts();
    selected[1].error = "router-timeout";
    selected[2].decision = undefined;
    selected.pop();
    const report = evaluateRouting(cases, selected);
    expect(report).toMatchObject({
      scheduled: 7,
      attempted: 6,
      completed: 4,
      errors: 1,
      incomplete: 1,
      unrun: 1,
      easyFast: 1,
      easyFastCoverage: 0.2,
      hardAndUnknownStrong: 1,
      hardAndUnknownStrongCoverage: 0.5,
      routerLatency: { samples: 6, missing: 1, complete: false },
      gates: { fullPopulationCompleted: false, passed: false },
    });
    expect(report.rows.at(-1)).toMatchObject({
      route: null,
      attempt: null,
      status: "unrun",
    });
  });

  it("rejects route-all-strong despite perfect safety and answer correctness", () => {
    const report = evaluateRouting(
      cases,
      attempts().map((attempt) => ({ ...attempt, decision: "strong" })),
    );
    expect(report.allStrong).toBe(true);
    expect(report.unsafeFast).toBe(0);
    expect(report.answers.allPassed).toBe(true);
    expect(report.gates).toMatchObject({
      usefulEasyCoverage: false,
      notAllStrong: false,
      passed: false,
    });
  });

  it("retains unsafe fast decisions for both hard and unknown labels after errors", () => {
    const selected = attempts();
    selected[5] = {
      ...selected[5],
      decision: { route: "fast" },
      error: "execution-error",
    };
    selected[6] = { ...selected[6], decision: "fast" };
    const report = evaluateRouting(cases, selected);
    expect(report.unsafeFast).toBe(2);
    expect(report.gates.noUnsafeFast).toBe(false);
    expect(report.answers).toMatchObject({
      correct: 6,
      unavailable: 1,
      allPassed: false,
    });
  });

  it("cannot replace missing operational latency with feature-cache diagnostics", () => {
    const selected = attempts().map((attempt) => ({
      ...attempt,
      routerElapsedMs: null,
      featureCacheElapsedMs: 0.1,
    }));
    const report = evaluateRouting(cases, selected);
    expect(report.routerLatency).toEqual({
      samples: 0,
      missing: 7,
      complete: false,
      p95Ms: null,
    });
    expect(report.featureCacheDiagnostics).toMatchObject({
      p95Ms: 0.1,
      complete: true,
      operationalLatencyEvidence: false,
    });
    expect(report.gates.operationalRouterP95).toBe(false);
    expect(report.gates.passed).toBe(false);
  });

  it("fails when operational p95 is above 100ms and preserves explicit zero samples", () => {
    const selected = attempts();
    selected[0].routerElapsedMs = 0;
    selected[6].routerElapsedMs = 100.01;
    const report = evaluateRouting(cases, selected);
    expect(report.routerLatency.samples).toBe(7);
    expect(report.routerLatency.p95Ms).toBe(100.01);
    expect(report.gates.operationalRouterP95).toBe(false);
    expect(percentile95([])).toBeNull();
    expect(percentile95([0])).toBe(0);
    expect(percentile95(Array.from({ length: 20 }, (_, index) => index))).toBe(
      18,
    );
  });

  it("fails an empty population or one without easy controls", () => {
    expect(evaluateRouting([], []).gates.passed).toBe(false);
    const report = evaluateRouting([cases[5]], [attempts()[5]]);
    expect(report.easyFastCoverage).toBeNull();
    expect(report.gates.usefulEasyCoverage).toBe(false);
  });

  it("rejects duplicate or unknown identities and malformed observed values", () => {
    expect(() => evaluateRouting([cases[0], cases[0]], [])).toThrow(
      /duplicate case/,
    );
    expect(() =>
      evaluateRouting(cases, [attempts()[0], attempts()[0]]),
    ).toThrow(/duplicate attempt/);
    expect(() => evaluateRouting(cases, [{ caseId: "not-scheduled" }])).toThrow(
      /unknown attempt/,
    );
    for (const routerElapsedMs of [-1, Infinity, NaN])
      expect(() =>
        evaluateRouting(cases, [{ ...attempts()[0], routerElapsedMs }]),
      ).toThrow(/finite nonnegative/);
    expect(() =>
      evaluateRouting(cases, [
        { ...attempts()[0], usage: { inputTokens: NaN } },
      ]),
    ).toThrow(/usage/);
    expect(() =>
      evaluateRouting(cases, [
        { ...attempts()[0], decision: "unknown" } as unknown as RoutingAttempt,
      ]),
    ).toThrow(/invalid decision/);
  });
});

describe("separate downstream answer and baseline gate", () => {
  it("allows a baseline without routing decisions and keeps missing usage and latency unknown", () => {
    const baseline = cases.map((item) => ({ caseId: item.id, passed: true }));
    const report = evaluateDownstream(cases, attempts(), baseline);
    expect(report.gates.passed).toBe(true);
    expect(report.baseline.completed).toBe(7);
    expect(report.baseline.latency.p95Ms).toBeNull();
    expect(report.baseline.usage.available).toBe(false);
    expect(report.baseline.usage.metrics.inputTokens).toEqual({
      samples: 0,
      missing: 7,
      total: null,
    });
    expect(report.practicalBenefitEstablished).toBe(false);
  });

  it("cannot pass with an incomplete baseline or a failed selected answer", () => {
    const selected = attempts();
    selected[0].passed = false;
    const report = evaluateDownstream(cases, selected, attempts().slice(1));
    expect(report.selected.answers).toMatchObject({
      scheduled: 7,
      correct: 6,
      incorrect: 1,
      correctness: 6 / 7,
    });
    expect(report.baseline).toMatchObject({
      scheduled: 7,
      completed: 6,
      unrun: 1,
    });
    expect(report.baseline.answers).toMatchObject({
      unavailable: 1,
      correctness: 6 / 7,
    });
    expect(report.gates).toMatchObject({
      baselineComplete: false,
      allSelectedAnswerChecksPassed: false,
      passed: false,
    });
  });

  it("does not accept a positive pass flag without a frozen expected answer", () => {
    const withoutExpected = cases.map(
      ({ expected: _expected, ...item }) => item,
    );
    const report = evaluateDownstream(withoutExpected, attempts(), attempts());
    expect(report.selected.answers).toMatchObject({
      checked: 0,
      correct: 0,
      unavailable: 7,
      allPassed: false,
    });
    expect(report.gates.passed).toBe(false);
    expect(evaluateRouting(withoutExpected, attempts()).gates.passed).toBe(
      true,
    );
  });

  it("retains reported usage zeros but never fills absent counters or rows with zero", () => {
    const selected = attempts().map((attempt) => ({
      ...attempt,
      usage: { outputTokens: 0 },
    }));
    const report = evaluateDownstream(cases, selected, selected.slice(1));
    expect(report.selected.usage.metrics.outputTokens).toEqual({
      samples: 7,
      missing: 0,
      total: 0,
    });
    expect(report.selected.usage.metrics.inputTokens.total).toBeNull();
    expect(report.baseline.usage.metrics.outputTokens).toEqual({
      samples: 6,
      missing: 1,
      total: null,
    });
    expect(report.baseline.usage.available).toBe(false);
  });

  it("rejects duplicate or unknown task attempts in either lane", () => {
    expect(() =>
      evaluateDownstream(cases, attempts(), [attempts()[0], attempts()[0]]),
    ).toThrow(/duplicate attempt/);
    expect(() =>
      evaluateDownstream(
        cases,
        [{ caseId: "extra", passed: true }],
        attempts(),
      ),
    ).toThrow(/unknown attempt/);
  });
});

describe("independent qualification gates require outer evidence", () => {
  function controls() {
    const population: RoutingCase[] = Array.from(
      { length: 60 },
      (_, index) => ({
        id: `control-${index}`,
        family:
          index < 10 ? "numeric" : index < 20 ? "format" : "implementation",
        label: index < 20 ? "easy" : index < 40 ? "hard" : "unknown",
        metadata: { independent: true, group: `task-${index}` },
      }),
    );
    const recorded: RoutingAttempt[] = population.map((item, index) => ({
      caseId: item.id,
      decision: index < 12 ? "fast" : "strong",
      routerElapsedMs: 10,
    }));
    return { population, recorded };
  }
  const qualification = {
    minimumFamilies: 3,
    requiredFamilies: ["numeric", "format", "implementation"],
    attestation: {
      realExecution: true,
      independentEvaluation: true,
      artifactIdentity: "invented-test-artifact",
      sourceIdentity: "invented-test-source",
    },
  };

  it("cannot qualify tiny controls or an unattested development summary", () => {
    expect(evaluateRouting(cases, attempts()).qualificationEligible).toBe(
      false,
    );
    const { population, recorded } = controls();
    const report = evaluateRouting(population, recorded);
    expect(report.gates.passed).toBe(true);
    expect(report.qualificationGates).toMatchObject({
      minimumEasyControls: true,
      minimumStrongRequiredControls: true,
      familyCoveragePredeclared: false,
      realExecutionAndIdentityAttested: false,
      passed: false,
    });
  });

  it("accepts only complete independent controls with predeclared family coverage and outer attestation", () => {
    const { population, recorded } = controls();
    const report = evaluateRouting(population, recorded, { qualification });
    expect(report.qualificationEligible).toBe(true);
    expect(report.qualification).toMatchObject({
      evidenceBasis: "outer-attestation-required-not-self-verified",
      independentEasyGroups: 20,
      independentStrongRequiredGroups: 40,
      independentFamilies: 3,
    });
    expect(
      evaluateRouting(population, recorded, {
        qualification: { ...qualification, minimumFamilies: 4 },
      }).qualificationGates.familyCoverage,
    ).toBe(false);
  });

  it("does not count twenty matched easy variants as twenty independent tasks", () => {
    const { population, recorded } = controls();
    for (const item of population.slice(0, 20)) {
      item.metadata!.group = "one-task";
      item.family = "numeric";
    }
    const report = evaluateRouting(population, recorded, { qualification });
    expect(report.qualification.independentEasyGroups).toBe(1);
    expect(report.qualificationGates.minimumEasyControls).toBe(false);
    expect(report.qualificationEligible).toBe(false);
  });

  it("requires invariant completed routes for provided matched format/order variants", () => {
    const { population, recorded } = controls();
    for (const attempt of recorded.slice(0, 16)) attempt.decision = "fast";
    population.push({
      ...population[0],
      id: "format-variant",
      metadata: { ...population[0].metadata, format: "json", order: "B-A" },
    });
    recorded.push({
      caseId: "format-variant",
      decision: "strong",
      routerElapsedMs: 10,
    });
    const report = evaluateRouting(population, recorded, { qualification });
    expect(report.gates.passed).toBe(true);
    expect(report.qualificationGates.matchedVariantsInvariant).toBe(false);
    expect(report.qualificationEligible).toBe(false);
  });

  it("requires a named predeclared source for an explicit coverage override", () => {
    const { population, recorded } = controls();
    recorded[10].decision = "strong";
    recorded[11].decision = "strong";
    expect(() =>
      evaluateRouting(population, recorded, {
        qualification: { ...qualification, minimumEasyFastCoverage: 0.5 },
      }),
    ).toThrow(/gateSource/);
    const report = evaluateRouting(population, recorded, {
      qualification: {
        ...qualification,
        minimumEasyFastCoverage: 0.5,
        gateSource: "invented-frozen-protocol",
      },
    });
    expect(report.gates.usefulEasyCoverage).toBe(false);
    expect(report.qualificationGates.usefulEasyCoverage).toBe(true);
    expect(report.qualificationEligible).toBe(true);
  });
});

describe("format, order, and family sensitivity", () => {
  it("summarizes metadata independently and retains incomplete matched groups", () => {
    const variants: RoutingCase[] = [
      {
        id: "plain",
        family: "__proto__",
        label: "easy",
        metadata: {
          format: "plain",
          order: "A-B",
          group: "same-task",
          independent: true,
        },
      },
      {
        id: "json",
        family: "__proto__",
        label: "easy",
        metadata: {
          format: "json",
          order: "B-A",
          group: "same-task",
          independent: true,
        },
      },
      {
        id: "unrun",
        family: "missing",
        label: "unknown",
        metadata: { format: "plain", group: "missing-task" },
      },
    ];
    const report = evaluateRouting(variants, [
      { caseId: "plain", decision: "fast", routerElapsedMs: 1 },
      { caseId: "json", decision: "strong", routerElapsedMs: 1 },
    ]);
    expect(report.sensitivity).toMatchObject({
      independentCases: 2,
      independentGroups: 1,
      undeclaredCases: 1,
    });
    expect(report.sensitivity.byFamily.__proto__.scheduled).toBe(2);
    expect(report.sensitivity.byFormat.plain).toMatchObject({
      scheduled: 2,
      completed: 1,
      unrun: 1,
    });
    expect(report.sensitivity.byOrder["B-A"].easyFastCoverage).toBe(0);
    expect(report.sensitivity.matchedGroups).toEqual([
      {
        group: "same-task",
        scheduled: 2,
        completed: 2,
        complete: true,
        routes: ["fast", "strong"],
        routeDisagreement: true,
      },
      {
        group: "missing-task",
        scheduled: 1,
        completed: 0,
        complete: false,
        routes: [],
        routeDisagreement: null,
      },
    ]);
  });

  it("rejects matched groups that mix gold labels", () => {
    expect(() =>
      evaluateRouting(
        [
          { ...cases[0], metadata: { group: "mixed" } },
          { ...cases[5], metadata: { group: "mixed" } },
        ],
        [],
      ),
    ).toThrow(/mixes labels/);
  });
});
