import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GUARDRAIL_PROTOCOL_SHA256 } from "../dist/guardrail.js";
import { selectFromAdmission } from "../scripts/guardrail-c8-select-cutoff.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const pin = (character) => character.repeat(64);

test("joins independently pinned TRAIN-CAL baseline and freezes threshold", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-c8-select-"));
  try {
    const fitPath = join(directory, "fit.jsonl");
    const calPath = join(directory, "cal.jsonl");
    const admissionPath = join(directory, "admission.json");
    const scoresPath = join(directory, "scores.json");
    const baselinePath = join(directory, "baseline.json");
    const outputPath = join(directory, "cutoff.json");
    const row = (id, group, split, answer) => ({
      id,
      group_id: group,
      split,
      targets: { risk: { answer } },
    });
    const fitBytes = Buffer.from(
      JSON.stringify(row("fit", "fit-group", "train", "allow")) + "\n",
    );
    const calBytes = Buffer.from(
      [
        JSON.stringify(row("safe", "cal-group", "calibration", "allow")),
        JSON.stringify(row("risky", "cal-group", "calibration", "confirm")),
        "",
      ].join("\n"),
    );
    await writeFile(fitPath, fitBytes);
    await writeFile(calPath, calBytes);
    const admission = {
      version: 1,
      purpose: "candidate8_fit_calibration_admission",
      trainingReady: true,
      fit: { file: fitPath, sha256: sha(fitBytes), rows: 1, groups: 1 },
      calibration: {
        file: calPath,
        sha256: sha(calBytes),
        rows: 2,
        groups: 1,
        notPassedToFit: true,
      },
    };
    const admissionBytes = Buffer.from(JSON.stringify(admission));
    await writeFile(admissionPath, admissionBytes);
    const baseline = {
      version: 1,
      purpose: "candidate8_train_cal_baseline_replay",
      baselineSha256: pin("a"),
      policySha256: pin("b"),
      calibrationCorpusSha256: sha(calBytes),
      records: [
        { id: "safe", action: "allow" },
        { id: "risky", action: "allow" },
      ],
    };
    const baselineBytes = Buffer.from(JSON.stringify(baseline));
    await writeFile(baselinePath, baselineBytes);
    const scores = {
      version: 1,
      purpose: "candidate8_train_calibration_only",
      modelSha256: pin("c"),
      nativeBinarySha256: pin("d"),
      promptProtocolSha256: GUARDRAIL_PROTOCOL_SHA256,
      baselineSha256: pin("a"),
      policySha256: pin("b"),
      admissionSha256: sha(admissionBytes),
      fitSha256: sha(fitBytes),
      calibrationCorpusSha256: sha(calBytes),
      fitGroups: ["fit-group"],
      cases: [
        { id: "risky", groupId: "cal-group", expected: "confirm" },
        { id: "safe", groupId: "cal-group", expected: "allow" },
      ],
      records: [
        {
          id: "risky",
          groupId: "cal-group",
          expected: "confirm",
          gate: "prepared",
          modelAnswered: true,
          allowScore: 0.55,
          inputSha256: pin("e"),
          elapsedMs: 10,
        },
        {
          id: "safe",
          groupId: "cal-group",
          expected: "allow",
          gate: "prepared",
          modelAnswered: true,
          allowScore: 0.9,
          inputSha256: pin("f"),
          elapsedMs: 11,
        },
      ],
    };
    await writeFile(scoresPath, JSON.stringify(scores));
    const args = {
      admissionPath,
      admissionSha256: sha(admissionBytes),
      scoresPath,
      baselinePath,
      baselineReceiptSha256: sha(baselineBytes),
      outputPath,
      modelSha256: pin("c"),
      nativeBinarySha256: pin("d"),
      baselineSha256: pin("a"),
      policySha256: pin("b"),
    };
    const result = await selectFromAdmission(args);
    assert.equal(result.accepted, true);
    assert.ok(result.cutoff > 0.55 && result.cutoff < 0.9);
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(output.input.baselineReceiptSha256, sha(baselineBytes));
    assert.equal(output.metrics.selectedUnsafeAutomaticAllows, 0);
    await assert.rejects(
      selectFromAdmission({
        ...args,
        outputPath: join(directory, "changed.json"),
        baselineReceiptSha256: pin("0"),
      }),
      /operator pin/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
