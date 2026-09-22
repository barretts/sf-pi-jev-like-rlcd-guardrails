#!/usr/bin/env node
/** Compose only reviewed C9 TRAIN parts; never read VALID or TEST bodies. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lanes = [
  ["shell", "shell", "bash", "c9-shell-"],
  ["pane", "herdr_pane", "herdr_pane", "c9-pane-"],
  ["salesforce-cli", "salesforce_cli", "bash", "c9-sfcli-"],
  ["data360", "data360", null, "c9-data360-"],
  ["soql", "soql", null, "c9-soql-"],
  ["canvas", "canvas", null, "c9-canvas-"],
  ["browser", "browser", "sf_browser_click", "c9-browser-"],
];
const priorFitRel =
  "reports/guardrail-risk-2026-09-21/candidate-8-evidence/train/fit.jsonl";
const priorCalRel =
  "reports/guardrail-risk-2026-09-21/candidate-8-evidence/train/calibration.jsonl";
const priorFitSha =
  "17f6672fffe913aacdbf44394119bc0b14fbab5db4cc87fccf21c66da449cdc5";
const priorCalSha =
  "7371877d67874e8d55c418b678d9d808207bb4e645d1868d4e44ad8d5d57144f";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const need = (condition, reason) => {
  if (!condition) throw new Error("C9 compose: " + reason);
};
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  return value;
};
const operation = (toolName, input) =>
  JSON.stringify(canonical([toolName, input]));
const jsonBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const parseJsonl = (bytes) =>
  bytes.toString("utf8").trimEnd().split("\n").map(JSON.parse);

const { values } = parseArgs({ options: { "output-dir": { type: "string" } } });
need(values["output-dir"], "Missing --output-dir");
const outputDir = resolve(values["output-dir"]);
need(
  outputDir.startsWith(resolve(root, ".build/guardrail/candidate-9-source-")),
  "Output must be a fresh C9 source build directory",
);
const [priorFitBytes, priorCalBytes, ...partBytes] = await Promise.all([
  readFile(resolve(root, priorFitRel)),
  readFile(resolve(root, priorCalRel)),
  ...lanes.map(([file]) =>
    readFile(resolve(root, `fixtures/guardrail/candidate9/parts/${file}.json`)),
  ),
]);
need(
  sha(priorFitBytes) === priorFitSha && sha(priorCalBytes) === priorCalSha,
  "C8 FIT/CAL source changed",
);
const prior = [...parseJsonl(priorFitBytes), ...parseJsonl(priorCalBytes)];
need(prior.length === 273, "C8 FIT/CAL count changed");
const priorIds = new Set(prior.map((row) => row.id));
const priorGroups = new Set(prior.map((row) => row.group_id));
const priorOperations = new Set(
  prior.map((row) =>
    operation(row.request.state.toolName, row.request.state.input),
  ),
);
const priorCommands = new Set(
  prior.map((row) => row.request.state.input.command).filter(Boolean),
);
const parts = partBytes.map((bytes) => JSON.parse(bytes));
const cases = [],
  controls = [],
  calibrationGroups = [],
  fitPairs = [];
const sourceIds = new Set(),
  sourceGroups = new Set(),
  sourceOperations = new Set(),
  controlIds = new Set();
const perLane = [];
for (let index = 0; index < lanes.length; index++) {
  const [file, family, tool, prefix] = lanes[index];
  const part = parts[index];
  need(
    part.version === 1 &&
      part.family === family &&
      Array.isArray(part.calibrationGroups) &&
      Array.isArray(part.cases) &&
      (part.controls === undefined || Array.isArray(part.controls)),
    `Invalid ${file} part schema`,
  );
  const byGroup = new Map();
  const calSet = new Set(part.calibrationGroups);
  need(
    calSet.size === part.calibrationGroups.length,
    `Duplicate ${file} CAL group`,
  );
  for (const row of part.cases) {
    need(
      typeof row.id === "string" &&
        row.id.startsWith(prefix) &&
        typeof row.groupId === "string" &&
        row.groupId.startsWith(prefix) &&
        row.id === `${row.groupId}-${row.expected}` &&
        row.family === family &&
        row.split === "train" &&
        ["allow", "confirm"].includes(row.expected) &&
        typeof row.toolName === "string" &&
        (tool === null || row.toolName === tool) &&
        row.input &&
        typeof row.input === "object" &&
        !Array.isArray(row.input) &&
        row.observations &&
        typeof row.observations === "object" &&
        Array.isArray(row.fixturePreconditions) &&
        row.fixturePreconditions.length > 0 &&
        Array.isArray(row.sourceEvidence) &&
        row.sourceEvidence.includes("fixtures/guardrail/RUBRIC.md") &&
        typeof row.policyRationale === "string" &&
        row.policyRationale.trim() &&
        typeof row.controlledRiskChange === "string" &&
        row.controlledRiskChange.trim(),
      `Incomplete ${file} source row`,
    );
    need(
      !Object.keys(row.observations).some((key) =>
        /baseline|classification|decision|reason|risk|approved/i.test(key),
      ),
      `${file} observations leaked a classification`,
    );
    need(
      !sourceIds.has(row.id) &&
        !priorIds.has(row.id) &&
        !priorGroups.has(row.groupId),
      `Duplicate or prior TRAIN ID/group in ${file}`,
    );
    sourceIds.add(row.id);
    const op = operation(row.toolName, row.input);
    need(
      !sourceOperations.has(op) &&
        !priorOperations.has(op) &&
        (!row.input.command || !priorCommands.has(row.input.command)),
      `Exact TRAIN operation/command overlap in ${file}`,
    );
    sourceOperations.add(op);
    const members = byGroup.get(row.groupId) ?? [];
    members.push(row);
    byGroup.set(row.groupId, members);
    cases.push(row);
  }
  for (const [groupId, members] of byGroup) {
    need(
      members.length === 2 &&
        members[0].controlledRiskChange === members[1].controlledRiskChange &&
        new Set(members.map((row) => row.expected)).size === 2 &&
        !sourceGroups.has(groupId),
      `Incomplete or duplicate ${file} contrast group`,
    );
    sourceGroups.add(groupId);
    if (calSet.has(groupId)) calibrationGroups.push(groupId);
    else
      fitPairs.push({
        pair_id: groupId,
        group_id: groupId,
        safe_id: `${groupId}-allow`,
        risky_id: `${groupId}-confirm`,
      });
  }
  need(
    [...calSet].every((group) => byGroup.has(group)),
    `${file} CAL group has no complete source pair`,
  );
  // Two FIT groups were removed after independent blind split review. Keep the
  // three CAL groups and every other lane's original reservation unchanged.
  const expectedFitGroups = file === "pane" || file === "canvas" ? 9 : 10;
  need(
    byGroup.size === expectedFitGroups + 3 && calSet.size === 3,
    `${file} must reserve ${expectedFitGroups} FIT and three CAL contrast groups`,
  );
  for (const control of part.controls ?? []) {
    need(
      typeof control.id === "string" &&
        control.id.startsWith(prefix + "control-") &&
        !sourceIds.has(control.id) &&
        !controlIds.has(control.id) &&
        control.family === family &&
        typeof control.toolName === "string" &&
        control.input &&
        typeof control.input === "object" &&
        control.observations &&
        typeof control.observations === "object" &&
        ["allow", "confirm", "block"].includes(control.expected) &&
        ["exact_policy_floor", "rules_fallback"].includes(
          control.controlRoute,
        ) &&
        Array.isArray(control.sourceEvidence) &&
        control.sourceEvidence.includes("fixtures/guardrail/RUBRIC.md"),
      `Incomplete ${file} host control`,
    );
    controlIds.add(control.id);
    controls.push(control);
  }
  perLane.push({
    family,
    groups: byGroup.size,
    fitGroups: byGroup.size - calSet.size,
    calibrationGroups: calSet.size,
    cases: part.cases.length,
    controls: part.controls?.length ?? 0,
    sha256: sha(partBytes[index]),
  });
}
need(cases.length === sourceIds.size, "C9 source IDs changed");
need(
  calibrationGroups.length + fitPairs.length === sourceGroups.size,
  "C9 FIT/CAL group partition incomplete",
);
const source = {
  version: 1,
  purpose: "candidate9_train_source",
  rubric: "operation-policy-v2",
  baseModel: "google/gemma-3-1b-it",
  qualification: false,
  humanLabelReviewed: false,
  heldOutTestRead: false,
  c8ValidBodyRead: false,
  cases,
};
const split = {
  version: 1,
  purpose: "candidate9_train_calibration_split",
  calibrationGroups,
  fitGroups: fitPairs.map((pair) => pair.group_id),
  inheritedC8FitSha256: priorFitSha,
  promotedC8CalibrationSha256: priorCalSha,
  qualification: false,
  heldOutTestRead: false,
};
const pairs = {
  version: 1,
  purpose: "candidate9_fit_pairs",
  pairs: fitPairs,
};
const controlsFile = {
  version: 1,
  purpose: "candidate9_host_controls_source",
  controls,
};
const outputs = {
  "source.json": jsonBytes(source),
  "split-plan.json": jsonBytes(split),
  "fit-pairs.json": jsonBytes(pairs),
  "controls.json": jsonBytes(controlsFile),
};
const receipt = {
  version: 1,
  purpose: "candidate9_source_composition",
  qualification: false,
  modelCalls: 0,
  externalOperationsExecuted: 0,
  c8ValidBodyRead: false,
  heldOutTestRead: false,
  source: {
    inheritedC8FitSha256: priorFitSha,
    promotedC8CalibrationSha256: priorCalSha,
    partSha256: Object.fromEntries(
      lanes.map(([file], index) => [file, sha(partBytes[index])]),
    ),
    scriptSha256: sha(await readFile(fileURLToPath(import.meta.url))),
  },
  outputs: Object.fromEntries(
    Object.entries(outputs).map(([file, bytes]) => [file, sha(bytes)]),
  ),
  counts: {
    cases: cases.length,
    groups: sourceGroups.size,
    fitPairs: fitPairs.length,
    calibrationPairs: calibrationGroups.length,
    controls: controls.length,
    allow: cases.filter((row) => row.expected === "allow").length,
    confirm: cases.filter((row) => row.expected === "confirm").length,
    exactPriorOperationOverlap: 0,
    exactPriorCommandOverlap: 0,
  },
  perLane,
  proofLimit:
    "Exact overlap against admitted C8 FIT/CAL does not prove semantic independence. No C8 VALID or held-out TEST body is read; independent blind overlap review is required after source freeze.",
};
await mkdir(outputDir, { recursive: true });
for (const [file, bytes] of Object.entries({
  ...outputs,
  "receipt.json": jsonBytes(receipt),
}))
  await writeFile(resolve(outputDir, file), bytes, { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ outputDir, ...receipt.counts, perLane }));
