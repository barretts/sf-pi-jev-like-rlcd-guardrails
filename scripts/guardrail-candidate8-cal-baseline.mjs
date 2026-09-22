#!/usr/bin/env node
/** Replay C8 TRAIN-internal calibration through the pinned, model-free sf-pi Safety Kernel. */
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const calibrationRel =
  "reports/guardrail-risk-2026-09-21/candidate-8-evidence/train/calibration.jsonl";
const calibrationSha256 =
  "7371877d67874e8d55c418b678d9d808207bb4e645d1868d4e44ad8d5d57144f";
const hostCommit = "bc7862b078997d2c60aa908979b5cbf59f83db80";
const hostRuntimeSha256 =
  "6ec845e7365d2948ecf502326bcabbb7b042b7d300437516db3b299fd390078e";
const browserSources = [
  "fixtures/guardrail/candidate6/browser-train-proposal.json",
  "fixtures/guardrail/candidate8/train-recovery.json",
];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const need = (ok, why) => {
  if (!ok) throw new Error("C8 CAL baseline: " + why);
};
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, nested]) => [key, canonical(nested)]),
        )
      : value;
const same = (a, b) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
// Mirror sf-pi's risk-identity canonical JSON exactly, including Unicode keys.
const hostCanonical = (value) => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map(hostCanonical).join(",") + "]";
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
        .map((key) => JSON.stringify(key) + ":" + hostCanonical(value[key]))
        .join(",") +
      "}"
    );
  throw new Error("Incomplete CAL input");
};
const unknown = (id, inputSha256, reason) => ({
  id,
  inputSha256,
  action: "unknown",
  route: "insufficient_facts",
  reason,
});

const { values } = parseArgs({
  options: {
    "sf-pi": { type: "string" },
    "sf-deps": { type: "string" },
    output: { type: "string" },
  },
});
for (const key of ["sf-pi", "sf-deps", "output"])
  need(values[key], "Missing --" + key);
const sfRoot = resolve(values["sf-pi"]);
const sfDeps = resolve(values["sf-deps"]);
const output = resolve(values.output);
need(
  output.startsWith(
    resolve(root, ".build/guardrail/candidate-8-cal-baseline-"),
  ) && output.endsWith("/receipt.json"),
  "Output must be a fresh C8 CAL baseline .build receipt",
);
need(
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: sfRoot,
    encoding: "utf8",
  }).trim() === hostCommit,
  "sf-pi host commit changed",
);
need(
  (await stat(sfDeps)).isDirectory(),
  "sf-pi dependency directory unavailable",
);
const calFile = resolve(root, calibrationRel);
const calBytes = await readFile(calFile);
need(sha(calBytes) === calibrationSha256, "CAL corpus bytes changed");
const calRows = calBytes.toString("utf8").trimEnd().split("\n").map(JSON.parse);
need(
  calRows.length === 47 &&
    new Set(calRows.map((row) => row.id)).size === 47 &&
    calRows.every(
      (row) =>
        row.split === "calibration" &&
        row.request?.state?.version === 2 &&
        row.request.state.toolName &&
        row.request.state.input &&
        row.request.state.facts,
    ),
  "Unexpected CAL corpus shape",
);
const browserSourceBytes = await Promise.all(
  browserSources.map((path) => readFile(resolve(root, path))),
);
const browserById = new Map();
for (const bytes of browserSourceBytes)
  for (const row of JSON.parse(bytes).cases ?? [])
    if (row.toolName === "sf_browser_click") {
      need(!browserById.has(row.id), "Duplicate TRAIN browser source ID");
      browserById.set(row.id, row);
    }

const detectUrl = pathToFileURL(
  resolve(sfRoot, "lib/common/sf-environment/detect.ts"),
).href;
const stubUrl = pathToFileURL(
  resolve(root, "scripts/guardrail-v3-research-detect-stub.mjs"),
).href;
const dependencyParent = pathToFileURL(
  resolve(sfDeps, "__c8_cal_resolver__.mjs"),
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

const agentDir = await mkdtemp(resolve(tmpdir(), "c8-cal-baseline-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
try {
  const sfImport = (path) => import(pathToFileURL(resolve(sfRoot, path)).href);
  const [
    { readBundledConfig },
    { evaluateSafety },
    { prepareJevRiskInput },
    { salesforceOrgTarget },
    { clearSharedSfEnvironment, restoreFromSessionEntries },
    { writeLatestBrowserSnapshotRefs },
    { getJevRiskBaselineSha256 },
  ] = await Promise.all([
    sfImport("extensions/sf-guardrail/lib/config.ts"),
    sfImport("extensions/sf-guardrail/lib/safety-kernel.ts"),
    sfImport("extensions/sf-guardrail/lib/jev-risk.ts"),
    sfImport("extensions/sf-guardrail/lib/org-context.ts"),
    sfImport("lib/common/sf-environment/shared-runtime.ts"),
    sfImport("lib/common/sf-browser-snapshot-state.ts"),
    sfImport("extensions/sf-guardrail/lib/risk-baseline-identity.ts"),
  ]);
  need(
    getJevRiskBaselineSha256() === hostRuntimeSha256,
    "sf-pi guardrail runtime changed",
  );
  const policy = readBundledConfig();
  const policySha256 = sha(hostCanonical(JSON.parse(JSON.stringify(policy))));
  const policyFileSha256 = sha(
    await readFile(
      resolve(sfRoot, "extensions/sf-guardrail/SF_GUARDRAIL_DEFAULTS.json"),
    ),
  );
  const records = [];
  for (const row of calRows) {
    const state = row.request.state;
    const facts = state.facts;
    const inputSha256 = sha(hostCanonical(state));
    const operationSha256 = sha(
      hostCanonical({ toolName: state.toolName, input: state.input }),
    );
    const cwd = "/example/project";
    const sessionId = `c8-cal-baseline-${row.id}`;
    clearSharedSfEnvironment(cwd);
    let factRoute = "no_external_facts";
    let missingReason = null;
    if (facts.orgs !== undefined) {
      const org = facts.orgs;
      const command = state.input.command;
      const target =
        typeof command === "string"
          ? salesforceOrgTarget(command)
          : { kind: "invocation", targetOrg: state.input.target_org };
      const alias = target.kind === "invocation" ? target.targetOrg : undefined;
      if (
        !Array.isArray(org) ||
        org.length !== 1 ||
        org[0].guessed !== false ||
        !["production", "sandbox", "scratch", "developer", "trial"].includes(
          org[0].type,
        ) ||
        typeof alias !== "string" ||
        !alias ||
        (typeof command === "string" && org[0].command !== command)
      )
        missingReason = "org_fact_or_literal_target_incomplete";
      else {
        const env = {
          cli: { installed: true, version: "2.0.0" },
          project: { detected: true },
          config: { hasTargetOrg: true, targetOrg: alias, location: "Global" },
          org: { detected: true, alias, orgType: org[0].type },
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
        factRoute = "verified_org_fact_replayed";
      }
    }
    if (state.toolName === "sf_browser_click") {
      const source = browserById.get(row.id);
      const page = source?.observations?.browserPage;
      const ref = source?.observations?.browserRef;
      if (
        !source ||
        !same(source.input, state.input) ||
        !page ||
        typeof page.snapshot !== "string" ||
        sha(page.snapshot) !== facts.browserPage?.snapshotSha256 ||
        page.url !== facts.browserPage?.url ||
        facts.browserPage?.status !== "fresh" ||
        !ref ||
        ref.ref !== state.input.ref ||
        ref.label !== facts.browserRef?.label ||
        ref.role !== facts.browserRef?.role ||
        facts.browserRef?.status !== "fresh" ||
        facts.browserRef?.snapshotSha256 !== facts.browserPage?.snapshotSha256
      )
        missingReason = "browser_snapshot_or_ref_incomplete";
      else {
        const capture = writeLatestBrowserSnapshotRefs({
          sessionId,
          snapshot: page.snapshot,
          url: page.url,
        });
        if (
          capture.snapshotSha256 !== facts.browserPage.snapshotSha256 ||
          !capture.refs.some(
            (candidate) =>
              candidate.ref === state.input.ref &&
              candidate.label === facts.browserRef.label &&
              candidate.role === facts.browserRef.role,
          )
        )
          missingReason = "browser_host_capture_disagrees";
        else factRoute = "train_snapshot_replayed";
      }
    }
    if (missingReason) {
      records.push({
        ...unknown(row.id, inputSha256, missingReason),
        operationSha256,
      });
      continue;
    }
    const input = {
      toolName: state.toolName,
      input: state.input,
      cwd,
      sessionId,
      config: policy,
    };
    const baseline = await evaluateSafety(input);
    const prepared = await prepareJevRiskInput(input, baseline);
    if (!same(prepared, state)) {
      records.push({
        ...unknown(row.id, inputSha256, "reconstructed_facts_mismatch"),
        operationSha256,
      });
      continue;
    }
    records.push({
      id: row.id,
      inputSha256,
      operationSha256,
      action: baseline?.action ?? "allow",
      route: baseline?.feature ?? "no_rule_decision",
      ruleId: baseline?.ruleId ?? null,
      factRoute,
    });
  }
  need(
    sha(await readFile(calFile)) === calibrationSha256,
    "CAL changed during replay",
  );
  need(
    getJevRiskBaselineSha256() === hostRuntimeSha256,
    "sf-pi runtime changed during replay",
  );
  const receipt = {
    version: 1,
    purpose: "candidate8_train_cal_baseline_replay",
    qualification: false,
    modelCalls: 0,
    externalOperationsExecuted: 0,
    heldOutTestRead: false,
    baselineSha256: hostRuntimeSha256,
    policySha256,
    calibrationCorpusSha256: calibrationSha256,
    source: {
      hostCommit,
      policy: "bundled",
      policyFileSha256,
      browserTrainSources: Object.fromEntries(
        browserSources.map((file, index) => [
          file,
          sha(browserSourceBytes[index]),
        ]),
      ),
      scriptSha256: sha(await readFile(fileURLToPath(import.meta.url))),
    },
    counts: {
      rows: records.length,
      allow: records.filter((record) => record.action === "allow").length,
      confirm: records.filter((record) => record.action === "confirm").length,
      block: records.filter((record) => record.action === "block").length,
      unknown: records.filter((record) => record.action === "unknown").length,
    },
    records,
    proofLimit:
      "Bundled-policy, model-free Safety Kernel replay on TRAIN-internal calibration only. Prepared-state parity checks reconstructed independent org/browser facts. It is neither C8 VALID nor held-out TEST effectiveness.",
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(receipt, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      output,
      ...receipt.counts,
      baselineSha256: receipt.baselineSha256,
      policySha256: receipt.policySha256,
      calibrationCorpusSha256: receipt.calibrationCorpusSha256,
    }),
  );
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
}
