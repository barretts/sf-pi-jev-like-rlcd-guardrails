#!/usr/bin/env node
/** Verify a committed C7 blind split without opening held-out TEST data. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = "blind-c7-20260922";
const manifestPath = `${directory}/manifest.json`;
const schemaPath = `${directory}/case.schema.json`;
const validPath = `${directory}/valid.json`;
const testPath = `${directory}/test.json`;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isHash = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const identifier = (value) =>
  typeof value === "string" && /^[a-z0-9][a-z0-9-]*$/.test(value);
const identifierHash = (values) =>
  hash(`${JSON.stringify([...new Set(values)].sort())}\n`);

function requireThat(condition, message) {
  if (!condition) throw new Error(`Candidate 7 blind seal: ${message}`);
}

function git(repoRoot, args) {
  const result = spawnSync("git", args, { cwd: repoRoot });
  requireThat(result.status === 0, `git ${args[0]} failed`);
  return result.stdout;
}

async function committedBytes(repoRoot, relativePath) {
  const path = resolve(repoRoot, relativePath);
  const entry = await lstat(path);
  requireThat(
    entry.isFile() && !entry.isSymbolicLink(),
    `${relativePath} is not a regular file`,
  );
  const current = await readFile(path);
  const committed = git(repoRoot, ["show", `HEAD:${relativePath}`]);
  requireThat(
    current.equals(committed),
    `${relativePath} differs from Git HEAD`,
  );
  return current;
}

/**
 * TEST metadata is checked, but this function never resolves, opens, hashes,
 * parses, or stats the TEST file. A later reader must first verify a committed
 * passing freeze, then compare the TEST bytes with this opaque seal.
 */
export async function verifyCandidate7BlindMetadata({
  repoRoot = root,
  expectedManifestSha256,
}) {
  requireThat(
    isHash(expectedManifestSha256),
    "expected manifest SHA-256 is required",
  );
  const manifestBytes = await committedBytes(repoRoot, manifestPath);
  requireThat(
    hash(manifestBytes) === expectedManifestSha256,
    "manifest pin changed",
  );
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const valid = manifest?.splits?.valid;
  const test = manifest?.splits?.test;
  requireThat(
    manifest?.schema_version === "c7-manifest.1" &&
      manifest.case_schema_version === "c7.1" &&
      manifest.case_schema_path === schemaPath &&
      isHash(manifest.case_schema_sha256) &&
      valid?.path === validPath &&
      test?.path === testPath &&
      isHash(valid.sha256) &&
      isHash(test.sha256) &&
      Number.isSafeInteger(valid.case_count) &&
      valid.case_count > 0 &&
      Number.isSafeInteger(valid.group_count) &&
      valid.group_count > 0 &&
      Array.isArray(valid.group_ids) &&
      valid.group_ids.every(identifier) &&
      Array.isArray(valid.template_ids) &&
      valid.template_ids.every(identifier) &&
      isHash(valid.group_ids_sha256) &&
      isHash(valid.template_ids_sha256) &&
      Number.isSafeInteger(test.case_count) &&
      test.case_count > 0 &&
      Number.isSafeInteger(test.group_count) &&
      test.group_count > 0 &&
      isHash(test.group_ids_sha256) &&
      isHash(test.template_ids_sha256) &&
      JSON.stringify(Object.keys(test).sort()) ===
        JSON.stringify(
          [
            "path",
            "sha256",
            "case_count",
            "group_count",
            "group_ids_sha256",
            "template_ids_sha256",
          ].sort(),
        ),
    "manifest split or opaque TEST metadata is incomplete",
  );
  const [schemaBytes, validBytes] = await Promise.all([
    committedBytes(repoRoot, schemaPath),
    committedBytes(repoRoot, validPath),
  ]);
  requireThat(
    hash(schemaBytes) === manifest.case_schema_sha256 &&
      hash(validBytes) === valid.sha256,
    "committed schema or VALID data changed",
  );
  const validation = JSON.parse(validBytes.toString("utf8"));
  const groups = validation?.cases?.map((row) => row?.group_id);
  const templates = validation?.cases?.map((row) => row?.template_id);
  requireThat(
    validation?.schema_version === "c7.1" &&
      validation.split === "valid" &&
      Array.isArray(validation?.cases) &&
      validation.cases.length === valid.case_count &&
      new Set(validation.cases.map((row) => row?.id)).size ===
        valid.case_count &&
      groups.every(identifier) &&
      templates.every(identifier) &&
      new Set(groups).size === valid.group_count &&
      identifierHash(groups) === valid.group_ids_sha256 &&
      identifierHash(templates) === valid.template_ids_sha256 &&
      JSON.stringify([...new Set(groups)].sort()) ===
        JSON.stringify(valid.group_ids) &&
      JSON.stringify([...new Set(templates)].sort()) ===
        JSON.stringify(valid.template_ids),
    "VALID population differs from the manifest",
  );
  return {
    manifestSha256: expectedManifestSha256,
    caseSchemaSha256: manifest.case_schema_sha256,
    validSha256: valid.sha256,
    validCaseCount: valid.case_count,
    validGroupCount: valid.group_count,
    testSeal: {
      path: test.path,
      sha256: test.sha256,
      caseCount: test.case_count,
      groupCount: test.group_count,
      groupIdsSha256: test.group_ids_sha256,
      templateIdsSha256: test.template_ids_sha256,
    },
  };
}
