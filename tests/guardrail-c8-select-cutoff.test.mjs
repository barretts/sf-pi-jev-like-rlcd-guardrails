import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { canonical } from "../dist/core.js";
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
    const sfPiPath = join(directory, "sf-pi");
    const baselineScriptPath = join(directory, "replay.mjs");
    const outputPath = join(directory, "cutoff.json");
    await mkdir(sfPiPath);
    execFileSync("git", ["init", "-q", sfPiPath]);
    execFileSync("git", ["-C", sfPiPath, "config", "user.name", "C8 Test"]);
    execFileSync("git", [
      "-C",
      sfPiPath,
      "config",
      "user.email",
      "c8@example.invalid",
    ]);
    await writeFile(join(sfPiPath, "tracked.txt"), "host fixture\n");
    execFileSync("git", ["-C", sfPiPath, "add", "tracked.txt"]);
    execFileSync("git", ["-C", sfPiPath, "commit", "-qm", "fixture"]);
    const hostCommit = execFileSync(
      "git",
      ["-C", sfPiPath, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();
    const replayScript = Buffer.from(
      "// independent sf-pi baseline replay fixture\n",
    );
    await writeFile(baselineScriptPath, replayScript);
    const row = (id, group, split, answer) => ({
      id,
      group_id: group,
      split,
      targets: { risk: { answer } },
      request: {
        state: {
          version: 2,
          toolName: "bash",
          input: { command: id },
          facts: {},
        },
      },
    });
    const inputSha = (id) =>
      sha(
        Buffer.from(
          canonical(row(id, "cal-group", "calibration", "allow").request.state),
        ),
      );
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
      source: { hostCommit, scriptSha256: sha(replayScript) },
      records: [
        { id: "safe", action: "allow", inputSha256: inputSha("safe") },
        { id: "risky", action: "allow", inputSha256: inputSha("risky") },
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
          inputSha256: inputSha("risky"),
          elapsedMs: 10,
        },
        {
          id: "safe",
          groupId: "cal-group",
          expected: "allow",
          gate: "prepared",
          modelAnswered: true,
          allowScore: 0.9,
          inputSha256: inputSha("safe"),
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
      sfPiPath,
      baselineScriptPath,
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
    const cliOutputPath = join(directory, "cli-cutoff.json");
    const stdout = execFileSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../scripts/guardrail-c8-select-cutoff.mjs", import.meta.url),
        ),
        "--admission",
        admissionPath,
        "--admission-sha256",
        sha(admissionBytes),
        "--scores",
        scoresPath,
        "--baseline",
        baselinePath,
        "--baseline-receipt-sha256",
        sha(baselineBytes),
        "--sf-pi",
        sfPiPath,
        "--baseline-script",
        baselineScriptPath,
        "--output",
        cliOutputPath,
        "--model-sha256",
        pin("c"),
        "--native-binary-sha256",
        pin("d"),
        "--host-baseline-sha256",
        pin("a"),
        "--policy-sha256",
        pin("b"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(
      JSON.parse(stdout).receiptSha256,
      sha(await readFile(cliOutputPath)),
    );
    await assert.rejects(
      selectFromAdmission({
        ...args,
        outputPath: join(directory, "changed.json"),
        baselineReceiptSha256: pin("0"),
      }),
      /operator pin/,
    );
    const changedBaseline = structuredClone(baseline);
    changedBaseline.records[0].inputSha256 = pin("0");
    const changedBaselineBytes = Buffer.from(JSON.stringify(changedBaseline));
    await writeFile(baselinePath, changedBaselineBytes);
    await assert.rejects(
      selectFromAdmission({
        ...args,
        outputPath: join(directory, "mismatched-baseline.json"),
        baselineReceiptSha256: sha(changedBaselineBytes),
      }),
      /baseline replay input SHA differs/,
    );
    await writeFile(baselinePath, baselineBytes);
    const wrongHost = structuredClone(baseline);
    wrongHost.source.hostCommit = pin("0");
    const wrongHostBytes = Buffer.from(JSON.stringify(wrongHost));
    await writeFile(baselinePath, wrongHostBytes);
    await assert.rejects(
      selectFromAdmission({
        ...args,
        outputPath: join(directory, "wrong-host.json"),
        baselineReceiptSha256: sha(wrongHostBytes),
      }),
      /baseline replay identity or inventory/,
    );
    await writeFile(baselinePath, baselineBytes);
    scores.records[0].inputSha256 = pin("0");
    await writeFile(scoresPath, JSON.stringify(scores));
    await assert.rejects(
      selectFromAdmission({
        ...args,
        outputPath: join(directory, "mismatched-score.json"),
      }),
      /model score did not use the admitted/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
