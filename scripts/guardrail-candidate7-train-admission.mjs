#!/usr/bin/env node
/** Pin and admit only compatible C6+C7 TRAIN rows. TEST is never opened. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  guardrailRequest,
  GUARDRAIL_PROTOCOL_SHA256,
} from "../dist/guardrail.js";
import { RFDT_BASE_MODEL } from "../dist/rfdt.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = resolve(root, ".build/guardrail");
const sourceFile = resolve(
  root,
  "fixtures/guardrail/candidate7/train-contrasts.json",
);
const admittedC6Sha256 =
  "d31bdb1bcca9bb4866e8dafed3290b4dc15b4b5abb0d9909ef67e855bc066602";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const need = (condition, message) => {
  if (!condition) throw new Error(`C7 TRAIN admission: ${message}`);
};
const rowsFrom = (bytes, name) => {
  const text = bytes.toString("utf8");
  need(
    text.endsWith("\n") && !text.includes("\r") && !text.includes("\n\n"),
    `${name} is not complete LF JSONL`,
  );
  return text.trimEnd().split("\n").map(JSON.parse);
};
const relativeBuild = (file) => {
  const rel = relative(buildRoot, file);
  return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

const { values } = parseArgs({
  options: {
    "base-train": { type: "string" },
    "host-receipt": { type: "string" },
    "host-receipt-sha256": { type: "string" },
    "screen-receipt": { type: "string" },
    "screen-receipt-sha256": { type: "string" },
    "output-dir": { type: "string" },
  },
});
for (const key of [
  "base-train",
  "host-receipt",
  "host-receipt-sha256",
  "screen-receipt",
  "screen-receipt-sha256",
  "output-dir",
])
  need(values[key], `Missing --${key}`);
for (const key of ["host-receipt-sha256", "screen-receipt-sha256"])
  need(/^[a-f0-9]{64}$/.test(values[key]), `Invalid --${key}`);
const outputDir = resolve(values["output-dir"]);
need(
  relativeBuild(outputDir) &&
    outputDir.split("/").at(-1).startsWith("candidate-7-train-admission-"),
  "Output must be a fresh candidate-7-train-admission-* directory under .build/guardrail",
);

const baseFile = resolve(values["base-train"]);
const hostReceiptFile = resolve(values["host-receipt"]);
const screenReceiptFile = resolve(values["screen-receipt"]);
need(
  baseFile.endsWith("admitted-train.jsonl") &&
    relativeBuild(hostReceiptFile) &&
    relativeBuild(screenReceiptFile),
  "Invalid TRAIN/receipt source path",
);
const [baseBytes, hostReceiptBytes, screenReceiptBytes, sourceBytes] =
  await Promise.all([
    readFile(baseFile),
    readFile(hostReceiptFile),
    readFile(screenReceiptFile),
    readFile(sourceFile),
  ]);
need(sha(baseBytes) === admittedC6Sha256, "C6 admitted TRAIN bytes changed");
need(
  sha(hostReceiptBytes) === values["host-receipt-sha256"],
  "Host receipt changed",
);
need(
  sha(screenReceiptBytes) === values["screen-receipt-sha256"],
  "Source screen receipt changed",
);
const [hostReceipt, screenReceipt, source] = [
  JSON.parse(hostReceiptBytes),
  JSON.parse(screenReceiptBytes),
  JSON.parse(sourceBytes),
];
need(
  hostReceipt.purpose === "candidate7_train_host_preflight" &&
    hostReceipt.qualification === false &&
    hostReceipt.modelCalls === 0 &&
    hostReceipt.externalOperationsExecuted === 0 &&
    hostReceipt.heldOutTestRead === false &&
    hostReceipt.source?.sha256 === sha(sourceBytes) &&
    hostReceipt.source?.preflightScriptSha256 ===
      sha(
        await readFile(
          resolve(root, "scripts/guardrail-candidate7-host-preflight.mjs"),
        ),
      ) &&
    hostReceipt.source?.mockDiscoveryStubSha256 ===
      sha(
        await readFile(
          resolve(root, "scripts/guardrail-v3-research-detect-stub.mjs"),
        ),
      ) &&
    hostReceipt.source?.scorerDistributionSha256 ===
      sha(await readFile(resolve(root, "dist/guardrail.js"))) &&
    hostReceipt.source?.scorerProtocolSha256 === GUARDRAIL_PROTOCOL_SHA256 &&
    hostReceipt.counts?.preparedRows === source.cases?.length &&
    hostReceipt.counts?.readyGroups === 18 &&
    hostReceipt.groups?.every((group) => group.ready) &&
    hostReceipt.status?.every(
      (row) =>
        row.eligible &&
        !row.floor &&
        row.prepared &&
        row.factMatched &&
        row.reason === null,
    ),
  "C7 host preflight did not prepare every TRAIN case",
);
need(
  screenReceipt.purpose === "candidate7_train_source_screen" &&
    screenReceipt.qualification === false &&
    screenReceipt.heldOutTestRead === false &&
    screenReceipt.source?.sha256 === sha(sourceBytes) &&
    screenReceipt.source?.screenScriptSha256 ===
      sha(
        await readFile(
          resolve(root, "scripts/guardrail-candidate7-train-screen.mjs"),
        ),
      ) &&
    screenReceipt.source?.builderSha256 ===
      sha(
        await readFile(
          resolve(
            root,
            "fixtures/guardrail/candidate7/build-train-contrasts.mjs",
          ),
        ),
      ) &&
    screenReceipt.source?.rubricSha256 ===
      sha(await readFile(resolve(root, "fixtures/guardrail/RUBRIC.md"))) &&
    screenReceipt.counts?.rows === source.cases.length &&
    screenReceipt.counts?.groups === 18 &&
    screenReceipt.baseTrain?.sha256 === admittedC6Sha256 &&
    screenReceipt.baseTrain?.protocolVersion === 2 &&
    screenReceipt.diagnosticValid?.selectionEvidence === false,
  "C7 source screen or base contract changed",
);
const projectedFile = hostReceipt.projectedTrain?.file;
need(
  typeof projectedFile === "string" &&
    isAbsolute(projectedFile) &&
    relativeBuild(projectedFile) &&
    hostReceipt.projectedTrain.rows === source.cases.length &&
    hostReceipt.projectedTrain.baseModel === "google/gemma-3-1b-it" &&
    hostReceipt.projectedTrain.scorerProtocolSha256 ===
      hostReceipt.source.scorerProtocolSha256,
  "Host projection missing or changed",
);
const projectedBytes = await readFile(projectedFile);
need(
  sha(projectedBytes) === hostReceipt.projectedTrain.sha256,
  "Host-projected TRAIN bytes changed",
);
const base = rowsFrom(baseBytes, "C6 base");
const projected = rowsFrom(projectedBytes, "C7 projection");
need(
  base.length === 175 && projected.length === 52,
  "TRAIN row counts changed",
);
const rows = [...base, ...projected];
const ids = new Set();
const groups = new Map();
const operationInputs = new Set();
const version = base[0].request.state.version;
for (const row of rows) {
  need(
    row.split === "train" &&
      row.request?.model === RFDT_BASE_MODEL &&
      row.request.state?.version === version &&
      version === 2 &&
      JSON.stringify(row.request) ===
        JSON.stringify(guardrailRequest(row.request.state, RFDT_BASE_MODEL)) &&
      ["allow", "confirm"].includes(row.targets?.risk?.answer),
    `Incompatible RFDT row ${row.id}`,
  );
  need(!ids.has(row.id), `Duplicate TRAIN ID ${row.id}`);
  ids.add(row.id);
  const op = JSON.stringify([
    row.request.state.toolName,
    row.request.state.input,
    row.request.state.facts,
  ]);
  need(
    !operationInputs.has(op),
    `Duplicate model-visible TRAIN input ${row.id}`,
  );
  operationInputs.add(op);
  const existing = groups.get(row.group_id) ?? [];
  existing.push(row.id);
  groups.set(row.group_id, existing);
}
need(
  groups.size === 77 &&
    source.cases.every((row, index) => {
      const projectedRow = projected[index];
      try {
        assert.deepStrictEqual(
          [
            projectedRow.id,
            projectedRow.group_id,
            projectedRow.targets.risk.answer,
          ],
          [row.id, row.groupId, row.expected],
        );
        return true;
      } catch {
        return false;
      }
    }),
  "C7 projected group/label order differs from source",
);

const admittedBytes = Buffer.from(
  rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
);
const receipt = {
  version: 1,
  purpose: "candidate7_train_only_admission",
  qualification: false,
  humanLabelReviewed: false,
  agentRubricReviewed: true,
  admittedForResearchTraining: true,
  heldOutTestRead: false,
  modelCalls: 0,
  externalOperationsExecuted: 0,
  source: {
    baseTrain: { file: baseFile, sha256: admittedC6Sha256 },
    candidate7Source: { file: sourceFile, sha256: sha(sourceBytes) },
    sourceScreen: {
      file: screenReceiptFile,
      sha256: values["screen-receipt-sha256"],
    },
    hostReceipt: {
      file: hostReceiptFile,
      sha256: values["host-receipt-sha256"],
    },
    hostCommit: hostReceipt.source.sfPiCommit,
    hostRuntimeSha256: hostReceipt.source.sfPiRuntimeSha256,
    scorerProtocolSha256: hostReceipt.source.scorerProtocolSha256,
  },
  admittedDataset: {
    file: resolve(outputDir, "train.jsonl"),
    sha256: sha(admittedBytes),
    rows: rows.length,
    groups: groups.size,
    baseModel: "google/gemma-3-1b-it",
    requestVersion: version,
  },
  limits: [
    "This admits source-rubric-reviewed rows for research training only; no human label approval or model qualification is implied.",
    "The host replay is mocked and must be repeated after any host or protocol change.",
    "No VALID or TEST row is passed to RFDT; TEST bytes and labels are not opened here.",
  ],
};
await mkdir(outputDir, { recursive: false });
await writeFile(receipt.admittedDataset.file, admittedBytes, {
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
    admittedDataset: receipt.admittedDataset,
    qualification: false,
  }),
);
