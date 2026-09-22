import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = resolve(
  root,
  "scripts/guardrail-candidate6-proposal-projection.mjs",
);
const sf =
  process.env.C6_SF_PI ?? "/private/tmp/sf-pi-guardrail-candidate5-20260922";
const sfDeps =
  process.env.C6_SF_DEPS ??
  "/private/tmp/sf-pi-guardrail-risk-20260921/node_modules";
const source = {
  sfCommit: "dd97a1a9165a89cdb7ff5b2d0c84d2bbf3843277",
  sfRuntime: "7d8c068bf02725b1f5ad7d77349a4144390ab0f1a6e531bc28f89af8270154c4",
  augmentation:
    "c8538642a18468d5e4607bd650a5dbd8c728791f142ed6496e74434ec7e92409",
  browser: "0066675417d3e6ffeb16af14f9e2571b23eb435f4b52a947ab5cc2c33b681a8d",
  protocol: "d67044fb1a5d2a519f12e8b7561ce8e7ed743f42753f726812b0bd99ea6ab530",
  scorer: "451e617f598d2b2e6bb5a708b3725f6b0cf3bde129cfc2a7ef7d1915618c34e2",
};
const output = () =>
  resolve(
    root,
    `.build/guardrail/candidate-6-proposal-projection-test-${randomUUID()}`,
  );
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const args = (destination, overrides = {}) => [
  script,
  "--sf-pi",
  sf,
  "--sf-deps",
  sfDeps,
  "--sf-commit",
  overrides.sfCommit ?? source.sfCommit,
  "--sf-runtime-sha256",
  overrides.sfRuntime ?? source.sfRuntime,
  "--augmentation-sha256",
  overrides.augmentation ?? source.augmentation,
  "--browser-sha256",
  overrides.browser ?? source.browser,
  "--scorer-protocol-sha256",
  overrides.protocol ?? source.protocol,
  "--scorer-distribution-sha256",
  overrides.scorer ?? source.scorer,
  "--output-dir",
  destination,
];

test("a changed source pin cannot produce a projected dataset", async () => {
  const destination = output();
  try {
    const result = spawnSync(
      process.execPath,
      args(destination, { augmentation: "0".repeat(64) }),
      {
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Pinned proposal or Jev scorer source changed/);
    assert.equal(existsSync(destination), false);
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
});

test(
  "the committed host projects ten matched TRAIN rows without execution",
  {
    skip: !process.env.C6_SF_PI || !process.env.C6_SF_DEPS,
  },
  async () => {
    const destination = output();
    try {
      const result = spawnSync(process.execPath, args(destination), {
        encoding: "utf8",
        timeout: 60_000,
      });
      assert.equal(result.status, 0, result.stderr);
      const receipt = JSON.parse(
        readFileSync(resolve(destination, "receipt.json"), "utf8"),
      );
      const dataset = readFileSync(resolve(destination, "train.jsonl"));
      const rows = dataset
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .map(JSON.parse);
      assert.equal(dataset.toString("utf8").endsWith("\n"), true);
      assert.equal(sha(dataset), receipt.dataset.sha256);
      assert.equal(rows.length, 10);
      assert.equal(new Set(rows.map((row) => row.id)).size, 10);
      assert.ok(
        rows.every(
          (row) =>
            row.split === "train" &&
            row.target_provenance.risk.source === "supplied",
        ),
      );
      assert.deepEqual(receipt.labels, { allow: 5, confirm: 5 });
      assert.deepEqual(receipt.baselineActions, {
        allow: 10,
        confirm: 0,
        block: 0,
      });
      assert.equal(receipt.trainGroups, 5);
      assert.equal(receipt.validationRows, 0);
      assert.equal(receipt.testRows, 0);
      assert.equal(receipt.modelCalls, 0);
      assert.equal(receipt.externalOperationsExecuted, 0);
      assert.equal(receipt.browserInputsDispatched, 0);
      assert.equal(receipt.qualification, false);
      assert.equal(receipt.trainingReady, false);
      assert.equal(receipt.source.sfPiRuntimeSha256, source.sfRuntime);
      assert.equal(receipt.source.scorerProtocolSha256, source.protocol);
      const groups = new Map();
      for (const row of rows) {
        const labels = groups.get(row.group_id) ?? [];
        labels.push(row.targets.risk.answer);
        groups.set(row.group_id, labels);
      }
      assert.equal(groups.size, 5);
      assert.ok(
        [...groups.values()].every(
          (labels) => labels.sort().join(",") === "allow,confirm",
        ),
      );
      const browser = rows.filter(
        (row) => row.request.state.toolName === "sf_browser_click",
      );
      assert.equal(browser.length, 4);
      assert.ok(
        browser.every(
          (row) =>
            row.request.state.facts.browserPage.snapshotSha256 ===
            row.request.state.facts.browserRef.snapshotSha256,
        ),
      );
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  },
);
