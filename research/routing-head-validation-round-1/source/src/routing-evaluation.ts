/** Offline summaries over a frozen scheduled population. No model execution. */
export type RoutingLabel = "easy" | "hard" | "unknown";
export type EvaluationRoute = "fast" | "strong";

export interface RoutingCase {
  id: string;
  family: string;
  label: RoutingLabel;
  expected?: unknown;
  essentialFactsAvailable?: boolean;
  metadata?: {
    format?: string;
    order?: string;
    /** Matched variants of the same task; groups may not mix labels. */
    group?: string;
    /** Authorship/independence declaration, not inferred from results. */
    independent?: boolean;
  };
}

export interface RoutingAttempt {
  caseId: string;
  decision?: EvaluationRoute | { route: EvaluationRoute };
  routerElapsedMs?: number | null;
  passed?: boolean;
  error?: string | null;
  model?: string;
  /** Whole downstream answer time, distinct from router time. */
  elapsedMs?: number | null;
  usage?: Record<string, number | null | undefined> | null;
  /** Offline diagnostic; never substituted for operational router time. */
  featureCacheElapsedMs?: number | null;
}

export const ROUTING_EVALUATION_GATES = Object.freeze({
  minimumEasyFastCoverage: 0.6,
  maximumUnsafeFast: 0,
  maximumRouterP95Ms: 100,
});

export const ROUTING_QUALIFICATION_GATES = Object.freeze({
  minimumIndependentEasyGroups: 20,
  minimumIndependentStrongRequiredGroups: 40,
});

export interface RoutingQualificationAttestation {
  realExecution: boolean;
  independentEvaluation: boolean;
  artifactIdentity: string;
  sourceIdentity: string;
}

export interface RoutingEvaluationOptions {
  qualification?: {
    /** Frozen by the outer protocol; no family minimum is invented here. */
    minimumFamilies?: number;
    requiredFamilies?: readonly string[];
    /** Override only when the outer protocol records its predeclared source. */
    minimumEasyFastCoverage?: number;
    gateSource?: string;
    attestation?: RoutingQualificationAttestation;
  };
}

export interface MeasurementSummary {
  samples: number;
  missing: number;
  complete: boolean;
  /** Observed samples only; incomplete evidence cannot pass latency gates. */
  p95Ms: number | null;
}

export interface AnswerSummary {
  scheduled: number;
  checked: number;
  correct: number;
  incorrect: number;
  unavailable: number;
  /** Includes unchecked and unrun rows in the denominator. */
  correctness: number | null;
  allPassed: boolean;
}

export interface RoutingPopulationSummary {
  scheduled: number;
  attempted: number;
  completed: number;
  errors: number;
  unrun: number;
  incomplete: number;
  easy: number;
  easyFast: number;
  easyFastCoverage: number | null;
  unsafeFast: number;
  hardAndUnknown: number;
  hardAndUnknownStrong: number;
  hardAndUnknownStrongCoverage: number | null;
  answers: AnswerSummary;
  routerLatency: MeasurementSummary;
}

export interface RoutingEvaluationRow {
  case: RoutingCase;
  attempt: RoutingAttempt | null;
  route: EvaluationRoute | null;
  status: "completed" | "error" | "unrun" | "incomplete";
}

export interface RoutingEvaluationReport extends RoutingPopulationSummary {
  scope: "frozen-population-gates-not-independent-qualification";
  qualificationEligible: boolean;
  qualification: {
    evidenceBasis: "outer-attestation-required-not-self-verified";
    gateSource: string;
    minimumEasyFastCoverage: number;
    independentEasyGroups: number;
    independentStrongRequiredGroups: number;
    independentFamilies: number;
    attestation: RoutingQualificationAttestation | null;
  };
  qualificationGates: {
    fullPopulationCompleted: boolean;
    noErrors: boolean;
    usefulEasyCoverage: boolean;
    noUnsafeFast: boolean;
    operationalRouterP95: boolean;
    minimumEasyControls: boolean;
    minimumStrongRequiredControls: boolean;
    allCasesDeclaredIndependent: boolean;
    familyCoveragePredeclared: boolean;
    familyCoverage: boolean;
    matchedVariantsInvariant: boolean;
    realExecutionAndIdentityAttested: boolean;
    passed: boolean;
  };
  allStrong: boolean;
  rows: RoutingEvaluationRow[];
  featureCacheDiagnostics: MeasurementSummary & {
    scope: "offline-feature-cache-diagnostic";
    operationalLatencyEvidence: false;
  };
  gates: {
    fullPopulationCompleted: boolean;
    noErrors: boolean;
    usefulEasyCoverage: boolean;
    notAllStrong: boolean;
    noUnsafeFast: boolean;
    operationalLatencyComplete: boolean;
    operationalRouterP95: boolean;
    passed: boolean;
  };
  sensitivity: {
    scope: "descriptive-frozen-population";
    independentCases: number;
    /** Unique declared task groups, so matched variants do not inflate this count. */
    independentGroups: number;
    undeclaredCases: number;
    byFamily: Record<string, RoutingPopulationSummary>;
    byFormat: Record<string, RoutingPopulationSummary>;
    byOrder: Record<string, RoutingPopulationSummary>;
    matchedGroups: {
      group: string;
      scheduled: number;
      completed: number;
      complete: boolean;
      routes: EvaluationRoute[];
      routeDisagreement: boolean | null;
    }[];
  };
}

function nonempty(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must be a nonempty string`);
}

function optionalMeasurement(value: unknown, name: string): void {
  if (
    value !== undefined &&
    value !== null &&
    (typeof value !== "number" || !Number.isFinite(value) || value < 0)
  )
    throw new Error(`${name} must be a finite nonnegative number or absent`);
}

function routeOf(attempt: RoutingAttempt): EvaluationRoute | null {
  if (attempt.decision === undefined) return null;
  const route =
    typeof attempt.decision === "string"
      ? attempt.decision
      : attempt.decision?.route;
  if (route !== "fast" && route !== "strong")
    throw new Error(`attempt ${attempt.caseId}: invalid decision route`);
  return route;
}

function population(
  cases: readonly RoutingCase[],
  attempts: readonly RoutingAttempt[],
): RoutingEvaluationRow[] {
  const ids = new Set<string>();
  const groupLabels = new Map<string, RoutingLabel>();
  const groupFamilies = new Map<string, string>();
  for (const item of cases) {
    nonempty(item.id, "case id");
    nonempty(item.family, `case ${item.id} family`);
    if (ids.has(item.id)) throw new Error(`duplicate case id ${item.id}`);
    ids.add(item.id);
    if (!["easy", "hard", "unknown"].includes(item.label))
      throw new Error(`case ${item.id}: invalid label`);
    if (
      item.essentialFactsAvailable !== undefined &&
      typeof item.essentialFactsAvailable !== "boolean"
    )
      throw new Error(
        `case ${item.id}: essentialFactsAvailable must be boolean`,
      );
    if (item.metadata !== undefined) {
      if (
        !item.metadata ||
        typeof item.metadata !== "object" ||
        Array.isArray(item.metadata)
      )
        throw new Error(`case ${item.id}: invalid metadata`);
      for (const key of ["format", "order", "group"] as const) {
        const value = item.metadata[key];
        if (value !== undefined) nonempty(value, `case ${item.id} ${key}`);
      }
      if (
        item.metadata.independent !== undefined &&
        typeof item.metadata.independent !== "boolean"
      )
        throw new Error(`case ${item.id}: independent must be boolean`);
      const group = item.metadata.group;
      if (group !== undefined) {
        const label = groupLabels.get(group);
        if (label !== undefined && label !== item.label)
          throw new Error(`matched group ${group} mixes labels`);
        groupLabels.set(group, item.label);
        const family = groupFamilies.get(group);
        if (family !== undefined && family !== item.family)
          throw new Error(`matched group ${group} mixes families`);
        groupFamilies.set(group, item.family);
      }
    }
  }
  const indexed = new Map<string, RoutingAttempt>();
  for (const attempt of attempts) {
    nonempty(attempt.caseId, "attempt caseId");
    if (!ids.has(attempt.caseId))
      throw new Error(`unknown attempt caseId ${attempt.caseId}`);
    if (indexed.has(attempt.caseId))
      throw new Error(`duplicate attempt caseId ${attempt.caseId}`);
    routeOf(attempt);
    for (const key of [
      "routerElapsedMs",
      "elapsedMs",
      "featureCacheElapsedMs",
    ] as const)
      optionalMeasurement(attempt[key], `attempt ${attempt.caseId} ${key}`);
    if (attempt.error !== undefined && attempt.error !== null)
      nonempty(attempt.error, `attempt ${attempt.caseId} error`);
    if (attempt.model !== undefined)
      nonempty(attempt.model, `attempt ${attempt.caseId} model`);
    if (attempt.passed !== undefined && typeof attempt.passed !== "boolean")
      throw new Error(`attempt ${attempt.caseId}: passed must be boolean`);
    if (attempt.usage !== undefined && attempt.usage !== null) {
      if (typeof attempt.usage !== "object" || Array.isArray(attempt.usage))
        throw new Error(`attempt ${attempt.caseId}: invalid usage`);
      for (const [key, value] of Object.entries(attempt.usage))
        optionalMeasurement(value, `attempt ${attempt.caseId} usage.${key}`);
    }
    indexed.set(attempt.caseId, attempt);
  }
  return cases.map((item) => {
    const attempt = indexed.get(item.id) ?? null;
    const route = attempt === null ? null : routeOf(attempt);
    return {
      case: item,
      attempt,
      route,
      status:
        attempt === null
          ? "unrun"
          : attempt.error != null
            ? "error"
            : route === null
              ? "incomplete"
              : "completed",
    };
  });
}

/** Nearest-rank percentile; preserves genuine explicit zeros. */
export function percentile95(values: readonly number[]): number | null {
  for (const value of values) {
    if (typeof value !== "number") throw new Error("latency must be numeric");
    optionalMeasurement(value, "latency");
  }
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function measurement(
  rows: readonly RoutingEvaluationRow[],
  key: "routerElapsedMs" | "elapsedMs" | "featureCacheElapsedMs",
): MeasurementSummary {
  const values = rows.flatMap((row) => {
    const value = row.attempt?.[key];
    return typeof value === "number" ? [value] : [];
  });
  return {
    samples: values.length,
    missing: rows.length - values.length,
    complete: rows.length > 0 && values.length === rows.length,
    p95Ms: percentile95(values),
  };
}

function answers(rows: readonly RoutingEvaluationRow[]): AnswerSummary {
  const checked = rows.filter(
    (row) =>
      row.case.expected !== undefined &&
      row.attempt?.error == null &&
      row.attempt?.passed !== undefined,
  );
  const correct = checked.filter((row) => row.attempt?.passed === true).length;
  return {
    scheduled: rows.length,
    checked: checked.length,
    correct,
    incorrect: checked.length - correct,
    unavailable: rows.length - checked.length,
    correctness: rows.length === 0 ? null : correct / rows.length,
    allPassed: rows.length > 0 && correct === rows.length,
  };
}

function summarize(
  rows: readonly RoutingEvaluationRow[],
): RoutingPopulationSummary {
  const complete = rows.filter((row) => row.status === "completed");
  const easy = rows.filter((row) => row.case.label === "easy");
  const easyFast = complete.filter(
    (row) => row.case.label === "easy" && row.route === "fast",
  ).length;
  const negative = rows.filter((row) => row.case.label !== "easy");
  const strong = complete.filter(
    (row) => row.case.label !== "easy" && row.route === "strong",
  ).length;
  return {
    scheduled: rows.length,
    attempted: rows.filter((row) => row.attempt !== null).length,
    completed: complete.length,
    errors: rows.filter((row) => row.status === "error").length,
    unrun: rows.filter((row) => row.status === "unrun").length,
    incomplete: rows.filter((row) => row.status === "incomplete").length,
    easy: easy.length,
    easyFast,
    easyFastCoverage: easy.length === 0 ? null : easyFast / easy.length,
    // Retain unsafe decisions even if downstream execution later failed.
    unsafeFast: negative.filter((row) => row.route === "fast").length,
    hardAndUnknown: negative.length,
    hardAndUnknownStrong: strong,
    hardAndUnknownStrongCoverage:
      negative.length === 0 ? null : strong / negative.length,
    answers: answers(rows),
    routerLatency: measurement(rows, "routerElapsedMs"),
  };
}

function strata(
  rows: readonly RoutingEvaluationRow[],
  key: (item: RoutingCase) => string | undefined,
): Record<string, RoutingPopulationSummary> {
  const groups = new Map<string, RoutingEvaluationRow[]>();
  for (const row of rows) {
    const value = key(row.case);
    if (value === undefined) continue;
    const group = groups.get(value) ?? [];
    group.push(row);
    groups.set(value, group);
  }
  return Object.fromEntries(
    [...groups].map(([name, members]) => [name, summarize(members)]),
  );
}

export function evaluateRouting(
  cases: readonly RoutingCase[],
  attempts: readonly RoutingAttempt[],
  options: RoutingEvaluationOptions = {},
): RoutingEvaluationReport {
  const rows = population(cases, attempts);
  const summary = summarize(rows);
  const allStrong =
    rows.length > 0 &&
    rows.every((row) => row.status === "completed" && row.route === "strong");
  const gates = {
    fullPopulationCompleted:
      summary.scheduled > 0 && summary.completed === summary.scheduled,
    noErrors: summary.errors === 0,
    usefulEasyCoverage:
      summary.easyFastCoverage !== null &&
      summary.easyFastCoverage >=
        ROUTING_EVALUATION_GATES.minimumEasyFastCoverage,
    notAllStrong: !allStrong,
    noUnsafeFast:
      summary.unsafeFast <= ROUTING_EVALUATION_GATES.maximumUnsafeFast,
    operationalLatencyComplete: summary.routerLatency.complete,
    operationalRouterP95:
      summary.routerLatency.complete &&
      summary.routerLatency.p95Ms !== null &&
      summary.routerLatency.p95Ms <=
        ROUTING_EVALUATION_GATES.maximumRouterP95Ms,
  };
  const groups = new Map<string, RoutingEvaluationRow[]>();
  for (const row of rows) {
    const group = row.case.metadata?.group;
    if (group !== undefined)
      groups.set(group, [...(groups.get(group) ?? []), row]);
  }
  const matchedGroups = [...groups].map(([group, members]) => {
    const completed = members.filter(
      (row) => row.status === "completed",
    ).length;
    const routes = [...new Set(members.flatMap((row) => row.route ?? []))];
    const complete = completed === members.length;
    return {
      group,
      scheduled: members.length,
      completed,
      complete,
      routes,
      routeDisagreement:
        members.length < 2 || !complete ? null : routes.length > 1,
    };
  });
  const qualification = options.qualification;
  const minimumFamilies = qualification?.minimumFamilies;
  if (
    minimumFamilies !== undefined &&
    (!Number.isInteger(minimumFamilies) || minimumFamilies < 1)
  )
    throw new Error("qualification minimumFamilies must be a positive integer");
  const requiredFamilies = qualification?.requiredFamilies ?? [];
  if (!Array.isArray(requiredFamilies))
    throw new Error("qualification requiredFamilies must be an array");
  for (const family of requiredFamilies)
    nonempty(family, "qualification required family");
  if (new Set(requiredFamilies).size !== requiredFamilies.length)
    throw new Error("qualification requiredFamilies must be distinct");
  const coverageMinimum =
    qualification?.minimumEasyFastCoverage ??
    ROUTING_EVALUATION_GATES.minimumEasyFastCoverage;
  if (
    !Number.isFinite(coverageMinimum) ||
    coverageMinimum <= 0 ||
    coverageMinimum > 1
  )
    throw new Error(
      "qualification coverage minimum must be greater than zero and at most one",
    );
  if (qualification?.minimumEasyFastCoverage !== undefined)
    nonempty(qualification.gateSource, "qualification coverage gateSource");
  if (qualification?.gateSource !== undefined)
    nonempty(qualification.gateSource, "qualification gateSource");
  const attestation = qualification?.attestation ?? null;
  if (attestation !== null) {
    if (
      typeof attestation.realExecution !== "boolean" ||
      typeof attestation.independentEvaluation !== "boolean"
    )
      throw new Error("qualification attestation flags must be boolean");
    nonempty(attestation.artifactIdentity, "qualification artifactIdentity");
    nonempty(attestation.sourceIdentity, "qualification sourceIdentity");
  }
  const independent = rows.filter(
    (row) => row.case.metadata?.independent === true,
  );
  const independentEasyGroups = new Set(
    independent
      .filter((row) => row.case.label === "easy")
      .map((row) => row.case.metadata?.group ?? row.case.id),
  ).size;
  const independentStrongGroups = new Set(
    independent
      .filter((row) => row.case.label !== "easy")
      .map((row) => row.case.metadata?.group ?? row.case.id),
  ).size;
  const independentFamilies = new Set(
    independent.map((row) => row.case.family),
  );
  const familyCoveragePredeclared =
    minimumFamilies !== undefined || requiredFamilies.length > 0;
  const qualificationGates = {
    fullPopulationCompleted: gates.fullPopulationCompleted,
    noErrors: gates.noErrors,
    usefulEasyCoverage:
      !allStrong &&
      summary.easyFastCoverage !== null &&
      summary.easyFastCoverage >= coverageMinimum,
    noUnsafeFast: gates.noUnsafeFast,
    operationalRouterP95: gates.operationalRouterP95,
    minimumEasyControls:
      independentEasyGroups >=
      ROUTING_QUALIFICATION_GATES.minimumIndependentEasyGroups,
    minimumStrongRequiredControls:
      independentStrongGroups >=
      ROUTING_QUALIFICATION_GATES.minimumIndependentStrongRequiredGroups,
    allCasesDeclaredIndependent:
      rows.length > 0 && independent.length === rows.length,
    familyCoveragePredeclared,
    familyCoverage:
      familyCoveragePredeclared &&
      (minimumFamilies === undefined ||
        independentFamilies.size >= minimumFamilies) &&
      requiredFamilies.every((family) => independentFamilies.has(family)),
    matchedVariantsInvariant: matchedGroups.every(
      (group) =>
        group.complete &&
        (group.scheduled < 2 || group.routeDisagreement === false),
    ),
    realExecutionAndIdentityAttested:
      attestation?.realExecution === true &&
      attestation.independentEvaluation === true,
  };
  const qualificationPassed = Object.values(qualificationGates).every(Boolean);
  return {
    ...summary,
    scope: "frozen-population-gates-not-independent-qualification",
    qualificationEligible: qualificationPassed,
    qualification: {
      evidenceBasis: "outer-attestation-required-not-self-verified",
      gateSource:
        qualification?.gateSource ??
        "ROUTING_EVALUATION_GATES predeclared default",
      minimumEasyFastCoverage: coverageMinimum,
      independentEasyGroups,
      independentStrongRequiredGroups: independentStrongGroups,
      independentFamilies: independentFamilies.size,
      attestation,
    },
    qualificationGates: { ...qualificationGates, passed: qualificationPassed },
    allStrong,
    rows,
    featureCacheDiagnostics: {
      ...measurement(rows, "featureCacheElapsedMs"),
      scope: "offline-feature-cache-diagnostic",
      operationalLatencyEvidence: false,
    },
    gates: { ...gates, passed: Object.values(gates).every(Boolean) },
    sensitivity: {
      scope: "descriptive-frozen-population",
      independentCases: rows.filter(
        (row) => row.case.metadata?.independent === true,
      ).length,
      independentGroups: new Set(
        rows
          .filter((row) => row.case.metadata?.independent === true)
          .map((row) => row.case.metadata?.group ?? row.case.id),
      ).size,
      undeclaredCases: rows.filter(
        (row) => row.case.metadata?.independent === undefined,
      ).length,
      byFamily: strata(rows, (item) => item.family),
      byFormat: strata(rows, (item) => item.metadata?.format),
      byOrder: strata(rows, (item) => item.metadata?.order),
      matchedGroups,
    },
  };
}

export interface DownstreamLaneSummary {
  scheduled: number;
  attempted: number;
  completed: number;
  errors: number;
  unrun: number;
  incomplete: number;
  answers: AnswerSummary;
  latency: MeasurementSummary;
  routerLatency: MeasurementSummary;
  usage: {
    available: boolean;
    metrics: Record<
      string,
      { samples: number; missing: number; total: number | null }
    >;
  };
}

function downstreamLane(
  rows: readonly RoutingEvaluationRow[],
): DownstreamLaneSummary {
  // A baseline need not have a routing decision; an actual answer check completes it.
  const errors = rows.filter((row) => row.attempt?.error != null).length;
  const unrun = rows.filter((row) => row.attempt === null).length;
  const completed = rows.filter(
    (row) =>
      row.attempt !== null &&
      row.attempt.error == null &&
      row.attempt.passed !== undefined,
  ).length;
  const keys = new Set([
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    ...rows.flatMap((row) => Object.keys(row.attempt?.usage ?? {})),
  ]);
  const metrics = Object.fromEntries(
    [...keys].map((key) => {
      const values = rows.flatMap((row) => {
        const value = row.attempt?.usage?.[key];
        return typeof value === "number" ? [value] : [];
      });
      return [
        key,
        {
          samples: values.length,
          missing: rows.length - values.length,
          total:
            rows.length > 0 && values.length === rows.length
              ? values.reduce((sum, value) => sum + value, 0)
              : null,
        },
      ];
    }),
  );
  return {
    scheduled: rows.length,
    attempted: rows.length - unrun,
    completed,
    errors,
    unrun,
    incomplete: rows.length - completed - errors - unrun,
    answers: answers(rows),
    latency: measurement(rows, "elapsedMs"),
    routerLatency: measurement(rows, "routerElapsedMs"),
    usage: {
      available:
        rows.length > 0 && rows.every((row) => row.attempt?.usage != null),
      metrics,
    },
  };
}

/** Answer correctness is a separate gate from routing quality and usefulness. */
export function evaluateDownstream(
  cases: readonly RoutingCase[],
  selectedAttempts: readonly RoutingAttempt[],
  baselineAttempts: readonly RoutingAttempt[],
) {
  const selected = downstreamLane(population(cases, selectedAttempts));
  const baseline = downstreamLane(population(cases, baselineAttempts));
  const gates = {
    selectedComplete:
      selected.scheduled > 0 && selected.completed === selected.scheduled,
    baselineComplete:
      baseline.scheduled > 0 && baseline.completed === baseline.scheduled,
    noSelectedErrors: selected.errors === 0,
    noBaselineErrors: baseline.errors === 0,
    allSelectedAnswerChecksPassed: selected.answers.allPassed,
    allBaselineAnswerChecksPassed: baseline.answers.allPassed,
  };
  return {
    scheduled: cases.length,
    selected,
    baseline,
    gates: { ...gates, passed: Object.values(gates).every(Boolean) },
    practicalBenefitEstablished: false as const,
  };
}

export const summarizeRoutingEvaluation = evaluateRouting;
export const summarizeDownstreamEvaluation = evaluateDownstream;
