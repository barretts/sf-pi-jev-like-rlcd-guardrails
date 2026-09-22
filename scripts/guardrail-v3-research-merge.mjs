#!/usr/bin/env node
/** Combine two already projected TRAIN/VALID research datasets; never qualify. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  guardrailRequest,
  GUARDRAIL_PROTOCOL_SHA256,
} from "../dist/guardrail.js";
import { assignRfdtSplits, validateRfdtExample } from "../dist/rfdt.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const officialRun = resolve(root, ".build/guardrail/candidate-5");
const originalBase = "google/gemma-3-1b-it";
const originalRevision = "dcc83ea841ab6100d6b47a070329e1ba4cf78752";
const originalWeightsSha256 =
  "3d4ef8d71c14db7e448a09ebe891cfb6bf32c57a9b44499ae0d1c098e48516b6";
const sealedCorpusSha256 =
  "bb4ed147933c076111b127e6a5433c6ce7ea54cc43befb7d384ddb54681e6309";
/** Reviewed TRAIN near-replays of fixed VALID operations; no VALID row is removed. */
const withheldTrainGroups = Object.freeze([
  "train-shell-quoted-remove",
  "v2-train-apex-cli-recalculateLeadScores",
  "v2-train-soql-large-contact-read",
  "v3-train-canvas-release-heading-lookup",
  "train-shell-recursive-force-remove",
  "train-shell-secure-shred",
  "train-salesforce-production-deploy",
  "train-salesforce-production-data-delete",
]);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashFile = async (path) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};
const inside = (file, directory) => {
  const rel = relative(directory, file);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel))
  );
};
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const canonical = (value) =>
  JSON.stringify(value, (_, item) =>
    item && !Array.isArray(item) && typeof item === "object"
      ? Object.fromEntries(
          Object.entries(item).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : item,
  );
const lines = (bytes) =>
  bytes
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));

function checkRows(rows, allowedSplits, expectedModel) {
  if (!rows.length) throw new Error("Empty research input");
  const ids = new Set();
  const groups = new Map();
  const inputs = new Map();
  const duplicateIds = new Set();
  for (const row of rows) {
    const validated = validateRfdtExample(row);
    if (
      typeof row.id !== "string" ||
      !row.id ||
      ids.has(row.id) ||
      typeof row.group_id !== "string" ||
      !row.group_id ||
      !allowedSplits.includes(row.split) ||
      row.request?.model !== expectedModel ||
      row.request?.options?.template_version !== "v2" ||
      row.request?.state === undefined ||
      row.request.state?.toolName?.startsWith("sf_browser_") ||
      row.request.questions?.length !== 1 ||
      row.request.questions[0]?.id !== "risk" ||
      row.request.questions[0]?.type !== "choice" ||
      canonical(row.request.questions[0]?.criteria?.map((item) => item.id)) !==
        canonical(["allow", "confirm"]) ||
      canonical(Object.keys(row.targets ?? {})) !== canonical(["risk"]) ||
      canonical(Object.keys(row.target_provenance ?? {})) !==
        canonical(["risk"]) ||
      !["allow", "confirm"].includes(row.targets?.risk?.answer) ||
      canonical(row.targets?.risk) !==
        canonical({ answer: row.targets?.risk?.answer }) ||
      canonical(row.target_provenance?.risk) !==
        canonical({ source: "supplied" }) ||
      row.regression !== undefined ||
      validated.request.questions.length !== 1 ||
      canonical(row.request) !==
        canonical(guardrailRequest(row.request.state, expectedModel))
    )
      throw new Error("Invalid or duplicate TRAIN/VALID research row");
    ids.add(row.id);
    const previous = groups.get(row.group_id);
    if (previous && previous !== row.split)
      throw new Error("Operation group crosses TRAIN and validation");
    groups.set(row.group_id, row.split);
    const input = canonical(row.request.state);
    const first = inputs.get(input);
    if (first) {
      if (
        first.group_id !== row.group_id ||
        first.split !== row.split ||
        first.targets.risk.answer !== row.targets.risk.answer ||
        row.split !== "train"
      )
        throw new Error("Model input repeats across groups, splits, or labels");
      duplicateIds.add(row.id);
    } else inputs.set(input, row);
  }
  return { ids, groups, inputs, duplicateIds };
}

async function main() {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      supplement: { type: "string" },
      "sf-pi": { type: "string" },
      output: { type: "string" },
      receipt: { type: "string" },
    },
  });
  if (Object.keys(values).length !== 5 || Object.values(values).some((v) => !v))
    throw new Error(
      "Required: --base V3_RECEIPT --supplement TRAIN_RECEIPT --sf-pi SF_CHECKOUT --output NEW_JSONL --receipt NEW_JSON",
    );
  const sf = resolve(values["sf-pi"]);
  const output = resolve(values.output);
  const receiptPath = resolve(values.receipt);
  if (
    output === receiptPath ||
    inside(output, officialRun) ||
    inside(receiptPath, officialRun)
  )
    throw new Error(
      "Research merge must stay outside the official candidate-5 run",
    );
  const [base, supplement] = await Promise.all([
    readJson(resolve(values.base)),
    readJson(resolve(values.supplement)),
  ]);
  if (
    base.purpose !== "nonqualifying_v3_train_validation_research_export" ||
    base.qualification !== false ||
    base.officialCandidate5Admission !== false ||
    base.heldOutContentEmitted !== false ||
    supplement.purpose !== "nonqualifying_train_only_rfdt_systems_smoke" ||
    supplement.qualification !== false ||
    supplement.officialCandidate5Admission !== false ||
    base.source.sfPiCommit !== supplement.source.projectedSfPiCommit ||
    base.source.sfPiRuntimeSha256 !==
      supplement.source.projectedSfPiRuntimeSha256 ||
    base.source.scorerProtocolSha256 !==
      supplement.source.scorerProtocolSha256 ||
    base.source.scorerProtocolSha256 !== GUARDRAIL_PROTOCOL_SHA256 ||
    base.source.baseModel !== supplement.source.baseModel ||
    base.source.baseRevision !== supplement.source.baseRevision ||
    base.source.baseModel !== originalBase ||
    base.source.baseRevision !== originalRevision ||
    supplement.source.baseWeightsSha256 !== originalWeightsSha256 ||
    base.source.sealedCorpusSha256 !==
      supplement.source.supplementBaseCorpusSha256 ||
    base.source.sealedCorpusSha256 !== sealedCorpusSha256
  )
    throw new Error("Research source or nonqualification identity mismatch");
  const sfCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: sf,
    encoding: "utf8",
  }).trim();
  const { calculateJevRiskBaselineIdentity } = await import(
    pathToFileURL(
      resolve(sf, "extensions/sf-guardrail/lib/risk-baseline-identity.ts"),
    ).href
  );
  const sfRuntimeSha256 = calculateJevRiskBaselineIdentity().sha256;
  const [scorerBytes, exportScriptBytes, supplementScriptBytes] =
    await Promise.all([
      readFile(resolve(root, "dist/guardrail.js")),
      readFile(resolve(root, "scripts/guardrail-v3-research-export.mjs")),
      readFile(resolve(root, "scripts/guardrail-candidate5-train-smoke.mjs")),
    ]);
  if (
    sfCommit !== base.source.sfPiCommit ||
    sfRuntimeSha256 !== base.source.sfPiRuntimeSha256 ||
    sha(scorerBytes) !== supplement.source.scorerDistributionSha256 ||
    sha(exportScriptBytes) !== base.source.researchScriptSha256 ||
    sha(supplementScriptBytes) !== supplement.source.preparationScriptSha256
  )
    throw new Error(
      "Current SF host or Jev scorer differs from research receipts",
    );
  if (
    !supplement.source.checkpoint.endsWith(
      `/models--google--gemma-3-1b-it/snapshots/${originalRevision}`,
    ) ||
    (await hashFile(
      resolve(supplement.source.checkpoint, "model.safetensors"),
    )) !== originalWeightsSha256 ||
    (await hashFile(base.source.sealedCorpusFile)) !== sealedCorpusSha256
  )
    throw new Error("Original Google base or sealed research corpus changed");
  const [baseBytes, supplementBytes, bundleBytes] = await Promise.all([
    readFile(base.rfdt.file),
    readFile(supplement.dataset.file),
    readFile(base.bundle.file),
  ]);
  if (
    sha(baseBytes) !== base.rfdt.sha256 ||
    sha(supplementBytes) !== supplement.dataset.sha256 ||
    sha(bundleBytes) !== base.bundle.sha256
  )
    throw new Error("Research dataset changed since receipt");
  const baseRows = lines(baseBytes);
  const extraRows = lines(supplementBytes);
  if (
    baseRows.length !== base.rfdt.rows ||
    extraRows.length !== supplement.trainRows ||
    extraRows.length !== 40
  )
    throw new Error("Research row count changed");
  const baseSets = checkRows(
    baseRows,
    ["train", "validation"],
    base.source.baseModel,
  );
  const extraSets = checkRows(extraRows, ["train"], base.source.baseModel);
  const bundle = JSON.parse(bundleBytes);
  const eligible = new Map(
    bundle.records
      .filter((record) => record.modelEligible === true)
      .map((record) => [record.id, record]),
  );
  if (
    bundle.source.sfPiRuntimeSha256 !== sfRuntimeSha256 ||
    eligible.size !== baseRows.length ||
    baseRows.some((row) => {
      const record = eligible.get(row.id);
      return (
        !record ||
        record.split !== row.split ||
        record.groupId !== row.group_id ||
        record.expected !== row.targets.risk.answer ||
        canonical(record.riskInput) !== canonical(row.request.state)
      );
    })
  )
    throw new Error("Base research rows differ from eligible host records");
  if (
    [...extraSets.ids].some((id) => baseSets.ids.has(id)) ||
    [...extraSets.groups.keys()].some((group) => baseSets.groups.has(group)) ||
    [...extraSets.inputs.keys()].some((input) => baseSets.inputs.has(input))
  )
    throw new Error("Supplement overlaps the base TRAIN/VALID export");
  const rawMergedRows = [
    ...baseRows.filter((row) => !baseSets.duplicateIds.has(row.id)),
    ...extraRows.filter((row) => !extraSets.duplicateIds.has(row.id)),
  ];
  const withheld = new Set(withheldTrainGroups);
  const withheldRows = rawMergedRows.filter((row) =>
    withheld.has(row.group_id),
  );
  if (
    withheldRows.length !== 24 ||
    withheldRows.some((row) => row.split !== "train") ||
    withheldTrainGroups.some(
      (group) => !withheldRows.some((row) => row.group_id === group),
    )
  )
    throw new Error("Reviewed TRAIN near-replay withhold changed");
  const mergedRows = rawMergedRows.filter((row) => !withheld.has(row.group_id));
  if (
    !mergedRows.some((row) => row.split === "train") ||
    !mergedRows.some((row) => row.split === "validation")
  )
    throw new Error("TRAIN and validation must both be nonempty");
  assignRfdtSplits(mergedRows.map((row) => validateRfdtExample(row)));
  const mergedBytes = Buffer.from(
    mergedRows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  const receipt = {
    version: 1,
    purpose: "nonqualifying_v3_research_merged_train_validation",
    qualification: false,
    officialCandidate5Admission: false,
    heldOutContentEmitted: false,
    browserModelEligible: false,
    plannedOptimizerSteps: 256,
    plannedSelection: "validation_only",
    leakageScreening:
      "canonical exact inputs, authored groups, and eight reviewed TRAIN near-replay groups withheld; family-head overlap remains",
    splitReview: {
      validationChanged: false,
      heldOutTestInspected: false,
      withheldTrainGroups,
      withheldTrainIds: withheldRows.map((row) => row.id),
      withheldTrainRows: withheldRows.length,
      rationale:
        "same operation/effect or templated near-replay as fixed validation case",
    },
    originalGoogleBaseOnly: true,
    noTeacher: true,
    noForbiddenFallback: true,
    rows: {
      train: mergedRows.filter((row) => row.split === "train").length,
      validation: mergedRows.filter((row) => row.split === "validation").length,
      test: 0,
      groups: new Set(mergedRows.map((row) => row.group_id)).size,
      deduplicatedTrainInputs:
        baseSets.duplicateIds.size + extraSets.duplicateIds.size,
    },
    source: {
      mergeScriptSha256: sha(await readFile(fileURLToPath(import.meta.url))),
      baseReceipt: resolve(values.base),
      baseReceiptSha256: sha(await readFile(resolve(values.base))),
      baseDatasetSha256: base.rfdt.sha256,
      deduplicatedTrainIds: [
        ...baseSets.duplicateIds,
        ...extraSets.duplicateIds,
      ],
      supplementReceipt: resolve(values.supplement),
      supplementReceiptSha256: sha(await readFile(resolve(values.supplement))),
      supplementDatasetSha256: supplement.dataset.sha256,
      sfPiCommit: base.source.sfPiCommit,
      sfPiRuntimeSha256: base.source.sfPiRuntimeSha256,
      sfPiRoot: sf,
      scorerProtocolSha256: base.source.scorerProtocolSha256,
      model: base.source.baseModel,
      revision: base.source.baseRevision,
      baseWeightsSha256: supplement.source.baseWeightsSha256,
      checkpoint: supplement.source.checkpoint,
    },
    dataset: { file: output, sha256: sha(mergedBytes) },
  };
  await Promise.all([
    mkdir(dirname(output), { recursive: true }),
    mkdir(dirname(receiptPath), { recursive: true }),
  ]);
  await writeFile(output, mergedBytes, { mode: 0o600, flag: "wx" });
  try {
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    await rm(output);
    throw error;
  }
  console.log(
    JSON.stringify({
      purpose: receipt.purpose,
      rows: receipt.rows,
      datasetSha256: receipt.dataset.sha256,
      qualification: false,
    }),
  );
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  await main();
