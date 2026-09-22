import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { verifyCandidate7BlindMetadata } from "../scripts/guardrail-candidate7-blind-seal.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const idsSha = (values) =>
  sha(`${JSON.stringify([...new Set(values)].sort())}\n`);
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

async function fixture() {
  const repoRoot = await mkdtemp(resolve(tmpdir(), "jev-c7-blind-seal-"));
  const directory = resolve(repoRoot, "blind-c7-20260922");
  await mkdir(directory);
  const schema = "{}\n";
  const valid = `${JSON.stringify({ schema_version: "c7.1", split: "valid", cases: [{ id: "v1", group_id: "g1", template_id: "t1" }] })}\n`;
  const manifest = {
    schema_version: "c7-manifest.1",
    case_schema_version: "c7.1",
    case_schema_path: "blind-c7-20260922/case.schema.json",
    case_schema_sha256: sha(schema),
    splits: {
      valid: {
        path: "blind-c7-20260922/valid.json",
        sha256: sha(valid),
        case_count: 1,
        group_count: 1,
        group_ids: ["g1"],
        template_ids: ["t1"],
        group_ids_sha256: idsSha(["g1"]),
        template_ids_sha256: idsSha(["t1"]),
      },
      test: {
        path: "blind-c7-20260922/test.json",
        sha256: sha("sealed-test-bytes-not-present\n"),
        case_count: 2,
        group_count: 1,
        group_ids_sha256: sha("opaque-group-ids"),
        template_ids_sha256: sha("opaque-template-ids"),
      },
    },
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  await Promise.all([
    writeFile(resolve(directory, "case.schema.json"), schema),
    writeFile(resolve(directory, "valid.json"), valid),
    writeFile(resolve(directory, "manifest.json"), manifestBytes),
  ]);
  git(repoRoot, "init", "-q");
  git(
    repoRoot,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "add",
    ".",
  );
  git(
    repoRoot,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "Seal metadata",
  );
  return {
    repoRoot,
    directory,
    manifest,
    expectedManifestSha256: sha(manifestBytes),
  };
}

test("prefreeze metadata check succeeds without a TEST file or labels", async () => {
  const source = await fixture();
  try {
    const result = await verifyCandidate7BlindMetadata(source);
    assert.equal(result.validCaseCount, 1);
    assert.equal(result.testSeal.caseCount, 2);
    assert.deepEqual(Object.keys(result.testSeal), [
      "path",
      "sha256",
      "caseCount",
      "groupCount",
      "groupIdsSha256",
      "templateIdsSha256",
    ]);
    await assert.rejects(readFile(resolve(source.directory, "test.json")), {
      code: "ENOENT",
    });
  } finally {
    await rm(source.repoRoot, { recursive: true, force: true });
  }
});

test("prefreeze check rejects changed or uncommitted VALID and manifest bytes", async () => {
  const source = await fixture();
  try {
    await writeFile(resolve(source.directory, "valid.json"), '{"cases":[]}\n');
    await assert.rejects(
      verifyCandidate7BlindMetadata(source),
      /differs from Git HEAD/,
    );
    git(source.repoRoot, "checkout", "--", "blind-c7-20260922/valid.json");
    await writeFile(resolve(source.directory, "manifest.json"), "{}\n");
    await assert.rejects(
      verifyCandidate7BlindMetadata(source),
      /differs from Git HEAD/,
    );
  } finally {
    await rm(source.repoRoot, { recursive: true, force: true });
  }
});

test("prefreeze check rejects a mismatched manifest pin and exposed TEST IDs", async () => {
  const source = await fixture();
  try {
    await assert.rejects(
      verifyCandidate7BlindMetadata({
        ...source,
        expectedManifestSha256: sha("wrong"),
      }),
      /manifest pin changed/,
    );
    const changed = structuredClone(source.manifest);
    changed.splits.test.group_ids = ["secret-test-group"];
    const bytes = `${JSON.stringify(changed, null, 2)}\n`;
    await writeFile(resolve(source.directory, "manifest.json"), bytes);
    git(source.repoRoot, "add", "blind-c7-20260922/manifest.json");
    git(
      source.repoRoot,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "Reveal TEST IDs",
    );
    await assert.rejects(
      verifyCandidate7BlindMetadata({
        ...source,
        expectedManifestSha256: sha(bytes),
      }),
      /opaque TEST metadata/,
    );
  } finally {
    await rm(source.repoRoot, { recursive: true, force: true });
  }
});

test("prefreeze check verifies VALID groups and templates against the seal", async () => {
  const source = await fixture();
  try {
    const valid = `${JSON.stringify({ schema_version: "c7.1", split: "valid", cases: [{ id: "v1", group_id: "g1", template_id: "t2" }] })}\n`;
    await writeFile(resolve(source.directory, "valid.json"), valid);
    const changed = structuredClone(source.manifest);
    changed.splits.valid.sha256 = sha(valid);
    const bytes = `${JSON.stringify(changed, null, 2)}\n`;
    await writeFile(resolve(source.directory, "manifest.json"), bytes);
    git(
      source.repoRoot,
      "add",
      "blind-c7-20260922/valid.json",
      "blind-c7-20260922/manifest.json",
    );
    git(
      source.repoRoot,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "Mismatched template seal",
    );
    await assert.rejects(
      verifyCandidate7BlindMetadata({
        ...source,
        expectedManifestSha256: sha(bytes),
      }),
      /VALID population differs/,
    );
  } finally {
    await rm(source.repoRoot, { recursive: true, force: true });
  }
});

test("prefreeze check rejects a symlink even when it serves the sealed bytes", async () => {
  const source = await fixture();
  try {
    const original = await readFile(resolve(source.directory, "valid.json"));
    await writeFile(resolve(source.directory, "valid-copy.json"), original);
    await rm(resolve(source.directory, "valid.json"));
    await symlink("valid-copy.json", resolve(source.directory, "valid.json"));
    await assert.rejects(
      verifyCandidate7BlindMetadata(source),
      /is not a regular file/,
    );
  } finally {
    await rm(source.repoRoot, { recursive: true, force: true });
  }
});
