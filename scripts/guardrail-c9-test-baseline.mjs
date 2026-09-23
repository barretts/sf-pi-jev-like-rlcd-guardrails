#!/usr/bin/env node
/**
 * Future C9 blind-side TEST baseline replay. It registers a model-free sentinel
 * provider in sf-pi shadow mode, never a tool handler or a model worker.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptFile = fileURLToPath(import.meta.url);
const stubFile = resolve(root, "scripts/guardrail-v3-research-detect-stub.mjs");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isPin = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const isCommit = (value) =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const gitHead = (cwd) =>
  execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
const label = Object.freeze({
  allow: "allow",
  require_approval: "confirm",
  hard_block: "block",
});

async function regularBytes(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`Expected regular, non-symlink file: ${path}`);
  return readFile(path);
}

function installResolver(sfPi, sfDeps) {
  const detectUrl = pathToFileURL(
    resolve(sfPi, "lib/common/sf-environment/detect.ts"),
  ).href;
  const stubUrl = pathToFileURL(stubFile).href;
  const dependencyParent = pathToFileURL(
    resolve(sfDeps, "__c9_model_free_preflight__.mjs"),
  ).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      let found;
      try {
        found = nextResolve(specifier, context);
      } catch (error) {
        if (
          error.code !== "ERR_MODULE_NOT_FOUND" ||
          specifier.startsWith(".") ||
          specifier.startsWith("/") ||
          specifier.startsWith("node:")
        )
          throw error;
        found = nextResolve(specifier, {
          ...context,
          parentURL: dependencyParent,
        });
      }
      return found.url === detectUrl
        ? { url: stubUrl, shortCircuit: true }
        : found;
    },
  });
}

function installOrg(row, cwd, clear, restore) {
  clear(cwd);
  const org = row.fixture?.observations?.org;
  if (!org) return;
  if (
    typeof org.alias !== "string" ||
    !org.alias ||
    ![
      "production",
      "sandbox",
      "scratch",
      "developer",
      "trial",
      "unknown",
    ].includes(org.type) ||
    typeof org.guessed !== "boolean"
  )
    throw new Error(`Invalid independent org fact: ${row.id}`);
  const env = {
    cli: { installed: true, version: "2.0.0" },
    project: { detected: true },
    config: { hasTargetOrg: true, targetOrg: org.alias, location: "Global" },
    org: {
      detected: !org.guessed,
      alias: org.alias,
      username: `${org.alias.toLowerCase()}@example.test`,
      orgType: org.type,
    },
    detectedAt: 0,
  };
  restore(
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

function installBrowser(row, sessionId, browser) {
  const ref = row.fixture?.observations?.browserRef;
  const page = row.fixture?.observations?.browserPage;
  if (!page) return;
  if (
    page.status !== "fresh" ||
    typeof page.snapshot !== "string" ||
    sha(page.snapshot) !== page.snapshotSha256 ||
    !["http:", "https:"].includes(new URL(page.url).protocol)
  )
    throw new Error(`Invalid independent browser page: ${row.id}`);
  const capture = browser.writeLatestBrowserSnapshotRefs({
    sessionId,
    snapshot: page.snapshot,
    url: page.url,
  });
  if (capture.snapshotSha256 !== page.snapshotSha256)
    throw new Error(`Browser observation changed: ${row.id}`);
  if (ref?.status === "stale")
    browser.markLatestBrowserSnapshotStale(sessionId, "fixture-stale-ref");
  if (ref?.status === "fresh") {
    const lookup = browser.findLatestBrowserSnapshotRefLookup(
      sessionId,
      row.operation.input.ref,
    );
    if (
      lookup.status !== "fresh" ||
      lookup.ref?.label !== ref.label ||
      lookup.ref?.role !== ref.role ||
      ref.snapshotSha256 !== page.snapshotSha256
    )
      throw new Error(`Browser ref differs from observation: ${row.id}`);
  }
}

function configuredPolicy(row, readBundledConfig) {
  const config = readBundledConfig();
  const behaviors = row.fixture?.policyBehaviors;
  if (!behaviors) return config;
  for (const ruleId of Object.keys(behaviors))
    if (!config.policies.rules.some((rule) => rule.id === ruleId))
      throw new Error(`Unknown exact policy ${ruleId}: ${row.id}`);
  return {
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

// Exact pre-model fact reasons from the frozen host contract, also checked by
// verifyCandidate9NonModelRoutes. Authored fixture gaps cannot exempt failures.
const factPreparationFallbacks = new Set([
  "Jev Salesforce org target is ambiguous; using Safety Kernel fallback",
  "Jev org lookup failed; using Safety Kernel fallback",
  "Jev Salesforce org identity unverified; using Safety Kernel fallback",
  "Browser reference evidence unavailable before model check",
  "Jev browser click lacks matching recent reference and page observations; using Safety Kernel fallback",
]);

export function classifyC9BaselineRouting(
  row,
  { sentinelCalls, eligible, policyFloor, comparison },
) {
  const routing = sentinelCalls
    ? "model_prepared"
    : comparison?.source === "exact_policy"
      ? "exact_policy"
      : comparison?.source === "rules_fallback" &&
          factPreparationFallbacks.has(comparison.reason)
        ? "pre_model_fallback"
        : "rules_fallback";
  if (
    !sentinelCalls &&
    eligible &&
    !policyFloor &&
    routing === "rules_fallback"
  )
    throw new Error(
      `C9 eligible request did not reach model-free sentinel: ${row.id}`,
    );
  return routing;
}

async function runtimeIdentity(sfPi, sfDeps) {
  installResolver(sfPi, sfDeps);
  const sfImport = (path) => import(pathToFileURL(resolve(sfPi, path)).href);
  const [
    { readBundledConfig },
    { calculateJevRiskBaselineIdentity },
    { getJevRiskPolicySha256 },
    { canonical },
    { GUARDRAIL_PROTOCOL_SHA256 },
  ] = await Promise.all([
    sfImport("extensions/sf-guardrail/lib/config.ts"),
    sfImport("extensions/sf-guardrail/lib/risk-baseline-identity.ts"),
    sfImport("extensions/sf-guardrail/lib/jev-risk.ts"),
    import(pathToFileURL(resolve(root, "dist/core.js")).href),
    import(pathToFileURL(resolve(root, "dist/guardrail.js")).href),
  ]);
  const runnerSha256 = sha(await regularBytes(scriptFile));
  const stubSha256 = sha(await regularBytes(stubFile));
  const jevRuntimeCommit = gitHead(root);
  const jevRuntimeSha256 = sha(
    canonical({
      jevRuntimeCommit,
      coreSha256: sha(await regularBytes(resolve(root, "dist/core.js"))),
      guardrailSha256: sha(
        await regularBytes(resolve(root, "dist/guardrail.js")),
      ),
      baselineSealSha256: sha(
        await regularBytes(resolve(root, "dist/guardrail-c9-baseline-seal.js")),
      ),
      runnerSha256,
      stubSha256,
    }),
  );
  return {
    hostCommit: gitHead(sfPi),
    hostRuntimeSha256: calculateJevRiskBaselineIdentity().sha256,
    policySha256: getJevRiskPolicySha256(readBundledConfig()),
    jevRuntimeCommit,
    jevRuntimeSha256,
    scorerProtocolSha256: GUARDRAIL_PROTOCOL_SHA256,
    runnerSha256,
    stubSha256,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      "sf-pi": { type: "string" },
      "sf-deps": { type: "string" },
      "identity-only": { type: "boolean" },
      source: { type: "string" },
      "source-sha256": { type: "string" },
      "selection-freeze-sha256": { type: "string" },
      "host-commit": { type: "string" },
      "host-runtime-sha256": { type: "string" },
      "policy-sha256": { type: "string" },
      "jev-runtime-commit": { type: "string" },
      "jev-runtime-sha256": { type: "string" },
      "output-dir": { type: "string" },
    },
  });
  if (!values["sf-pi"] || !values["sf-deps"])
    throw new Error("Required: --sf-pi DIR --sf-deps NODE_MODULES");
  const sfPi = resolve(values["sf-pi"]);
  const sfDeps = resolve(values["sf-deps"]);
  const identity = await runtimeIdentity(sfPi, sfDeps);
  if (values["identity-only"]) {
    console.log(JSON.stringify(identity, null, 2));
    return;
  }
  if (
    !values.source ||
    !values["output-dir"] ||
    !isAbsolute(values.source) ||
    !isAbsolute(values["output-dir"]) ||
    !isPin(values["source-sha256"]) ||
    !isPin(values["selection-freeze-sha256"]) ||
    !isCommit(values["host-commit"]) ||
    !isPin(values["host-runtime-sha256"]) ||
    !isPin(values["policy-sha256"]) ||
    !isCommit(values["jev-runtime-commit"]) ||
    !isPin(values["jev-runtime-sha256"])
  )
    throw new Error(
      "C9 blind baseline requires absolute source/output and pre-model pins",
    );
  for (const [field, observed] of Object.entries(identity)) {
    const requested =
      values[field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)];
    if (requested !== undefined && requested !== observed)
      throw new Error(`C9 ${field} differs from the pre-model selection pin`);
  }
  const sourceBytes = await regularBytes(values.source);
  if (sha(sourceBytes) !== values["source-sha256"])
    throw new Error("C9 sealed TEST source differs from the blind source pin");
  const source = JSON.parse(sourceBytes);
  if (
    source.schema_version !== "c9.1" ||
    source.split !== "test" ||
    !Array.isArray(source.cases) ||
    source.cases.length < 1
  )
    throw new Error("C9 source must be a nonempty held-out TEST corpus");
  const fakeAgentDir = await mkdtemp(resolve(tmpdir(), "c9-model-free-host-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = fakeAgentDir;
  try {
    const sfImport = (path) => import(pathToFileURL(resolve(sfPi, path)).href);
    const [
      { readBundledConfig },
      { evaluateSafety },
      {
        evaluateJevRisk,
        jevRiskEligible,
        jevRiskPolicyFloor,
        jevBrowserClickEvidenceFingerprint,
        getJevRiskPolicySha256,
        JEV_RISK_PROVIDER_EVENT,
      },
      { clearSharedSfEnvironment, restoreFromSessionEntries },
      browser,
      { previewCliSendFloor, previewNativeSendFloor },
      { getHostPreviewSession },
      { canonical },
      { createC9PreModelBaselineSeal, serializeC9BaselineSeal },
    ] = await Promise.all([
      sfImport("extensions/sf-guardrail/lib/config.ts"),
      sfImport("extensions/sf-guardrail/lib/safety-kernel.ts"),
      sfImport("extensions/sf-guardrail/lib/jev-risk.ts"),
      sfImport("lib/common/sf-environment/shared-runtime.ts"),
      sfImport("lib/common/sf-browser-snapshot-state.ts"),
      sfImport("extensions/sf-guardrail/lib/preview-session-facts.ts"),
      sfImport("lib/common/agent-preview/store.ts"),
      import(pathToFileURL(resolve(root, "dist/core.js")).href),
      import(
        pathToFileURL(resolve(root, "dist/guardrail-c9-baseline-seal.js")).href
      ),
    ]);
    const digest = (value) => sha(canonical(value));
    const prepared = [];
    const pi = {
      events: {
        emit(event, request) {
          if (event === JEV_RISK_PROVIDER_EVENT)
            request.providers.push({
              version: 1,
              id: "jev",
              protocolSha256: identity.scorerProtocolSha256,
              modelSha256: "f".repeat(64),
              qualified: false,
              async evaluate(input) {
                prepared.push({ input, inputSha256: digest(input) });
                return {
                  action: "confirm",
                  reason: "risk_detected",
                  allowScore: 0.01,
                  elapsedMs: 0,
                  inputSha256: digest(input),
                  inputTokens: 1,
                  calibration: "uncalibrated",
                };
              },
            });
        },
      },
    };
    const rows = [];
    for (const row of source.cases) {
      const cwd = row.fixture?.cwd;
      if (typeof cwd !== "string" || !cwd)
        throw new Error(`C9 case has no cwd: ${row.id}`);
      const sessionId = `c9-pre-${row.id}`;
      installOrg(row, cwd, clearSharedSfEnvironment, restoreFromSessionEntries);
      installBrowser(row, sessionId, browser);
      const config = configuredPolicy(row, readBundledConfig);
      const input = {
        toolName: row.operation?.tool,
        input: row.operation?.input,
        cwd,
        sessionId,
        config,
      };
      const browserEvidenceBeforeBaseline =
        input.toolName === "sf_browser_click"
          ? jevBrowserClickEvidenceFingerprint(input)
          : undefined;
      const rawBaseline = await evaluateSafety(input);
      const command =
        input.toolName === "bash" ||
        (input.toolName === "herdr_pane" && input.input.action === "run")
          ? input.input.command
          : undefined;
      const baselineDecision =
        typeof command === "string"
          ? previewCliSendFloor(command, rawBaseline, config, sessionId, cwd)
          : input.toolName === "agentscript_preview" &&
              input.input.action === "send"
            ? previewNativeSendFloor(
                input.input,
                rawBaseline,
                typeof input.input.session_id === "string"
                  ? getHostPreviewSession(
                      input.input.session_id,
                      sessionId,
                      cwd,
                    )
                  : undefined,
                sessionId,
                cwd,
              )
            : rawBaseline;
      const baseline = baselineDecision?.action ?? "allow";
      const before = prepared.length;
      const startedAt = performance.now();
      const evaluated = await evaluateJevRisk(pi, input, baselineDecision, {
        mode: "shadow",
        startedAt,
        browserEvidenceBeforeBaseline,
      });
      if (evaluated.decision !== baselineDecision)
        throw new Error(`C9 shadow changed baseline decision: ${row.id}`);
      const calls = prepared.slice(before);
      if (calls.length > 1)
        throw new Error(`C9 duplicate sentinel call: ${row.id}`);
      const eligible = jevRiskEligible(input);
      const floor = eligible && jevRiskPolicyFloor(input, baselineDecision);
      if (calls.length && (!eligible || floor))
        throw new Error(
          `C9 sentinel reached an ineligible operation: ${row.id}`,
        );
      if (calls.length) {
        const riskInput = calls[0].input;
        if (
          canonical(Object.keys(riskInput).sort()) !==
            canonical(["facts", "input", "toolName", "version"]) ||
          riskInput.toolName !== input.toolName ||
          canonical(riskInput.input) !== canonical(input.input)
        )
          throw new Error(
            `C9 risk input leaked label or changed operation: ${row.id}`,
          );
      }
      const comparison = evaluated.comparison;
      const routing = classifyC9BaselineRouting(row, {
        sentinelCalls: calls.length,
        eligible,
        policyFloor: floor,
        comparison,
      });
      rows.push({
        id: row.id,
        groupId: row.group_id,
        family: row.family,
        expected: label[row.expected?.decision],
        operationSha256: digest({
          toolName: input.toolName,
          input: input.input,
          cwd,
        }),
        baseline,
        routing,
        inputSha256: calls[0]?.inputSha256 ?? null,
        policySha256: getJevRiskPolicySha256(config),
        reason: calls.length ? null : (comparison?.reason ?? routing),
      });
    }
    const preflight = {
      version: 1,
      purpose: "candidate9_model_free_test_preflight",
      mode: "shadow_sentinel_no_model_no_tool_execution",
      modelScoringStarted: false,
      modelCalls: 0,
      externalOperationsExecuted: 0,
      sourceSha256: values["source-sha256"],
      selectionFreezeSha256: values["selection-freeze-sha256"],
      ...identity,
      rows,
    };
    const preflightRaw = JSON.stringify(preflight) + "\n";
    const sourceRaw = sourceBytes.toString("utf8");
    const seal = createC9PreModelBaselineSeal(sourceRaw, preflightRaw, {
      sourceSha256: values["source-sha256"],
      selectionFreezeSha256: values["selection-freeze-sha256"],
      ...identity,
    });
    if (
      sha(await regularBytes(values.source)) !== values["source-sha256"] ||
      canonical(await runtimeIdentity(sfPi, sfDeps)) !== canonical(identity)
    )
      throw new Error("C9 source or runtime changed during pre-model replay");
    await mkdir(values["output-dir"], { recursive: false });
    const preflightFile = resolve(values["output-dir"], "preflight.json");
    const sealFile = resolve(values["output-dir"], "baseline-seal.json");
    await writeFile(preflightFile, preflightRaw, { flag: "wx", mode: 0o600 });
    const sealRaw = serializeC9BaselineSeal(seal);
    await writeFile(sealFile, sealRaw, { flag: "wx", mode: 0o600 });
    console.log(
      JSON.stringify({
        preflightFile,
        preflightSha256: sha(preflightRaw),
        sealFile,
        sealSha256: sha(sealRaw),
        cases: seal.cases,
        groups: seal.groups,
        modelCalls: 0,
        externalOperationsExecuted: 0,
      }),
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(fakeAgentDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptFile) await main();
