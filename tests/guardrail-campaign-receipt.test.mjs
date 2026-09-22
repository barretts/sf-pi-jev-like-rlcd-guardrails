import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  assertCompatibleCampaignSnapshot,
  assertPreparedTrainingData,
  verifyBaselineSources,
} from "../scripts/guardrail-campaign-receipt.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "jev-guardrail-receipt-"));
  const names = [
    "extensions/sf-guardrail/tests/guardrail-corpus.test.ts",
    "extensions/sf-guardrail/lib/risk-baseline-identity.ts",
    "extensions/sf-guardrail/index.ts",
    ...Array.from(
      { length: 8 },
      (_, i) => `extensions/sf-guardrail/lib/source-${i}.ts`,
    ),
  ];
  const sources = {};
  for (const name of names) {
    const file = join(root, name);
    await mkdir(dirname(file), { recursive: true });
    const bytes = Buffer.from(`source ${name}\n`);
    await writeFile(file, bytes);
    sources[name] = sha(bytes);
  }
  const runtime = Object.fromEntries(Object.entries(sources).sort());
  const bundle = {
    version: 1,
    mockedExecution: true,
    corpusSha256: "c".repeat(64),
    baselineSourceSha256: sha(JSON.stringify(runtime)),
    provenanceSourceSha256: sha(JSON.stringify(sources)),
    sourceSha256: sources,
    runtimeSourceSha256: runtime,
    records: [{ id: "synthetic" }],
    summary: { cases: 1 },
  };
  return { root, bundle, names };
}

test("receipt preflight rehashes the physical exporter and runtime inventory", async () => {
  const { root, bundle } = await fixture();
  try {
    const result = await verifyBaselineSources(root, bundle);
    assert.equal(result.baselineSourceSha256, bundle.baselineSourceSha256);
    assert.equal(
      result.exporterSha256,
      bundle.sourceSha256[
        "extensions/sf-guardrail/tests/guardrail-corpus.test.ts"
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("receipt preflight rejects a changed source even when the saved bundle is unchanged", async () => {
  const { root, bundle, names } = await fixture();
  try {
    await writeFile(join(root, names[3]), "changed\n");
    await assert.rejects(verifyBaselineSources(root, bundle), /source changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("receipt preflight rejects omitted exporter and inconsistent source summaries", async () => {
  const { root, bundle } = await fixture();
  try {
    delete bundle.sourceSha256[
      "extensions/sf-guardrail/tests/guardrail-corpus.test.ts"
    ];
    await assert.rejects(
      verifyBaselineSources(root, bundle),
      /omits an enforcement or export surface/,
    );
    bundle.sourceSha256[
      "extensions/sf-guardrail/tests/guardrail-corpus.test.ts"
    ] = "0".repeat(64);
    await assert.rejects(verifyBaselineSources(root, bundle), /source changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("receipt preflight binds the physical authored and prepared TRAIN/VALID dataset", () => {
  const authored = {
    path: "/tmp/candidate/authored-train-validation.jsonl",
    sha256: "a".repeat(64),
  };
  const dataset = {
    path: "/tmp/candidate/dataset.jsonl",
    sha256: authored.sha256,
  };
  const runFiles = {
    "authored-train-validation.jsonl": authored,
    "dataset.jsonl": dataset,
  };
  const prospective = {
    trainRows: 3,
    validationRows: 2,
    testRowsPassedToTraining: 0,
    authoredTrainValidationSha256: authored.sha256,
  };
  const manifest = {
    source: { file: authored.path, sha256: authored.sha256, examples: 5 },
    prepared: { dataset_file: dataset.path, dataset_sha256: dataset.sha256 },
  };
  assert.doesNotThrow(() =>
    assertPreparedTrainingData(prospective, manifest, runFiles),
  );
  assert.throws(
    () =>
      assertPreparedTrainingData(
        { ...prospective, testRowsPassedToTraining: 1 },
        manifest,
        runFiles,
      ),
    /prepared TRAIN\/VALID data/,
  );
  assert.throws(
    () =>
      assertPreparedTrainingData(prospective, manifest, {
        ...runFiles,
        "authored-train-validation.jsonl": {
          ...authored,
          sha256: "b".repeat(64),
        },
      }),
    /prepared TRAIN\/VALID data/,
  );
});

test("receipt remains valid across a later docs commit but rejects source drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-guardrail-receipt-history-"));
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  const commit = (message) => {
    git("add", "docs.md", "source.ts");
    git(
      "-c",
      "user.name=Receipt Test",
      "-c",
      "user.email=receipt@example.test",
      "commit",
      "-qm",
      message,
    );
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "--quiet");
    await writeFile(join(root, "source.ts"), "export const risk = 1;\n");
    await writeFile(join(root, "docs.md"), "first\n");
    const first = commit("initial");
    const pinned = {
      jevCommit: first,
      jevSources: { "source.ts": sha("export const risk = 1;\n") },
      modelSha256: "a".repeat(64),
    };
    await writeFile(join(root, "docs.md"), "later evidence\n");
    const docsCommit = commit("evidence");
    assert.doesNotThrow(() =>
      assertCompatibleCampaignSnapshot(
        pinned,
        { ...pinned, jevCommit: docsCommit },
        root,
      ),
    );
    assert.throws(
      () =>
        assertCompatibleCampaignSnapshot(
          pinned,
          { ...pinned, jevCommit: "0".repeat(40) },
          root,
        ),
      /not a descendant/,
    );
    await writeFile(join(root, "source.ts"), "export const risk = 2;\n");
    const sourceCommit = commit("changed executable source");
    assert.throws(
      () =>
        assertCompatibleCampaignSnapshot(
          pinned,
          {
            ...pinned,
            jevCommit: sourceCommit,
            jevSources: { "source.ts": sha("export const risk = 2;\n") },
          },
          root,
        ),
      /campaign inputs or executable surfaces changed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
