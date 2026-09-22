import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const expectedSha256 =
  "0066675417d3e6ffeb16af14f9e2571b23eb435f4b52a947ab5cc2c33b681a8d";
const bytes = await readFile(join(here, "browser-train-proposal.json"));
const proposal = JSON.parse(bytes);

test("browser proposal is pinned and separate from training admission", () => {
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    expectedSha256,
  );
  assert.equal(proposal.version, 1);
  assert.equal(proposal.rubric, "operation-policy-v2");
  assert.equal(proposal.humanLabelReviewed, false);
  assert.equal(proposal.trainingReady, false);
  assert.equal(proposal.qualification, false);
  assert.equal(proposal.cases.length, 4);
  assert.equal(new Set(proposal.cases.map((row) => row.id)).size, 4);
  assert.ok(proposal.cases.every((row) => row.split === "train"));
});

test("every click has one internally consistent mocked snapshot and paired labels", () => {
  const groups = new Map();
  for (const row of proposal.cases) {
    assert.equal(row.toolName, "sf_browser_click");
    assert.ok(["allow", "confirm"].includes(row.expected));
    const ref = row.observations.browserRef;
    const page = row.observations.browserPage;
    assert.equal(ref.status, "fresh");
    assert.equal(ref.role, "link");
    assert.equal(ref.ref, row.input.ref);
    assert.match(ref.line, new RegExp(`\\[ref=${row.input.ref}\\]$`));
    assert.ok(page.snapshot.includes(ref.line));
    assert.equal(page.status, "fresh");
    const url = new URL(page.url);
    assert.equal(url.protocol, "https:");
    assert.equal(page.url, url.origin + url.pathname);
    assert.equal(
      page.snapshotSha256,
      createHash("sha256").update(page.snapshot).digest("hex"),
    );
    groups.set(row.groupId, [...(groups.get(row.groupId) ?? []), row.expected]);
  }
  assert.equal(groups.size, 2);
  for (const labels of groups.values())
    assert.deepEqual(labels.sort(), ["allow", "confirm"]);
});
