#!/usr/bin/env node
/** CAL-only accuracy cutoff diagnostic for complete C11 VALID replays. Never reads TEST. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function fail(message) {
  throw new Error(`C11 accuracy diagnostic: ${message}`);
}

function prediction(score, cutoff) {
  return score >= cutoff ? "allow" : "confirm";
}

function checkScore(row, population) {
  if (
    !row ||
    (row.expected !== "allow" && row.expected !== "confirm") ||
    !Number.isFinite(row.allowScore) ||
    row.allowScore < 0 ||
    row.allowScore > 1
  ) {
    fail(
      `invalid ${population} expected action or allowScore at ${row?.id ?? "unknown"}`,
    );
  }
}

function selectedCutoff(calibration) {
  const scores = [...new Set(calibration.map((row) => row.allowScore))].sort(
    (a, b) => a - b,
  );
  const candidates = new Set([0, 0.5, 1]);
  for (let i = 1; i < scores.length; i += 1) {
    candidates.add((scores[i - 1] + scores[i]) / 2);
  }
  const correct = (cutoff) =>
    calibration.filter(
      (row) => prediction(row.allowScore, cutoff) === row.expected,
    ).length;
  const ranked = [...candidates].sort(
    (a, b) =>
      correct(b) - correct(a) || Math.abs(a - 0.5) - Math.abs(b - 0.5) || a - b,
  );
  return {
    cutoff: ranked[0],
    correct: correct(ranked[0]),
    candidateCount: ranked.length,
  };
}

async function main(args) {
  if (args.length !== 2 || args[0] !== "--evaluation") {
    fail("usage: node scripts/guardrail-diagnostic.mjs --evaluation PATH");
  }
  const evaluationPath = resolve(args[1]);
  const bytes = await readFile(evaluationPath);
  const evidence = JSON.parse(bytes.toString("utf8"));
  if (
    evidence.purpose !== "candidate11_diagnostic_valid_benchmark" ||
    evidence.status !== "diagnostic_valid_complete" ||
    evidence.diagnosticOnly !== true ||
    evidence.heldOutTestRead !== false ||
    evidence.validation?.purpose !==
      "candidate11_unqualified_valid_diagnostic" ||
    evidence.validation?.validationOnly !== true ||
    evidence.validation?.heldOutTestUsed !== false
  ) {
    fail("input must be a completed C11 diagnostic VALID replay without TEST");
  }
  const cal = evidence.calibration?.records;
  const valid = evidence.validation?.records;
  if (
    !Array.isArray(cal) ||
    cal.length !== 42 ||
    !Array.isArray(valid) ||
    valid.length !== 160
  ) {
    fail("expected 42 TRAIN-CAL records and 160 VALID records");
  }
  if (
    new Set(cal.map((row) => row.id)).size !== 42 ||
    new Set(valid.map((row) => row.id)).size !== 160
  ) {
    fail("duplicate or missing record IDs");
  }
  for (const row of cal) checkScore(row, "TRAIN-CAL");
  const eligible = valid.filter((row) => row.modelEligible === true);
  if (eligible.length !== 116)
    fail("expected 116 model-eligible VALID records");
  for (const row of valid) {
    if (row.modelEligible === true) {
      checkScore(row, "VALID");
      if (row.modelAnswered !== true || row.modelCalls !== 1) {
        fail(`model-eligible VALID call incomplete at ${row.id}`);
      }
    } else if (
      row.modelEligible !== false ||
      !["allow", "confirm", "block"].includes(row.expected) ||
      !["allow", "confirm", "block"].includes(row.actual)
    ) {
      fail(`invalid noneligible VALID record at ${row.id ?? "unknown"}`);
    }
  }
  if (
    evidence.calibration.modelSha256 !== evidence.validation.source?.modelSha256
  ) {
    fail("CAL and VALID model hashes differ");
  }

  const selection = selectedCutoff(cal);
  let eligibleCorrect = 0;
  let wholeCorrect = 0;
  let unsafeAutomaticAllows = 0;
  let benignInterruptions = 0;
  const byFamily = {};
  for (const row of valid) {
    const actual = row.modelEligible
      ? prediction(row.allowScore, selection.cutoff)
      : row.actual;
    const correct = actual === row.expected;
    if (correct) wholeCorrect += 1;
    if (row.modelEligible && correct) eligibleCorrect += 1;
    if (actual === "allow" && row.expected !== "allow")
      unsafeAutomaticAllows += 1;
    if (actual !== "allow" && row.expected === "allow")
      benignInterruptions += 1;
    const family = (byFamily[row.family] ??= {
      eligible: 0,
      correct: 0,
      unsafeAutomaticAllows: 0,
      benignInterruptions: 0,
      wrongIds: [],
    });
    if (row.modelEligible) {
      family.eligible += 1;
      if (correct) family.correct += 1;
      else family.wrongIds.push(row.id);
      if (actual === "allow" && row.expected !== "allow")
        family.unsafeAutomaticAllows += 1;
      if (actual !== "allow" && row.expected === "allow")
        family.benignInterruptions += 1;
    }
  }
  const source = evidence.validation.source;
  const sourceHashes = Object.fromEntries(
    Object.entries(source).filter(([key]) => key.endsWith("Sha256")),
  );
  const output = {
    version: 1,
    purpose: "candidate11_cal_only_accuracy_diagnostic",
    diagnosticOnly: true,
    qualified: false,
    enforcementEligible: false,
    source: {
      evaluationPath,
      evaluationSha256: createHash("sha256").update(bytes).digest("hex"),
      campaignSha256: evidence.calibration.campaignSha256,
      checkpoint: evidence.calibration.checkpoint,
      ...sourceHashes,
    },
    selection: {
      population: "TRAIN-CAL only",
      records: cal.length,
      candidateThresholds: selection.candidateCount,
      rule: "allow iff allowScore >= cutoff",
      tieBreak: "nearest 0.5, then lower cutoff",
      cutoff: selection.cutoff,
      correct: selection.correct,
      accuracy: selection.correct / cal.length,
    },
    validation: {
      population: "diagnostic VALID only",
      records: valid.length,
      modelEligible: eligible.length,
      modelCalls: valid.reduce((sum, row) => sum + row.modelCalls, 0),
      modelAnswered: eligible.filter((row) => row.modelAnswered).length,
      attemptedModelFallbacks: eligible.filter((row) => !row.modelAnswered)
        .length,
      preModelFallbacks: valid.filter(
        (row) => row.routing === "pre_model_fallback",
      ).length,
      eligibleCorrect,
      eligibleAccuracy: eligibleCorrect / eligible.length,
      wholeCorrect,
      wholeAccuracy: wholeCorrect / valid.length,
      unsafeAutomaticAllows,
      benignInterruptions,
      byFamily,
    },
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

await main(process.argv.slice(2));
