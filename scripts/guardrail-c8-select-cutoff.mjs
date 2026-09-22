#!/usr/bin/env node
/** Freeze a C8 cutoff from complete TRAIN calibration scores and admitted sources only. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { canonical } from "../dist/core.js";
import { selectC8Calibration } from "../dist/guardrail-calibration.js";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pin = (value) => /^[a-f0-9]{64}$/.test(value ?? "");
const commitPin = (value) =>
  /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value ?? "");
const fail = (message) => {
  throw new Error(message);
};

async function regularBytes(path, maxBytes = 4 * 1024 * 1024) {
  const file = resolve(path);
  const info = await lstat(file);
  if (!info.isFile() || info.size > maxBytes)
    fail("C8 calibration input must be a bounded regular file");
  const bytes = await readFile(file);
  if (bytes.length > maxBytes)
    fail("C8 calibration input exceeds its byte limit");
  return bytes;
}

function sourceRows(bytes, split) {
  const rows = bytes
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const ids = new Set();
  for (const row of rows) {
    if (
      row.split !== (split === "fit" ? "train" : "calibration") ||
      typeof row.id !== "string" ||
      !row.id ||
      ids.has(row.id) ||
      typeof row.group_id !== "string" ||
      !row.group_id ||
      (split === "calibration" &&
        (!row.request?.state || typeof row.request.state !== "object")) ||
      !["allow", "confirm"].includes(row.targets?.risk?.answer)
    )
      fail(`Invalid ${split} source inventory`);
    ids.add(row.id);
  }
  return rows;
}

async function admittedRows(
  admissionPath,
  savedPath,
  siblingName,
  expectedSha256,
) {
  const sibling = join(dirname(resolve(admissionPath)), siblingName);
  let bytes;
  try {
    bytes = await regularBytes(sibling, 8 * 1024 * 1024);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    bytes = await regularBytes(savedPath, 8 * 1024 * 1024);
  }
  if (sha(bytes) !== expectedSha256) fail(`C8 admitted ${siblingName} changed`);
  return bytes;
}

export async function selectFromAdmission({
  admissionPath,
  admissionSha256,
  scoresPath,
  baselinePath,
  baselineReceiptSha256,
  sfPiPath,
  baselineScriptPath,
  outputPath,
  modelSha256,
  nativeBinarySha256,
  baselineSha256,
  policySha256,
}) {
  for (const value of [
    admissionSha256,
    baselineReceiptSha256,
    modelSha256,
    nativeBinarySha256,
    baselineSha256,
    policySha256,
  ])
    if (!pin(value)) fail("Missing or malformed operator SHA-256 pin");
  const admissionBytes = await regularBytes(admissionPath);
  if (sha(admissionBytes) !== admissionSha256)
    fail("C8 admission receipt differs from the operator pin");
  const admission = JSON.parse(admissionBytes.toString("utf8"));
  if (
    admission.version !== 1 ||
    admission.purpose !== "candidate8_fit_calibration_admission" ||
    admission.trainingReady !== true ||
    admission.calibration?.notPassedToFit !== true ||
    !pin(admission.fit?.sha256) ||
    !pin(admission.calibration?.sha256)
  )
    fail("C8 admission is not a frozen TRAIN/CAL source split");
  const fitBytes = await admittedRows(
    admissionPath,
    admission.fit.file,
    "fit.jsonl",
    admission.fit.sha256,
  );
  const calibrationBytes = await admittedRows(
    admissionPath,
    admission.calibration.file,
    "calibration.jsonl",
    admission.calibration.sha256,
  );
  const fit = sourceRows(fitBytes, "fit");
  const calibration = sourceRows(calibrationBytes, "calibration");
  const fitGroups = [...new Set(fit.map((row) => row.group_id))].sort();
  const cases = calibration
    .map((row) => ({
      id: row.id,
      groupId: row.group_id,
      expected: row.targets.risk.answer,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (
    fit.length !== admission.fit.rows ||
    fitGroups.length !== admission.fit.groups ||
    calibration.length !== admission.calibration.rows ||
    new Set(calibration.map((row) => row.group_id)).size !==
      admission.calibration.groups ||
    cases.some((item) => fitGroups.includes(item.groupId))
  )
    fail("C8 source inventory or group isolation changed");
  const scores = JSON.parse((await regularBytes(scoresPath)).toString("utf8"));
  if (
    scores.modelSha256 !== modelSha256 ||
    scores.nativeBinarySha256 !== nativeBinarySha256 ||
    scores.baselineSha256 !== baselineSha256 ||
    scores.policySha256 !== policySha256 ||
    scores.admissionSha256 !== admissionSha256 ||
    scores.fitSha256 !== admission.fit.sha256 ||
    scores.calibrationCorpusSha256 !== admission.calibration.sha256 ||
    canonical(scores.fitGroups) !== canonical(fitGroups) ||
    canonical(scores.cases) !== canonical(cases) ||
    !Array.isArray(scores.records) ||
    scores.records.some((record) => Object.hasOwn(record, "baseline"))
  )
    fail(
      "C8 scored TRAIN calibration does not match the admitted inventory and pins",
    );
  const baselineBytes = await regularBytes(baselinePath);
  if (sha(baselineBytes) !== baselineReceiptSha256)
    fail("C8 sf-pi baseline replay differs from the operator pin");
  const baseline = JSON.parse(baselineBytes.toString("utf8"));
  const host = resolve(sfPiPath);
  const hostCommit = execFileSync("git", ["-C", host, "rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  try {
    execFileSync("git", ["-C", host, "diff", "--quiet", "HEAD"], {
      timeout: 10_000,
    });
  } catch {
    fail("C8 sf-pi host has uncommitted tracked changes");
  }
  const baselineScriptSha256 = sha(await regularBytes(baselineScriptPath));
  if (
    baseline.version !== 1 ||
    baseline.purpose !== "candidate8_train_cal_baseline_replay" ||
    baseline.baselineSha256 !== baselineSha256 ||
    baseline.policySha256 !== policySha256 ||
    !commitPin(hostCommit) ||
    baseline.source?.hostCommit !== hostCommit ||
    baseline.source?.scriptSha256 !== baselineScriptSha256 ||
    baseline.calibrationCorpusSha256 !== admission.calibration.sha256 ||
    !Array.isArray(baseline.records) ||
    baseline.records.length !== cases.length
  )
    fail("C8 sf-pi baseline replay identity or inventory is incomplete");
  const baselineActions = new Map();
  const calibrationInputSha256 = new Map(
    calibration.map((row) => [
      row.id,
      sha(Buffer.from(canonical(row.request.state))),
    ]),
  );
  for (const record of baseline.records) {
    if (
      !record ||
      typeof record.id !== "string" ||
      baselineActions.has(record.id) ||
      !["allow", "confirm", "block", "unknown"].includes(record.action)
    )
      fail("C8 sf-pi baseline replay contains a duplicate or invalid action");
    if (record.inputSha256 !== calibrationInputSha256.get(record.id))
      fail(
        "C8 sf-pi baseline replay input SHA differs from admitted TRAIN calibration",
      );
    baselineActions.set(record.id, record.action);
  }
  if (cases.some(({ id }) => !baselineActions.has(id)))
    fail(
      "C8 sf-pi baseline replay does not cover the admitted calibration cases",
    );
  const input = {
    ...scores,
    baselineReceiptSha256,
    records: scores.records.map((record) => ({
      ...record,
      baseline: baselineActions.get(record.id),
    })),
  };
  if (
    input.records.some(
      (record) =>
        record.gate === "prepared" &&
        record.inputSha256 !== calibrationInputSha256.get(record.id),
    )
  )
    fail("C8 model score did not use the admitted TRAIN calibration request");
  const receipt = selectC8Calibration(input);
  const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + "\n");
  await writeFile(resolve(outputPath), bytes, { flag: "wx", mode: 0o600 });
  return {
    accepted: receipt.accepted,
    reason: receipt.reason,
    cutoff: receipt.minimumAllowScore,
    scoringProtocolSha256: receipt.scoringProtocolSha256,
    receiptSha256: sha(bytes),
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values } = parseArgs({
      options: Object.fromEntries(
        [
          "admission",
          "admission-sha256",
          "scores",
          "baseline",
          "baseline-receipt-sha256",
          "sf-pi",
          "baseline-script",
          "output",
          "model-sha256",
          "native-binary-sha256",
          "host-baseline-sha256",
          "policy-sha256",
        ].map((name) => [name, { type: "string" }]),
      ),
    });
    if (
      Object.values(values).length !== 12 ||
      Object.values(values).some((value) => !value)
    )
      fail("All C8 TRAIN calibration paths and SHA-256 pins are required");
    console.log(
      JSON.stringify(
        await selectFromAdmission({
          admissionPath: values.admission,
          admissionSha256: values["admission-sha256"],
          scoresPath: values.scores,
          baselinePath: values.baseline,
          baselineReceiptSha256: values["baseline-receipt-sha256"],
          sfPiPath: values["sf-pi"],
          baselineScriptPath: values["baseline-script"],
          outputPath: values.output,
          modelSha256: values["model-sha256"],
          nativeBinarySha256: values["native-binary-sha256"],
          baselineSha256: values["host-baseline-sha256"],
          policySha256: values["policy-sha256"],
        }),
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
