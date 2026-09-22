#!/usr/bin/env node
/** Model-free, operation-free host routing replay for Candidate 9 sealed VALID only. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceFile = resolve(root, "blind-c9-20260922/valid.json");
const { values } = parseArgs({
  options: {
    "sf-pi": { type: "string" },
    "sf-deps": { type: "string" },
    "jev-runtime": { type: "string" },
    output: { type: "string" },
  },
});
if (!values["sf-pi"] || !values["sf-deps"])
  throw new Error("Required: --sf-pi DIR --sf-deps NODE_MODULES");
const sfRoot = resolve(values["sf-pi"]);
const sfDeps = resolve(values["sf-deps"]);
const jevRuntimeRoot = resolve(values["jev-runtime"] ?? root);
const output = resolve(
  values.output ?? resolve(root, ".build/guardrail/c9-valid-preflight.json"),
);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const [
  { canonical },
  { GUARDRAIL_PROTOCOL_SHA256 },
  { C8_BASE_PROTOCOL_SHA256 },
] = await Promise.all([
  import(pathToFileURL(resolve(jevRuntimeRoot, "dist/core.js")).href),
  import(pathToFileURL(resolve(jevRuntimeRoot, "dist/guardrail.js")).href),
  import(
    pathToFileURL(resolve(jevRuntimeRoot, "dist/guardrail-calibration.js")).href
  ),
]);
const sourceBytes = await readFile(sourceFile);
const manifestBytes = await readFile(resolve(root, "blind-c9-20260922/manifest.json"));
const manifest = JSON.parse(manifestBytes);
if (manifest.source?.sha256 !== sha(sourceBytes) || manifest.source?.case_count !== 160)
  throw new Error("C9 VALID source differs from sealed manifest");
const source = JSON.parse(sourceBytes);
if (
  source.schema_version !== "c9.1" ||
  source.split !== "valid" ||
  source.cases.length !== 160
)
  throw new Error("Unexpected Candidate 9 VALID source");

const detectUrl = pathToFileURL(
  resolve(sfRoot, "lib/common/sf-environment/detect.ts"),
).href;
const stubUrl = pathToFileURL(
  resolve(root, "scripts/guardrail-v3-research-detect-stub.mjs"),
).href;
const dependencyParent = pathToFileURL(
  resolve(sfDeps, "__c9_valid_resolver__.mjs"),
).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    let result;
    try {
      result = nextResolve(specifier, context);
    } catch (error) {
      if (
        error.code !== "ERR_MODULE_NOT_FOUND" ||
        specifier.startsWith(".") ||
        specifier.startsWith("/") ||
        specifier.startsWith("node:")
      )
        throw error;
      result = nextResolve(specifier, {
        ...context,
        parentURL: dependencyParent,
      });
    }
    return result.url === detectUrl
      ? { url: stubUrl, shortCircuit: true }
      : result;
  },
});

const fakeAgentDir = await mkdtemp(resolve(tmpdir(), "c9-valid-host-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = fakeAgentDir;
try {
  const sfImport = (path) => import(pathToFileURL(resolve(sfRoot, path)).href);
  const [
    { readBundledConfig },
    { evaluateSafety },
    { jevRiskEligible, jevRiskPolicyFloor, prepareJevRiskInput, getJevRiskPolicySha256 },
    { clearSharedSfEnvironment, restoreFromSessionEntries },
    { writeLatestBrowserSnapshotRefs, markLatestBrowserSnapshotStale },
    { calculateJevRiskBaselineIdentity },
  ] = await Promise.all([
    sfImport("extensions/sf-guardrail/lib/config.ts"),
    sfImport("extensions/sf-guardrail/lib/safety-kernel.ts"),
    sfImport("extensions/sf-guardrail/lib/jev-risk.ts"),
    sfImport("lib/common/sf-environment/shared-runtime.ts"),
    sfImport("lib/common/sf-browser-snapshot-state.ts"),
    sfImport("extensions/sf-guardrail/lib/risk-baseline-identity.ts"),
  ]);

  const status = [];
  for (const row of source.cases) {
    const toolName = row.operation.tool;
    const operation = row.operation.input;
    const org = row.fixture.observations?.org;
    const browserRef = row.fixture.observations?.browserRef;
    const browserPage = row.fixture.observations?.browserPage;
    // Unknown orgs and stale/missing browser refs are intentional fallback
    // cases. Never let the replay discover a real org or browser session.
    const shellSf =
      ["bash", "herdr_pane"].includes(toolName) &&
      /\b(?:sf|sfdx)\s/.test(operation.command ?? "");
    const nativeOrg =
      ["sf_apex", "agentscript_lifecycle", "sf_soql"].includes(toolName) ||
      toolName.startsWith("data360_");
    const preModelFallback =
      (shellSf || nativeOrg) && !org
        ? "org_fact_unavailable"
        : toolName === "sf_browser_click" &&
            (!browserRef || browserRef.status !== "fresh" || !browserPage)
          ? "browser_evidence_unavailable"
          : null;
    const cwd = row.fixture.cwd;
    const sessionId = `c9-valid-${row.id}`;
    const operationSha256 = sha(canonical({ toolName, input: operation, cwd }));
    const caseIdentity = {
      id: row.id,
      family: row.family,
      group_id: row.group_id,
      expected: row.expected.decision,
      operation_sha256: operationSha256,
    };
    clearSharedSfEnvironment(cwd);
    if (org) {
      const env = {
        cli: { installed: true, version: "2.0.0" },
        project: { detected: true },
        config: {
          hasTargetOrg: true,
          targetOrg: org.alias,
          location: "Global",
        },
        org: {
          detected: true,
          alias: org.alias,
          username: `${org.alias.toLowerCase()}@example.test`,
          orgType: org.type,
        },
        detectedAt: 0,
      };
      restoreFromSessionEntries(
        {
          sessionManager: {
            getBranch: () => [
              { type: "custom", customType: "sf-environment", data: { env } },
            ],
          },
        },
        cwd,
      );
    }
    if (browserPage) {
      const capture = writeLatestBrowserSnapshotRefs({
        sessionId,
        snapshot: browserPage.snapshot,
        url: browserPage.url,
      });
      if (
        capture.snapshotSha256 !== browserPage.snapshotSha256 ||
        !capture.refs.some(
          (ref) => ref.ref === operation.ref.replace(/^@/, "") && ref.label === browserRef.label,
        )
      )
        throw new Error(`Invalid authored browser observation: ${row.id}`);
      if (browserRef?.status === "stale")
        markLatestBrowserSnapshotStale(sessionId, "C9 mocked navigation invalidated the captured ref");
    }
    let config = readBundledConfig();
    const behaviors = row.fixture.policyBehaviors;
    if (behaviors) {
      for (const ruleId of Object.keys(behaviors))
        if (!config.policies.rules.some((rule) => rule.id === ruleId))
          throw new Error(`Unknown exact policy ${ruleId} for ${row.id}`);
      config = {
        ...config,
        policies: {
          ...config.policies,
          rules: config.policies.rules.map((rule) =>
            Object.hasOwn(behaviors, rule.id)
              ? { ...rule, behavior: behaviors[rule.id] }
              : rule,
          ),
        },
      };
    }
    caseIdentity.policy_sha256 = getJevRiskPolicySha256(config);
    const input = { toolName, input: operation, cwd, sessionId, config };
    let baselineAction = null;
    try {
      const baseline = await evaluateSafety(input);
      baselineAction = baseline?.action ?? "allow";
      if (preModelFallback) {
        status.push({
          ...caseIdentity,
          routing: "pre_model_fallback",
          reason: preModelFallback,
          baseline_action: baselineAction,
          risk_input_sha256: null,
        });
        continue;
      }
      const eligible = jevRiskEligible(input);
      const floor = eligible && jevRiskPolicyFloor(input, baseline);
      if (!eligible || floor) {
        status.push({
          ...caseIdentity,
          routing: "rules_fallback",
          reason: !eligible ? "ineligible" : "host_policy_floor",
          baseline_action: baselineAction,
          risk_input_sha256: null,
        });
        continue;
      }
      const prepared = await prepareJevRiskInput(input, baseline);
      if (
        prepared.toolName !== toolName ||
        JSON.stringify(prepared.input) !== JSON.stringify(operation)
      )
        throw new Error("Prepared operation differs from authored request");
      if (
        org &&
        !prepared.facts.orgs?.some(
          (fact) => fact.type === org.type && fact.guessed === false,
        )
      )
        throw new Error("Independent org fact missing from prepared input");
      status.push({
        ...caseIdentity,
        routing: "model_prepared",
        baseline_action: baselineAction,
        risk_input_sha256: sha(canonical(prepared)),
      });
    } catch (error) {
      const reason = String(error.message ?? error).slice(0, 240);
      const expectedFallback = reason === "Jev Salesforce org target is ambiguous; using Safety Kernel fallback";
      status.push({
        ...caseIdentity,
        routing: expectedFallback ? "pre_model_fallback" : "preparation_error",
        reason,
        baseline_action: baselineAction,
        risk_input_sha256: null,
      });
    }
  }
  const summary = {};
  for (const row of status) {
    const lane = (summary[row.family] ??= {
      total: 0,
      model_prepared: 0,
      risky_prepared: 0,
      rules_fallback: 0,
      pre_model_fallback: 0,
      preparation_error: 0,
      baseline_blocks: 0,
    });
    lane.total++;
    lane[row.routing]++;
    if (row.routing === "model_prepared" && row.expected === "require_approval")
      lane.risky_prepared++;
    if (row.baseline_action === "block") lane.baseline_blocks++;
  }
  if (
    status.some((row) => row.routing === "preparation_error") ||
    status.filter((row) => row.expected === "hard_block").length !== 2 ||
    status.some((row) => row.expected === "hard_block" && row.baseline_action !== "block")
  )
    throw new Error(`C9 VALID preflight did not preserve all exact hard blocks: ${JSON.stringify(status.filter((row) => row.routing === "preparation_error" || row.expected === "hard_block"))}`);
  const hostCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: sfRoot,
    encoding: "utf8",
  }).trim();
  const runtimeCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: jevRuntimeRoot,
    encoding: "utf8",
  }).trim();
  const hostBaselineIdentity = calculateJevRiskBaselineIdentity();
  if (hostCommit !== manifest.host.commit ||
      hostBaselineIdentity.sha256 !== manifest.host.baseline_identity_sha256 ||
      getJevRiskPolicySha256(readBundledConfig()) !== manifest.host.default_policy_sha256)
    throw new Error(`C9 host differs from sealed manifest: commit=${hostCommit} baseline=${hostBaselineIdentity.sha256} policy=${getJevRiskPolicySha256(readBundledConfig())}`);
  const receipt = {
    version: 1,
    source: "blind-c9-20260922/valid.json",
    source_sha256: sha(sourceBytes),
    manifest_sha256: sha(manifestBytes),
    default_policy_sha256: getJevRiskPolicySha256(readBundledConfig()),
    rubric_sha256: sha(
      await readFile(resolve(root, "fixtures/guardrail/RUBRIC.md")),
    ),
    case_schema_sha256: sha(
      await readFile(resolve(root, "blind-c9-20260922/case.schema.json")),
    ),
    host_commit: hostCommit,
    host_baseline_sha256: hostBaselineIdentity.sha256,
    jev_runtime_commit: runtimeCommit,
    jev_runtime_core_js_sha256: sha(
      await readFile(resolve(jevRuntimeRoot, "dist/core.js")),
    ),
    jev_runtime_guardrail_js_sha256: sha(
      await readFile(resolve(jevRuntimeRoot, "dist/guardrail.js")),
    ),
    jev_runtime_calibration_js_sha256: sha(
      await readFile(resolve(jevRuntimeRoot, "dist/guardrail-calibration.js")),
    ),
    preflight_script_sha256: sha(
      await readFile(fileURLToPath(import.meta.url)),
    ),
    decision_base_protocol_sha256: C8_BASE_PROTOCOL_SHA256,
    scorer_prompt_sha256: GUARDRAIL_PROTOCOL_SHA256,
    model_protocol_sha256: GUARDRAIL_PROTOCOL_SHA256,
    mode: "fake-facts-no-model-no-execution",
    operation_sha256_contract:
      "sha256(jev canonical({toolName,input:originalOperation,cwd}))",
    label_review: "machine_authored_human_review_pending",
    summary,
    status,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ output, summary }, null, 2));
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(fakeAgentDir, { recursive: true, force: true });
}
