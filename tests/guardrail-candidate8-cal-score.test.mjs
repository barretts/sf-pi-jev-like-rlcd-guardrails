import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { strict as assert } from "node:assert";
import test from "node:test";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { canonical } from "../dist/core.js";
import { GUARDRAIL_PROTOCOL_SHA256 } from "../dist/guardrail.js";
import {
  C8_CAL_ADMISSION_SHA256,
  C8_CAL_CORPUS_SHA256,
  C8_FIT_CORPUS_SHA256,
  loadCandidate8Calibration,
  scoreCandidate8Calibration,
} from "../scripts/guardrail-candidate8-cal-score.mjs";

const root = resolve(import.meta.dirname, "..");
const calFile = resolve(
  root,
  "reports/guardrail-risk-2026-09-21/candidate-8-evidence/train/calibration.jsonl",
);
const fitFile = resolve(
  root,
  "reports/guardrail-risk-2026-09-21/candidate-8-evidence/train/fit.jsonl",
);
const readRows = async (file) =>
  (await readFile(file, "utf8")).trimEnd().split("\n").map(JSON.parse);
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const identity = {
  modelId: "jev/c8-test",
  modelSha256: "a".repeat(64),
  nativeBinarySha256: "b".repeat(64),
  baselineSha256: "c".repeat(64),
  policySha256: "d".repeat(64),
};

async function source() {
  const [rows, fit] = await Promise.all([readRows(calFile), readRows(fitFile)]);
  return {
    admissionSha256: C8_CAL_ADMISSION_SHA256,
    fitSha256: C8_FIT_CORPUS_SHA256,
    calibrationCorpusSha256: C8_CAL_CORPUS_SHA256,
    promptProtocolSha256: GUARDRAIL_PROTOCOL_SHA256,
    fitGroups: [...new Set(fit.map((row) => row.group_id))].sort(order),
    rows: rows.sort((a, b) => order(a.id, b.id)),
  };
}

function fakeClassifier({ failAt = -1 } = {}) {
  const seen = [];
  return {
    seen,
    async classify(request) {
      assert.equal(request.state.version, 2);
      assert.equal(Object.hasOwn(request.state, "baseline"), false);
      assert.equal(Object.hasOwn(request, "targets"), false);
      seen.push(request.state);
      if (seen.length - 1 === failAt) throw new Error("mocked worker failure");
      return {
        model: request.model,
        answers: {
          risk: {
            type: "choice",
            choice: "allow",
            probabilities: { allow: 0.995, confirm: 0.005 },
          },
        },
        usage: { input_tokens: 32, output_tokens: 0 },
      };
    },
  };
}

test("scores all 47 TRAIN-CAL request states through the native guardrail classifier contract", async () => {
  const training = await source();
  const classifier = fakeClassifier();
  const report = await scoreCandidate8Calibration(training, {
    classifier,
    ...identity,
  });
  assert.equal(report.purpose, "candidate8_train_calibration_only");
  assert.equal(report.records.length, 47);
  assert.equal(report.cases.length, 47);
  assert.equal(classifier.seen.length, 47);
  assert.deepEqual(
    report.records.map((row) => row.id),
    [...report.records.map((row) => row.id)].sort(order),
  );
  assert.ok(
    report.records.every(
      (row) =>
        row.gate === "prepared" &&
        row.modelAnswered &&
        row.allowScore === 0.995 &&
        row.elapsedMs >= 0,
    ),
  );
  assert.deepEqual(
    report.records.map((row) => row.inputSha256),
    classifier.seen.map((state) => sha(canonical(state))),
  );
  assert.equal(report.promptProtocolSha256, GUARDRAIL_PROTOCOL_SHA256);
  assert.equal(report.fitSha256, C8_FIT_CORPUS_SHA256);
  assert.equal(report.calibrationCorpusSha256, C8_CAL_CORPUS_SHA256);
  assert.equal(report.admissionSha256, C8_CAL_ADMISSION_SHA256);
  assert.equal(JSON.stringify(report).includes("baselineAction"), false);
});

test("retains a failed model call in a non-selectable 47-row attempt", async () => {
  const classifier = fakeClassifier({ failAt: 2 });
  const report = await scoreCandidate8Calibration(await source(), {
    classifier,
    ...identity,
  });
  assert.equal(report.purpose, "candidate8_train_calibration_attempt");
  assert.equal(report.records.length, 47);
  assert.equal(report.records.filter((row) => row.modelAnswered).length, 46);
  assert.match(report.records[2].error, /mocked worker failure/);
  assert.equal(report.records[2].allowScore, null);
  assert.equal(classifier.seen.length, 47);
});

test(
  "loads only the exact admitted FIT and TRAIN-CAL bytes when local admission is supplied",
  {
    skip: !process.env.C8_ADMISSION_FILE,
  },
  async () => {
    const loaded = await loadCandidate8Calibration({
      admissionFile: process.env.C8_ADMISSION_FILE,
      calibrationFile: calFile,
      fitFile,
    });
    assert.equal(loaded.rows.length, 47);
    assert.equal(loaded.fitGroups.length, 77);
    assert.equal(loaded.admissionSha256, C8_CAL_ADMISSION_SHA256);
    assert.ok(loaded.rows.every((row) => row.split === "calibration"));
  },
);

test(
  "rejects a modified TRAIN-CAL partition before scoring",
  {
    skip: !process.env.C8_ADMISSION_FILE,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "c8-cal-tamper-"));
    try {
      const changed = resolve(directory, "calibration.jsonl");
      await writeFile(
        changed,
        (await readFile(calFile, "utf8")).replace(
          '"split":"calibration"',
          '"split":"validation"',
        ),
      );
      await assert.rejects(
        loadCandidate8Calibration({
          admissionFile: process.env.C8_ADMISSION_FILE,
          calibrationFile: changed,
          fitFile,
        }),
        /pinned admission, TRAIN-CAL, or FIT bytes changed/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
