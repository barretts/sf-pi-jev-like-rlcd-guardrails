#!/usr/bin/env node
/** Reproducible, model-free Pi SDK workflow comparison for the committed C6 host. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = fileURLToPath(import.meta.url);
const outputRoot = resolve(root, ".build/guardrail");
const hostTest = "extensions/sf-guardrail/tests/jev-risk-sdk.test.ts";
const decisionEntry = "sf-guardrail-decision";
const allowEntry = "sf-guardrail-allow";
const comparisonEntry = "sf-guardrail-risk-comparison";
const testTitle =
  "checks the frozen representative workflow collector using scripted risk predictions";
const sourcePin = Object.freeze({
  sfCommit: "dd97a1a9165a89cdb7ff5b2d0c84d2bbf3843277",
  sfBaselineSha256:
    "7d8c068bf02725b1f5ad7d77349a4144390ab0f1a6e531bc28f89af8270154c4",
  sfTestSha256:
    "572ef253883dce408d7298eb8a500c8dd1ed68f5b10c9129158e53402a1ef5d5",
  workflowDefinitionSha256:
    "0039df8fc5568b3be141f4f28f253b7f32e429019e3b4e288cb42029f56e7fc4",
});
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const check = (condition, reason) => {
  if (!condition) throw new Error(reason);
};
const nonnegative = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const p95 = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null;
};

/** Validate the actual Pi SDK collector output before giving it a Jev receipt. */
export function validateScriptedSdkReport(report) {
  check(report?.version === 1, "Unexpected Pi SDK workflow report version");
  check(
    report.scope ===
      "Actual Pi SDK with scripted risk predictions and counter-only tools; collector proof only.",
    "Pi SDK report does not describe the counter-only collector",
  );
  check(
    report.baselineSourceSha256 === sourcePin.sfBaselineSha256 &&
      report.workflowDefinitionSha256 === sourcePin.workflowDefinitionSha256,
    "Pi SDK workflow or sf-guardrail baseline changed",
  );
  check(
    Array.isArray(report.workflows) && report.workflows.length === 5,
    "Expected five frozen representative workflows",
  );
  const operations = report.workflows.flatMap((workflow) => {
    check(typeof workflow.id === "string" && workflow.id, "Workflow has no ID");
    check(
      Array.isArray(workflow.operations),
      `Workflow ${workflow.id} has no operations`,
    );
    return workflow.operations.map((operation) => ({
      ...operation,
      workflowId: workflow.id,
    }));
  });
  check(operations.length === 10, "Expected ten matched Pi SDK operations");
  check(
    new Set(report.workflows.map((workflow) => workflow.id)).size ===
      report.workflows.length,
    "Duplicate Pi SDK workflow ID",
  );
  check(
    report.workflows.some(
      (workflow) => workflow.id === "protected-path-exact-block",
    ) &&
      operations.filter((operation) => operation.expected === "block")
        .length === 1,
    "Exact hard-block operation is missing",
  );
  check(
    operations.every(
      (operation) =>
        typeof operation.toolName === "string" &&
        operation.input &&
        typeof operation.input === "object" &&
        ["allow", "confirm", "block"].includes(operation.expected),
    ),
    "Pi SDK workflow operation is incomplete",
  );
  const modes = ["off", "shadow", "enforce"];
  check(
    Array.isArray(report.measurements) &&
      report.measurements.length === modes.length &&
      report.measurements.map((row) => row.mode).join(",") === modes.join(","),
    "Expected exactly off, shadow, and fixture-only enforce runs",
  );
  for (const run of report.measurements) {
    check(
      Array.isArray(run.calls) && run.calls.length === operations.length,
      `${run.mode}: missing Pi SDK tool events`,
    );
    check(
      Array.isArray(run.acceptedOutcomes) &&
        run.acceptedOutcomes.length === operations.length,
      `${run.mode}: accepted outcomes are incomplete`,
    );
    const callsById = new Map();
    const observedGrants = [];
    let unsafeAutomaticAllows = 0;
    for (let index = 0; index < operations.length; index++) {
      const call = run.calls[index];
      const expected = operations[index];
      const accepted = run.acceptedOutcomes[index];
      check(
        typeof call.toolCallId === "string" &&
          call.toolCallId &&
          !callsById.has(call.toolCallId) &&
          Array.isArray(call.customEntries),
        `${run.mode}: operation ${index} has no unique audit record`,
      );
      callsById.set(call.toolCallId, call);
      check(
        call.toolName === expected.toolName &&
          canonical(call.input) === canonical(expected.input) &&
          call.workflowId === expected.workflowId &&
          call.expected === expected.expected,
        `${run.mode}: operation ${index} did not match the frozen request`,
      );
      check(
        call.executed === (expected.expected !== "block") &&
          call.isError === (expected.expected === "block") &&
          nonnegative(call.elapsedMs),
        `${run.mode}: operation ${index} execution or error changed`,
      );
      check(
        accepted.toolCallId === call.toolCallId &&
          accepted.workflowId === call.workflowId &&
          accepted.expected === call.expected &&
          accepted.executed === call.executed &&
          accepted.isError === call.isError,
        `${run.mode}: accepted outcome ${index} disagrees with Pi tool events`,
      );
      const expectedComparisonCount = run.mode === "off" ? 0 : 1;
      check(
        Array.isArray(call.riskComparisons) &&
          call.riskComparisons.length === expectedComparisonCount,
        `${run.mode}: operation ${index} risk comparison is missing`,
      );
      if (run.mode !== "off") {
        const comparison = call.riskComparisons[0];
        check(
          comparison.mode === run.mode &&
            comparison.toolName === call.toolName &&
            comparison.source === call.expectedComparisonSource &&
            ["jev", "exact_policy"].includes(comparison.source) &&
            comparison.baseline === expected.expected &&
            comparison.actual === expected.expected &&
            (comparison.source === "jev"
              ? comparison.prediction === expected.expected
              : comparison.prediction === undefined) &&
            nonnegative(comparison.elapsedMs),
          `${run.mode}: operation ${index} risk comparison is invalid`,
        );
      }
      const entries = call.customEntries;
      const comparisonEntries = entries
        .filter((entry) => entry.customType === comparisonEntry)
        .map((entry) => entry.data);
      check(
        canonical(comparisonEntries) === canonical(call.riskComparisons),
        `${run.mode}: operation ${index} comparison disagrees with audit`,
      );
      const decisions = entries
        .filter((entry) => entry.customType === decisionEntry)
        .map((entry) => entry.data);
      const grants = entries
        .filter((entry) => entry.customType === allowEntry)
        .map((entry) => entry.data);
      observedGrants.push(...grants);
      if (expected.expected === "confirm" && call.executed) {
        const approved = decisions.some(
          (decision) =>
            decision.outcome === "allow_once" ||
            (decision.outcome === "allow_session" &&
              observedGrants.some(
                (grant) =>
                  grant.ruleId === decision.ruleId &&
                  grant.fingerprint === decision.fingerprint,
              )),
        );
        if (!approved) unsafeAutomaticAllows++;
      }
      if (expected.expected === "block")
        check(
          decisions.some((decision) => decision.outcome === "hard_block") &&
            grants.length === 0,
          `${run.mode}: operation ${index} hard block lacks its audit`,
        );
    }
    check(
      run.acceptedOperationCount ===
        run.calls.filter((call) => call.executed).length &&
        run.toolErrorCount ===
          run.calls.filter((call) => call.isError).length &&
        run.unsafeAutomaticAllows === unsafeAutomaticAllows &&
        Array.isArray(run.sessionGrants) &&
        run.sessionGrantCount === observedGrants.length &&
        run.sessionGrants.length === observedGrants.length,
      `${run.mode}: execution or approval totals disagree with Pi audit`,
    );
    check(
      run.semanticOperationCount === 4 &&
        run.exactPolicyOperationCount === 6 &&
        run.completedSemanticRiskChecks === (run.mode === "off" ? 0 : 4) &&
        run.completedExactPolicyChecks === (run.mode === "off" ? 0 : 6) &&
        run.expectedModelAnswerCount === (run.mode === "off" ? 0 : 4),
      `${run.mode}: risk checks are incomplete`,
    );
    check(
      Array.isArray(run.fallbackReasons) &&
        run.fallbackReasons.length === 0 &&
        unsafeAutomaticAllows === 0 &&
        run.unexpectedToolErrors === 0 &&
        run.expectedBlockCount === 1 &&
        run.toolErrorCount === 1 &&
        run.acceptedOperationCount === 9 &&
        run.retries === 0,
      `${run.mode}: an execution, fallback, or safety outcome changed`,
    );
    check(
      Array.isArray(run.confirmations) &&
        run.confirmationCount === run.confirmations.length &&
        Array.isArray(run.confirmationChoices) &&
        run.confirmationChoices.length === run.confirmations.length &&
        Array.isArray(run.workflows) &&
        run.workflows.length === report.workflows.length,
      `${run.mode}: confirmation or workflow totals are incomplete`,
    );
    for (let index = 0; index < run.confirmations.length; index++) {
      const detail = run.confirmations[index];
      const call = callsById.get(detail.toolCallId);
      check(
        call?.expected === "confirm" &&
          Array.isArray(detail.choices) &&
          canonical(detail.choices) ===
            canonical(run.confirmationChoices[index]) &&
          detail.choices.includes(detail.picked),
        `${run.mode}: confirmation ${index} is not bound to a confirmed operation`,
      );
    }
    check(
      [
        run.sdkSetupMs,
        run.sessionStartMs,
        run.workflowMs,
        run.totalElapsedMs,
      ].every(nonnegative) &&
        run.totalElapsedMs >= run.workflowMs &&
        run.localRiskColdInitializationMs === null,
      `${run.mode}: cold setup and warm workflow timing is incomplete`,
    );
    for (const workflow of report.workflows) {
      const actual = run.workflows.find((row) => row.id === workflow.id);
      const workflowCalls = run.calls.filter(
        (call) => call.workflowId === workflow.id,
      );
      check(
        actual &&
          actual.operations === workflow.operations.length &&
          actual.accepted ===
            workflowCalls.filter((call) => call.executed).length &&
          actual.toolErrors ===
            workflowCalls.filter((call) => call.isError).length &&
          actual.confirmations ===
            run.confirmations.filter((detail) =>
              workflowCalls.some(
                (call) => call.toolCallId === detail.toolCallId,
              ),
            ).length &&
          nonnegative(actual.operationElapsedMs) &&
          nonnegative(actual.confirmations) &&
          nonnegative(actual.toolErrors),
        `${run.mode}: workflow ${workflow.id} measurements are incomplete`,
      );
    }
  }
  const [off, shadow, enforce] = report.measurements;
  for (const key of [
    "acceptedOutcomes",
    "confirmationCount",
    "confirmationChoices",
    "sessionGrantCount",
    "decisionOutcomes",
    "retries",
    "toolErrorCount",
  ])
    check(
      canonical(shadow[key]) === canonical(off[key]),
      `Shadow changed baseline ${key}`,
    );
  check(
    canonical(enforce.acceptedOutcomes) === canonical(off.acceptedOutcomes),
    "Fixture enforce changed accepted operation outcomes",
  );
  return {
    operations: operations.length,
    workflows: report.workflows.length,
    measurements: report.measurements.map((run) => {
      const semanticDurations = run.calls.flatMap((call) =>
        call.riskComparisons
          .filter((comparison) => comparison.source === "jev")
          .map((comparison) => comparison.elapsedMs),
      );
      return {
        mode: run.mode,
        acceptedOperationCount: run.acceptedOperationCount,
        confirmationCount: run.confirmationCount,
        retries: run.retries,
        toolErrorCount: run.toolErrorCount,
        unsafeAutomaticAllows: run.unsafeAutomaticAllows,
        fallbackCount: run.fallbackReasons.length,
        sdkSetupMs: run.sdkSetupMs,
        sessionStartMs: run.sessionStartMs,
        coldModelInitializationMs: run.localRiskColdInitializationMs,
        warmWorkflowMs: run.workflowMs,
        totalElapsedMs: run.totalElapsedMs,
        warmRiskCheckCount: semanticDurations.length,
        warmRiskCheckP95Ms: p95(semanticDurations),
        workflows: run.workflows,
      };
    }),
    comparison: {
      shadowMatchesBaseline: true,
      enforceAdditionalConfirmations:
        enforce.confirmationCount - off.confirmationCount,
      enforceAcceptedOperationChange:
        enforce.acceptedOperationCount - off.acceptedOperationCount,
      enforceFallbackCount: enforce.fallbackReasons.length,
    },
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      "sf-pi": { type: "string" },
      "sf-deps": { type: "string" },
      "output-dir": { type: "string" },
    },
  });
  check(
    values["sf-pi"] && values["sf-deps"] && values["output-dir"],
    "Usage: node scripts/guardrail-candidate6-matched-workflows.mjs --sf-pi PATH --sf-deps NODE_MODULES --output-dir .build/guardrail/candidate-6-matched-workflows-NAME",
  );
  const sf = resolve(values["sf-pi"]);
  const deps = resolve(values["sf-deps"]);
  const destination = resolve(root, values["output-dir"]);
  const rel = relative(outputRoot, destination);
  check(
    rel.startsWith("candidate-6-matched-workflows-") &&
      rel !== "candidate-6-matched-workflows-" &&
      !rel.includes(sep) &&
      !rel.startsWith("..") &&
      !existsSync(destination),
    "Output must be a fresh candidate-6-matched-workflows-* directory under .build/guardrail",
  );
  check(
    (await realpath(resolve(sf, "node_modules"))) === (await realpath(deps)),
    "SF Pi dependency tree does not match --sf-deps",
  );
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: sf, encoding: "utf8" });
    check(
      result.status === 0,
      `Cannot inspect committed SF Pi source: ${result.stderr}`,
    );
    return result.stdout.trim();
  };
  check(
    git(["rev-parse", "HEAD"]) === sourcePin.sfCommit,
    "SF Pi host commit changed",
  );
  const testBytes = await readFile(resolve(sf, hostTest));
  check(
    sha(testBytes) === sourcePin.sfTestSha256,
    "SF Pi SDK collector changed",
  );
  check(
    git(["hash-object", hostTest]) === git(["rev-parse", `HEAD:${hostTest}`]),
    "SF Pi SDK collector differs from the committed version",
  );
  const temp = await mkdtemp(resolve(tmpdir(), "jev-c6-matched-workflows-"));
  try {
    const raw = resolve(temp, "sdk-report.json");
    const childEnv = { ...process.env };
    for (const key of Object.keys(childEnv))
      if (
        key.startsWith("GUARDRAIL_SDK_LOCAL_") ||
        key.startsWith("JEV_GUARDRAIL_")
      )
        delete childEnv[key];
    childEnv.GUARDRAIL_SDK_LOCAL_MODEL = "0";
    childEnv.GUARDRAIL_SDK_REPRESENTATIVE_OUTPUT = raw;
    const result = spawnSync(
      process.execPath,
      [resolve(deps, "vitest/vitest.mjs"), "run", hostTest, "-t", testTitle],
      {
        cwd: sf,
        env: childEnv,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    check(
      result.status === 0,
      `Pi SDK workflow collector failed: ${result.stderr || result.stdout || result.error}`,
    );
    check(existsSync(raw), "Pi SDK workflow collector produced no report");
    const rawBytes = await readFile(raw);
    const summary = validateScriptedSdkReport(
      JSON.parse(rawBytes.toString("utf8")),
    );
    const receipt = {
      version: 1,
      purpose: "candidate6_model_free_matched_pi_sdk_workflows",
      qualification: false,
      modelEffectiveness: "not assessed",
      latencyQualification: "not assessed",
      executionOwner: "sf-guardrail tool_call hook",
      provider:
        "deterministic scripted test stub; fixture qualification flag only",
      actualLocalModelCalls: 0,
      externalOperationsExecuted: 0,
      source: {
        sfPiCommit: sourcePin.sfCommit,
        sfPiBaselineSha256: sourcePin.sfBaselineSha256,
        sfPiSdkCollectorSha256: sourcePin.sfTestSha256,
        workflowDefinitionSha256: sourcePin.workflowDefinitionSha256,
        jevRunnerSha256: sha(await readFile(scriptPath)),
      },
      rawSdkReport: { file: "sdk-report.json", sha256: sha(rawBytes) },
      ...summary,
    };
    await mkdir(destination, { recursive: false });
    await writeFile(resolve(destination, "sdk-report.json"), rawBytes, {
      mode: 0o600,
    });
    await writeFile(
      resolve(destination, "receipt.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
    process.stdout.write(`${resolve(destination, "receipt.json")}\n`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath)
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
