import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = resolve(
  root,
  "scripts/guardrail-candidate6-supplement-preflight.mjs",
);
const supplement = resolve(
  root,
  "fixtures/guardrail/candidate6/train-supplement.json",
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const output = () =>
  resolve(
    root,
    `.build/guardrail/candidate-6-supplement-preflight-test-${randomUUID()}`,
  );

test("a changed supplement is rejected against its pinned source hash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "c6-preflight-hash-test-"));
  try {
    const copy = join(dir, "tampered.json");
    const original = readFileSync(supplement);
    writeFileSync(copy, `${original.toString("utf8")} `);
    const destination = output();
    const result = spawnSync(
      process.execPath,
      [
        script,
        "--sf-pi",
        root,
        "--sf-deps",
        dir,
        "--supplement",
        copy,
        "--supplement-sha256",
        sha(original),
        "--output-dir",
        destination,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Pinned C6 supplement SHA-256 mismatch/);
    assert.equal(existsSync(destination), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "a validated cleanup exact floor cannot enter the C6 model dataset",
  { skip: !process.env.C6_SF_PI || !process.env.C6_SF_DEPS },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "c6-preflight-floor-test-"));
    const cleanupDir = await mkdtemp(join(tmpdir(), "tmp.c6-floor-test-"));
    const destination = output();
    try {
      const candidate = JSON.parse(readFileSync(supplement, "utf8"));
      const firstShell = candidate.cases.find((row) => row.family === "shell");
      assert.ok(firstShell);
      firstShell.input.command = `rm -rf ${cleanupDir}`;
      const bytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
      const copy = join(dir, "floored.json");
      writeFileSync(copy, bytes);
      const result = spawnSync(
        process.execPath,
        [
          script,
          "--sf-pi",
          process.env.C6_SF_PI,
          "--sf-deps",
          process.env.C6_SF_DEPS,
          "--supplement",
          copy,
          "--supplement-sha256",
          sha(bytes),
          "--output-dir",
          destination,
        ],
        { encoding: "utf8", timeout: 60_000 },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /ineligible or exact-floored/);
      assert.equal(existsSync(destination), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(cleanupDir, { recursive: true, force: true });
      await rm(destination, { recursive: true, force: true });
    }
  },
);
