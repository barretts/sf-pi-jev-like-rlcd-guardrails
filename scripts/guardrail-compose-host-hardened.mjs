/** Compose a separate host-hardened guardrail corpus without changing the original 612 cases. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const basePath = resolve(root, "fixtures/guardrail/corpus.json");
const addendumPath = resolve(
  root,
  "fixtures/guardrail/host-hardened-apex-addendum.json",
);
const baseSha256 =
  "f04d11f220f8f167a579e0fd3f466a1d47f2c0a612fb1411ee264bfc34675ee2";
const campaignId = "host-hardened-apex-coverage-v1";
const groupBySplit = {
  train: "train-apex-anonymous-identity-probe",
  validation: "validation-apex-anonymous-limits-probe",
  test: "test-apex-anonymous-clock-probe",
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (message) => {
  throw new Error(message);
};

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...keys].sort()))
    fail(`${label} has unexpected or missing keys`);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { output: { type: "string" } },
});
if (positionals.length || !values.output?.trim())
  fail("--output FILE is required");
const outputPath = resolve(values.output);
if (outputPath === basePath || outputPath === addendumPath)
  fail("Output must be separate from the source corpus and addendum");

const baseBytes = await readFile(basePath);
if (sha256(baseBytes) !== baseSha256)
  fail("Original 612-case corpus does not match its pinned SHA-256");
const base = JSON.parse(baseBytes);
if (
  base.version !== 1 ||
  base.rubricVersion !== "operation-policy-v1" ||
  base.cases?.length !== 612
)
  fail("Original corpus version, rubric, or case count changed");

const addendumBytes = await readFile(addendumPath);
const addendum = JSON.parse(addendumBytes);
exactKeys(
  addendum,
  [
    "version",
    "campaignId",
    "baseCorpusSha256",
    "rubricVersion",
    "provenance",
    "cases",
  ],
  "addendum",
);
if (
  addendum.version !== 1 ||
  addendum.campaignId !== campaignId ||
  addendum.baseCorpusSha256 !== baseSha256 ||
  addendum.rubricVersion !== base.rubricVersion ||
  typeof addendum.provenance !== "string" ||
  !addendum.provenance.trim() ||
  !Array.isArray(addendum.cases) ||
  addendum.cases.length !== 9
)
  fail("Addendum campaign metadata is invalid");

// Only inspect original IDs and group IDs. The original held-out inputs and labels
// are copied byte-for-byte as parsed JSON and are never printed or used here.
const ids = new Set(base.cases.map(({ id }) => id));
const groups = new Set(base.cases.map(({ groupId }) => groupId));
const variantsBySplit = new Map();
for (const row of addendum.cases) {
  exactKeys(
    row,
    [
      "id",
      "groupId",
      "family",
      "split",
      "expected",
      "rubricId",
      "tags",
      "toolName",
      "input",
      "observations",
    ],
    "addendum case",
  );
  const groupId = groupBySplit[row.split];
  const match = typeof row.id === "string" && row.id.match(/^(.+)-v([1-3])$/);
  if (
    !groupId ||
    row.groupId !== groupId ||
    !match ||
    match[1] !== groupId ||
    ids.has(row.id) ||
    groups.has(row.groupId) ||
    row.family !== "apex" ||
    row.expected !== "confirm" ||
    row.rubricId !== "arbitrary-org-code" ||
    row.toolName !== "sf_apex" ||
    JSON.stringify(row.tags) !==
      JSON.stringify(["anonymous-apex", "read-like-body"])
  )
    fail(`Invalid or duplicate addendum ID/group: ${String(row.id)}`);
  ids.add(row.id);
  const variants = variantsBySplit.get(row.split) ?? new Set();
  if (variants.has(match[2]))
    fail(`Duplicate ${row.split} variant ${match[2]}`);
  variants.add(match[2]);
  variantsBySplit.set(row.split, variants);

  exactKeys(
    row.input,
    ["action", "target_org", "allow_mutation", "body"],
    row.id + " input",
  );
  exactKeys(row.observations, ["org"], row.id + " observations");
  exactKeys(row.observations.org, ["type", "alias"], row.id + " org");
  if (
    row.input.action !== "anon.run" ||
    row.input.target_org !== "DevOrg" ||
    row.input.allow_mutation !== false ||
    typeof row.input.body !== "string" ||
    !row.input.body.trim() ||
    row.observations.org.alias !== "DevOrg" ||
    row.observations.org.type !== "sandbox"
  )
    fail(`Invalid Anonymous Apex request or org observation: ${row.id}`);
}
for (const split of Object.keys(groupBySplit))
  if (
    JSON.stringify([...(variantsBySplit.get(split) ?? new Set())].sort()) !==
    '["1","2","3"]'
  )
    fail(`Expected three related ${split} variants`);

const addendumSha256 = sha256(addendumBytes);
const composed = {
  version: base.version,
  rubricVersion: base.rubricVersion,
  provenance: `${base.provenance} ${addendum.provenance}`,
  grouping: `${base.grouping} The three new Anonymous Apex probe groups remain disjoint by split.`,
  campaign: { id: campaignId, baseCorpusSha256: baseSha256, addendumSha256 },
  cases: [...base.cases, ...addendum.cases],
};
const encoded = JSON.stringify(composed, null, 2) + "\n";
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, encoded, { flag: "wx", mode: 0o600 });
console.log(
  JSON.stringify({
    output: outputPath,
    campaignId,
    cases: composed.cases.length,
    baseCorpusSha256: baseSha256,
    addendumSha256,
    sha256: sha256(encoded),
  }),
);
