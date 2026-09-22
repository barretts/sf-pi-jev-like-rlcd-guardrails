import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonical } from "../dist/core.js";
import { GUARDRAIL_PROTOCOL_SHA256 } from "../dist/guardrail.js";
import { selectFromPinnedSources } from "../scripts/guardrail-candidate9-select-cutoff.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const pin = (c) => c.repeat(64);
const hostCommit = "4f7fae07f7c04a7ca9f4fdbabc4594a20a8f1d2a";
const hostBaseline =
  "4c4f874ef4f19988e7a7db84055ebf28c6d25813723acf2c807934e2c8f15421";
const policy =
  "e02e9c0914c1b1395adb0b341d6149b54b0b514c2b86cceab44994b5f6425347";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "jev-c9-selector-"));
  const paths = { output: join(dir, "cutoff.json"), sfPi: dir };
  const put = async (name, value) => {
    const path = join(dir, name);
    const bytes =
      typeof value === "string" ? value : JSON.stringify(value) + "\n";
    await writeFile(path, bytes);
    paths[name.replace(/\.[^.]+$/, "")] = path;
    return sha(bytes);
  };
  const row = (id, group, expected, split) => ({
    id,
    group_id: group,
    split,
    request: {
      state: {
        version: 2,
        toolName: "bash",
        input: { command: `echo ${id}` },
        facts: {},
      },
    },
    targets: { risk: { answer: expected } },
  });
  const fit = [
    row("fit-safe", "fit-group", "allow", "train"),
    row("fit-risk", "fit-group", "confirm", "train"),
  ];
  const cal = [
    row("cal-safe", "cal-one", "allow", "calibration"),
    row("cal-risk", "cal-two", "confirm", "calibration"),
  ];
  const fitSha256 = await put(
    "fit.jsonl",
    fit.map(JSON.stringify).join("\n") + "\n",
  );
  const calibrationCorpusSha256 = await put(
    "cal.jsonl",
    cal.map(JSON.stringify).join("\n") + "\n",
  );
  const pairsSha256 = await put("pairs.json", {
    version: 1,
    pairs: [
      {
        pair_id: "p1",
        group_id: "fit-group",
        safe_id: "fit-safe",
        risky_id: "fit-risk",
      },
    ],
  });
  const familiesSha256 = await put("families.json", {
    version: 1,
    purpose: "candidate9_fit_families",
    rows: fit.map((r) => ({
      id: r.id,
      group_id: r.group_id,
      family: "shell",
      expected: r.targets.risk.answer,
    })),
  });
  const sourceSha = pin("1");
  const admission = {
    version: 1,
    purpose: "candidate9_fit_calibration_admission",
    trainingReady: true,
    source: {
      hostCommit,
      hostRuntimeSha256: hostBaseline,
      c9SourceSha256: sourceSha,
      pairsSha256,
      familiesSha256,
    },
    fit: { sha256: fitSha256, rows: 2, groups: 1 },
    calibration: {
      sha256: calibrationCorpusSha256,
      rows: 2,
      groups: 2,
      notPassedToFit: true,
    },
  };
  let admissionSha256 = await put("admission.json", admission);
  const planSha256 = await put("objectivePlan.json", {
    version: 2,
    purpose: "candidate9_train_only",
    arm: "B",
    pair_manifest_sha256: pairsSha256,
    family_manifest_sha256: familiesSha256,
    steps: 256,
    validation_rows_passed_to_training: 0,
    test_rows_passed_to_training: 0,
  });
  const cases = cal
    .map((r) => ({
      id: r.id,
      groupId: r.group_id,
      expected: r.targets.risk.answer,
      gate: "prepared",
      inputSha256: sha(Buffer.from(canonical(r.request.state))),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const records = cases.map((r) => ({
    ...r,
    modelAnswered: true,
    modelCalls: 1,
    allowScore: r.expected === "allow" ? 0.9 : 0.1,
    elapsedMs: 25,
  }));
  const scores = {
    version: 1,
    purpose: "candidate9_train_calibration_only",
    arm: "B",
    modelSha256: pin("2"),
    nativeBinarySha256: pin("3"),
    artifactFormat: "q8_0",
    artifactManifestSha256: pin("5"),
    registrySha256: pin("6"),
    runManifestSha256: pin("7"),
    fitPlanSha256: pin("8"),
    quantizationManifestSha256: pin("9"),
    calScorerCliSha256: pin("a"),
    calScorerCoreSha256: pin("b"),
    coldInitializationMs: 120,
    coldInitializationBasis:
      "backend_warmup_after_source_and_artifact_verification",
    preScoreVerificationMs: 10,
    elapsedBasis:
      "direct_jev_risk_check_including_prompt_preparation_and_queue",
    promptProtocolSha256: GUARDRAIL_PROTOCOL_SHA256,
    hostCommit,
    baselineSha256: hostBaseline,
    policySha256: policy,
    admissionSha256,
    fitSha256,
    calibrationCorpusSha256,
    pairManifestSha256: pairsSha256,
    familyManifestSha256: familiesSha256,
    objectivePlanSha256: planSha256,
    fitGroups: ["fit-group"],
    cases,
    records,
  };
  let scoresSha256 = await put("scores.json", scores);
  const baselineScriptSha = await put(
    "baselineScript.txt",
    "pinned synthetic baseline script\n",
  );
  const controlsScriptSha = await put(
    "hostControlsScript.txt",
    "pinned synthetic controls script\n",
  );
  const baselineReceiptSha256 = await put("baseline.json", {
    version: 1,
    purpose: "candidate9_train_cal_baseline_replay",
    baselineSha256: hostBaseline,
    policySha256: policy,
    calibrationCorpusSha256,
    modelCalls: 0,
    qualification: false,
    heldOutTestRead: false,
    externalOperationsExecuted: 0,
    source: { hostCommit, scriptSha256: baselineScriptSha },
    records: cases.map((c) => ({
      id: c.id,
      inputSha256: c.inputSha256,
      action: "allow",
      gate: "model_prepared",
    })),
  });
  const hostControlsReceiptSha256 = await put("hostControls.json", {
    version: 1,
    purpose: "candidate9_host_controls",
    baselineSha256: hostBaseline,
    policySha256: policy,
    modelCalls: 0,
    qualification: false,
    heldOutTestRead: false,
    externalOperationsExecuted: 0,
    source: {
      hostCommit,
      scriptSha256: controlsScriptSha,
      c9SourceSha256: sourceSha,
    },
    records: [
      {
        id: "floor",
        operationSha256: pin("4"),
        baselineAction: "block",
        actualAction: "block",
        effectivePolicySha256: policy,
        gate: "exact_policy_floor",
        modelCalls: 0,
      },
    ],
    counts: { rows: 1, unchanged: 1, modelCalls: 0 },
  });
  admission.source.hostControlsReceiptSha256 = hostControlsReceiptSha256;
  admission.source.calibrationBaselineReceiptSha256 = baselineReceiptSha256;
  admissionSha256 = await put("admission.json", admission);
  scores.admissionSha256 = admissionSha256;
  scoresSha256 = await put("scores.json", scores);
  const pins = {
    admissionSha256,
    scoresSha256,
    baselineReceiptSha256,
    hostControlsReceiptSha256,
    modelSha256: scores.modelSha256,
    nativeBinarySha256: scores.nativeBinarySha256,
    hostBaselineSha256: hostBaseline,
    policySha256: policy,
  };
  return { paths, pins, cases };
}

test("C9 selector joins admitted CAL, independent replay and real scorer bytes", async () => {
  const { paths, pins } = await fixture();
  const result = await selectFromPinnedSources(paths, pins, async () => ({
    commit: hostCommit,
    baselineSha256: hostBaseline,
  }));
  assert.equal(result.accepted, true);
  assert.equal(result.reason, "selected");
  const receipt = JSON.parse(await readFile(paths.output, "utf8"));
  assert.equal(receipt.metrics.selectedBenignInterruptions, 0);
  assert.equal(receipt.metrics.selectedUnsafeAutomaticAllows, 0);
  assert.equal(receipt.input.baselineReceiptSha256, pins.baselineReceiptSha256);
  assert.equal(
    receipt.input.hostControlsReceiptSha256,
    pins.hostControlsReceiptSha256,
  );
});

test("C9 selector rejects same-ID different-operation score after re-pinning its file", async () => {
  const { paths, pins } = await fixture();
  const scores = JSON.parse(await readFile(paths.scores, "utf8"));
  scores.records[0].inputSha256 = pin("9");
  const bytes = JSON.stringify(scores) + "\n";
  await writeFile(paths.scores, bytes);
  pins.scoresSha256 = sha(bytes);
  await assert.rejects(
    selectFromPinnedSources(paths, pins, async () => ({
      commit: hostCommit,
      baselineSha256: hostBaseline,
    })),
    /admitted CAL operations/,
  );
});

test("C9 cutoff CLI refuses unpinned invocations before writing a receipt", () => {
  const script = new URL(
    "../scripts/guardrail-candidate9-select-cutoff.mjs",
    import.meta.url,
  );
  const result = spawnSync(process.execPath, [script.pathname], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing admissionSha256/);
});
