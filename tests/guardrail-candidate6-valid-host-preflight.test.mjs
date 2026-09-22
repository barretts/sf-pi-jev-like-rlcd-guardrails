import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { verifyValidationBytes } from "../scripts/guardrail-candidate6-valid-host-preflight.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = {
  valid: resolve(root, "blind-c6-20260922/c6-valid-v3.json"),
  manifest: resolve(root, "blind-c6-20260922/c6-valid-v3.manifest.json"),
  schema: resolve(root, "blind-c6-20260922/c6-case.schema.json"),
};
const sourceBytes = async () =>
  Promise.all([
    readFile(files.valid),
    readFile(files.manifest),
    readFile(files.schema),
  ]);

test("accepts the exact sealed C6 VALID v3 bytes and exact-block contract", async () => {
  const [valid, manifest, schema] = await sourceBytes();
  const result = verifyValidationBytes(valid, manifest, schema);
  assert.equal(result.rows.length, 54);
  assert.equal(result.groups, 24);
  assert.equal(result.declaredExactBlocks, 5);
  assert.deepEqual(result.counts, {
    allow: 26,
    require_approval: 23,
    hard_block: 5,
  });
  assert.equal(
    result.rows.every((row) => row.id.startsWith("c6-valid-")),
    true,
  );
});

test("rejects a changed VALID row even if its manifest is untouched", async () => {
  const [valid, manifest, schema] = await sourceBytes();
  const changed = Buffer.from(valid);
  changed[changed.length - 2] ^= 1;
  assert.throws(
    () => verifyValidationBytes(changed, manifest, schema),
    /differs from pinned bytes/,
  );
});

test("rejects changed manifest or schema independently", async () => {
  const [valid, manifest, schema] = await sourceBytes();
  const changedManifest = Buffer.from(manifest);
  changedManifest[changedManifest.length - 2] ^= 1;
  assert.throws(
    () => verifyValidationBytes(valid, changedManifest, schema),
    /differs from pinned bytes/,
  );
  const changedSchema = Buffer.from(schema);
  changedSchema[changedSchema.length - 2] ^= 1;
  assert.throws(
    () => verifyValidationBytes(valid, manifest, changedSchema),
    /differs from pinned bytes/,
  );
});

test(
  "replays VALID through the real host without model calls or tool execution",
  { skip: !process.env.C6_SF_PI || !process.env.C6_SF_DEPS },
  async () => {
    const outputDir = resolve(
      root,
      `.build/guardrail/candidate-6-valid-host-preflight-test-${randomUUID()}`,
    );
    try {
      execFileSync(
        process.execPath,
        [
          resolve(
            root,
            "scripts/guardrail-candidate6-valid-host-preflight.mjs",
          ),
          "--sf-pi",
          process.env.C6_SF_PI,
          "--sf-deps",
          process.env.C6_SF_DEPS,
          "--output-dir",
          outputDir,
        ],
        { cwd: root, encoding: "utf8", timeout: 30_000 },
      );
      const receipt = JSON.parse(
        await readFile(resolve(outputDir, "receipt.json")),
      );
      assert.equal(receipt.validationOnly, true);
      assert.equal(receipt.heldOutTestUsed, false);
      assert.equal(receipt.testRows, 0);
      assert.equal(receipt.modelCalls, 0);
      assert.equal(receipt.externalOperationsExecuted, 0);
      assert.equal(receipt.eligibility.total, 54);
      assert.equal(receipt.fixtureObservations.customBlockPolicies, 5);
      assert.equal(receipt.baselineActions.block, 5);
      assert.equal(
        receipt.eligibility.prepared +
          receipt.eligibility.policyFloor +
          receipt.eligibility.fallback,
        receipt.eligibility.eligible,
      );
      assert.equal(
        receipt.source.validSha256,
        "da14b83047094971dfe5083a5ea2fd437c01a44600ce9d9a196cb6dd62287905",
      );
      await assert.rejects(stat(resolve(outputDir, "fixture-cwd")), {
        code: "ENOENT",
      });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  },
);
