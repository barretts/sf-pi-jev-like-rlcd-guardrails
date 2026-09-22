#!/usr/bin/env node
/** C8 TRAIN-only integrity and overlap screen. Never reads a TEST body. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceFile = resolve(
  root,
  "fixtures/guardrail/candidate8/train-recovery.json",
);
const pairsFile = resolve(root, "fixtures/guardrail/candidate8/pairs.json");
const splitFile = resolve(
  root,
  "fixtures/guardrail/candidate8/split-plan.json",
);
const builderFile = resolve(
  root,
  "fixtures/guardrail/candidate8/build-train-recovery.mjs",
);
const baseFile = resolve(
  root,
  "reports/guardrail-risk-2026-09-21/candidate-7-evidence/train/admitted-train.jsonl",
);
const baseSha =
  "745004e919d7c8cd6d3a1bb0078f741a9fa6134443ea195b618cf6a39aed53e7";
const validSha =
  "5c34cdd17d8741d5dd819756ff150371fcebb6dfdc5bdbe4476e57a906cc4a0f";
const blindSha =
  "868dac2146b72e732b07017c451f88f1066c2faea3c46300f5fba75545e76200";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const need = (ok, why) => {
  if (!ok) throw new Error(why);
};
const opKey = (tool, input) => JSON.stringify([tool, input]);

const { values } = parseArgs({
  options: {
    valid: { type: "string" },
    "blind-manifest": { type: "string" },
    output: { type: "string" },
  },
});
need(
  values.valid && values["blind-manifest"],
  "Pass --valid and --blind-manifest",
);
need(
  /\/blind-c7-20260922\/valid\.json$/.test(resolve(values.valid)),
  "Only scored C7 VALID is allowed",
);
need(
  /\/blind-c7-20260922\/manifest\.json$/.test(
    resolve(values["blind-manifest"]),
  ),
  "Only opaque C7 blind manifest is allowed",
);
const [
  sourceBytes,
  pairBytes,
  splitBytes,
  baseBytes,
  validBytes,
  blindBytes,
  builderBytes,
] = await Promise.all([
  readFile(sourceFile),
  readFile(pairsFile),
  readFile(splitFile),
  readFile(baseFile),
  readFile(values.valid),
  readFile(values["blind-manifest"]),
  readFile(builderFile),
]);
need(
  sha(baseBytes) === baseSha &&
    sha(validBytes) === validSha &&
    sha(blindBytes) === blindSha,
  "Pinned C7 TRAIN, VALID, or opaque manifest bytes changed",
);
const source = JSON.parse(sourceBytes),
  pairs = JSON.parse(pairBytes),
  split = JSON.parse(splitBytes);
const base = baseBytes.toString("utf8").trimEnd().split("\n").map(JSON.parse);
const valid = JSON.parse(validBytes),
  blind = JSON.parse(blindBytes);
need(
  source.version === 1 &&
    source.rubric === "operation-policy-v2" &&
    source.baseModel === "google/gemma-3-1b-it" &&
    source.trainingReady === false &&
    source.qualification === false &&
    source.humanLabelReviewed === false &&
    source.agentRubricReviewed === true &&
    source.cases?.length === 48,
  "Unexpected C8 TRAIN source",
);
need(
  pairs.version === 1 &&
    Object.keys(pairs).sort().join(",") === "pairs,version" &&
    pairs.pairs?.length === 31,
  "Unexpected fit pair manifest",
);
need(
  split.version === 1 &&
    split.calibrationNewGroups?.length === 4 &&
    split.calibrationInheritedGroups?.length === 13 &&
    split.excludedNewGroups?.length === 1 &&
    split.qualification === false &&
    split.heldOutTestRead === false,
  "Unexpected calibration split plan",
);
need(
  base.length === 227 &&
    new Set(base.map((row) => row.group_id)).size === 77 &&
    base.every(
      (row) =>
        row.split === "train" && row.request?.model === "google/gemma-3-1b-it",
    ),
  "Inherited TRAIN contract changed",
);
need(
  valid.split === "valid" &&
    valid.cases?.length === 65 &&
    blind.splits?.valid?.sha256 === validSha &&
    blind.splits?.test?.case_count === 65,
  "Blind split metadata changed",
);

const ids = new Set(),
  groups = new Map(),
  operations = new Set();
for (const row of source.cases) {
  need(
    typeof row.id === "string" && row.id.startsWith("c8-") && !ids.has(row.id),
    "Duplicate/invalid C8 ID",
  );
  ids.add(row.id);
  need(
    row.split === "train" &&
      row.groupId?.startsWith("c8-") &&
      ["allow", "confirm"].includes(row.expected) &&
      typeof row.toolName === "string" &&
      row.input &&
      typeof row.input === "object" &&
      !Array.isArray(row.input) &&
      row.observations &&
      typeof row.observations === "object" &&
      Array.isArray(row.fixturePreconditions) &&
      row.fixturePreconditions.length &&
      Array.isArray(row.sourceEvidence) &&
      row.sourceEvidence.includes("fixtures/guardrail/RUBRIC.md") &&
      typeof row.policyRationale === "string" &&
      row.policyRationale.trim() &&
      typeof row.controlledRiskChange === "string" &&
      row.controlledRiskChange.trim(),
    "Incomplete C8 policy row: " + row.id,
  );
  need(
    !Object.keys(row.observations).some((key) =>
      /baseline|rule|decision|risk|approved/i.test(key),
    ),
    "Existing classification leaked to observations: " + row.id,
  );
  const op = opKey(row.toolName, row.input);
  need(!operations.has(op), "Duplicate C8 operation: " + row.id);
  operations.add(op);
  const members = groups.get(row.groupId) ?? [];
  members.push(row);
  groups.set(row.groupId, members);
}
need(groups.size === 18, "C8 group count changed");
for (const [group, rows] of groups) {
  need(
    rows.length % 2 === 0 &&
      rows.length >= 2 &&
      rows.filter((row) => row.expected === "allow").length ===
        rows.length / 2 &&
      rows.filter((row) => row.expected === "confirm").length ===
        rows.length / 2,
    "Incomplete matched group: " + group,
  );
}
const calNew = new Set(split.calibrationNewGroups);
const calInherited = new Set(split.calibrationInheritedGroups);
const excludedNew = new Set(split.excludedNewGroups);
need(
  calNew.size === 4 &&
    calInherited.size === 13 &&
    excludedNew.size === 1 &&
    [...calNew].every((group) => groups.has(group)) &&
    [...excludedNew].every(
      (group) => groups.has(group) && !calNew.has(group),
    ) &&
    [...calInherited].every((group) =>
      base.some((row) => row.group_id === group),
    ),
  "Calibration groups absent or repeated",
);
const fitNew = source.cases.filter(
  (row) => !calNew.has(row.groupId) && !excludedNew.has(row.groupId),
);
const calibrationNew = source.cases.filter((row) => calNew.has(row.groupId));
const excludedNewRows = source.cases.filter((row) =>
  excludedNew.has(row.groupId),
);
const fitInherited = base.filter((row) => !calInherited.has(row.group_id));
const calibrationInherited = base.filter((row) =>
  calInherited.has(row.group_id),
);
need(
  fitNew.length === 36 &&
    calibrationNew.length === 10 &&
    excludedNewRows.length === 2 &&
    fitInherited.length + calibrationInherited.length === 227,
  "Split row accounting changed",
);
const used = new Set(),
  pairIds = new Set();
const fitNewById = new Map(fitNew.map((row) => [row.id, row]));
const fitInheritedById = new Map(fitInherited.map((row) => [row.id, row]));
for (const pair of pairs.pairs) {
  need(
    Object.keys(pair).sort().join(",") ===
      "group_id,pair_id,risky_id,safe_id" &&
      !pairIds.has(pair.pair_id) &&
      !calNew.has(pair.group_id) &&
      !excludedNew.has(pair.group_id) &&
      !calInherited.has(pair.group_id),
    "Invalid, duplicate, or calibration pair",
  );
  pairIds.add(pair.pair_id);
  const safe =
    fitNewById.get(pair.safe_id) ?? fitInheritedById.get(pair.safe_id);
  const risky =
    fitNewById.get(pair.risky_id) ?? fitInheritedById.get(pair.risky_id);
  need(
    (safe?.expected ?? safe?.targets?.risk?.answer) === "allow" &&
      (risky?.expected ?? risky?.targets?.risk?.answer) === "confirm" &&
      (safe?.groupId ?? safe?.group_id) === pair.group_id &&
      (risky?.groupId ?? risky?.group_id) === pair.group_id &&
      !used.has(safe.id) &&
      !used.has(risky.id),
    "Pair violates fit-only opposite-label contract: " + pair.pair_id,
  );
  used.add(safe.id);
  used.add(risky.id);
}
need(
  fitNew.every((row) => used.has(row.id)) &&
    pairs.pairs.filter((pair) => pair.group_id.startsWith("c8-")).length ===
      18 &&
    pairs.pairs.filter((pair) => !pair.group_id.startsWith("c8-")).length ===
      13,
  "Fit pair manifest omitted new fit rows or changed reviewed inherited selection",
);
const baseOps = new Set(
  base.map((row) => opKey(row.request.state.toolName, row.request.state.input)),
);
const validOps = new Set(
  valid.cases.map((row) => opKey(row.operation.tool, row.operation.input)),
);
const validCommands = new Set(
  valid.cases.map((row) => row.operation.input.command).filter(Boolean),
);
need(
  !source.cases.some((row) => baseOps.has(opKey(row.toolName, row.input))) &&
    !source.cases.some((row) => validOps.has(opKey(row.toolName, row.input))) &&
    !source.cases.some((row) => validCommands.has(row.input.command)),
  "C8 copies an exact C7 TRAIN/VALID operation or VALID command",
);
const sourceText = sourceBytes.toString("utf8");
need(
  !sourceText.includes("OrderReviewAgent") &&
    !sourceText.includes("sf agent deactivate --api-name"),
  "Excluded incidental legacy TEST syntax appeared in C8 source",
);
const rowHash = (rows) =>
  sha(
    Buffer.from(
      rows
        .map((row) => row.id)
        .sort()
        .join("\n") + "\n",
    ),
  );
const receipt = {
  version: 1,
  purpose: "candidate8_train_source_screen",
  qualification: false,
  trainingReady: false,
  humanLabelReviewed: false,
  modelCalls: 0,
  externalOperationsExecuted: 0,
  heldOutTestBodyRead: false,
  provenanceLimit:
    "C7 VALID outcomes informed C8 TRAIN error families. A few legacy v2 TEST syntax lines were incidentally returned by an rg during development; those strings/templates were excluded. The sealed C7 TEST body was never read. Exact overlap checks cannot establish semantic independence or compare unseen TEST operations.",
  source: {
    file: sourceFile,
    sha256: sha(sourceBytes),
    builderSha256: sha(builderBytes),
    pairsSha256: sha(pairBytes),
    splitPlanSha256: sha(splitBytes),
    rubricSha256: sha(
      await readFile(resolve(root, "fixtures/guardrail/RUBRIC.md")),
    ),
    screenScriptSha256: sha(await readFile(fileURLToPath(import.meta.url))),
  },
  counts: {
    rows: source.cases.length,
    groups: groups.size,
    fitPairs: pairs.pairs.length,
    newFitPairs: 18,
    inheritedFitPairs: 13,
    allow: source.cases.filter((row) => row.expected === "allow").length,
    confirm: source.cases.filter((row) => row.expected === "confirm").length,
    byFamily: Object.fromEntries(
      [...new Set(source.cases.map((row) => row.family))]
        .sort()
        .map((family) => [
          family,
          source.cases.filter((row) => row.family === family).length,
        ]),
    ),
  },
  partition: {
    fit: {
      inheritedRows: fitInherited.length,
      newRows: fitNew.length,
      totalRows: fitInherited.length + fitNew.length,
      inheritedGroups: 77 - calInherited.size,
      newGroups: 18 - calNew.size - excludedNew.size,
      newIdsSha256: rowHash(fitNew),
      inheritedIdsSha256: rowHash(fitInherited),
    },
    calibration: {
      inheritedRows: calibrationInherited.length,
      newRows: calibrationNew.length,
      totalRows: calibrationInherited.length + calibrationNew.length,
      inheritedGroups: calInherited.size,
      newGroups: calNew.size,
      newIdsSha256: rowHash(calibrationNew),
      inheritedIdsSha256: rowHash(calibrationInherited),
    },
    excludedHostFallback: {
      rows: excludedNewRows.length,
      groups: excludedNew.size,
      newIdsSha256: rowHash(excludedNewRows),
      reason: "Unverified org identity triggers code-owned fallback",
    },
  },
  priorTrain: {
    sha256: baseSha,
    rows: base.length,
    groups: 77,
    exactOperationOverlap: 0,
  },
  diagnosticValid: {
    sha256: validSha,
    rows: valid.cases.length,
    exactOperationOverlap: 0,
    exactCommandOverlap: 0,
    selectionEvidence: false,
  },
  opaquePriorTest: {
    manifestSha256: blindSha,
    contentSha256: blind.splits.test.sha256,
    cases: blind.splits.test.case_count,
    groups: blind.splits.test.group_count,
    groupIdsSha256: blind.splits.test.group_ids_sha256,
    templateIdsSha256: blind.splits.test.template_ids_sha256,
    bodyRead: false,
    operationOverlapKnown: false,
  },
};
if (values.output) {
  const output = resolve(values.output);
  need(
    output.startsWith(
      resolve(root, ".build/guardrail/candidate-8-train-screen-"),
    ) && output.endsWith("/receipt.json"),
    "Output must be under fresh C8 .build screen directory",
  );
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(receipt, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
}
console.log(JSON.stringify(receipt));
