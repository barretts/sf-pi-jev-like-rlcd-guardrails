#!/usr/bin/env node
/** FIT-only, model-free C11 diagnostic against the current frozen C10 host. */
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = "fixtures/guardrail/candidate11/fit-counterfactuals.draft.jsonl";
const outputPath = "fixtures/guardrail/candidate11/host-fit-replay-c10.draft.json";
const fitPath = "reports/guardrail-risk-2026-09-21/candidate-9-evidence/train/fit.jsonl";
const rubricPath = "fixtures/guardrail/RUBRIC.md";
const pins = {
  sourceSha256: "6ec3e800c3e7a73dda9fd65fed88804c8d3a939bdb44dc84621fd71d7901a24b",
  admittedFitSha256: "8071644e852b1399732e0b5d47f52989239dbf79f38bdcac535167675182ae25",
  rubricSha256: "cad1720e8ee31c153985ee98af010671d323917c0ef30c7ebd61c3832b318ae6",
  hostCommit: "a4ba5fe5f86bc0cb01ab85c037bb05114a26ff8a",
  hostRuntimeSha256: "0a23e057fb433fc4ee2ecd42465b377c660db5e024b6a406f6994497eba693b2",
  hostPolicySha256: "e02e9c0914c1b1395adb0b341d6149b54b0b514c2b86cceab44994b5f6425347",
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const need = (condition, message) => {
  if (!condition) throw new Error(`C11 FIT replay: ${message}`);
};
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
      : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const parseJsonl = (bytes) => bytes.toString("utf8").trimEnd().split("\n").map(JSON.parse);
const { values } = parseArgs({
  options: { "sf-pi": { type: "string" }, "sf-deps": { type: "string" } },
});
const sfRoot = resolve(values["sf-pi"] ?? "/private/tmp/sf-pi-guardrail-c10-qualification-20260922");
const sfDeps = resolve(values["sf-deps"] ?? "/private/tmp/sf-pi-guardrail-c10-qualification-20260922/node_modules");
// Verify the worktree commit with local file reads; no subprocess is used.
const gitPointer = await readFile(resolve(sfRoot, ".git"), "utf8");
need(gitPointer.startsWith("gitdir: "), "expected a frozen Git worktree");
const gitDir = resolve(sfRoot, gitPointer.slice(8).trim());
const commonDir = resolve(gitDir, (await readFile(resolve(gitDir, "commondir"), "utf8")).trim());
const headText = (await readFile(resolve(gitDir, "HEAD"), "utf8")).trim();
const initialHead = headText.startsWith("ref: ")
  ? (await readFile(resolve(commonDir, headText.slice(5)), "utf8")).trim()
  : headText;
need(initialHead === pins.hostCommit, "host commit differs from C10 pin");
const [sourceBytes, fitBytes, rubricBytes] = await Promise.all(
  [sourcePath, fitPath, rubricPath].map((path) => readFile(resolve(root, path))),
);
need(sha(sourceBytes) === pins.sourceSha256, "draft FIT bytes changed");
need(sha(fitBytes) === pins.admittedFitSha256, "admitted C9 FIT bytes changed");
need(sha(rubricBytes) === pins.rubricSha256, "operation-policy-v2 rubric changed");
const rows = parseJsonl(sourceBytes);
const inherited = new Map(parseJsonl(fitBytes).map((row) => [row.id, row]));

// Independent mock observations are explicit scenarios. They do not read the
// draft's targets, embedded org facts, alias wording, or baseline decisions.
const aliases = [
  ["neutral-a", "C11TargetA"], ["neutral-b", "C11TargetB"],
  ["prod-named", "C11ProdNamed"], ["sandbox-named", "C11SandboxNamed"],
];
const families = [
  { slug: "delete-bash", toolName: "bash", group: "c5-draft-diversity-local-salesforce-02",
    reference: "c5-draft-diversity-local-salesforce-02-safe", oldAlias: "NuanceTarget732" },
  { slug: "create-rest-bash", toolName: "bash", group: "c5-salesforce-rest-account-basic-info",
    reference: "c5-rest-org-sandbox-post-bash", oldAlias: "C5Target905" },
  { slug: "create-rest-pane", toolName: "herdr_pane", group: "c5-salesforce-rest-account-basic-info",
    reference: "c5-rest-org-sandbox-post-pane", oldAlias: "C5Target905" },
];
const scenarios = families.flatMap((family) => aliases.flatMap(([slug, alias]) =>
  ["sandbox", "production"].map((orgType) => ({
    ...family, id: `c11-draft-${family.slug}-${slug}-${orgType}`, alias, orgType,
    rubricExpected: orgType === "sandbox" ? "allow" : "confirm",
  })),
));
need(rows.length === 24 && new Set(rows.map((row) => row.id)).size === 24, "expected 24 unique FIT rows");
const byId = new Map(rows.map((row) => [row.id, row]));
need(scenarios.every((scenario) => byId.has(scenario.id)), "draft scenario catalog differs");

const attempts = { externalProcess: 0, network: 0, mockedDiscovery: 0 };
const blocked = (kind) => () => { attempts[kind]++; throw new Error(`C11 FIT replay forbids ${kind}`); };
for (const key of ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"])
  childProcess[key] = blocked("externalProcess");
for (const module of [http, https])
  for (const key of ["request", "get"]) module[key] = blocked("network");
net.connect = net.createConnection = tls.connect = blocked("network");
globalThis.fetch = blocked("network");
syncBuiltinESMExports();
globalThis.__c11MockDiscovery = () => attempts.mockedDiscovery++;
const detectStub = "data:text/javascript," + encodeURIComponent([
  "export function detectProject(cwd){globalThis.__c11MockDiscovery();return{detected:false,projectRoot:cwd}}",
  "export async function detectConfig(){globalThis.__c11MockDiscovery();return{hasTargetOrg:false}}",
  "export async function detectOrg(){globalThis.__c11MockDiscovery();return{detected:false,orgType:'unknown'}}",
  "export async function detectEnvironment(){globalThis.__c11MockDiscovery();return{cli:{installed:false},project:{detected:false},config:{hasTargetOrg:false},org:{detected:false,orgType:'unknown'},detectedAt:0}}",
].join("\n"));
const detectUrl = pathToFileURL(resolve(sfRoot, "lib/common/sf-environment/detect.ts")).href;
const dependencyParent = pathToFileURL(resolve(sfDeps, "__c11_fit_host_resolver__.mjs")).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    let found;
    try { found = nextResolve(specifier, context); }
    catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND" || /^[./]/.test(specifier) || specifier.startsWith("node:")) throw error;
      found = nextResolve(specifier, { ...context, parentURL: dependencyParent });
    }
    return found.url === detectUrl ? { url: detectStub, shortCircuit: true } : found;
  },
});
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = `/private/tmp/c11-fit-replay-unused-agent-dir-${process.pid}`;
try {
  const sfImport = (path) => import(pathToFileURL(resolve(sfRoot, path)).href);
  const [
    { readBundledConfig }, { evaluateSafety },
    { jevRiskEligible, jevRiskPolicyFloor, prepareJevRiskInput, getJevRiskPolicySha256 },
    { salesforceOrgTarget, resolveOrgContext },
    { clearSharedSfEnvironment, restoreFromSessionEntries },
    { getJevRiskBaselineSha256, calculateJevRiskBaselineIdentity },
  ] = await Promise.all([
    sfImport("extensions/sf-guardrail/lib/config.ts"),
    sfImport("extensions/sf-guardrail/lib/safety-kernel.ts"),
    sfImport("extensions/sf-guardrail/lib/jev-risk.ts"),
    sfImport("extensions/sf-guardrail/lib/org-context.ts"),
    sfImport("lib/common/sf-environment/shared-runtime.ts"),
    sfImport("extensions/sf-guardrail/lib/risk-baseline-identity.ts"),
  ]);
  const config = readBundledConfig();
  need(getJevRiskBaselineSha256() === pins.hostRuntimeSha256, "host runtime SHA differs");
  need(getJevRiskPolicySha256(config) === pins.hostPolicySha256, "host policy SHA differs");
  const statuses = [];
  for (const scenario of scenarios) {
    const row = byId.get(scenario.id), state = row.request.state;
    const reference = inherited.get(scenario.reference);
    need(reference, "admitted source operation missing");
    const expectedInput = { ...reference.request.state.input,
      command: reference.request.state.input.command.replace(scenario.oldAlias, scenario.alias) };
    need(state.toolName === scenario.toolName && same(state.input, expectedInput), `operation changed: ${row.id}`);
    need(row.split === "train" && row.group_id === scenario.group, `FIT ancestry changed: ${row.id}`);
    const requestTemplate = ({ state: omitted, ...template }) => template;
    need(same(requestTemplate(row.request), requestTemplate(reference.request)), `request protocol changed: ${row.id}`);
    need(row.request.model === "google/gemma-3-1b-it", "unexpected model lineage");
    const target = salesforceOrgTarget(state.input.command);
    need(target.kind === "invocation" && target.targetOrg === scenario.alias, `literal target mismatch: ${row.id}`);
    const cwd = `/example/c11-independent-mock/${row.id}`;
    clearSharedSfEnvironment(cwd);
    const env = {
      cli: { installed: true, version: "2.0.0" }, project: { detected: true },
      config: { hasTargetOrg: true, targetOrg: scenario.alias, location: "Global" },
      org: { detected: true, alias: scenario.alias, orgType: scenario.orgType }, detectedAt: 0,
    };
    restoreFromSessionEntries({ sessionManager: { getBranch: () => [
      { type: "custom", customType: "sf-environment", data: { env } },
    ] } }, cwd);
    const resolved = resolveOrgContext(state.input.command, cwd, config.productionAliases);
    const input = { toolName: scenario.toolName, input: state.input, cwd, config, sessionId: row.id };
    const baseline = await evaluateSafety(input);
    const eligible = jevRiskEligible(input), floor = eligible && jevRiskPolicyFloor(input, baseline);
    const status = {
      id: row.id, groupId: row.group_id, toolName: scenario.toolName,
      independentObservation: { kind: "mock_session_cache", alias: scenario.alias, type: scenario.orgType, liveVerified: false },
      resolvedOrg: { alias: resolved.alias, type: resolved.type, guessed: resolved.guessed, source: resolved.source },
      expected: row.targets.risk.answer, rubricExpected: scenario.rubricExpected,
      rubricConsistent: row.targets.risk.answer === scenario.rubricExpected,
      eligible, codeOwnedFloor: floor, baselineAction: baseline?.action ?? "allow", ruleId: baseline?.ruleId ?? null,
      baselineFeature: baseline?.feature ?? null,
      gate: !eligible ? "ineligible" : floor ? "code_owned_floor" : "prepare_pending",
      admitted: false,
    };
    if (eligible && !floor) {
      try {
        const preparedState = await prepareJevRiskInput(input, baseline);
        status.preparedState = preparedState;
        status.factParity = same(preparedState, state);
        status.mockProjectionConsistent = preparedState.facts.orgs?.length === 1 &&
          preparedState.facts.orgs[0].type === scenario.orgType && preparedState.facts.orgs[0].guessed === false &&
          preparedState.facts.orgs[0].command === state.input.command;
        status.gate = status.factParity && status.mockProjectionConsistent && status.rubricConsistent
          ? "model_prepared_mock_only" : "projection_or_rubric_mismatch";
        status.preparedStateSha256 = sha(JSON.stringify(canonical(preparedState)));
      } catch (error) { status.gate = "prepare_error"; status.reason = error.message; }
    }
    statuses.push(status);
    clearSharedSfEnvironment(cwd);
  }
  need(calculateJevRiskBaselineIdentity().sha256 === pins.hostRuntimeSha256, "host runtime changed during replay");
  for (const [path, digest] of [[sourcePath, pins.sourceSha256], [fitPath, pins.admittedFitSha256], [rubricPath, pins.rubricSha256]])
    need(sha(await readFile(resolve(root, path))) === digest, "input changed during replay");
  const receipt = {
    version: 1, purpose: "candidate11_fit_mock_current_c10_host_replay_draft", qualification: false, admitted: false,
    modelCalls: 0, externalOperationsExecuted: 0, trainingExecuted: false,
    calBodyRead: false, validBodyRead: false, testBodyRead: false, predictionsRead: false,
    source: { ...pins, sourcePath, fitPath, rubricPath, sfPiPath: sfRoot, dependencyPath: sfDeps,
      scriptSha256: sha(await readFile(fileURLToPath(import.meta.url))) },
    independence: {
      mockCatalogDefinedInReplayScript: true, resolverSeedReadsRequestFacts: false, resolverSeedReadsTargets: false,
      rubricExpectedReadsTargets: false, aliasTextDeterminesOrgType: false,
      authorFactsRemainMocked: true, liveOrgResolutionPerformed: false,
      evidenceLimit: "Separate explicit mock scenarios exercise the real frozen cache resolver and risk-input preparer. They verify synthetic projection consistency, not externally verified organization identities or human label review.",
    },
    counts: { rows: statuses.length, groups: new Set(statuses.map((row) => row.groupId)).size,
      eligible: statuses.filter((row) => row.eligible).length,
      codeOwnedFloors: statuses.filter((row) => row.codeOwnedFloor).length,
      modelPreparedMockOnly: statuses.filter((row) => row.gate === "model_prepared_mock_only").length,
      rubricConsistent: statuses.filter((row) => row.rubricConsistent).length,
      factParity: statuses.filter((row) => row.factParity).length,
      admitted: 0 },
    blockedAttempts: attempts,
    codeOwnedFloorInventory: statuses.filter((row) => row.codeOwnedFloor).map(({ id, baselineAction, ruleId }) => ({ id, baselineAction, ruleId })),
    statuses,
    admission: { decision: "retain_unadmitted", reason: "No admission action is performed by this diagnostic. The existing source-admission workflow has not been rerun with these draft additions. Controlled mocks establish synthetic projection parity only; author claims remain mocked and human label review remains pending." },
    proofLimit: "Actual model-free FIT preparation against pinned current C10 sf-pi runtime/policy; no model inference, external execution, held-out data access, training, qualification, or host modification.",
  };
  await writeFile(resolve(root, outputPath), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ output: resolve(root, outputPath), ...receipt.counts, blockedAttempts: attempts }));
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
}
