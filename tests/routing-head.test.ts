import { describe, expect, it } from "vitest";
import {
  ROUTING_HEAD_LIMITS,
  fitRoutingHead,
  scoreRoutingHead,
  validateRoutingHeadArtifact,
  type RoutingHeadArtifact,
  type RoutingTrainingRow,
} from "../src/routing-head.js";

// Every feature and label in this file is invented; no cache or model is read.
const inventedRows: RoutingTrainingRow[] = [-3, -2, -1, -0.5, 0.5, 1, 2, 3].map(
  (x, i) => ({
    id: `invented-${i}`,
    features: [x, x / 2, 17],
    label: x < 0 ? "fast" : "strong",
  }),
);
function jsonCopy(artifact: RoutingHeadArtifact) {
  return JSON.parse(JSON.stringify(artifact));
}
function independentObjective(
  artifact: RoutingHeadArtifact,
  parameters: readonly number[],
  rows: readonly RoutingTrainingRow[] = inventedRows,
) {
  let loss = 0;
  for (const row of rows) {
    let logit = parameters[artifact.dimension];
    for (let j = 0; j < artifact.dimension; j++)
      logit +=
        parameters[j] *
        ((row.features[j] - artifact.featureCenter[j]) /
          artifact.featureScale[j]);
    const target = row.label === "strong" ? 1 : 0;
    loss +=
      (Math.max(logit, 0) -
        target * logit +
        Math.log1p(Math.exp(-Math.abs(logit)))) /
      rows.length;
  }
  for (const weight of parameters.slice(0, artifact.dimension))
    loss += (artifact.trainingDiagnostics.l2 * weight ** 2) / 2;
  return loss;
}

describe("CPU cached-feature routing head", () => {
  it("learns an invented separation and reports full-objective stationarity", () => {
    const artifact = fitRoutingHead(inventedRows);
    const diagnostics = artifact.trainingDiagnostics;
    expect(scoreRoutingHead(artifact, [-2, -1, 17]).decision).toBe("fast");
    expect(scoreRoutingHead(artifact, [2, 1, 17]).decision).toBe("strong");
    expect(diagnostics.stationary).toBe(true);
    expect(diagnostics.termination).toBe("stationary");
    expect(diagnostics.gradientInfinityNorm).toBeLessThanOrEqual(
      diagnostics.stationarityTolerance,
    );
    expect(diagnostics.iterations).toBeGreaterThan(0);
    expect(diagnostics.loss).toBeLessThan(diagnostics.initialLoss);
    expect(diagnostics.fullGradient).toHaveLength(artifact.dimension + 1);
    expect(diagnostics.classCounts).toEqual({ fast: 4, strong: 4 });
    expect(artifact.featureCenter[2]).toBe(17);
    expect(artifact.featureScale[2]).toBe(1);
    expect(artifact.weights[2]).toBe(0);
    expect(artifact.calibration).toBe("uncalibrated");
  });

  it("matches independently differentiated loss, including L2 and bias", () => {
    const gradientRows = inventedRows.slice(1);
    const artifact = fitRoutingHead(gradientRows, {
      maxIterations: 1,
      tolerance: 1e-12,
    });
    const parameters = [...artifact.weights, artifact.bias];
    const step = 1e-5;
    const numericalGradient = parameters.map((_, j) => {
      const plus = [...parameters];
      const minus = [...parameters];
      plus[j] += step;
      minus[j] -= step;
      return (
        (independentObjective(artifact, plus, gradientRows) -
          independentObjective(artifact, minus, gradientRows)) /
        (2 * step)
      );
    });
    expect(artifact.trainingDiagnostics.loss).toBeCloseTo(
      independentObjective(artifact, parameters, gradientRows),
      12,
    );
    numericalGradient.forEach((value, j) =>
      expect(artifact.trainingDiagnostics.fullGradient[j]).toBeCloseTo(
        value,
        8,
      ),
    );
    expect(
      Math.abs(artifact.trainingDiagnostics.fullGradient.at(-1)!),
    ).toBeGreaterThan(1e-6);
    expect(artifact.trainingDiagnostics.stationary).toBe(false);
    expect(artifact.trainingDiagnostics.termination).toBe("max_iterations");
    expect(artifact.trainingDiagnostics.iterations).toBe(1);
  });

  it("is deterministic across row order and leaves caller data untouched", () => {
    const before = JSON.stringify(inventedRows);
    const first = fitRoutingHead(inventedRows);
    const second = fitRoutingHead([...inventedRows].reverse());
    expect(second).toEqual(first);
    expect(JSON.stringify(inventedRows)).toBe(before);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.weights)).toBe(true);
    expect(Object.isFrozen(first.featureCenter)).toBe(true);
    expect(Object.isFrozen(first.trainingDiagnostics)).toBe(true);
    expect(Object.isFrozen(first.trainingDiagnostics.fullGradient)).toBe(true);
    expect(Object.isFrozen(first.trainingDiagnostics.classCounts)).toBe(true);
    expect(() => (first.weights as number[]).push(1)).toThrow();
  });

  it("persists its transform and round-trips JSON without changing scores", () => {
    const artifact = fitRoutingHead(inventedRows);
    const parsed = jsonCopy(artifact);
    const restored = validateRoutingHeadArtifact(parsed);
    const expected = scoreRoutingHead(artifact, [1.4, 0.7, 17]);
    expect(scoreRoutingHead(restored, [1.4, 0.7, 17])).toEqual(expected);
    expect(expected.fastScore + expected.strongScore).toBe(1);
    parsed.weights[0] = 900;
    expect(scoreRoutingHead(restored, [1.4, 0.7, 17])).toEqual(expected);
    const transformed = inventedRows.map((row) => ({
      ...row,
      features: row.features.map((value) => value * 11 + 150),
    }));
    expect(
      scoreRoutingHead(fitRoutingHead(transformed), [165.4, 157.7, 337])
        .strongScore,
    ).toBeCloseTo(expected.strongScore, 10);
  });

  it("makes exact ties uncertain even with a nondefault threshold", () => {
    const tied = fitRoutingHead(
      [
        { id: "a", features: [7, 4], label: "fast" },
        { id: "b", features: [7, 4], label: "strong" },
      ],
      { threshold: 0.7, minMargin: 0.1 },
    );
    expect(tied.trainingDiagnostics.iterations).toBe(0);
    expect(tied.trainingDiagnostics.stationary).toBe(true);
    expect(scoreRoutingHead(tied, [7, 4])).toEqual({
      fastScore: 0.5,
      strongScore: 0.5,
      decision: "uncertain",
    });
  });

  it("abstains at both explicit cutoff boundaries for unequal scores", () => {
    const rows: RoutingTrainingRow[] = [
      "fast",
      "strong",
      "strong",
      "strong",
    ].map((label, i) => ({
      id: `boundary-${i}`,
      features: [0],
      label: label as "fast" | "strong",
    }));
    const probability = scoreRoutingHead(fitRoutingHead(rows), [0]).strongScore;
    expect(probability).toBeGreaterThan(0.5);
    for (const threshold of [probability - 0.125, probability + 0.125]) {
      const artifact = fitRoutingHead(rows, { threshold, minMargin: 0.25 });
      expect(scoreRoutingHead(artifact, [0]).decision).toBe("uncertain");
    }
    expect(
      scoreRoutingHead(
        fitRoutingHead(rows, {
          threshold: probability - 0.2,
          minMargin: 0.1,
        }),
        [0],
      ).decision,
    ).toBe("strong");
    expect(
      scoreRoutingHead(
        fitRoutingHead(rows, {
          threshold: probability + 0.2,
          minMargin: 0.05,
        }),
        [0],
      ).decision,
    ).toBe("fast");
  });

  it("uses explicit abstention width and can retain raw feature coordinates", () => {
    const artifact = fitRoutingHead(inventedRows, {
      standardize: false,
      minMargin: 1,
    });
    expect(artifact.featureCenter).toEqual([0, 0, 0]);
    expect(artifact.featureScale).toEqual([1, 1, 1]);
    expect(artifact.minMargin).toBe(1);
    expect(scoreRoutingHead(artifact, [1e12, 1e12, 17]).decision).toBe(
      "uncertain",
    );
    expect(scoreRoutingHead(artifact, [-1e12, -1e12, 17]).decision).toBe(
      "uncertain",
    );
  });

  it("reduces the fitted weight norm when L2 is increased", () => {
    const weak = fitRoutingHead(inventedRows, { l2: 0.01 });
    const strong = fitRoutingHead(inventedRows, { l2: 10 });
    expect(Math.hypot(...strong.weights)).toBeLessThan(
      Math.hypot(...weak.weights),
    );
    expect(weak.trainingDiagnostics.stationary).toBe(true);
    expect(strong.trainingDiagnostics.stationary).toBe(true);
  });

  it("supports an invented 1152-dimensional cached representation", () => {
    const artifact = fitRoutingHead([
      { id: "a", features: new Array(1152).fill(-1), label: "fast" },
      { id: "b", features: new Array(1152).fill(1), label: "strong" },
    ]);
    expect(artifact.dimension).toBe(1152);
    expect(artifact.trainingDiagnostics.stationary).toBe(true);
    expect(scoreRoutingHead(artifact, new Array(1152).fill(1)).decision).toBe(
      "strong",
    );
  });

  it.each([
    (a: any) => {
      a.version = 2;
    },
    (a: any) => {
      a.extra = "unknown";
    },
    (a: any) => {
      a.bias = Infinity;
    },
    (a: any) => {
      a.weights[0] = NaN;
    },
    (a: any) => {
      a.weights.pop();
    },
    (a: any) => {
      a.featureScale[0] = 0;
    },
    (a: any) => {
      a.featureScale[0] = Number.MIN_VALUE;
    },
    (a: any) => {
      a.dimension = ROUTING_HEAD_LIMITS.dimension + 1;
    },
    (a: any) => {
      a.threshold = 1;
    },
    (a: any) => {
      a.minMargin = 2;
    },
    (a: any) => {
      a.trainingDiagnostics.fullGradient.pop();
    },
    (a: any) => {
      a.trainingDiagnostics.gradientNorm = 9;
    },
    (a: any) => {
      a.trainingDiagnostics.stationary = false;
    },
    (a: any) => {
      a.trainingDiagnostics.classCounts.strong = 0;
    },
    (a: any) => {
      a.trainingDiagnostics.extra = true;
    },
    (a: any) => {
      delete a.featureCenter[0];
    },
    (a: any) => {
      Object.defineProperty(a, "bias", { get: () => 0 });
    },
    (a: any) => {
      Object.setPrototypeOf(a, { inherited: true });
    },
  ])("rejects a malformed artifact before scoring (%#)", (mutate) => {
    const artifact = jsonCopy(fitRoutingHead(inventedRows));
    mutate(artifact);
    expect(() => validateRoutingHeadArtifact(artifact)).toThrow();
    expect(() => scoreRoutingHead(artifact, [1, 0.5, 17])).toThrow();
  });

  it("rejects invalid rows, features, and optimizer options", () => {
    expect(() => fitRoutingHead([])).toThrow();
    expect(() => fitRoutingHead([inventedRows[0], inventedRows[0]])).toThrow();
    expect(() => fitRoutingHead(inventedRows.slice(0, 3))).toThrow(/both/);
    expect(() => fitRoutingHead(inventedRows, { l2: 0 })).toThrow();
    expect(() => fitRoutingHead(inventedRows, { maxIterations: 0 })).toThrow();
    expect(() =>
      fitRoutingHead(inventedRows, { maxIterations: 2001 }),
    ).toThrow();
    expect(() => fitRoutingHead(inventedRows, { tolerance: NaN })).toThrow();
    expect(() => fitRoutingHead(inventedRows, { l2: null } as never)).toThrow();
    expect(() =>
      fitRoutingHead(new Array(8193).fill(inventedRows[0])),
    ).toThrow();
    const tooManyCells = new Array(257).fill({
      id: "cell-limit",
      features: new Array(4096).fill(0),
      label: "fast",
    });
    expect(() => fitRoutingHead(tooManyCells)).toThrow(/feature cells/);
    const malformed = inventedRows.map((row) => ({
      ...row,
      features: [...row.features],
    }));
    malformed[1].features[0] = Infinity;
    expect(() => fitRoutingHead(malformed)).toThrow();
    const artifact = fitRoutingHead(inventedRows);
    expect(() => scoreRoutingHead(artifact, [1])).toThrow(/dimension/);
    expect(() => scoreRoutingHead(artifact, [NaN, 0, 17])).toThrow();
    expect(() => scoreRoutingHead(artifact, [1e13, 0, 17])).toThrow();
    expect(() =>
      fitRoutingHead([
        { id: "a", features: new Array(4097).fill(0), label: "fast" },
        { id: "b", features: new Array(4097).fill(1), label: "strong" },
      ]),
    ).toThrow();
  });
});
