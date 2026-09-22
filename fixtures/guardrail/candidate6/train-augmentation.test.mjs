import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const expectedSha256 =
  "c8538642a18468d5e4607bd650a5dbd8c728791f142ed6496e74434ec7e92409";
const bytes = await readFile(join(here, "train-augmentation.json"));
const proposal = JSON.parse(bytes);

test("C6 augmentation is a pinned, separate TRAIN-only proposal", () => {
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    expectedSha256,
  );
  assert.equal(proposal.version, 1);
  assert.equal(proposal.rubric, "operation-policy-v2");
  assert.match(proposal.status, /TRAIN-only/);
  assert.equal(
    proposal.sfPiSourceCommit,
    "dd97a1a9165a89cdb7ff5b2d0c84d2bbf3843277",
  );
  assert.equal(proposal.humanLabelReviewed, false);
  assert.equal(proposal.trainingReady, false);
  assert.equal(proposal.qualification, false);
  assert.equal(proposal.cases.length, 6);
  assert.equal(new Set(proposal.cases.map((row) => row.id)).size, 6);
  assert.ok(proposal.cases.every((row) => row.split === "train"));
});

test("every authored operation group keeps its safe and risky contrast together", () => {
  const groups = new Map();
  for (const row of proposal.cases) {
    assert.ok(row.id.startsWith("c6-aug-"));
    assert.ok(row.groupId.startsWith("c6-aug-"));
    assert.ok(["allow", "confirm"].includes(row.expected));
    assert.ok(row.input && typeof row.input === "object");
    assert.ok(row.observations && typeof row.observations === "object");
    assert.ok(row.fixturePreconditions.length > 0);
    assert.ok(row.sourceEvidence.includes("fixtures/guardrail/RUBRIC.md"));
    groups.set(row.groupId, [...(groups.get(row.groupId) ?? []), row.expected]);
  }
  assert.equal(groups.size, 3);
  for (const labels of groups.values())
    assert.deepEqual(labels.sort(), ["allow", "confirm"]);
});

test("Git rehearsal suppresses pre-push hooks; live push stays risky", () => {
  const pair = proposal.cases.filter(
    (row) => row.groupId === "c6-aug-git-dry-run-vs-live-force-push",
  );
  const safe = pair.find((row) => row.expected === "allow")?.input.command;
  const risky = pair.find((row) => row.expected === "confirm")?.input.command;
  assert.match(safe, /git push --dry-run --no-verify --force-with-lease/);
  assert.match(risky, /git push --force-with-lease/);
  assert.doesNotMatch(risky, /--dry-run|--no-verify/);
});
