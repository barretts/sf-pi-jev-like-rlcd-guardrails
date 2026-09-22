#!/usr/bin/env node
/** Revalidate C8 TRAIN and project C9 TRAIN through a pinned, model-free sf-pi host. */
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
import {
  guardrailRequest,
  GUARDRAIL_PROTOCOL_SHA256,
} from "../dist/guardrail.js";
import { RFDT_BASE_MODEL } from "../dist/rfdt.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostCommit = "4f7fae07f7c04a7ca9f4fdbabc4594a20a8f1d2a";
const hostRuntimeSha256 =
  "4c4f874ef4f19988e7a7db84055ebf28c6d25813723acf2c807934e2c8f15421";
const hostPolicySha256 =
  "e02e9c0914c1b1395adb0b341d6149b54b0b514c2b86cceab44994b5f6425347";
const priorFiles = [
  [
    "reports/guardrail-risk-2026-09-21/candidate-8-evidence/train/fit.jsonl",
    "17f6672fffe913aacdbf44394119bc0b14fbab5db4cc87fccf21c66da449cdc5",
  ],
  [
    "reports/guardrail-risk-2026-09-21/candidate-8-evidence/train/calibration.jsonl",
    "7371877d67874e8d55c418b678d9d808207bb4e645d1868d4e44ad8d5d57144f",
  ],
];
const browserSources = [
  "fixtures/guardrail/candidate6/browser-train-proposal.json",
  "fixtures/guardrail/candidate7/train-contrasts.json",
  "fixtures/guardrail/candidate8/train-recovery.json",
];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const need = (ok, why) => {
  if (!ok) throw new Error("C9 host project: " + why);
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
// Match the host's canonical risk-input digest, including Unicode key order.
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
  throw new Error("Incomplete C9 risk input");
};
const jsonl = (rows) =>
  Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
const parseJsonl = (bytes) =>
  bytes.toString("utf8").trimEnd().split("\n").map(JSON.parse);

const { values } = parseArgs({
  options: {
    "sf-pi": { type: "string" },
    "sf-deps": { type: "string" },
    source: { type: "string" },
    "source-sha256": { type: "string" },
    "output-dir": { type: "string" },
  },
});
for (const key of ["sf-pi", "sf-deps", "source", "source-sha256", "output-dir"])
  need(values[key], "Missing --" + key);
const sfRoot = resolve(values["sf-pi"]),
  sfDeps = resolve(values["sf-deps"]),
  sourceFile = resolve(values.source),
  outputDir = resolve(values["output-dir"]);
need(
  outputDir.startsWith(resolve(root, ".build/guardrail/candidate-9-host-")),
  "Output must be a fresh C9 host .build directory",
);
need(
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: sfRoot,
    encoding: "utf8",
  }).trim() === hostCommit,
  "sf-pi host HEAD changed",
);
need((await stat(sfDeps)).isDirectory(), "sf-pi dependencies unavailable");
const [sourceBytes, ...priorAndBrowserBytes] = await Promise.all([
  readFile(sourceFile),
  ...priorFiles.map(([path]) => readFile(resolve(root, path))),
  ...browserSources.map((path) => readFile(resolve(root, path))),
]);
need(sha(sourceBytes) === values["source-sha256"], "C9 source bytes changed");
for (let i = 0; i < priorFiles.length; i++)
  need(
    sha(priorAndBrowserBytes[i]) === priorFiles[i][1],
    "Inherited C8 TRAIN bytes changed",
  );
const source = JSON.parse(sourceBytes);
need(
  source.version === 1 &&
    source.purpose === "candidate9_train_source" &&
    source.rubric === "operation-policy-v2" &&
    source.baseModel === RFDT_BASE_MODEL &&
    source.qualification === false &&
    source.c8ValidBodyRead === false &&
    source.heldOutTestRead === false &&
    Array.isArray(source.cases),
  "Unexpected C9 TRAIN source",
);
const prior = priorAndBrowserBytes.slice(0, 2).flatMap(parseJsonl);
need(prior.length === 273, "Inherited C8 TRAIN count changed");
const browserById = new Map();
for (const bytes of priorAndBrowserBytes.slice(2))
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
  resolve(sfDeps, "__c9_host_resolver__.mjs"),
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
const agentDir = await mkdtemp(resolve(tmpdir(), "c9-train-host-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
try {
  const sfImport = (path) => import(pathToFileURL(resolve(sfRoot, path)).href);
  const [
    { readBundledConfig },
    { evaluateSafety },
    {
      jevRiskEligible,
      jevRiskPolicyFloor,
      prepareJevRiskInput,
      getJevRiskPolicySha256,
    },
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
    "sf-pi runtime identity changed",
  );
  const policy = readBundledConfig();
  need(
    getJevRiskPolicySha256(policy) === hostPolicySha256,
    "sf-pi effective policy changed",
  );
  const status = [],
    projectedPrior = [],
    projectedNew = [];
  const allRows = [
    ...prior.map((row) => ({ kind: "prior", row })),
    ...source.cases.map((row) => ({ kind: "new", row })),
  ];
  for (const { kind, row } of allRows) {
    const state = kind === "prior" ? row.request.state : null;
    const id = row.id,
      groupId = kind === "prior" ? row.group_id : row.groupId,
      toolName = kind === "prior" ? state.toolName : row.toolName,
      toolInput = kind === "prior" ? state.input : row.input;
    const facts = kind === "prior" ? state.facts : null;
    const observations = kind === "prior" ? null : row.observations;
    const cwd = "/example/project",
      sessionId = `c9-host-${id}`;
    clearSharedSfEnvironment(cwd);
    let reason = null,
      factRoute = "none";
    let orgAlias, orgType;
    if (kind === "prior" && facts.orgs?.length) {
      const org = facts.orgs;
      const target =
        typeof toolInput.command === "string"
          ? salesforceOrgTarget(toolInput.command)
          : { kind: "invocation", targetOrg: toolInput.target_org };
      if (
        org.length !== 1 ||
        org[0].guessed !== false ||
        !["production", "sandbox", "scratch", "developer", "trial"].includes(
          org[0].type,
        ) ||
        target.kind !== "invocation" ||
        !target.targetOrg ||
        (typeof toolInput.command === "string" &&
          org[0].command !== toolInput.command)
      )
        reason = "inherited_org_fact_missing_literal_alias";
      else {
        orgAlias = target.targetOrg;
        orgType = org[0].type;
        factRoute = "inherited_verified_org";
      }
    } else if (kind === "new" && observations.org) {
      if (
        typeof observations.org.alias !== "string" ||
        !observations.org.alias ||
        !["production", "sandbox", "scratch", "developer", "trial"].includes(
          observations.org.type,
        )
      )
        reason = "new_org_fact_incomplete";
      else {
        orgAlias = observations.org.alias;
        orgType = observations.org.type;
        factRoute = "new_verified_org";
      }
    }
    if (orgAlias) {
      const env = {
        cli: { installed: true, version: "2.0.0" },
        project: { detected: true },
        config: { hasTargetOrg: true, targetOrg: orgAlias, location: "Global" },
        org: { detected: true, alias: orgAlias, orgType },
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
    if (toolName === "sf_browser_click") {
      const browserSource = kind === "prior" ? browserById.get(id) : row;
      const page = browserSource?.observations?.browserPage,
        ref = browserSource?.observations?.browserRef;
      if (
        !browserSource ||
        !same(browserSource.input, toolInput) ||
        !page ||
        typeof page.snapshot !== "string" ||
        page.snapshotSha256 !== sha(page.snapshot) ||
        !ref ||
        ref.ref.replace(/^@/, "") !== toolInput.ref.replace(/^@/, "") ||
        (kind === "prior" &&
          (page.snapshotSha256 !== facts.browserPage?.snapshotSha256 ||
            page.url !== facts.browserPage?.url ||
            ref.label !== facts.browserRef?.label ||
            ref.role !== facts.browserRef?.role))
      )
        reason = "browser_source_or_digest_incomplete";
      else {
        const capture = writeLatestBrowserSnapshotRefs({
          sessionId,
          snapshot: page.snapshot,
          url: page.url,
        });
        if (
          capture.snapshotSha256 !== page.snapshotSha256 ||
          !capture.refs.some(
            (candidate) =>
              candidate.ref.replace(/^@/, "") ===
                toolInput.ref.replace(/^@/, "") &&
              candidate.label === ref.label &&
              candidate.role === ref.role,
          )
        )
          reason = "browser_host_capture_mismatch";
        else factRoute = "train_browser_snapshot";
      }
    }
    const input = {
      toolName,
      input: toolInput,
      cwd,
      sessionId,
      config: policy,
    };
    if (reason) {
      status.push({
        id,
        groupId,
        kind,
        gate: "incomplete_facts",
        factRoute,
        reason,
      });
      continue;
    }
    const baseline = await evaluateSafety(input);
    const eligible = jevRiskEligible(input);
    const floor = eligible && jevRiskPolicyFloor(input, baseline);
    if (!eligible || floor) {
      status.push({
        id,
        groupId,
        kind,
        gate: !eligible ? "ineligible" : "code_owned_floor",
        factRoute,
        baselineAction: baseline?.action ?? "allow",
        ruleId: baseline?.ruleId ?? null,
      });
      continue;
    }
    let riskInput;
    try {
      riskInput = await prepareJevRiskInput(input, baseline);
    } catch (error) {
      status.push({
        id,
        groupId,
        kind,
        gate: "prepare_error",
        factRoute,
        reason: error.message,
      });
      continue;
    }
    if (
      riskInput.version !== 2 ||
      riskInput.toolName !== toolName ||
      !same(riskInput.input, toolInput) ||
      (kind === "prior" && !same(riskInput, state)) ||
      (kind === "new" &&
        ((observations.org &&
          !riskInput.facts.orgs?.some(
            (fact) => fact.type === orgType && fact.guessed === false,
          )) ||
          (toolName === "sf_browser_click" &&
            (riskInput.facts.browserPage?.snapshotSha256 !==
              observations.browserPage.snapshotSha256 ||
              riskInput.facts.browserRef?.label !==
                observations.browserRef.label))))
    ) {
      status.push({
        id,
        groupId,
        kind,
        gate: "fact_parity_mismatch",
        factRoute,
        baselineAction: baseline?.action ?? "allow",
      });
      continue;
    }
    const request = guardrailRequest(riskInput, RFDT_BASE_MODEL);
    need(request.questions?.[0]?.id === "risk", "Prompt protocol changed");
    if (kind === "prior") {
      need(same(request, row.request), "Inherited C8 prompt changed");
      projectedPrior.push({ ...row, split: "train" });
    } else
      projectedNew.push({
        id,
        group_id: groupId,
        split: "train",
        request,
        targets: { risk: { answer: row.expected } },
        target_provenance: { risk: { source: "supplied" } },
      });
    status.push({
      id,
      groupId,
      kind,
      gate: "model_prepared",
      factRoute,
      baselineAction: baseline?.action ?? "allow",
      ruleId: baseline?.ruleId ?? null,
      inputSha256: sha(hostCanonical(riskInput)),
      route: baseline?.feature ?? "no_rule_decision",
    });
  }
  need(
    sha(await readFile(sourceFile)) === values["source-sha256"],
    "C9 source changed",
  );
  need(
    getJevRiskBaselineSha256() === hostRuntimeSha256,
    "sf-pi runtime changed during projection",
  );
  const statusByGroup = new Map();
  for (const row of status) {
    const group = statusByGroup.get(row.groupId) ?? [];
    group.push(row);
    statusByGroup.set(row.groupId, group);
  }
  const excludedPriorGroups = [...statusByGroup]
    .filter(
      ([, rows]) =>
        rows[0].kind === "prior" &&
        rows.some((row) => row.gate !== "model_prepared"),
    )
    .map(([groupId]) => groupId)
    .sort();
  const excludedPriorSet = new Set(excludedPriorGroups);
  const admittedPrior = projectedPrior.filter(
    (row) => !excludedPriorSet.has(row.group_id),
  );
  const newFailures = status.filter(
    (row) => row.kind === "new" && row.gate !== "model_prepared",
  );
  const priorBytes = jsonl(admittedPrior),
    newBytes = jsonl(projectedNew);
  const receipt = {
    version: 1,
    purpose: "candidate9_train_final_host_projection",
    qualification: false,
    modelCalls: 0,
    externalOperationsExecuted: 0,
    c8ValidBodyRead: false,
    heldOutTestRead: false,
    source: {
      c9SourceSha256: values["source-sha256"],
      inheritedC8FitSha256: priorFiles[0][1],
      promotedC8CalibrationSha256: priorFiles[1][1],
      browserTrainSourceSha256: Object.fromEntries(
        browserSources.map((file, index) => [
          file,
          sha(priorAndBrowserBytes[index + 2]),
        ]),
      ),
      sfPiCommit: hostCommit,
      sfPiRuntimeSha256: hostRuntimeSha256,
      sfPiPolicySha256: hostPolicySha256,
      scorerProtocolSha256: GUARDRAIL_PROTOCOL_SHA256,
      scriptSha256: sha(await readFile(fileURLToPath(import.meta.url))),
    },
    projectedPrior: {
      file: "prior-prepared.jsonl",
      sha256: sha(priorBytes),
      rows: admittedPrior.length,
      groups: new Set(admittedPrior.map((row) => row.group_id)).size,
    },
    projectedNew: {
      file: "new-prepared.jsonl",
      sha256: sha(newBytes),
      rows: projectedNew.length,
      groups: new Set(projectedNew.map((row) => row.group_id)).size,
    },
    counts: {
      inheritedRows: prior.length,
      inheritedPreparedRows: status.filter(
        (row) => row.kind === "prior" && row.gate === "model_prepared",
      ).length,
      inheritedAdmittedRows: admittedPrior.length,
      inheritedExcludedGroups: excludedPriorGroups.length,
      newRows: source.cases.length,
      newPreparedRows: projectedNew.length,
      newFailures: newFailures.length,
    },
    excludedPriorGroups,
    statuses: status,
    proofLimit:
      "Model-free replay of TRAIN only on final sf-pi host. Reconstructed facts and prompt parity gate inherited reuse. Prior groups with incomplete facts/floors are excluded whole; new failures reject admission. No model effectiveness claim.",
  };
  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, "prior-prepared.jsonl"), priorBytes, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(resolve(outputDir, "new-prepared.jsonl"), newBytes, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(
    resolve(outputDir, "receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      outputDir,
      ...receipt.counts,
      excludedPriorGroups,
      newFailures,
    }),
  );
  need(newFailures.length === 0, "C9 new TRAIN contains ineligible groups");
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
}
