#!/usr/bin/env node
/** Model-free, operation-free host routing replay for Candidate 8 VALID only. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonical } from "../dist/core.js";
import { GUARDRAIL_PROTOCOL_SHA256 } from "../dist/guardrail.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceFile = resolve(root, "blind-c8-20260922/valid.json");
const { values } = parseArgs({ options: {
  "sf-pi": { type: "string" },
  "sf-deps": { type: "string" },
  output: { type: "string" },
} });
if (!values["sf-pi"] || !values["sf-deps"])
  throw new Error("Required: --sf-pi DIR --sf-deps NODE_MODULES");
const sfRoot = resolve(values["sf-pi"]);
const sfDeps = resolve(values["sf-deps"]);
const output = resolve(values.output ?? resolve(root, ".build/guardrail/c8-valid-preflight.json"));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const sourceBytes = await readFile(sourceFile);
const source = JSON.parse(sourceBytes);
if (source.schema_version !== "c8.2" || source.split !== "valid" || source.cases.length !== 96)
  throw new Error("Unexpected Candidate 8 VALID source");

const detectUrl = pathToFileURL(resolve(sfRoot, "lib/common/sf-environment/detect.ts")).href;
const stubUrl = pathToFileURL(resolve(root, "scripts/guardrail-v3-research-detect-stub.mjs")).href;
const dependencyParent = pathToFileURL(resolve(sfDeps, "__c8_valid_resolver__.mjs")).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    let result;
    try { result = nextResolve(specifier, context); }
    catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND" || specifier.startsWith(".") ||
          specifier.startsWith("/") || specifier.startsWith("node:")) throw error;
      result = nextResolve(specifier, { ...context, parentURL: dependencyParent });
    }
    return result.url === detectUrl ? { url: stubUrl, shortCircuit: true } : result;
  },
});

const fakeAgentDir = await mkdtemp(resolve(tmpdir(), "c8-valid-host-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = fakeAgentDir;
try {
  const sfImport = (path) => import(pathToFileURL(resolve(sfRoot, path)).href);
  const [
    { readBundledConfig },
    { evaluateSafety },
    { jevRiskEligible, jevRiskPolicyFloor, prepareJevRiskInput },
    { clearSharedSfEnvironment, restoreFromSessionEntries },
    { writeLatestBrowserSnapshotRefs },
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
    const shellSf = ["bash", "herdr_pane"].includes(toolName) &&
      /\b(?:sf|sfdx)\s/.test(operation.command ?? "");
    const nativeOrg = ["sf_apex", "agentscript_lifecycle", "sf_soql"].includes(toolName) ||
      toolName.startsWith("data360_");
    const preModelFallback = (shellSf || nativeOrg) && !org
      ? "org_fact_unavailable"
      : toolName === "sf_browser_click" && (!browserRef || browserRef.status !== "fresh" || !browserPage)
        ? "browser_evidence_unavailable"
        : null;
    const cwd = "/workspace/c8-valid";
    const sessionId = `c8-valid-${row.id}`;
    clearSharedSfEnvironment(cwd);
    if (org) {
      const env = {
        cli: { installed: true, version: "2.0.0" },
        project: { detected: true },
        config: { hasTargetOrg: true, targetOrg: org.alias, location: "Global" },
        org: { detected: true, alias: org.alias, username: `${org.alias.toLowerCase()}@example.test`, orgType: org.type },
        detectedAt: 0,
      };
      restoreFromSessionEntries({ sessionManager: { getBranch: () => [
        { type: "custom", customType: "sf-environment", data: { env } },
      ] } }, cwd);
    }
    if (browserPage) {
      const capture = writeLatestBrowserSnapshotRefs({ sessionId, snapshot: browserPage.snapshot, url: browserPage.url });
      if (capture.snapshotSha256 !== browserPage.snapshotSha256 ||
          !capture.refs.some((ref) => ref.ref === operation.ref && ref.label === browserRef.label))
        throw new Error(`Invalid authored browser observation: ${row.id}`);
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
            Object.hasOwn(behaviors, rule.id) ? { ...rule, behavior: behaviors[rule.id] } : rule),
        },
      };
    }
    const input = { toolName, input: operation, cwd, sessionId, config };
    try {
      const baseline = await evaluateSafety(input);
      const baselineAction = baseline?.action ?? "allow";
      if (preModelFallback) {
        status.push({ id: row.id, family: row.family, routing: "pre_model_fallback", reason: preModelFallback, baseline_action: baselineAction, risk_input_sha256: null });
        continue;
      }
      const eligible = jevRiskEligible(input);
      const floor = eligible && jevRiskPolicyFloor(input, baseline);
      if (!eligible || floor) {
        status.push({ id: row.id, family: row.family, routing: "rules_fallback", reason: !eligible ? "ineligible" : "host_policy_floor", baseline_action: baselineAction, risk_input_sha256: null });
        continue;
      }
      const prepared = await prepareJevRiskInput(input, baseline);
      if (prepared.toolName !== toolName || JSON.stringify(prepared.input) !== JSON.stringify(operation))
        throw new Error("Prepared operation differs from authored request");
      if (org && !prepared.facts.orgs?.some((fact) => fact.type === org.type && fact.guessed === false))
        throw new Error("Independent org fact missing from prepared input");
      status.push({ id: row.id, family: row.family, routing: "model_prepared", expected: row.expected.decision, baseline_action: baselineAction, risk_input_sha256: sha(canonical(prepared)) });
    } catch (error) {
      status.push({ id: row.id, family: row.family, routing: "preparation_error", reason: String(error.message ?? error).slice(0, 240), baseline_action: null, risk_input_sha256: null });
    }
  }
  const summary = {};
  for (const row of status) {
    const lane = summary[row.family] ??= { total: 0, model_prepared: 0, risky_prepared: 0, rules_fallback: 0, pre_model_fallback: 0, preparation_error: 0, baseline_blocks: 0 };
    lane.total++;
    lane[row.routing]++;
    if (row.routing === "model_prepared" && row.expected === "require_approval") lane.risky_prepared++;
    if (row.baseline_action === "block") lane.baseline_blocks++;
  }
  if (status.some((row) => row.routing === "preparation_error") ||
      summary.exact_policy?.baseline_blocks !== 3)
    throw new Error("VALID preflight did not preserve all exact hard blocks");
  const hostCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sfRoot, encoding: "utf8" }).trim();
  const hostBaselineIdentity = calculateJevRiskBaselineIdentity();
  const receipt = {
    version: 1,
    source: "blind-c8-20260922/valid.json",
    source_sha256: sha(sourceBytes),
    rubric_sha256: sha(await readFile(resolve(root, "fixtures/guardrail/RUBRIC.md"))),
    case_schema_sha256: sha(await readFile(resolve(root, "blind-c8-20260922/case.schema.json"))),
    host_commit: hostCommit,
    host_baseline_sha256: hostBaselineIdentity.sha256,
    model_protocol_sha256: GUARDRAIL_PROTOCOL_SHA256,
    mode: "fake-facts-no-model-no-execution",
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
