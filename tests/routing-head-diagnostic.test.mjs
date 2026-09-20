import assert from "node:assert/strict";
import { test, after, mock } from "node:test";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  realpath,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

// CPU-only invented data. Any accidental feature-worker launch is blocked.
const blockedSpawn = mock.method(childProcess, "spawn", () => {
  throw new Error("workers_forbidden_in_cpu_tests");
});
syncBuiltinESMExports();
const scriptSource = await readFile(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../scripts/routing-head-diagnostic.mjs",
  ),
  "utf8",
);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const roots = [];
const fixture = () => ({
  version: 1,
  cases: Array.from({ length: 60 }, (_, i) => ({
    id: `invented-${i}`,
    prompt: `Invented request ${i}.`,
    ...(i % 3 === 0
      ? {
          previousExchange: {
            user: `Prior invented question ${i}`,
            assistant: "Prior invented answer",
            expected: "HOST_PRIOR_SECRET",
          },
        }
      : {}),
    label: i < 20 ? "easy" : i < 40 ? "hard" : "unknown",
    expected: "HOST_GOLD_SECRET",
    hostOnly: "HOST_METADATA_SECRET",
  })),
});
async function harness() {
  const root = await realpath(
    await mkdtemp(resolve(tmpdir(), "jev-head-diagnostic-cpu-")),
  );
  roots.push(root);
  await Promise.all(
    ["scripts", "src", "dist", "routing", "fixtures", ".build"].map((path) =>
      mkdir(resolve(root, path), { recursive: true }),
    ),
  );
  const script = resolve(root, "scripts/routing-head-diagnostic.mjs"),
    fixturePath = resolve(root, "fixtures/invented.json"),
    headFile = resolve(root, "invented-head.json"),
    python = resolve(root, ".build/invented-python"),
    output = resolve(root, "prepared");
  const headBytes =
    JSON.stringify({
      version: 1,
      dimension: 1152,
      threshold: 0.1,
      minMargin: 0.02,
      calibration: "uncalibrated",
      invented: true,
    }) + "\n";
  await Promise.all([
    writeFile(resolve(root, "package.json"), '{"type":"module"}\n'),
    writeFile(
      resolve(root, "package-lock.json"),
      '{"lockfileVersion":3,"invented":true}\n',
    ),
    writeFile(script, scriptSource),
    writeFile(fixturePath, JSON.stringify(fixture())),
    writeFile(headFile, headBytes),
    writeFile(python, "Never executable. Invented Python pin."),
    ...[
      "routing/feature_worker.py",
      "src/routing-runtime.ts",
      "src/routing-head.ts",
      "dist/routing-head.js",
    ].map((path) =>
      writeFile(
        resolve(root, path),
        "// Invented source hash placeholder. Never executed.\n",
      ),
    ),
    writeFile(
      resolve(root, "dist/routing-runtime.js"),
      'export function createRoutingRuntime(){throw new Error("actual_runtime_forbidden_in_cpu_tests");}\n',
    ),
  ]);
  const module = await import(pathToFileURL(script).href),
    testHeadSha256 = hash(headBytes);
  const options = {
    output,
    fixture: fixturePath,
    headFile,
    python,
    forceEncoderCall: true,
  };
  return {
    root,
    module,
    options,
    output,
    fixturePath,
    headFile,
    python,
    headBytes: Buffer.from(headBytes),
    testHeadSha256,
  };
}
async function prepared() {
  const sandbox = await harness();
  sandbox.plan = await sandbox.module.prepareDiagnostic(sandbox.options, {
    testHeadSha256: sandbox.testHeadSha256,
  });
  return sandbox;
}
function injected(
  sandbox,
  {
    failAt = -1,
    badCleanup = false,
    badResult,
    onCall,
    onDispose,
    disposeFailure = false,
    throwStatus = false,
  } = {},
) {
  const calls = [];
  let factoryCalls = 0,
    disposeCalls = 0,
    active = 0,
    peak = 0;
  const status = {
    state: "cold",
    modelReady: false,
    activeRequests: 0,
    queuedRequests: 0,
    submittedRequests: 0,
    completedRequests: 0,
    fallbackRequests: 0,
  };
  const expectedProvenance = (workerSourceSha256) => ({
    invented: true,
    workerSourceSha256,
  });
  return {
    calls,
    get factoryCalls() {
      return factoryCalls;
    },
    get disposeCalls() {
      return disposeCalls;
    },
    get peak() {
      return peak;
    },
    status,
    dependencies: {
      forceEncoderCall: true,
      testHeadSha256: sandbox.testHeadSha256,
      expectedProvenance,
      createRuntime(options) {
        factoryCalls++;
        assert.equal(hash(options.headArtifact), sandbox.testHeadSha256);
        return {
          get status() {
            if (throwStatus) throw new Error("synthetic_status_failed");
            return { ...status };
          },
          async classify(input, signal) {
            const ordinal = calls.length;
            calls.push(input);
            status.submittedRequests++;
            active++;
            peak = Math.max(peak, active);
            status.activeRequests = active;
            try {
              assert.equal(active, 1, "Classification must be serial");
              assert.equal(input.essentialFactsAvailable, true);
              if (ordinal === failAt) {
                status.state = "failed";
                const failure = new Error("synthetic_failure");
                failure.code = "synthetic_failure";
                throw failure;
              }
              await onCall?.(input, signal, ordinal);
              const cold = !status.modelReady;
              status.modelReady = true;
              status.state = "ready";
              status.completedRequests++;
              const result = {
                decision: "fast",
                confidence: 0.98,
                calibration: "uncalibrated",
                reason: "head-score",
                fastScore: 0.98,
                strongScore: 0.02,
                artifactId: options.artifactId,
                artifactSha256: options.artifactSha256,
                qualificationSha256: options.qualificationSha256,
                workerSha256: options.workerSha256,
                inputTokens: 10,
                featureElapsedMs: cold ? 2000 : 4,
                operationalElapsedMs: cold ? 2100 : 5,
                provenance: expectedProvenance(options.workerSha256),
              };
              return badResult ? badResult(result) : result;
            } finally {
              active--;
              status.activeRequests = active;
            }
          },
          async dispose() {
            disposeCalls++;
            await onDispose?.();
            await new Promise((resolveImmediate) =>
              setImmediate(resolveImmediate),
            );
            status.state = "disposed";
            status.activeRequests = badCleanup ? 1 : 0;
            if (disposeFailure) throw new Error("synthetic_cleanup_failed");
          },
        };
      },
    },
  };
}
after(async () => {
  const attempts = blockedSpawn.mock.callCount();
  blockedSpawn.mock.restore();
  syncBuiltinESMExports();
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
  assert.equal(attempts, 0);
});

test("imports without a runtime build and rejects absent forced flag before any file read", async () => {
  const sandbox = await harness();
  await rm(resolve(sandbox.root, "dist"), { recursive: true });
  const fresh = resolve(sandbox.root, "scripts/another-diagnostic.mjs");
  await writeFile(fresh, scriptSource);
  const module = await import(pathToFileURL(fresh).href);
  await assert.rejects(
    module.prepareDiagnostic({
      output: resolve(sandbox.root, "never-created"),
    }),
    /explicit_lab_encoder_flag_required/,
  );
  await assert.rejects(
    module.runDiagnostic(resolve(sandbox.root, "not-a-directory")),
    /explicit_lab_encoder_flag_required/,
  );
  assert.equal((await readdir(sandbox.root)).includes("never-created"), false);
});
test("encoder serialization uses only actual prompt and projected prior text", async () => {
  const { module } = await harness();
  assert.equal(
    module.diagnosticText(fixture().cases[0]),
    "Previous exchange:\nUser: Prior invented question 0\nAssistant: Prior invented answer\n\nCurrent request:\nInvented request 0.",
  );
  assert.equal(
    module.diagnosticText(fixture().cases[1]),
    "Invented request 1.",
  );
  for (const row of module.diagnosticRows(fixture()))
    assert.doesNotMatch(row.text, /HOST_|"label"|"expected"/);
});
test("preparation freezes the exact 180-call schedule and all declared pins", async () => {
  const sandbox = await prepared(),
    plan = sandbox.plan;
  assert.equal(plan.rows.length, 60);
  assert.equal(plan.schedule.length, 180);
  assert.deepEqual(
    plan.schedule.map((row) => row.id),
    [...Array(3)].flatMap(() => fixture().cases.map((row) => row.id)),
  );
  assert.deepEqual(
    plan.schedule.map((row) => row.phase),
    ["cold", "warm-1", "warm-2"].flatMap((phase) => new Array(60).fill(phase)),
  );
  assert.equal(plan.productionQualified, false);
  assert.equal(plan.promoted, false);
  assert.equal(plan.featureCacheUsed, false);
  assert.equal(plan.generationCallsPlanned, 0);
  assert.equal(plan.head.sha256, sandbox.testHeadSha256);
  assert.deepEqual(plan.hostRuntime, {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  });
  assert.ok(
    plan.sources.some(
      (source) => source.path === resolve(sandbox.root, "package-lock.json"),
    ),
  );
  assert.equal(
    (await readFile(resolve(sandbox.output, "plan.sha256"), "utf8")).trim(),
    hash(await readFile(resolve(sandbox.output, "plan.json"))),
  );
  for (const source of plan.sources) {
    const bytes = await readFile(source.path);
    assert.equal(source.bytes, bytes.length);
    assert.equal(source.sha256, hash(bytes));
  }
  assert.doesNotMatch(
    JSON.stringify(plan.rows),
    /HOST_GOLD_SECRET|HOST_METADATA_SECRET|HOST_PRIOR_SECRET/,
  );
});
test("actual CLI pin cannot be overridden and synthetic inputs require an injected runtime", async () => {
  const sandbox = await harness();
  await assert.rejects(
    sandbox.module.prepareDiagnostic(sandbox.options),
    /frozen_head_mismatch/,
  );
  const second = await prepared();
  await assert.rejects(
    second.module.runDiagnostic(second.output, {
      forceEncoderCall: true,
      testHeadSha256: second.testHeadSha256,
    }),
    /test_runtime_injection_required/,
  );
});
test("concurrent preparations admit one frozen plan", async () => {
  const sandbox = await harness();
  const results = await Promise.allSettled(
    [0, 1].map(() =>
      sandbox.module.prepareDiagnostic(sandbox.options, {
        testHeadSha256: sandbox.testHeadSha256,
      }),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    1,
  );
});
test("one runtime executes every cold and warm input serially without a feature cache", async () => {
  const sandbox = await prepared(),
    fake = injected(sandbox),
    originalFetch = globalThis.fetch;
  const result = await sandbox.module.runDiagnostic(
    sandbox.output,
    fake.dependencies,
  );
  assert.equal(result.status, "lab_completed");
  assert.equal(fake.factoryCalls, 1);
  assert.equal(fake.disposeCalls, 1);
  assert.equal(fake.peak, 1);
  assert.equal(fake.calls.length, 180);
  assert.deepEqual(
    fake.calls.map((input) => input.text),
    [...Array(3)].flatMap(() => sandbox.plan.rows.map((row) => row.text)),
  );
  assert.ok(
    fake.calls.every(
      (input) =>
        Object.keys(input).sort().join(",") === "essentialFactsAvailable,text",
    ),
  );
  assert.equal(result.records.filter((row) => row.coldStart).length, 1);
  assert.equal(result.summary.coldStartupOperationalMs.samples, 1);
  assert.equal(result.summary.coldStartupOperationalMs.p95, 2100);
  assert.equal(result.summary.initialPassNonStartupOperationalMs.samples, 59);
  assert.equal(result.summary.warmDescriptiveOperationalMs.samples, 120);
  for (const phase of Object.values(result.summary.phases)) {
    assert.equal(phase.completed, 60);
    assert.equal(phase.errors, 0);
    assert.equal(phase.unrun, 0);
    assert.equal(phase.rawEasyFast, 20);
    assert.equal(phase.rawHardFast, 20);
    assert.equal(phase.rawUnknownFast, 20);
  }
  assert.equal(result.productionQualified, false);
  assert.equal(result.summary.productionQualified, false);
  assert.equal(result.summary.completenessProof, false);
  assert.equal(result.cleanup.awaited, true);
  assert.equal(result.cleanup.status.state, "disposed");
  assert.equal(result.cleanup.status.activeRequests, 0);
  assert.equal(result.cleanup.status.queuedRequests, 0);
  assert.equal(globalThis.fetch, originalFetch);
  assert.deepEqual(
    JSON.parse(await readFile(resolve(sandbox.output, "result.json"), "utf8")),
    result,
  );
  await assert.rejects(
    sandbox.module.runDiagnostic(sandbox.output, fake.dependencies),
    /EEXIST/,
  );
  assert.equal(fake.calls.length, 180);
});
test("a failed encoder call is retained and every remaining scheduled cell stays unrun", async () => {
  const sandbox = await prepared(),
    fake = injected(sandbox, { failAt: 2 });
  const result = await sandbox.module.runDiagnostic(
    sandbox.output,
    fake.dependencies,
  );
  assert.equal(result.status, "lab_failed");
  assert.equal(fake.calls.length, 3);
  assert.equal(result.records.length, 180);
  assert.equal(
    result.records.filter((row) => row.status === "completed").length,
    2,
  );
  assert.equal(
    result.records.filter((row) => row.status === "error").length,
    1,
  );
  assert.equal(
    result.records.filter((row) => row.status === "unrun").length,
    177,
  );
  assert.equal(result.records[2].error, "synthetic_failure");
  assert.equal(fake.disposeCalls, 1);
  assert.equal(result.productionQualified, false);
});

test("concurrent run claims admit one runtime and exactly one full schedule", async () => {
  const sandbox = await prepared(),
    fake = injected(sandbox);
  const results = await Promise.allSettled(
    [0, 1].map(() =>
      sandbox.module.runDiagnostic(sandbox.output, fake.dependencies),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    1,
  );
  assert.equal(fake.factoryCalls, 1);
  assert.equal(fake.calls.length, 180);
});
test("an existing foreign result is never overwritten and no runtime is created", async () => {
  const sandbox = await prepared(),
    fake = injected(sandbox),
    foreign = Buffer.from("foreign result bytes\n"),
    originalFetch = globalThis.fetch,
    interruptListeners = process.listenerCount("SIGINT"),
    terminateListeners = process.listenerCount("SIGTERM");
  await writeFile(resolve(sandbox.output, "result.json"), foreign);
  const result = await sandbox.module.runDiagnostic(
    sandbox.output,
    fake.dependencies,
  );
  assert.equal(result.status, "lab_failed");
  assert.equal(result.errors[0].code, "EEXIST");
  assert.equal(fake.factoryCalls, 0);
  assert.equal(fake.calls.length, 0);
  assert.equal(
    result.records.filter((row) => row.status === "unrun").length,
    180,
  );
  assert.deepEqual(
    await readFile(resolve(sandbox.output, "result.json")),
    foreign,
  );
  assert.equal(globalThis.fetch, originalFetch);
  assert.equal(process.listenerCount("SIGINT"), interruptListeners);
  assert.equal(process.listenerCount("SIGTERM"), terminateListeners);
});
test("throwing status getters retain cleanup uncertainty and restore globals before persistence", async () => {
  const sandbox = await prepared(),
    fake = injected(sandbox, { throwStatus: true }),
    originalFetch = globalThis.fetch,
    interruptListeners = process.listenerCount("SIGINT"),
    terminateListeners = process.listenerCount("SIGTERM");
  const result = await sandbox.module.runDiagnostic(
    sandbox.output,
    fake.dependencies,
  );
  assert.equal(result.status, "lab_failed");
  assert.equal(fake.factoryCalls, 1);
  assert.equal(fake.calls.length, 0);
  assert.equal(fake.disposeCalls, 1);
  assert.equal(result.cleanup.awaited, true);
  assert.equal(result.cleanup.confirmed, false);
  assert.equal(result.cleanup.status, null);
  assert.equal(result.cleanup.error, "runtime_cleanup_unconfirmed");
  assert.equal(globalThis.fetch, originalFetch);
  assert.equal(process.listenerCount("SIGINT"), interruptListeners);
  assert.equal(process.listenerCount("SIGTERM"), terminateListeners);
  assert.deepEqual(
    JSON.parse(await readFile(resolve(sandbox.output, "result.json"), "utf8")),
    result,
  );
});
for (const [name, badResult] of Object.entries({
  missingScore: (row) => ({ ...row, fastScore: null }),
  fallback: (row) => ({ ...row, reason: "essential-facts-not-verified" }),
  wrongHead: (row) => ({ ...row, artifactSha256: "0".repeat(64) }),
  wrongProvenance: (row) => ({ ...row, provenance: {} }),
  invalidLatency: (row) => ({ ...row, operationalElapsedMs: NaN }),
})) {
  test(`rejects unusable raw-head observation: ${name}`, async () => {
    const sandbox = await prepared(),
      fake = injected(sandbox, { badResult });
    const result = await sandbox.module.runDiagnostic(
      sandbox.output,
      fake.dependencies,
    );
    assert.equal(result.status, "lab_failed");
    assert.equal(result.records[0].status, "error");
    assert.equal(
      result.records.filter((row) => row.status === "unrun").length,
      179,
    );
    assert.equal(fake.disposeCalls, 1);
  });
}
test("network calls are denied and fetch is restored after cleanup", async () => {
  const sandbox = await prepared(),
    originalFetch = globalThis.fetch;
  const fake = injected(sandbox, {
    failAt: 1,
    onCall: async () => {
      await assert.rejects(
        fetch("https://invented.invalid"),
        /diagnostic_network_forbidden/,
      );
    },
  });
  await sandbox.module.runDiagnostic(sandbox.output, fake.dependencies);
  assert.equal(globalThis.fetch, originalFetch);
});
test("external cancellation stops the current call and awaits actual disposal", async () => {
  const sandbox = await prepared(),
    controller = new AbortController();
  let entered;
  const ready = new Promise((resolveReady) => {
    entered = resolveReady;
  });
  const fake = injected(sandbox, {
    onCall: (_input, signal) =>
      new Promise((_resolve, reject) => {
        entered();
        signal.addEventListener(
          "abort",
          () => reject(new Error("diagnostic_cancelled")),
          { once: true },
        );
      }),
  });
  const pending = sandbox.module.runDiagnostic(sandbox.output, {
    ...fake.dependencies,
    signal: controller.signal,
  });
  await ready;
  controller.abort();
  const result = await pending;
  assert.equal(result.status, "lab_failed");
  assert.equal(fake.calls.length, 1);
  assert.equal(
    result.records.filter((row) => row.status === "unrun").length,
    179,
  );
  assert.equal(result.cleanup.awaited, true);
  assert.equal(result.cleanup.status.activeRequests, 0);
});
test("a hung call reaches the frozen deadline without waiting for real time", async (context) => {
  const sandbox = await prepared();
  let entered;
  const ready = new Promise((resolveReady) => {
    entered = resolveReady;
  });
  const fake = injected(sandbox, {
    onCall: (_input, signal) =>
      new Promise((_resolve, reject) => {
        entered();
        signal.addEventListener(
          "abort",
          () => reject(new Error("diagnostic_cancelled")),
          { once: true },
        );
      }),
  });
  context.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = sandbox.module.runDiagnostic(
      sandbox.output,
      fake.dependencies,
    );
    await ready;
    context.mock.timers.tick(
      sandbox.module.DIAGNOSTIC_OPTIONS.coldRequestMs + 1,
    );
    const result = await pending;
    assert.equal(result.status, "lab_failed");
    assert.equal(result.records[0].error, "diagnostic_timeout");
    assert.equal(result.cleanup.awaited, true);
  } finally {
    context.mock.timers.reset();
  }
});

test("a hung dispose reaches its cleanup deadline and cannot complete the LAB", async (context) => {
  const sandbox = await prepared();
  let entered;
  const reachedDispose = new Promise((resolveReached) => {
    entered = resolveReached;
  });
  const fake = injected(sandbox, {
    onDispose: () => {
      entered();
      return new Promise(() => {});
    },
  });
  context.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = sandbox.module.runDiagnostic(
      sandbox.output,
      fake.dependencies,
    );
    await reachedDispose;
    context.mock.timers.tick(sandbox.module.DIAGNOSTIC_OPTIONS.cleanupMs + 1);
    const result = await pending;
    assert.equal(result.status, "lab_failed");
    assert.equal(
      result.records.filter((row) => row.status === "completed").length,
      180,
    );
    assert.equal(result.cleanup.awaited, false);
    assert.equal(result.cleanup.confirmed, false);
    assert.equal(result.cleanup.error, "diagnostic_timeout");
  } finally {
    context.mock.timers.reset();
  }
});
for (const [name, options] of Object.entries({
  pendingRequests: { badCleanup: true },
  disposalFailure: { disposeFailure: true },
})) {
  test(`cleanup uncertainty disqualifies LAB completion: ${name}`, async () => {
    const sandbox = await prepared(),
      fake = injected(sandbox, options);
    const result = await sandbox.module.runDiagnostic(
      sandbox.output,
      fake.dependencies,
    );
    assert.equal(result.status, "lab_failed");
    assert.equal(
      result.records.filter((row) => row.status === "completed").length,
      180,
    );
    assert.equal(result.cleanup.awaited, !options.disposeFailure);
    assert.equal(result.cleanup.confirmed, false);
    assert.ok(result.cleanup.error);
    assert.equal(result.productionQualified, false);
  });
}
test("plan, fixture, head and source edits fail before the runtime factory is called", async () => {
  for (const which of ["plan", "fixture", "head", "source"]) {
    const sandbox = await prepared(),
      fake = injected(sandbox);
    const path =
      which === "plan"
        ? resolve(sandbox.output, "plan.json")
        : which === "fixture"
          ? sandbox.fixturePath
          : which === "head"
            ? sandbox.headFile
            : sandbox.python;
    await writeFile(path, (await readFile(path, "utf8")) + " ");
    await assert.rejects(
      sandbox.module.runDiagnostic(sandbox.output, fake.dependencies),
    );
    assert.equal(fake.factoryCalls, 0);
    assert.equal(fake.calls.length, 0);
  }
});
test("pure validation rejects edited schedule, host labels, options, pins and head settings", async () => {
  const sandbox = await prepared(),
    fixtureBytes = await readFile(sandbox.fixturePath);
  for (const edit of [
    (plan) => {
      plan.schedule.pop();
    },
    (plan) => {
      plan.rows[0].label = "hard";
    },
    (plan) => {
      plan.rows[0].text += "HOST_INJECTED";
    },
    (plan) => {
      plan.options.phases.reverse();
    },
    (plan) => {
      plan.sources.pop();
    },
    (plan) => {
      plan.productionQualified = true;
    },
    (plan) => {
      plan.forceEncoderCall = false;
    },
    (plan) => {
      plan.head.threshold = 0.9;
    },
    (plan) => {
      plan.featureCacheUsed = true;
    },
    (plan) => {
      plan.hostRuntime.node = "invented-other-node";
    },
  ]) {
    const plan = JSON.parse(JSON.stringify(sandbox.plan));
    edit(plan);
    assert.throws(() =>
      sandbox.module.validateDiagnosticPlan(
        plan,
        fixtureBytes,
        sandbox.headBytes,
        { testHeadSha256: sandbox.testHeadSha256 },
      ),
    );
  }
});
test("invalid invented populations and prior/text fields fail pure validation", async () => {
  const { module } = await harness();
  for (const edit of [
    (value) => {
      value.cases.pop();
    },
    (value) => {
      value.cases[0].id = value.cases[1].id;
    },
    (value) => {
      value.cases[0].label = "fast";
    },
    (value) => {
      value.cases[0].prompt = "\ud800";
    },
    (value) => {
      value.cases[0].previousExchange.user = 1;
    },
    (value) => {
      value.cases[0].prompt = "x".repeat(32769);
    },
  ]) {
    const value = fixture();
    edit(value);
    assert.throws(() => module.diagnosticRows(value));
  }
});
