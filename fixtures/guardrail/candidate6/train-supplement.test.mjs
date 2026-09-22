import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const supplement = JSON.parse(
  readFileSync(join(here, "train-supplement.json"), "utf8"),
);
// Compare only with historical TRAIN proposals; blind validation and TEST are never opened.
const previousTrain = JSON.parse(
  readFileSync(join(here, "..", "candidate5", "train-supplement.json"), "utf8"),
);
const cases = supplement.cases;
const sourceSha256 = createHash("sha256")
  .update(readFileSync(join(here, "train-supplement.json")))
  .digest("hex");

test("C6 supplement is a separate TRAIN-only matched-contrast proposal", () => {
  assert.equal(supplement.rubric, "operation-policy-v2");
  assert.match(supplement.status, /TRAIN-only/);
  assert.equal(cases.length, 18);
  const groups = new Map();
  const ids = new Set();
  const requests = new Set();
  const previousRequests = new Set(
    previousTrain.cases.map((c) => JSON.stringify([c.toolName, c.input])),
  );
  for (const row of cases) {
    assert.equal(row.split, "train");
    assert.match(row.id, /^c6-supp-/);
    assert.ok(!ids.has(row.id), `duplicate id ${row.id}`);
    ids.add(row.id);
    assert.ok(["allow", "confirm"].includes(row.expected));
    assert.ok(["bash", "herdr_pane", "data360_api"].includes(row.toolName));
    assert.ok(
      Array.isArray(row.fixturePreconditions) &&
        row.fixturePreconditions.length > 0,
    );
    assert.ok(
      Array.isArray(row.sourceEvidence) && row.sourceEvidence.length >= 2,
    );
    const request = JSON.stringify([row.toolName, row.input]);
    assert.ok(!requests.has(request), `duplicate C6 request ${row.id}`);
    assert.ok(
      !previousRequests.has(request),
      `replayed C5 TRAIN request ${row.id}`,
    );
    requests.add(request);
    const labels = groups.get(row.groupId) ?? new Set();
    labels.add(row.expected);
    groups.set(row.groupId, labels);
  }
  assert.equal(groups.size, 8);
  assert.ok(
    cases.every((row) => row.groupId !== "c6-supp-shell-python-unlink"),
  );
  for (const [group, labels] of groups) {
    assert.deepEqual(
      [...labels].sort(),
      ["allow", "confirm"],
      `unmatched group ${group}`,
    );
  }
  assert.deepEqual([...new Set(cases.map((c) => c.family))].sort(), [
    "canvas",
    "data360",
    "salesforce",
    "shell",
    "soql",
  ]);
  assert.equal(cases.filter((row) => row.family === "shell").length, 2);
  assert.match(
    readFileSync(join(here, "README.md"), "utf8"),
    new RegExp(sourceSha256),
  );
  const chmod = cases.find(
    (row) =>
      row.groupId === "c6-supp-shell-heredoc-permissions" &&
      row.expected === "confirm",
  );
  assert.ok(chmod.fixturePreconditions.some((item) => /actor owns/.test(item)));
  const canvasEdit = cases.find(
    (row) =>
      row.groupId === "c6-supp-canvas-lookup-vs-edit" &&
      row.expected === "confirm",
  );
  assert.ok(
    canvasEdit.fixturePreconditions.some((item) => /write access/.test(item)),
  );
  for (const leadCreate of cases.filter(
    (row) =>
      row.groupId === "c6-supp-prod-lead-describe-vs-create" &&
      row.expected === "confirm",
  )) {
    assert.ok(
      leadCreate.fixturePreconditions.some((item) =>
        /no additional org-required/.test(item),
      ),
    );
  }
});

test("all shell requests parse without executing external operations", () => {
  for (const row of cases.filter((c) =>
    ["bash", "herdr_pane"].includes(c.toolName),
  )) {
    const checked = spawnSync("bash", ["-n"], {
      input: row.input.command,
      encoding: "utf8",
    });
    assert.equal(checked.status, 0, `${row.id}: ${checked.stderr}`);
  }
  const heredoc = cases.find((c) =>
    c.id.includes("shell-heredoc-permissions-safe"),
  );
  assert.match(heredoc.input.command, /\nC6_SCRIPT$/);
  const pane = cases.filter((c) => c.toolName === "herdr_pane");
  assert.equal(pane.length, 2);
  for (const row of pane) {
    assert.equal(row.input.action, "run");
    assert.equal(row.input.pane, "guardrail-c6-train");
  }
});

test("source-backed API contrasts preserve method, path, and required body shapes", () => {
  const d360 = cases.filter((c) => c.family === "data360");
  assert.deepEqual(
    d360.map((c) => c.input.params.method),
    ["GET", "PATCH", "GET", "PUT"],
  );
  assert.deepEqual(
    d360.map((c) => c.expected),
    ["allow", "confirm", "allow", "confirm"],
  );
  const spaceUpdate = d360.find((c) => c.input.params.method === "PATCH");
  assert.equal(typeof spaceUpdate.input.params.body.label, "string");
  assert.equal(typeof spaceUpdate.input.params.body.description, "string");
  const memberUpsert = d360.find((c) => c.input.params.method === "PUT");
  assert.equal(
    memberUpsert.input.params.body.members.members[0].memberName,
    "C6Events__dll",
  );
  assert.equal(
    memberUpsert.input.params.body.members.members[0].filter.conditions
      .conditions[0].tableName,
    "C6Events__dll",
  );
  for (const row of d360) {
    assert.equal(row.input.action, "rest.request");
    assert.equal(row.input.dry_run, false);
    assert.equal(row.input.target_org, "C6DataSandbox");
    assert.equal(row.observations.org.type, "sandbox");
    assert.ok(
      row.sourceEvidence.some((s) =>
        s.includes("developer.salesforce.com/docs/data/connectapi"),
      ),
    );
  }
  const slack = cases.filter((c) => c.family === "canvas");
  assert.equal(slack.length, 4);
  for (const row of slack) {
    assert.match(row.input.command, /https:\/\/slack\.com\/api\/canvases\./);
    assert.match(
      row.input.command,
      /--data-binary '\{"canvas_id":"F62C6REVIEW"/,
    );
    assert.ok(
      row.sourceEvidence.some((s) =>
        s.startsWith("https://docs.slack.dev/reference/methods/canvases."),
      ),
    );
  }
  const soql = cases.filter((c) => c.family === "soql");
  assert.ok(
    soql.some(
      (c) => c.expected === "confirm" && c.input.command.includes("--all-rows"),
    ),
  );
  assert.ok(
    soql.some(
      (c) => c.expected === "confirm" && c.input.command.includes("/queryAll/"),
    ),
  );
});
