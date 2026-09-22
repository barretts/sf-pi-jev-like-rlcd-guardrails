/**
 * Operation-free host replay shared by C8 TRAIN-CAL and prospective VALID.
 * The caller owns and seals its rows; this module never opens a corpus file.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const label = Object.freeze({
  allow: "allow",
  require_approval: "confirm",
  hard_block: "block",
});

function canonical(value) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  throw new Error("Expected finite JSON input");
}
const digest = (value) => sha(canonical(value));

/** A Pi event seam; no tool handler is registered and no tool is executed. */
export function createCandidate8Recorder() {
  const handlers = new Map();
  const on = (event, handler) =>
    handlers.set(event, [...(handlers.get(event) ?? []), handler]);
  return {
    events: {
      on,
      emit(event, payload) {
        for (const handler of handlers.get(event) ?? []) handler(payload);
      },
    },
    registerCommand() {},
  };
}

function configureResolver(sfPi, sfDeps, stubFile) {
  const detectUrl = pathToFileURL(
    resolve(sfPi, "lib/common/sf-environment/detect.ts"),
  ).href;
  const stubUrl = pathToFileURL(stubFile).href;
  const dependencyParent = pathToFileURL(
    resolve(sfDeps, "__c8_host_rows__.mjs"),
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
}

function installOrg(row, cwd, clear, restore) {
  clear(cwd);
  const org = row.fixture.observations?.org;
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
  const ref = row.fixture.observations?.browserRef;
  const page = row.fixture.observations?.browserPage;
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
    throw new Error(`Browser snapshot digest changed: ${row.id}`);
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
      throw new Error(`Browser ref changed from authored snapshot: ${row.id}`);
  }
}

function configuredPolicy(row, readBundledConfig) {
  let config = readBundledConfig();
  const behaviors = row.fixture.policyBehaviors;
  if (!behaviors) return config;
  for (const ruleId of Object.keys(behaviors))
    if (!config.policies.rules.some((rule) => rule.id === ruleId))
      throw new Error(`Unknown exact policy ${ruleId}: ${row.id}`);
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
  return config;
}

/** Verify the request actually offered to the model, without looking at its label. */
export function assertCandidate8PreparedCall(row, call, preflight) {
  const input = call?.input;
  if (
    !input ||
    canonical(Object.keys(input).sort()) !==
      canonical(["facts", "input", "toolName", "version"]) ||
    input.version !== 2 ||
    input.toolName !== row.operation.tool ||
    canonical(input.input) !== canonical(row.operation.input) ||
    !input.facts ||
    typeof input.facts !== "object" ||
    Object.keys(input.facts).some(
      (key) => !["orgs", "browserRef", "browserPage"].includes(key),
    ) ||
    call.inputSha256 !== preflight.risk_input_sha256
  )
    throw new Error(
      `Prepared model request differs from sealed preflight: ${row.id}`,
    );
  const org = row.fixture.observations?.org;
  if (
    org &&
    (!Array.isArray(input.facts.orgs) ||
      !input.facts.orgs.some(
        (fact) => fact.type === org.type && fact.guessed === org.guessed,
      ))
  )
    throw new Error(
      `Prepared org fact differs from independent fixture: ${row.id}`,
    );
  const page = row.fixture.observations?.browserPage;
  if (
    page &&
    (input.facts.browserPage?.snapshotSha256 !== page.snapshotSha256 ||
      input.facts.browserRef?.snapshotSha256 !== page.snapshotSha256)
  )
    throw new Error(
      `Prepared browser fact differs from independent fixture: ${row.id}`,
    );
}

function observeProviderCalls(pi, event, validateInput) {
  const calls = [];
  pi.events.on(event, (request) => {
    request.providers = request.providers.map(
      (original) =>
        new Proxy(original, {
          get(target, property, receiver) {
            if (property !== "evaluate")
              return Reflect.get(target, property, receiver);
            return (input, signal) => {
              validateInput(input);
              calls.push({ input, inputSha256: digest(input) });
              return target.evaluate(input, signal);
            };
          },
        }),
    );
  });
  return calls;
}

/**
 * Replay sealed caller-supplied rows against the actual sf-pi shadow bridge.
 * Every eligible attempt must match a model-free host preflight request hash.
 * Fallbacks are explicit, and any attempted-model fallback fails later gates.
 */
export async function runCandidate8HostRows({
  rows,
  preflightById,
  sfPi,
  sfDeps,
  stubFile,
  hostCommit,
  hostRuntimeSha256,
  protocolSha256,
  expectedModelSha256,
  validateInput,
  createProvider,
}) {
  if (
    !Array.isArray(rows) ||
    !rows.length ||
    !(preflightById instanceof Map) ||
    preflightById.size !== rows.length ||
    typeof validateInput !== "function" ||
    typeof createProvider !== "function"
  )
    throw new Error("Incomplete C8 host replay inputs");
  if (
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: sfPi,
      encoding: "utf8",
    }).trim() !== hostCommit
  )
    throw new Error("sf-pi checkout differs from pinned C8 host commit");
  if (!(await stat(sfDeps)).isDirectory())
    throw new Error("sf-pi dependencies unavailable");
  configureResolver(sfPi, sfDeps, stubFile);
  const fakeAgentDir = await mkdtemp(resolve(tmpdir(), "c8-host-rows-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = fakeAgentDir;
  let providerRuntime;
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
        JEV_RISK_PROVIDER_EVENT,
      },
      { clearSharedSfEnvironment, restoreFromSessionEntries },
      browser,
      { previewCliSendFloor, previewNativeSendFloor },
      { getHostPreviewSession },
      { calculateJevRiskBaselineIdentity },
    ] = await Promise.all([
      sfImport("extensions/sf-guardrail/lib/config.ts"),
      sfImport("extensions/sf-guardrail/lib/safety-kernel.ts"),
      sfImport("extensions/sf-guardrail/lib/jev-risk.ts"),
      sfImport("lib/common/sf-environment/shared-runtime.ts"),
      sfImport("lib/common/sf-browser-snapshot-state.ts"),
      sfImport("extensions/sf-guardrail/lib/preview-session-facts.ts"),
      sfImport("lib/common/agent-preview/store.ts"),
      sfImport("extensions/sf-guardrail/lib/risk-baseline-identity.ts"),
    ]);
    if (calculateJevRiskBaselineIdentity().sha256 !== hostRuntimeSha256)
      throw new Error("sf-pi risk runtime differs from pinned C8 baseline");
    const pi = createCandidate8Recorder();
    const cold = performance.now();
    providerRuntime = await createProvider(pi, JEV_RISK_PROVIDER_EVENT);
    await providerRuntime.warmup?.();
    const coldInitializationMs = performance.now() - cold;
    if (providerRuntime.status().protocolSha256 !== protocolSha256)
      throw new Error("Provider protocol differs from pinned C8 protocol");
    if (
      expectedModelSha256 &&
      providerRuntime.status().modelSha256 !== expectedModelSha256
    )
      throw new Error("Provider model differs from pinned C8 candidate");
    const calls = observeProviderCalls(
      pi,
      JEV_RISK_PROVIDER_EVENT,
      validateInput,
    );
    const records = [];
    for (const row of rows) {
      const preflight = preflightById.get(row.id);
      if (!preflight) throw new Error(`Missing C8 preflight row: ${row.id}`);
      const cwd = row.fixture.cwd;
      const sessionId = `c8-host-${row.id}`;
      installOrg(row, cwd, clearSharedSfEnvironment, restoreFromSessionEntries);
      installBrowser(row, sessionId, browser);
      const startedAt = performance.now();
      const config = configuredPolicy(row, readBundledConfig);
      const input = {
        toolName: row.operation.tool,
        input: row.operation.input,
        cwd,
        sessionId,
        config,
      };
      const priorCalls = calls.length;
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
      if (baseline !== preflight.baseline_action)
        throw new Error(`C8 baseline changed since preflight: ${row.id}`);
      const eligible = jevRiskEligible(input);
      const floor = eligible && jevRiskPolicyFloor(input, baselineDecision);
      const evaluated = await evaluateJevRisk(pi, input, baselineDecision, {
        mode: "shadow",
        startedAt,
        browserEvidenceBeforeBaseline,
      });
      const elapsedMs = performance.now() - startedAt;
      if (evaluated.decision !== baselineDecision)
        throw new Error(`Shadow changed executable decision: ${row.id}`);
      const newCalls = calls.slice(priorCalls);
      if (newCalls.length > 1 || ((!eligible || floor) && newCalls.length))
        throw new Error(`Unexpected provider call count: ${row.id}`);
      const comparison = evaluated.comparison;
      const routing = newCalls.length
        ? "model_prepared"
        : preflight.routing === "pre_model_fallback"
          ? "pre_model_fallback"
          : "rules_fallback";
      if (routing !== preflight.routing)
        throw new Error(`C8 model routing changed since preflight: ${row.id}`);
      if (routing === "model_prepared")
        assertCandidate8PreparedCall(row, newCalls[0], preflight);
      if (
        routing === "pre_model_fallback" &&
        !["rules_fallback", "exact_policy"].includes(comparison?.source)
      )
        throw new Error(`C8 missing-fact fallback changed: ${row.id}`);
      if (
        row.expected.decision === "hard_block" &&
        (baseline !== "block" ||
          newCalls.length ||
          comparison?.source !== "exact_policy")
      )
        throw new Error(`C8 exact hard block changed: ${row.id}`);
      if (
        comparison &&
        (comparison.mode !== "shadow" ||
          comparison.baseline !== baseline ||
          (comparison.source === "jev" &&
            (comparison.modelSha256 !== providerRuntime.status().modelSha256 ||
              comparison.protocolSha256 !== protocolSha256 ||
              comparison.inputSha256 !== newCalls[0]?.inputSha256 ||
              comparison.actual !==
                (comparison.prediction === "allow" ? "allow" : "confirm"))))
      )
        throw new Error(`C8 comparison identity changed: ${row.id}`);
      const source = comparison?.source ?? "rules_fallback";
      records.push({
        id: row.id,
        groupId: row.group_id,
        family: row.family,
        expected: label[row.expected.decision],
        baseline,
        actual: comparison?.actual ?? baseline,
        routing,
        source,
        elapsedMs,
        modelCalls: newCalls.length,
        modelAnswered: routing === "model_prepared" && source === "jev",
        inputSha256: newCalls[0]?.inputSha256 ?? null,
        allowScore: comparison?.allowScore ?? null,
        effectivePolicySha256: digest(
          JSON.parse(JSON.stringify(config.policies)),
        ),
        policyFloor: Boolean(floor),
        ...(routing === "pre_model_fallback"
          ? {
              fallbackReason: preflight.reason,
              hostReason: comparison?.reason ?? null,
            }
          : {}),
        ...(routing === "model_prepared" && source !== "jev"
          ? {
              error:
                comparison?.reason ?? "Eligible model call did not complete",
            }
          : {}),
        ...(comparison ? { comparison } : {}),
      });
    }
    if (
      calls.length !==
        records.filter((row) => row.routing === "model_prepared").length ||
      calculateJevRiskBaselineIdentity().sha256 !== hostRuntimeSha256 ||
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: sfPi,
        encoding: "utf8",
      }).trim() !== hostCommit ||
      providerRuntime.status().protocolSha256 !== protocolSha256
    )
      throw new Error(
        "C8 host, protocol, or call accounting changed during replay",
      );
    if (
      expectedModelSha256 &&
      providerRuntime.status().modelSha256 !== expectedModelSha256
    )
      throw new Error("C8 provider model changed during replay");
    return { records, coldInitializationMs, providerCalls: calls.length };
  } finally {
    await providerRuntime?.dispose?.();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(fakeAgentDir, { recursive: true, force: true });
  }
}
