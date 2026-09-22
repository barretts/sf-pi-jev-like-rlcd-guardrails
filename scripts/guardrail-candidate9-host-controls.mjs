#!/usr/bin/env node
/** Replay authored C9 host controls with mocked facts and zero model/tool calls. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GUARDRAIL_PROTOCOL_SHA256 } from "../dist/guardrail.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostCommit = "4f7fae07f7c04a7ca9f4fdbabc4594a20a8f1d2a";
const hostRuntimeSha256 =
  "4c4f874ef4f19988e7a7db84055ebf28c6d25813723acf2c807934e2c8f15421";
const hostPolicySha256 =
  "e02e9c0914c1b1395adb0b341d6149b54b0b514c2b86cceab44994b5f6425347";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const need = (condition, reason) => {
  if (!condition) throw new Error(`C9 controls: ${reason}`);
};
const canonical = (value) => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort((a, b) => {
          const aa = Array.from(a),
            bb = Array.from(b);
          for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
            const difference = aa[i].codePointAt(0) - bb[i].codePointAt(0);
            if (difference) return difference;
          }
          return aa.length - bb.length;
        })
        .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
        .join(",") +
      "}"
    );
  throw new Error("Invalid control value");
};
const { values } = parseArgs({
  options: {
    "sf-pi": { type: "string" },
    "sf-deps": { type: "string" },
    source: { type: "string" },
    "source-sha256": { type: "string" },
    controls: { type: "string" },
    "controls-sha256": { type: "string" },
    output: { type: "string" },
  },
});
for (const key of [
  "sf-pi",
  "sf-deps",
  "source",
  "source-sha256",
  "controls",
  "controls-sha256",
  "output",
])
  need(values[key], `Missing --${key}`);
const sfRoot = resolve(values["sf-pi"]),
  sfDeps = resolve(values["sf-deps"]),
  sourceFile = resolve(values.source),
  controlsFile = resolve(values.controls),
  outputFile = resolve(values.output);
need(
  outputFile.startsWith(
    resolve(root, ".build/guardrail/candidate-9-controls-"),
  ) && outputFile.endsWith("/receipt.json"),
  "Output must be a fresh C9 controls receipt",
);
need(
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: sfRoot,
    encoding: "utf8",
  }).trim() === hostCommit,
  "Host source commit changed",
);
need((await stat(sfDeps)).isDirectory(), "Host dependencies unavailable");
const [sourceBytes, controlsBytes] = await Promise.all([
  readFile(sourceFile),
  readFile(controlsFile),
]);
need(
  sha(sourceBytes) === values["source-sha256"] &&
    sha(controlsBytes) === values["controls-sha256"],
  "C9 source or controls SHA changed",
);
const source = JSON.parse(sourceBytes),
  controls = JSON.parse(controlsBytes);
need(
  source.version === 1 &&
    source.purpose === "candidate9_train_source" &&
    source.qualification === false &&
    controls.version === 1 &&
    controls.purpose === "candidate9_host_controls_source" &&
    Array.isArray(controls.controls) &&
    controls.controls.length >= 6 &&
    new Set(controls.controls.map((row) => row.id)).size ===
      controls.controls.length,
  "Control source schema/count invalid",
);
const detectUrl = pathToFileURL(
  resolve(sfRoot, "lib/common/sf-environment/detect.ts"),
).href;
const stubUrl = pathToFileURL(
  resolve(root, "scripts/guardrail-v3-research-detect-stub.mjs"),
).href;
const dependencyParent = pathToFileURL(
  resolve(sfDeps, "__c9_controls_resolver__.mjs"),
).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    let resolved;
    try {
      resolved = nextResolve(specifier, context);
    } catch (error) {
      if (
        error.code !== "ERR_MODULE_NOT_FOUND" ||
        specifier.startsWith(".") ||
        specifier.startsWith("/") ||
        specifier.startsWith("node:")
      )
        throw error;
      resolved = nextResolve(specifier, {
        ...context,
        parentURL: dependencyParent,
      });
    }
    return resolved.url === detectUrl
      ? { url: stubUrl, shortCircuit: true }
      : resolved;
  },
});
const agentDir = await mkdtemp(resolve(tmpdir(), "c9-controls-host-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
try {
  const sfImport = (path) => import(pathToFileURL(resolve(sfRoot, path)).href);
  const [
    { readBundledConfig },
    { evaluateSafety },
    { evaluateJevRisk, getJevRiskPolicySha256, jevRiskPolicyFloor },
    { getJevRiskBaselineSha256 },
    { clearSharedSfEnvironment },
    {
      writeLatestBrowserSnapshotRefs,
      markLatestBrowserSnapshotStale,
      findLatestBrowserSnapshotRefLookup,
    },
  ] = await Promise.all([
    sfImport("extensions/sf-guardrail/lib/config.ts"),
    sfImport("extensions/sf-guardrail/lib/safety-kernel.ts"),
    sfImport("extensions/sf-guardrail/lib/jev-risk.ts"),
    sfImport("extensions/sf-guardrail/lib/risk-baseline-identity.ts"),
    sfImport("lib/common/sf-environment/shared-runtime.ts"),
    sfImport("lib/common/sf-browser-snapshot-state.ts"),
  ]);
  need(
    getJevRiskBaselineSha256() === hostRuntimeSha256,
    "Host runtime SHA changed",
  );
  const bundled = readBundledConfig();
  need(
    getJevRiskPolicySha256(bundled) === hostPolicySha256,
    "Bundled effective policy changed",
  );
  const records = [];
  for (const row of controls.controls) {
    const sessionId = row.id,
      cwd = "/example/project";
    clearSharedSfEnvironment(cwd);
    let config = bundled;
    if (row.policyOverride) {
      need(
        row.policyOverride.ruleId === "sf-destructive-changes-xml" &&
          row.policyOverride.behavior === "block",
        `Unexpected control override: ${row.id}`,
      );
      config = structuredClone(bundled);
      const rule = config.policies.rules.find(
        (entry) => entry.id === row.policyOverride.ruleId,
      );
      need(rule, `Policy override rule missing: ${row.id}`);
      rule.behavior = "block";
      rule.enabled = true;
    }
    if (row.toolName === "sf_browser_click") {
      const page = row.observations.browserPage;
      need(
        page?.snapshotSha256 === sha(page.snapshot) &&
          typeof page.url === "string",
        `Browser control snapshot incomplete: ${row.id}`,
      );
      writeLatestBrowserSnapshotRefs({
        sessionId,
        snapshot: page.snapshot,
        url: page.url,
      });
      if (row.observations.browserRef.status === "stale")
        markLatestBrowserSnapshotStale(
          sessionId,
          "authored TRAIN control invalidation",
        );
      const lookup = findLatestBrowserSnapshotRefLookup(
        sessionId,
        row.input.ref,
      );
      const observedStatus = ["missing-ref", "missing-session"].includes(
        lookup.status,
      )
        ? "missing"
        : lookup.status;
      need(
        observedStatus === row.observations.browserRef.status,
        `Browser control ref observation mismatch: ${row.id}`,
      );
    }
    const input = {
      toolName: row.toolName,
      input: row.input,
      cwd,
      sessionId,
      config,
    };
    const baseline = await evaluateSafety(input);
    let modelCalls = 0,
      providerEvents = 0;
    const pi = {
      events: {
        emit(_event, request) {
          providerEvents++;
          request.providers.push({
            version: 1,
            id: "jev",
            protocolSha256: GUARDRAIL_PROTOCOL_SHA256,
            modelSha256: "a".repeat(64),
            qualified: false,
            qualificationBaselineSha256: hostRuntimeSha256,
            async evaluate() {
              modelCalls++;
              throw new Error("Model must not be called for C9 host control");
            },
          });
        },
      },
    };
    const floor = jevRiskPolicyFloor(input, baseline);
    const result = await evaluateJevRisk(pi, input, baseline, {
      mode: "shadow",
    });
    const baselineAction = baseline?.action ?? "allow";
    const actualAction = result.decision?.action ?? "allow";
    need(
      baselineAction === row.expected &&
        actualAction === baselineAction &&
        result.comparison?.actual === actualAction &&
        result.comparison?.source ===
          (row.controlRoute === "exact_policy_floor"
            ? "exact_policy"
            : "rules_fallback") &&
        modelCalls === 0 &&
        (row.controlRoute !== "exact_policy_floor" || floor),
      `Control action/gate changed: ${row.id} (${baselineAction}/${actualAction}/${result.comparison?.source})`,
    );
    records.push({
      id: row.id,
      operationSha256: sha(
        canonical({ toolName: row.toolName, input: row.input }),
      ),
      baselineAction,
      actualAction,
      gate: row.controlRoute,
      modelCalls,
      providerEvents,
      effectivePolicySha256: getJevRiskPolicySha256(config),
      ...(row.policyOverride ? { policyOverride: row.policyOverride } : {}),
      ruleId: baseline?.ruleId ?? null,
      comparisonSource: result.comparison.source,
      comparisonReason: result.comparison.reason,
    });
  }
  need(
    records.some(
      (row) =>
        row.gate === "exact_policy_floor" &&
        row.baselineAction === "block" &&
        row.actualAction === "block" &&
        row.modelCalls === 0,
    ),
    "No hard-block control",
  );
  need(
    records.every(
      (row) =>
        row.modelCalls === 0 &&
        row.baselineAction === row.actualAction &&
        (row.policyOverride || row.effectivePolicySha256 === hostPolicySha256),
    ),
    "Controls changed or policy hash invalid",
  );
  const receipt = {
    version: 1,
    purpose: "candidate9_host_controls",
    baselineSha256: hostRuntimeSha256,
    policySha256: hostPolicySha256,
    qualification: false,
    modelCalls: 0,
    externalOperationsExecuted: 0,
    heldOutTestRead: false,
    source: {
      hostCommit,
      scriptSha256: sha(await readFile(fileURLToPath(import.meta.url))),
      c9SourceSha256: sha(sourceBytes),
      controlsSourceSha256: sha(controlsBytes),
    },
    records,
    counts: {
      rows: records.length,
      unchanged: records.filter(
        (row) => row.baselineAction === row.actualAction,
      ).length,
      modelCalls: 0,
      hardBlocks: records.filter((row) => row.baselineAction === "block")
        .length,
    },
  };
  await mkdir(dirname(outputFile), { recursive: true });
  await writeFile(outputFile, JSON.stringify(receipt, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  console.log(JSON.stringify({ outputFile, ...receipt.counts }));
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
}
