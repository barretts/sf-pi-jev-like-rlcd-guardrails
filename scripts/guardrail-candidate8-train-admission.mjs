#!/usr/bin/env node
/** Separate C8 fit from TRAIN-internal calibration. No VALID or TEST input. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  guardrailRequest,
  GUARDRAIL_PROTOCOL_SHA256,
} from "../dist/guardrail.js";
import { RFDT_BASE_MODEL } from "../dist/rfdt.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseFile = resolve(
  root,
  "reports/guardrail-risk-2026-09-21/candidate-7-evidence/train/admitted-train.jsonl",
);
const sourceFile = resolve(
  root,
  "fixtures/guardrail/candidate8/train-recovery.json",
);
const pairsFile = resolve(root, "fixtures/guardrail/candidate8/pairs.json");
const splitFile = resolve(
  root,
  "fixtures/guardrail/candidate8/split-plan.json",
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const need = (ok, why) => {
  if (!ok) throw new Error("C8 admission: " + why);
};
const parseJsonl = (bytes, name) => {
  const text = bytes.toString("utf8");
  need(
    text.endsWith("\n") && !text.includes("\r") && !text.includes("\n\n"),
    name + " is not complete LF JSONL",
  );
  return text.trimEnd().split("\n").map(JSON.parse);
};
const jsonl = (rows) =>
  Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n") + "\n");

const { values } = parseArgs({
  options: {
    "screen-receipt": { type: "string" },
    "screen-sha256": { type: "string" },
    "host-receipt": { type: "string" },
    "host-sha256": { type: "string" },
    "output-dir": { type: "string" },
    "projected-train": { type: "string" },
  },
});
for (const key of [
  "screen-receipt",
  "screen-sha256",
  "host-receipt",
  "host-sha256",
  "output-dir",
])
  need(values[key], "Missing --" + key);
const outputDir = resolve(values["output-dir"]);
need(
  outputDir.startsWith(
    resolve(root, ".build/guardrail/candidate-8-admission-"),
  ),
  "Output must be under a fresh C8 admission build directory",
);
const [baseBytes, sourceBytes, pairsBytes, splitBytes, screenBytes, hostBytes] =
  await Promise.all([
    readFile(baseFile),
    readFile(sourceFile),
    readFile(pairsFile),
    readFile(splitFile),
    readFile(values["screen-receipt"]),
    readFile(values["host-receipt"]),
  ]);
need(
  sha(screenBytes) === values["screen-sha256"] &&
    sha(hostBytes) === values["host-sha256"],
  "Screen or host receipt bytes changed",
);
const screen = JSON.parse(screenBytes),
  host = JSON.parse(hostBytes);
const source = JSON.parse(sourceBytes),
  pairs = JSON.parse(pairsBytes),
  split = JSON.parse(splitBytes);
const base = parseJsonl(baseBytes, "Inherited C7 TRAIN");
need(
  screen.purpose === "candidate8_train_source_screen" &&
    host.purpose === "candidate8_train_host_preflight" &&
    screen.qualification === false &&
    host.qualification === false &&
    screen.heldOutTestBodyRead === false &&
    host.heldOutTestRead === false &&
    screen.modelCalls === 0 &&
    host.modelCalls === 0 &&
    screen.source.sha256 === sha(sourceBytes) &&
    host.source.sha256 === sha(sourceBytes) &&
    screen.source.pairsSha256 === sha(pairsBytes) &&
    screen.source.splitPlanSha256 === sha(splitBytes) &&
    screen.priorTrain.sha256 === sha(baseBytes) &&
    host.source.scorerProtocolSha256 === GUARDRAIL_PROTOCOL_SHA256 &&
    host.source.sfPiCommit === "bc7862b078997d2c60aa908979b5cbf59f83db80" &&
    host.source.sfPiRuntimeSha256 ===
      "6ec845e7365d2948ecf502326bcabbb7b042b7d300437516db3b299fd390078e" &&
    host.counts.preparedRows === 46 &&
    host.counts.readyGroups === 17 &&
    host.excludedHostFallback.groupId === "c8-query-vs-unknown-write" &&
    host.projectedTrain?.rows === 46 &&
    host.projectedTrain.groups === 17,
  "Pinned source, model-free host, or split contract changed",
);
need(
  source.cases.length === 48 &&
    pairs.pairs.length === 31 &&
    split.calibrationNewGroups.length === 4 &&
    split.calibrationInheritedGroups.length === 13 &&
    split.excludedNewGroups.length === 1 &&
    RFDT_BASE_MODEL === "google/gemma-3-1b-it",
  "Unexpected C8 source/pair/base contract",
);
const committedProjection = resolve(
  root,
  "reports/guardrail-risk-2026-09-21/candidate-8-evidence/train/projected-train.jsonl",
);
const projectedFile = values["projected-train"]
  ? resolve(values["projected-train"])
  : host.projectedTrain.file;
need(
  !values["projected-train"] || projectedFile === committedProjection,
  "Projection override must use the committed C8 TRAIN evidence copy",
);
const projectedBytes = await readFile(projectedFile);
need(
  sha(projectedBytes) === host.projectedTrain.sha256,
  "Projected TRAIN bytes changed",
);
const projected = parseJsonl(projectedBytes, "C8 host projection");
const expectedNew = source.cases.filter(
  (row) => !split.excludedNewGroups.includes(row.groupId),
);
need(
  projected.length === expectedNew.length &&
    projected.every(
      (row, index) =>
        row.id === expectedNew[index].id &&
        row.group_id === expectedNew[index].groupId &&
        row.targets?.risk?.answer === expectedNew[index].expected,
    ),
  "Host projection does not preserve C8 source order, labels, and groups",
);
const calNew = new Set(split.calibrationNewGroups);
const calInherited = new Set(split.calibrationInheritedGroups);
const fit = [
  ...base.filter((row) => !calInherited.has(row.group_id)),
  ...projected.filter((row) => !calNew.has(row.group_id)),
];
const calibration = [
  ...base.filter((row) => calInherited.has(row.group_id)),
  ...projected.filter((row) => calNew.has(row.group_id)),
].map((row) => ({ ...row, split: "calibration" }));
need(
  fit.length === 226 &&
    calibration.length === 47 &&
    new Set(fit.map((row) => row.group_id)).size === 77 &&
    new Set(calibration.map((row) => row.group_id)).size === 17,
  "Fit/calibration row or group counts changed",
);
const fitGroups = new Set(fit.map((row) => row.group_id));
const calGroups = new Set(calibration.map((row) => row.group_id));
need(
  [...fitGroups].every((group) => !calGroups.has(group)),
  "A group leaked across fit/calibration",
);
const allIds = new Set();
const allInputs = new Set();
for (const row of [...fit, ...calibration]) {
  need(!allIds.has(row.id), "Duplicate prepared source ID: " + row.id);
  allIds.add(row.id);
  need(
    row.request?.model === RFDT_BASE_MODEL &&
      row.request.state?.version === 2 &&
      row.request.options?.template_version === "v2" &&
      row.request.questions?.length === 1 &&
      row.request.questions[0].id === "risk" &&
      ["allow", "confirm"].includes(row.targets?.risk?.answer),
    "Incompatible model row: " + row.id,
  );
  need(
    JSON.stringify(row.request) ===
      JSON.stringify(guardrailRequest(row.request.state, RFDT_BASE_MODEL)),
    "Request prompt changed: " + row.id,
  );
  const modelInput = JSON.stringify(row.request.state);
  need(!allInputs.has(modelInput), "Duplicate model-visible input: " + row.id);
  allInputs.add(modelInput);
}
const fitById = new Map(fit.map((row) => [row.id, row]));
const pairMembers = new Set();
for (const pair of pairs.pairs) {
  const safe = fitById.get(pair.safe_id),
    risky = fitById.get(pair.risky_id);
  need(
    safe?.group_id === pair.group_id &&
      risky?.group_id === pair.group_id &&
      safe.targets.risk.answer === "allow" &&
      risky.targets.risk.answer === "confirm" &&
      !pairMembers.has(safe.id) &&
      !pairMembers.has(risky.id),
    "Fit-only pair invalid or overlaps calibration: " + pair.pair_id,
  );
  pairMembers.add(safe.id);
  pairMembers.add(risky.id);
}
need(
  pairMembers.size === 62 &&
    pairs.pairs.filter((pair) => pair.group_id.startsWith("c8-")).length ===
      18 &&
    pairs.pairs.filter((pair) => !pair.group_id.startsWith("c8-")).length ===
      13,
  "C8 fit pair coverage changed",
);
const fitBytes = jsonl(fit),
  calibrationBytes = jsonl(calibration);
await mkdir(outputDir, { recursive: true });
const fitFile = resolve(outputDir, "fit.jsonl");
const calibrationFile = resolve(outputDir, "calibration.jsonl");
await writeFile(fitFile, fitBytes, { flag: "wx", mode: 0o600 });
await writeFile(calibrationFile, calibrationBytes, { flag: "wx", mode: 0o600 });
const receipt = {
  version: 1,
  purpose: "candidate8_fit_calibration_admission",
  qualification: false,
  trainingReady: true,
  humanLabelReviewed: false,
  modelCalls: 0,
  externalOperationsExecuted: 0,
  heldOutTestRead: false,
  source: {
    inheritedTrainSha256: sha(baseBytes),
    candidate8SourceSha256: sha(sourceBytes),
    pairsSha256: sha(pairsBytes),
    splitPlanSha256: sha(splitBytes),
    sourceScreenSha256: sha(screenBytes),
    hostPreflightSha256: sha(hostBytes),
    projectedTrainSha256: sha(projectedBytes),
    hostCommit: host.source.sfPiCommit,
    hostRuntimeSha256: host.source.sfPiRuntimeSha256,
    baseModel: RFDT_BASE_MODEL,
    scorerProtocolSha256: GUARDRAIL_PROTOCOL_SHA256,
    admissionScriptSha256: sha(await readFile(fileURLToPath(import.meta.url))),
  },
  fit: {
    file: fitFile,
    sha256: sha(fitBytes),
    rows: fit.length,
    groups: fitGroups.size,
    allow: fit.filter((row) => row.targets.risk.answer === "allow").length,
    confirm: fit.filter((row) => row.targets.risk.answer === "confirm").length,
  },
  calibration: {
    file: calibrationFile,
    sha256: sha(calibrationBytes),
    rows: calibration.length,
    groups: calGroups.size,
    allow: calibration.filter((row) => row.targets.risk.answer === "allow")
      .length,
    confirm: calibration.filter((row) => row.targets.risk.answer === "confirm")
      .length,
    notPassedToFit: true,
  },
  newFitPairs: 18,
  inheritedFitPairs: 13,
  excludedHostFallback: host.excludedHostFallback,
};
await writeFile(
  resolve(outputDir, "receipt.json"),
  JSON.stringify(receipt, null, 2) + "\n",
  { flag: "wx", mode: 0o600 },
);
console.log(JSON.stringify(receipt));
