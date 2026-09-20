import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
  stat,
  access,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import ts from "typescript";

// No real corpus, model, Python executable, config, credentials, or cache is read.
// Block the only worker-launch primitive in the orchestrator before importing it.
const blockedSpawn = mock.method(childProcess, "spawn", () => {
  throw new Error("worker_processes_forbidden_in_cpu_training_tests");
});
syncBuiltinESMExports();
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [scriptSource, headSource] = await Promise.all([
  readFile(resolve(workspace, "scripts/routing-head-train.mjs"), "utf8"),
  readFile(resolve(workspace, "src/routing-head.ts"), "utf8"),
]);
const headJavaScript = ts.transpileModule(headSource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
  },
}).outputText;
const directories = [];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inventedCorpus = () => ({
  version: 1,
  cases: [
    {
      id: "invented-fast",
      family: "invented-family",
      text: "Invented request alpha.",
      label: "fast",
    },
    {
      id: "invented-strong",
      family: "invented-family",
      text: "Invented request beta.",
      label: "strong",
    },
  ],
});

async function harness(corpus = inventedCorpus()) {
  const root = await realpath(
    await mkdtemp(resolve(tmpdir(), "jev-routing-training-cpu-")),
  );
  directories.push(root);
  await Promise.all(
    [
      "scripts",
      "src",
      "dist",
      "routing",
      "fixtures",
      ".build/rfdt-venv/bin",
    ].map((path) => mkdir(resolve(root, path), { recursive: true })),
  );
  const script = resolve(root, "scripts/routing-head-train.mjs");
  const fixture = resolve(root, "fixtures/routing-train.json");
  const python = resolve(root, ".build/rfdt-venv/bin/python");
  await Promise.all([
    writeFile(resolve(root, "package.json"), '{"type":"module"}\n'),
    writeFile(script, scriptSource),
    writeFile(resolve(root, "src/routing-head.ts"), headSource),
    writeFile(resolve(root, "dist/routing-head.js"), headJavaScript),
    writeFile(
      resolve(root, "src/routing-runtime.ts"),
      "// Invented source pin placeholder. Never used for runtime validation.\n",
    ),
    writeFile(
      resolve(root, "dist/routing-runtime.js"),
      'export function routingFeatureProvenance() { throw new Error("runtime_provenance_forbidden_during_preparation"); }\n',
    ),
    writeFile(
      resolve(root, "routing/feature_worker.py"),
      "# Invented hash placeholder. Never executed.\n",
    ),
    writeFile(
      python,
      "Invented Python binary hash placeholder. Never executed.\n",
    ),
    writeFile(fixture, JSON.stringify(corpus) + "\n"),
  ]);
  return { root, script, fixture, python, output: resolve(root, "prepared") };
}
const importedHarness = await harness();
const imported = await import(pathToFileURL(importedHarness.script).href);

after(async () => {
  const attempts = blockedSpawn.mock.callCount();
  blockedSpawn.mock.restore();
  syncBuiltinESMExports();
  await Promise.all(
    directories.map((path) => rm(path, { recursive: true, force: true })),
  );
  assert.equal(
    attempts,
    0,
    "Preparation/import must never attempt to launch a worker",
  );
});

test("import has no preparation, worker launch, or signal-listener side effects", async () => {
  const sandbox = await harness();
  const before = (await readdir(sandbox.root, { recursive: true })).sort();
  const listeners = {
    interrupt: process.listenerCount("SIGINT"),
    terminate: process.listenerCount("SIGTERM"),
  };
  await import(pathToFileURL(sandbox.script).href);
  assert.deepEqual(
    (await readdir(sandbox.root, { recursive: true })).sort(),
    before,
  );
  assert.equal(process.listenerCount("SIGINT"), listeners.interrupt);
  assert.equal(process.listenerCount("SIGTERM"), listeners.terminate);
  assert.equal(blockedSpawn.mock.callCount(), 0);
});

test("pure validators import before any runtime build exists", async () => {
  const sandbox = await harness();
  await rm(resolve(sandbox.root, "dist"), { recursive: true });
  const module = await import(pathToFileURL(sandbox.script).href);
  assert.deepEqual(module.validateTrainingCorpus(inventedCorpus()).counts, {
    fast: 1,
    strong: 1,
  });
  assert.equal(blockedSpawn.mock.callCount(), 0);
});

test("head options are frozen, explicit, and within the head fit bounds", () => {
  const options = imported.HEAD_OPTIONS;
  assert.equal(Object.isFrozen(options), true);
  assert.deepEqual(Object.keys(options).sort(), [
    "l2",
    "maxIterations",
    "minMargin",
    "standardize",
    "threshold",
    "tolerance",
  ]);
  assert.ok(
    Number.isFinite(options.l2) && options.l2 >= 1e-8 && options.l2 <= 1e6,
  );
  assert.ok(
    Number.isSafeInteger(options.maxIterations) &&
      options.maxIterations > 0 &&
      options.maxIterations <= 2000,
  );
  assert.ok(
    Number.isFinite(options.tolerance) &&
      options.tolerance >= 1e-12 &&
      options.tolerance <= 1e-2,
  );
  assert.equal(options.standardize, true);
  assert.ok(
    Number.isFinite(options.threshold) &&
      options.threshold > 0 &&
      options.threshold < 1,
  );
  assert.ok(
    Number.isFinite(options.minMargin) &&
      options.minMargin >= 0 &&
      options.minMargin <=
        2 * Math.min(options.threshold, 1 - options.threshold),
  );
});

test("corpus validation preserves the full invented population without mutating it", () => {
  const corpus = inventedCorpus();
  const before = JSON.stringify(corpus);
  const result = imported.validateTrainingCorpus(corpus);
  assert.deepEqual(result.rows, corpus.cases);
  assert.deepEqual(result.counts, { fast: 1, strong: 1 });
  assert.equal(JSON.stringify(corpus), before);
  assert.notEqual(result.rows[0], corpus.cases[0]);
});

test("corpus validation accepts exactly 900 invented cases without sampling", () => {
  const corpus = {
    version: 1,
    cases: Array.from({ length: 900 }, (_, i) => ({
      id: `invented-${i}`,
      family: `invented-family-${i % 9}`,
      text: `Invented request number ${i}.`,
      label: i % 2 ? "strong" : "fast",
    })),
  };
  const result = imported.validateTrainingCorpus(corpus);
  assert.equal(result.rows.length, 900);
  assert.deepEqual(
    result.rows.map((row) => row.id),
    corpus.cases.map((row) => row.id),
  );
  assert.deepEqual(result.counts, { fast: 450, strong: 450 });
});

const invalidCorpusEdits = {
  version: (corpus) => {
    corpus.version = 2;
  },
  noCases: (corpus) => {
    corpus.cases = [];
  },
  oneCase: (corpus) => {
    corpus.cases.pop();
  },
  tooManyCases: (corpus) => {
    corpus.cases = new Array(901).fill(corpus.cases[0]);
  },
  duplicateId: (corpus) => {
    corpus.cases[1].id = corpus.cases[0].id;
  },
  duplicateText: (corpus) => {
    corpus.cases[1].text = corpus.cases[0].text;
  },
  emptyId: (corpus) => {
    corpus.cases[0].id = "";
  },
  oversizedHeadId: (corpus) => {
    corpus.cases[0].id = "x".repeat(257);
  },
  emptyFamily: (corpus) => {
    corpus.cases[0].family = "";
  },
  emptyText: (corpus) => {
    corpus.cases[0].text = "";
  },
  utf8ByteLimit: (corpus) => {
    corpus.cases[0].text = "é".repeat(16385);
  },
  unpairedTextSurrogate: (corpus) => {
    corpus.cases[0].text = "Invented malformed unicode \ud800";
  },
  unknownLabel: (corpus) => {
    corpus.cases[0].label = "uncertain";
  },
  onlyFast: (corpus) => {
    corpus.cases[1].label = "fast";
  },
  onlyStrong: (corpus) => {
    corpus.cases[0].label = "strong";
  },
};
for (const [name, edit] of Object.entries(invalidCorpusEdits)) {
  test(`rejects invalid invented corpus: ${name}`, () => {
    const corpus = inventedCorpus();
    edit(corpus);
    assert.throws(() => imported.validateTrainingCorpus(corpus));
  });
}

test("preparation pins exact source bytes, fixture bytes, model identity, and all rows", async () => {
  const sandbox = await harness();
  const module = await import(pathToFileURL(sandbox.script).href);
  const plan = await module.prepareTraining({
    output: sandbox.output,
    fixture: sandbox.fixture,
    python: sandbox.python,
  });
  const saved = JSON.parse(
    await readFile(resolve(sandbox.output, "plan.json"), "utf8"),
  );
  assert.deepEqual(saved, plan);
  assert.equal(plan.fixture.path, sandbox.fixture);
  assert.equal(plan.fixture.sha256, digest(await readFile(sandbox.fixture)));
  assert.deepEqual(plan.rows, inventedCorpus().cases);
  assert.equal(plan.population, 2);
  assert.equal(plan.featureCallsPlanned, 2);
  assert.deepEqual(plan.counts, { fast: 1, strong: 1 });
  assert.deepEqual(plan.headOptions, module.HEAD_OPTIONS);
  assert.deepEqual(plan.model, {
    id: "google/gemma-3-1b-it",
    revision: "dcc83ea841ab6100d6b47a070329e1ba4cf78752",
    weightSha256:
      "3d4ef8d71c14db7e448a09ebe891cfb6bf32c57a9b44499ae0d1c098e48516b6",
  });
  assert.equal(
    plan.workerPath,
    resolve(sandbox.root, "routing/feature_worker.py"),
  );
  assert.equal(plan.python, sandbox.python);
  const required = [
    sandbox.script,
    resolve(sandbox.root, "routing/feature_worker.py"),
    resolve(sandbox.root, "src/routing-head.ts"),
    resolve(sandbox.root, "dist/routing-head.js"),
    resolve(sandbox.root, "src/routing-runtime.ts"),
    resolve(sandbox.root, "dist/routing-runtime.js"),
    sandbox.python,
  ];
  for (const path of required) {
    const entry = plan.sources.find((entry) => entry.path === path);
    assert.ok(entry, `Missing source pin: ${path}`);
    const bytes = await readFile(path);
    assert.equal(entry.sha256, digest(bytes));
    assert.equal(entry.bytes, bytes.length);
  }
  assert.equal(plan.heldoutRead, false);
  assert.equal(plan.networkAllowed, false);
  assert.deepEqual((await readdir(sandbox.output)).sort(), [
    "plan.json",
    "plan.sha256",
    "prepare-claim.json",
  ]);
  assert.equal(
    (await readFile(resolve(sandbox.output, "plan.sha256"), "utf8")).trim(),
    digest(await readFile(resolve(sandbox.output, "plan.json"))),
  );
  assert.equal(
    (await stat(resolve(sandbox.output, "plan.json"))).mode & 0o777,
    0o600,
  );
  assert.equal((await stat(sandbox.output)).mode & 0o777, 0o700);
});

test("default preparation paths stay inside the injected sandbox", async () => {
  const sandbox = await harness();
  const module = await import(pathToFileURL(sandbox.script).href);
  const plan = await module.prepareTraining({ output: sandbox.output });
  assert.equal(plan.fixture.path, sandbox.fixture);
  assert.equal(plan.python, sandbox.python);
});

let validationFixture;
async function preparedValidationFixture() {
  validationFixture ??= (async () => {
    const sandbox = await harness();
    const module = await import(pathToFileURL(sandbox.script).href);
    const plan = await module.prepareTraining({ output: sandbox.output });
    return { module, plan, fixtureBytes: await readFile(sandbox.fixture) };
  })();
  return validationFixture;
}

test("pure plan validation crossbinds the frozen corpus without runtime calls", async () => {
  const { module, plan, fixtureBytes } = await preparedValidationFixture();
  const result = module.validateTrainingPlan(plan, fixtureBytes);
  assert.deepEqual(result, {
    rows: inventedCorpus().cases,
    counts: { fast: 1, strong: 1 },
  });
  assert.equal(blockedSpawn.mock.callCount(), 0);
});

const invalidPlanEdits = {
  schemaVersion: (plan) => {
    plan.schemaVersion = 2;
  },
  changedText: (plan) => {
    plan.rows[0].text = "An edited invented request.";
  },
  changedLabel: (plan) => {
    [plan.rows[0].label, plan.rows[1].label] = [
      plan.rows[1].label,
      plan.rows[0].label,
    ];
  },
  changedFamily: (plan) => {
    plan.rows[0].family = "Edited invented family";
  },
  changedRowOrder: (plan) => {
    plan.rows.reverse();
  },
  omittedRow: (plan) => {
    plan.rows.pop();
  },
  changedCounts: (plan) => {
    plan.counts.fast = 2;
  },
  changedPopulation: (plan) => {
    plan.population = 1;
  },
  changedFeatureCalls: (plan) => {
    plan.featureCallsPlanned = 1;
  },
  missingSource: (plan) => {
    plan.sources.pop();
  },
  extraSource: (plan) => {
    plan.sources.push({ ...plan.sources[0] });
  },
  reorderedSources: (plan) => {
    [plan.sources[0], plan.sources[1]] = [plan.sources[1], plan.sources[0]];
  },
  changedSourcePath: (plan) => {
    plan.sources[0].path += ".edited";
  },
  malformedSourceHash: (plan) => {
    plan.sources[0].sha256 = "not-a-sha256";
  },
  invalidSourceBytes: (plan) => {
    plan.sources[0].bytes = 0;
  },
  changedWorkerPath: (plan) => {
    plan.workerPath += ".edited";
  },
  changedPythonPath: (plan) => {
    plan.python += ".edited";
  },
  changedFixtureHash: (plan) => {
    plan.fixture.sha256 = "0".repeat(64);
  },
  changedModelId: (plan) => {
    plan.model.id = "invented/unapproved-model";
  },
  changedModelRevision: (plan) => {
    plan.model.revision = "0".repeat(40);
  },
  changedModelWeights: (plan) => {
    plan.model.weightSha256 = "0".repeat(64);
  },
  changedHeadOptions: (plan) => {
    plan.headOptions.threshold = 0.8;
  },
  heldoutEnabled: (plan) => {
    plan.heldoutRead = true;
  },
  networkEnabled: (plan) => {
    plan.networkAllowed = true;
  },
};
for (const [name, edit] of Object.entries(invalidPlanEdits)) {
  test(`pure plan validation rejects edited frozen metadata: ${name}`, async () => {
    const { module, plan, fixtureBytes } = await preparedValidationFixture();
    const changed = JSON.parse(JSON.stringify(plan));
    edit(changed);
    assert.throws(() => module.validateTrainingPlan(changed, fixtureBytes));
    assert.equal(blockedSpawn.mock.callCount(), 0);
  });
}

test("pure plan validation rejects changed fixture bytes even with the same case count", async () => {
  const { module, plan } = await preparedValidationFixture();
  const corpus = inventedCorpus();
  corpus.cases[0].text = "Changed invented fixture bytes.";
  assert.throws(() =>
    module.validateTrainingPlan(plan, Buffer.from(JSON.stringify(corpus))),
  );
  assert.equal(blockedSpawn.mock.callCount(), 0);
});

test("preparation refuses an existing plan and does not overwrite its bytes", async () => {
  const sandbox = await harness();
  const module = await import(pathToFileURL(sandbox.script).href);
  await module.prepareTraining({ output: sandbox.output });
  const original = await readFile(resolve(sandbox.output, "plan.json"));
  await assert.rejects(
    module.prepareTraining({ output: sandbox.output }),
    /plan_already_exists|EEXIST/,
  );
  assert.deepEqual(
    await readFile(resolve(sandbox.output, "plan.json")),
    original,
  );
});

test("concurrent preparation admits exactly one frozen plan", async () => {
  const sandbox = await harness();
  const module = await import(pathToFileURL(sandbox.script).href);
  const results = await Promise.allSettled([
    module.prepareTraining({ output: sandbox.output }),
    module.prepareTraining({ output: sandbox.output }),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const rejected = results.find((result) => result.status === "rejected");
  assert.match(rejected.reason.message, /plan_already_exists|EEXIST/);
  const saved = JSON.parse(
    await readFile(resolve(sandbox.output, "plan.json"), "utf8"),
  );
  assert.deepEqual(
    saved,
    results.find((result) => result.status === "fulfilled").value,
  );
});

test("invalid fixture and missing dependency never leave a reviewable plan", async () => {
  for (const missingDependency of [false, true]) {
    const sandbox = await harness();
    const module = await import(pathToFileURL(sandbox.script).href);
    if (missingDependency) await rm(sandbox.python);
    else await writeFile(sandbox.fixture, "{invalid JSON");
    await assert.rejects(module.prepareTraining({ output: sandbox.output }));
    await assert.rejects(
      access(resolve(sandbox.output, "plan.json")),
      (error) => error.code === "ENOENT",
    );
  }
});

test("injected CLI prepare performs metadata-only preparation without a worker", async () => {
  const sandbox = await harness();
  const argv = process.argv;
  const chunks = [];
  const stdout = mock.method(process.stdout, "write", (chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    process.argv = [
      process.execPath,
      sandbox.script,
      "--prepare",
      "--output",
      sandbox.output,
      "--fixture",
      sandbox.fixture,
      "--python",
      sandbox.python,
    ];
    await import(pathToFileURL(sandbox.script).href);
  } finally {
    process.argv = argv;
    stdout.mock.restore();
  }
  const result = JSON.parse(chunks.find((chunk) => chunk.startsWith("{")));
  assert.equal(result.prepared, true);
  assert.equal(result.population, 2);
  assert.deepEqual(result.counts, { fast: 1, strong: 1 });
  assert.equal(result.model.id, "google/gemma-3-1b-it");
  assert.deepEqual((await readdir(sandbox.output)).sort(), [
    "plan.json",
    "plan.sha256",
    "prepare-claim.json",
  ]);
  assert.equal(blockedSpawn.mock.callCount(), 0);
});

test("injected CLI requires exactly one action before preparation", async () => {
  for (const actions of [[], ["--prepare", "--run"]]) {
    const sandbox = await harness();
    const argv = process.argv;
    try {
      process.argv = [
        process.execPath,
        sandbox.script,
        "--output",
        sandbox.output,
        ...actions,
      ];
      await assert.rejects(
        import(pathToFileURL(sandbox.script).href),
        /Usage:/,
      );
    } finally {
      process.argv = argv;
    }
    await assert.rejects(
      access(resolve(sandbox.output, "plan.json")),
      (error) => error.code === "ENOENT",
    );
    assert.equal(blockedSpawn.mock.callCount(), 0);
  }
});
