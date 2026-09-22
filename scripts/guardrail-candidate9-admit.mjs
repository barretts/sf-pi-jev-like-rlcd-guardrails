#!/usr/bin/env node
/** Freeze the model-eligible C9 TRAIN fit/calibration partition; no model calls. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { RFDT_BASE_MODEL } from "../dist/rfdt.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const finalHost = {
  commit: "4f7fae07f7c04a7ca9f4fdbabc4594a20a8f1d2a",
  runtimeSha256:
    "4c4f874ef4f19988e7a7db84055ebf28c6d25813723acf2c807934e2c8f15421",
  policySha256:
    "e02e9c0914c1b1395adb0b341d6149b54b0b514c2b86cceab44994b5f6425347",
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const jsonlBytes = (rows) =>
  Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
const parseJsonl = (bytes) =>
  bytes.toString("utf8").trimEnd().split("\n").map(JSON.parse);
const need = (condition, reason) => {
  if (!condition) throw new Error(`C9 admission: ${reason}`);
};
const unique = (values) => new Set(values).size === values.length;
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
  throw new Error("Incomplete C9 admission value");
};

const { values } = parseArgs({
  options: {
    "source-dir": { type: "string" },
    "host-dir": { type: "string" },
    "controls-receipt": { type: "string" },
    "output-dir": { type: "string" },
  },
});
for (const key of ["source-dir", "host-dir", "controls-receipt", "output-dir"])
  need(values[key], `Missing --${key}`);
const sourceDir = resolve(values["source-dir"]),
  hostDir = resolve(values["host-dir"]),
  controlsReceiptFile = resolve(values["controls-receipt"]),
  outputDir = resolve(values["output-dir"]);
need(
  sourceDir.startsWith(resolve(root, ".build/guardrail/candidate-9-source-")) &&
    hostDir.startsWith(resolve(root, ".build/guardrail/candidate-9-host-")) &&
    outputDir.startsWith(
      resolve(root, ".build/guardrail/candidate-9-admission-"),
    ),
  "Inputs and output must be C9 .build directories",
);
const [
  sourceBytes,
  splitBytes,
  newPairBytes,
  controlsBytes,
  sourceReceiptBytes,
  priorBytes,
  newBytes,
  hostReceiptBytes,
  bashMapBytes,
  exclusionBytes,
  inheritedPairBytes,
  controlsReceiptBytes,
] = await Promise.all([
  readFile(resolve(sourceDir, "source.json")),
  readFile(resolve(sourceDir, "split-plan.json")),
  readFile(resolve(sourceDir, "fit-pairs.json")),
  readFile(resolve(sourceDir, "controls.json")),
  readFile(resolve(sourceDir, "receipt.json")),
  readFile(resolve(hostDir, "prior-prepared.jsonl")),
  readFile(resolve(hostDir, "new-prepared.jsonl")),
  readFile(resolve(hostDir, "receipt.json")),
  readFile(
    resolve(root, "fixtures/guardrail/candidate9/inherited-bash-families.json"),
  ),
  readFile(
    resolve(root, "fixtures/guardrail/candidate9/inherited-exclusions.json"),
  ),
  readFile(resolve(root, "fixtures/guardrail/candidate8/pairs.json")),
  readFile(controlsReceiptFile),
]);
const source = JSON.parse(sourceBytes),
  split = JSON.parse(splitBytes),
  newPairs = JSON.parse(newPairBytes),
  controls = JSON.parse(controlsBytes),
  sourceReceipt = JSON.parse(sourceReceiptBytes),
  hostReceipt = JSON.parse(hostReceiptBytes),
  bashMap = JSON.parse(bashMapBytes),
  exclusions = JSON.parse(exclusionBytes),
  inheritedPairs = JSON.parse(inheritedPairBytes).pairs,
  controlsReceipt = JSON.parse(controlsReceiptBytes);
need(
  source.version === 1 &&
    source.purpose === "candidate9_train_source" &&
    source.qualification === false &&
    source.baseModel === RFDT_BASE_MODEL &&
    split.purpose === "candidate9_train_calibration_split" &&
    newPairs.purpose === "candidate9_fit_pairs" &&
    sourceReceipt.purpose === "candidate9_source_composition" &&
    hostReceipt.purpose === "candidate9_train_final_host_projection" &&
    hostReceipt.modelCalls === 0 &&
    hostReceipt.externalOperationsExecuted === 0,
  "Source/host provenance invalid",
);
for (const [file, bytes] of Object.entries({
  "source.json": sourceBytes,
  "split-plan.json": splitBytes,
  "fit-pairs.json": newPairBytes,
  "controls.json": controlsBytes,
}))
  need(
    sourceReceipt.outputs[file] === sha(bytes),
    `${file} source SHA changed`,
  );
need(
  hostReceipt.source.c9SourceSha256 === sha(sourceBytes) &&
    hostReceipt.source.scriptSha256 ===
      sha(
        await readFile(
          resolve(root, "scripts/guardrail-candidate9-host-project.mjs"),
        ),
      ) &&
    hostReceipt.source.sfPiCommit === finalHost.commit &&
    hostReceipt.source.sfPiRuntimeSha256 === finalHost.runtimeSha256 &&
    hostReceipt.source.sfPiPolicySha256 === finalHost.policySha256 &&
    hostReceipt.projectedPrior.sha256 === sha(priorBytes) &&
    hostReceipt.projectedNew.sha256 === sha(newBytes) &&
    hostReceipt.counts.newFailures === 0 &&
    hostReceipt.counts.newPreparedRows === source.cases.length,
  "Final-host projection does not match source",
);
const projectedPrior = parseJsonl(priorBytes),
  added = parseJsonl(newBytes),
  sourceById = new Map(source.cases.map((row) => [row.id, row]));
const controlById = new Map(controls.controls.map((row) => [row.id, row]));
need(
  controlsReceipt.version === 1 &&
    controlsReceipt.purpose === "candidate9_host_controls" &&
    controlsReceipt.source.hostCommit === finalHost.commit &&
    controlsReceipt.baselineSha256 === finalHost.runtimeSha256 &&
    controlsReceipt.policySha256 === finalHost.policySha256 &&
    controlsReceipt.source.c9SourceSha256 === sha(sourceBytes) &&
    controlsReceipt.source.controlsSourceSha256 ===
      sourceReceipt.outputs["controls.json"] &&
    controlsReceipt.source.scriptSha256 ===
      sha(
        await readFile(
          resolve(root, "scripts/guardrail-candidate9-host-controls.mjs"),
        ),
      ) &&
    controlsReceipt.qualification === false &&
    controlsReceipt.heldOutTestRead === false &&
    controlsReceipt.counts.rows === controls.controls.length &&
    controlById.size === controls.controls.length &&
    controlsReceipt.records.length === controls.controls.length &&
    unique(controlsReceipt.records.map((row) => row.id)) &&
    controlsReceipt.counts.rows === controlsReceipt.counts.unchanged &&
    controlsReceipt.counts.hardBlocks ===
      controlsReceipt.records.filter((row) => row.baselineAction === "block")
        .length &&
    controlsReceipt.counts.hardBlocks >= 1 &&
    controlsReceipt.modelCalls === 0 &&
    controlsReceipt.externalOperationsExecuted === 0 &&
    controlsReceipt.records.every(
      (row) =>
        controlById.has(row.id) &&
        row.modelCalls === 0 &&
        row.actualAction === row.baselineAction &&
        row.baselineAction === controlById.get(row.id).expected &&
        row.gate === controlById.get(row.id).controlRoute &&
        row.operationSha256 ===
          sha(
            hostCanonical({
              toolName: controlById.get(row.id).toolName,
              input: controlById.get(row.id).input,
            }),
          ) &&
        /^[a-f0-9]{64}$/.test(row.effectivePolicySha256) &&
        row.effectivePolicySha256 ===
          (controlById.get(row.id).policyOverride
            ? row.effectivePolicySha256
            : finalHost.policySha256) &&
        (!controlById.get(row.id).policyOverride ||
          (row.effectivePolicySha256 !== finalHost.policySha256 &&
            row.gate === "exact_policy_floor" &&
            row.baselineAction === "block")) &&
        JSON.stringify(row.policyOverride ?? null) ===
          JSON.stringify(controlById.get(row.id).policyOverride ?? null),
    ),
  "Final-host controls receipt incomplete or changed",
);
need(
  exclusions.version === 1 &&
    exclusions.purpose === "candidate9_inherited_train_source_exclusions" &&
    Array.isArray(exclusions.groups) &&
    unique(exclusions.groups.map((entry) => entry.group_id)) &&
    exclusions.groups.every(
      (entry) =>
        entry.group_id &&
        entry.reason &&
        Array.isArray(entry.evidence) &&
        entry.evidence.length >= 2,
    ),
  "Source-review exclusion manifest incomplete",
);
const excludedGroups = new Set(
  exclusions.groups.map((entry) => entry.group_id),
);
need(
  [...excludedGroups].every((group) =>
    projectedPrior.some((row) => row.group_id === group),
  ),
  "Source-review exclusion has no projected group",
);
const prior = projectedPrior.filter((row) => !excludedGroups.has(row.group_id));
need(
  projectedPrior.length === hostReceipt.projectedPrior.rows &&
    added.length === hostReceipt.projectedNew.rows &&
    unique([...prior, ...added].map((row) => row.id)) &&
    sourceById.size === added.length,
  "Projected TRAIN IDs/counts incomplete",
);
for (const row of added) {
  const authored = sourceById.get(row.id);
  need(
    authored &&
      row.group_id === authored.groupId &&
      row.targets?.risk?.answer === authored.expected &&
      row.request?.state?.toolName === authored.toolName &&
      JSON.stringify(row.request.state.input) ===
        JSON.stringify(authored.input),
    `Projected source/target mismatch: ${row.id}`,
  );
}
const calGroups = new Set(split.calibrationGroups);
const newFitGroups = new Set(split.fitGroups);
need(
  unique(split.calibrationGroups) &&
    unique(split.fitGroups) &&
    [...calGroups].every((group) => !newFitGroups.has(group)),
  "FIT/CAL groups overlap",
);
const newGroups = new Set(added.map((row) => row.group_id));
need(
  [...newGroups].every(
    (group) => calGroups.has(group) !== newFitGroups.has(group),
  ) && [...calGroups, ...newFitGroups].every((group) => newGroups.has(group)),
  "New group partition changed",
);
const priorGroups = new Set(prior.map((row) => row.group_id));
need(
  [...priorGroups].every((group) => !newGroups.has(group)),
  "Inherited and new groups overlap",
);
const fit = [
  ...prior,
  ...added.filter((row) => newFitGroups.has(row.group_id)),
];
const calibration = added.filter((row) => calGroups.has(row.group_id));
need(
  calibration.length === 42 &&
    new Set(calibration.map((row) => row.group_id)).size === 21 &&
    calibration.every((row) => row.split === "train") &&
    fit.every((row) => row.split === "train"),
  "CAL reservation or source split changed",
);
const fitRows = fit.map((row) => ({ ...row, split: "train" }));
const calRows = calibration.map((row) => ({ ...row, split: "calibration" }));
const statusById = new Map(hostReceipt.statuses.map((row) => [row.id, row]));
need(
  statusById.size === hostReceipt.statuses.length &&
    calRows.every((row) => {
      const status = statusById.get(row.id);
      return (
        status?.kind === "new" &&
        status.gate === "model_prepared" &&
        /^[a-f0-9]{64}$/.test(status.inputSha256) &&
        ["allow", "confirm", "block"].includes(status.baselineAction)
      );
    }),
  "CAL final-host baseline inventory incomplete",
);
const fitById = new Map(fitRows.map((row) => [row.id, row]));
const bashFamilies = new Map(
  bashMap.groups.map((entry) => [entry.group_id, entry.family]),
);
need(
  bashMap.version === 1 &&
    bashMap.purpose === "candidate9_inherited_bash_family_review" &&
    bashFamilies.size === bashMap.groups.length,
  "Inherited bash family review invalid",
);
const nativeFamily = (toolName) => {
  if (toolName === "herdr_pane") return "herdr_pane";
  if (toolName === "sf_apex") return "apex";
  if (toolName === "agentscript_lifecycle") return "agentscript";
  if (toolName.startsWith("data360_")) return "data360";
  if (toolName === "sf_soql") return "soql";
  if (toolName === "slack_canvas") return "canvas";
  if (toolName === "sf_browser_click") return "browser";
  return null;
};
const families = {
  version: 1,
  purpose: "candidate9_fit_families",
  rows: fitRows.map((row) => {
    const family = sourceById.has(row.id)
      ? sourceById.get(row.id).family
      : row.request.state.toolName === "bash"
        ? bashFamilies.get(row.group_id)
        : nativeFamily(row.request.state.toolName);
    need(family, `Missing reviewed FIT family: ${row.id}`);
    return {
      id: row.id,
      group_id: row.group_id,
      family,
      expected: row.targets.risk.answer,
    };
  }),
};
const usedMembers = new Set();
const acceptedPairs = [...inheritedPairs, ...newPairs.pairs].filter(
  (pair) => fitById.has(pair.safe_id) && fitById.has(pair.risky_id),
);
for (const pair of acceptedPairs) {
  const safe = fitById.get(pair.safe_id),
    risky = fitById.get(pair.risky_id);
  need(
    safe.group_id === pair.group_id &&
      risky.group_id === pair.group_id &&
      safe.targets.risk.answer === "allow" &&
      risky.targets.risk.answer === "confirm" &&
      !usedMembers.has(pair.safe_id) &&
      !usedMembers.has(pair.risky_id),
    `Uncontrolled or reused pair: ${pair.pair_id}`,
  );
  usedMembers.add(pair.safe_id);
  usedMembers.add(pair.risky_id);
}
need(
  acceptedPairs.length ===
    new Set(acceptedPairs.map((pair) => pair.pair_id)).size &&
    newPairs.pairs.every((pair) => acceptedPairs.includes(pair)) &&
    acceptedPairs.length >= newPairs.pairs.length,
  "FIT pair manifest incomplete",
);
const pairs = { version: 1, pairs: acceptedPairs };
const outputFiles = {
  "fit.jsonl": jsonlBytes(fitRows),
  "calibration.jsonl": jsonlBytes(calRows),
  "pairs.json": jsonBytes(pairs),
  "families.json": jsonBytes(families),
};
const baseline = {
  version: 1,
  purpose: "candidate9_train_cal_baseline_replay",
  baselineSha256: finalHost.runtimeSha256,
  policySha256: finalHost.policySha256,
  calibrationCorpusSha256: sha(outputFiles["calibration.jsonl"]),
  qualification: false,
  modelCalls: 0,
  externalOperationsExecuted: 0,
  heldOutTestRead: false,
  source: {
    hostCommit: finalHost.commit,
    scriptSha256: hostReceipt.source.scriptSha256,
    hostProjectionReceiptSha256: sha(hostReceiptBytes),
    c9SourceSha256: sha(sourceBytes),
  },
  records: calRows.map((row) => {
    const status = statusById.get(row.id);
    return {
      id: row.id,
      inputSha256: status.inputSha256,
      action: status.baselineAction,
      gate: status.gate,
      route: status.route,
      ruleId: status.ruleId,
      factRoute: status.factRoute,
    };
  }),
};
outputFiles["calibration-baseline.json"] = jsonBytes(baseline);
const familyCounts = Object.fromEntries(
  [...new Set(families.rows.map((row) => row.family))].sort().map((family) => [
    family,
    {
      rows: families.rows.filter((row) => row.family === family).length,
      allow: families.rows.filter(
        (row) => row.family === family && row.expected === "allow",
      ).length,
      confirm: families.rows.filter(
        (row) => row.family === family && row.expected === "confirm",
      ).length,
    },
  ]),
);
const admission = {
  version: 1,
  purpose: "candidate9_fit_calibration_admission",
  trainingReady: true,
  qualification: false,
  modelCalls: 0,
  c8ValidBodyRead: false,
  heldOutTestRead: false,
  source: {
    baseModel: RFDT_BASE_MODEL,
    scorerProtocolSha256: hostReceipt.source.scorerProtocolSha256,
    hostCommit: hostReceipt.source.sfPiCommit,
    hostRuntimeSha256: hostReceipt.source.sfPiRuntimeSha256,
    c9SourceSha256: sha(sourceBytes),
    pairsSha256: sha(outputFiles["pairs.json"]),
    familiesSha256: sha(outputFiles["families.json"]),
    sourceCompositionReceiptSha256: sha(sourceReceiptBytes),
    hostProjectionReceiptSha256: sha(hostReceiptBytes),
    inheritedBashFamilySha256: sha(bashMapBytes),
    inheritedSourceExclusionSha256: sha(exclusionBytes),
    inheritedPairsSha256: sha(inheritedPairBytes),
    calibrationBaselineReceiptSha256: sha(
      outputFiles["calibration-baseline.json"],
    ),
    hostControlsReceiptSha256: sha(controlsReceiptBytes),
    scriptSha256: sha(await readFile(fileURLToPath(import.meta.url))),
  },
  fit: {
    sha256: sha(outputFiles["fit.jsonl"]),
    rows: fitRows.length,
    groups: new Set(fitRows.map((row) => row.group_id)).size,
  },
  calibration: {
    sha256: sha(outputFiles["calibration.jsonl"]),
    rows: calRows.length,
    groups: new Set(calRows.map((row) => row.group_id)).size,
    notPassedToFit: true,
  },
  counts: {
    inheritedRows: prior.length,
    inheritedHostPreparedRows: projectedPrior.length,
    inheritedSourceExcludedGroups: excludedGroups.size,
    newFitRows: added.length - calRows.length,
    pairs: acceptedPairs.length,
    inheritedPairs: acceptedPairs.length - newPairs.pairs.length,
    newPairs: newPairs.pairs.length,
    fitAllow: fitRows.filter((row) => row.targets.risk.answer === "allow")
      .length,
    fitConfirm: fitRows.filter((row) => row.targets.risk.answer === "confirm")
      .length,
  },
  familyCounts,
  excludedInheritedGroups: exclusions.groups,
  proofLimit:
    "TRAIN-only admission and host preparation, not model effectiveness or split independence. CAL was reserved by complete groups; no VALID or TEST body was used.",
};
await mkdir(outputDir, { recursive: true });
for (const [file, bytes] of Object.entries({
  ...outputFiles,
  "admission.json": jsonBytes(admission),
}))
  await writeFile(resolve(outputDir, file), bytes, { flag: "wx", mode: 0o600 });
console.log(
  JSON.stringify({
    outputDir,
    ...admission.fit,
    calibration: admission.calibration,
    ...admission.counts,
    familyCounts,
  }),
);
