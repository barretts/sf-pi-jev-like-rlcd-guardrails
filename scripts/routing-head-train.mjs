import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const MODEL = "google/gemma-3-1b-it";
const REVISION = "dcc83ea841ab6100d6b47a070329e1ba4cf78752";
const WEIGHTS =
  "3d4ef8d71c14db7e448a09ebe891cfb6bf32c57a9b44499ae0d1c098e48516b6";
const canonical = (value) =>
  JSON.stringify(value, function (_key, entry) {
    return entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.keys(entry)
            .sort()
            .map((key) => [key, entry[key]]),
        )
      : entry;
  });
const sourcePaths = (python) => [
  fileURLToPath(import.meta.url),
  resolve(root, "routing/feature_worker.py"),
  resolve(root, "src/routing-head.ts"),
  resolve(root, "dist/routing-head.js"),
  resolve(root, "src/routing-runtime.ts"),
  resolve(root, "dist/routing-runtime.js"),
  python,
];
// The head's threshold is the strong-score cutoff: .1 requires >.91 fast score
// outside the .02 abstention band. These are uncalibrated decision scores.
export const HEAD_OPTIONS = Object.freeze({
  l2: 0.001,
  maxIterations: 300,
  tolerance: 1e-7,
  standardize: true,
  threshold: 0.1,
  minMargin: 0.02,
});

export function validateTrainingCorpus(value) {
  if (
    value?.version !== 1 ||
    !Array.isArray(value.cases) ||
    value.cases.length < 2 ||
    value.cases.length > 900
  )
    throw new Error("invalid_training_corpus");
  const ids = new Set();
  const texts = new Set();
  const counts = { fast: 0, strong: 0 };
  const rows = value.cases.map((row) => {
    if (
      !row ||
      typeof row.id !== "string" ||
      !row.id ||
      row.id.length > 256 ||
      ids.has(row.id) ||
      typeof row.family !== "string" ||
      !row.family ||
      typeof row.text !== "string" ||
      !row.text ||
      row.text.length > 32768 ||
      !row.text.isWellFormed() ||
      Buffer.byteLength(row.text) > 32768 ||
      texts.has(row.text) ||
      !["fast", "strong"].includes(row.label)
    )
      throw new Error("invalid_training_row");
    ids.add(row.id);
    texts.add(row.text);
    counts[row.label]++;
    return { id: row.id, family: row.family, text: row.text, label: row.label };
  });
  if (!counts.fast || !counts.strong)
    throw new Error("training_requires_both_labels");
  return { rows, counts };
}

const save = async (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const exclusiveSave = async (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });

export async function prepareTraining({
  output,
  fixture = resolve(root, "fixtures/routing-train.json"),
  python = resolve(root, ".build/rfdt-venv/bin/python"),
}) {
  output = resolve(output);
  fixture = resolve(fixture);
  python = resolve(python);
  await mkdir(output, { recursive: true, mode: 0o700 });
  await writeFile(
    resolve(output, "prepare-claim.json"),
    JSON.stringify({ startedAt: new Date().toISOString() }) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  const fixtureBytes = await readFile(fixture);
  const { rows, counts } = validateTrainingCorpus(JSON.parse(fixtureBytes));
  const paths = sourcePaths(python);
  const sources = [];
  for (const path of paths) {
    const bytes = await readFile(path);
    sources.push({ path, bytes: bytes.length, sha256: digest(bytes) });
  }
  const plan = {
    schemaVersion: 1,
    purpose:
      "Machine-authored TRAIN only; one frozen Google feature extraction, then cached CPU head fitting",
    createdAt: new Date().toISOString(),
    fixture: { path: fixture, sha256: digest(fixtureBytes) },
    python,
    workerPath: resolve(root, "routing/feature_worker.py"),
    sources,
    model: { id: MODEL, revision: REVISION, weightSha256: WEIGHTS },
    headOptions: HEAD_OPTIONS,
    population: rows.length,
    counts,
    rows,
    featureCallsPlanned: rows.length,
    heldoutRead: false,
    networkAllowed: false,
  };
  await exclusiveSave(resolve(output, "plan.json"), plan);
  await writeFile(
    resolve(output, "plan.sha256"),
    digest(await readFile(resolve(output, "plan.json"))) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  return plan;
}

function validateProvenance(p, expected) {
  if (canonical(p) !== canonical(expected))
    throw new Error("worker_provenance_mismatch");
}

export function validateTrainingPlan(plan, fixtureBytes) {
  if (
    !plan ||
    plan.schemaVersion !== 1 ||
    !Array.isArray(plan.sources) ||
    typeof plan.python !== "string" ||
    typeof plan.fixture?.path !== "string"
  )
    throw new Error("invalid_training_plan");
  const expectedPaths = sourcePaths(resolve(plan.python));
  if (
    plan.workerPath !== resolve(root, "routing/feature_worker.py") ||
    plan.sources.length !== expectedPaths.length ||
    plan.sources.some(
      (entry, i) =>
        entry.path !== expectedPaths[i] ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 1 ||
        !/^[a-f0-9]{64}$/.test(entry.sha256),
    )
  )
    throw new Error("training_source_inventory_mismatch");
  if (digest(fixtureBytes) !== plan.fixture.sha256)
    throw new Error("training_fixture_drift");
  const corpus = validateTrainingCorpus(JSON.parse(fixtureBytes));
  if (
    JSON.stringify(corpus.rows) !== JSON.stringify(plan.rows) ||
    JSON.stringify(corpus.counts) !== JSON.stringify(plan.counts) ||
    plan.population !== corpus.rows.length ||
    plan.featureCallsPlanned !== corpus.rows.length
  )
    throw new Error("training_corpus_binding_mismatch");
  if (
    JSON.stringify(plan.headOptions) !== JSON.stringify(HEAD_OPTIONS) ||
    plan.model?.id !== MODEL ||
    plan.model?.revision !== REVISION ||
    plan.model?.weightSha256 !== WEIGHTS ||
    plan.heldoutRead !== false ||
    plan.networkAllowed !== false
  )
    throw new Error("training_plan_drift");
  return corpus;
}

export async function runTraining(output) {
  output = resolve(output);
  const planBytes = await readFile(resolve(output, "plan.json"));
  const plan = JSON.parse(planBytes);
  if (
    (await readFile(resolve(output, "plan.sha256"), "utf8")).trim() !==
    digest(planBytes)
  )
    throw new Error("training_plan_hash_mismatch");
  const fixtureBytes = await readFile(plan.fixture.path);
  validateTrainingPlan(plan, fixtureBytes);
  for (const entry of plan.sources)
    if (digest(await readFile(entry.path)) !== entry.sha256)
      throw new Error("training_source_drift");
  const [
    { fitRoutingHead, validateRoutingHeadArtifact },
    { routingFeatureProvenance },
  ] = await Promise.all([
    import("../dist/routing-head.js"),
    import("../dist/routing-runtime.js"),
  ]);
  for (const entry of plan.sources)
    if (digest(await readFile(entry.path)) !== entry.sha256)
      throw new Error("training_source_drift");
  const workerSha = plan.sources.find(
    (x) => x.path === plan.workerPath,
  )?.sha256;
  const expectedProvenance = routingFeatureProvenance(workerSha);
  const journal = {
    schemaVersion: 1,
    planSha256: digest(planBytes),
    startedAt: new Date().toISOString(),
    status: "extracting",
    scheduled: plan.rows.length,
    completed: 0,
    errors: [],
    unrun: plan.rows.length,
    featureCalls: 0,
    fitFeatureCalls: 0,
    child: null,
  };
  await exclusiveSave(resolve(output, "journal.json"), journal);
  const childHome = resolve(output, "worker-home");
  await mkdir(childHome, { recursive: true, mode: 0o700 });
  const child = spawn(plan.python, ["-I", "-u", plan.workerPath], {
    cwd: root,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: "/usr/bin:/bin:/opt/homebrew/bin",
      HOME: childHome,
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      PYTHONIOENCODING: "utf-8",
      HF_HUB_OFFLINE: "1",
      HF_HUB_DISABLE_IMPLICIT_TOKEN: "1",
      TRANSFORMERS_OFFLINE: "1",
    },
  });
  journal.child = {
    pid: child.pid ?? null,
    processGroup: child.pid ?? null,
    exitCode: null,
    signal: null,
    stdoutClosed: false,
    stderrClosed: false,
  };
  let buffer = Buffer.alloc(0),
    waiting = null,
    fatal = null,
    stderrBytes = 0;
  const stderrHasher = createHash("sha256");
  const lines = [];
  const deliver = (record) => {
    if (waiting) {
      const current = waiting;
      waiting = null;
      clearTimeout(current.timer);
      current.resolve(record);
    } else if (lines.length < 2) lines.push(record);
    else fail("unexpected_worker_output");
  };
  const fail = (code) => {
    if (fatal) return;
    fatal = new Error(code);
    if (waiting) {
      clearTimeout(waiting.timer);
      waiting.reject(fatal);
      waiting = null;
    }
  };
  child.on("error", () => fail("worker_spawn_failed"));
  child.stdin.on("error", () => fail("worker_input_stream_failed"));
  child.stdout.on("error", () => fail("worker_output_stream_failed"));
  child.stderr.on("error", () => fail("worker_error_stream_failed"));
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 1024 * 1024) {
      fail("worker_output_limit");
      return;
    }
    let idx;
    while ((idx = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0, idx);
      buffer = buffer.subarray(idx + 1);
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
        deliver(JSON.parse(text));
      } catch {
        fail("invalid_worker_output");
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    stderrHasher.update(chunk);
  });
  child.stdout.on("end", () => {
    journal.child.stdoutClosed = true;
    if (buffer.length) fail("incomplete_worker_output");
  });
  child.stderr.on("end", () => {
    journal.child.stderrClosed = true;
  });
  const closed = new Promise((resolveClose) =>
    child.on("close", (code, signal) => {
      journal.child.exitCode = code;
      journal.child.signal = signal;
      if (journal.status === "extracting") fail("worker_exited_early");
      resolveClose();
    }),
  );
  const next = (timeout) => {
    if (fatal) return Promise.reject(fatal);
    if (lines.length) return Promise.resolve(lines.shift());
    return new Promise((resolveNext, reject) => {
      waiting = {
        resolve: resolveNext,
        reject,
        timer: setTimeout(() => fail("worker_timeout"), timeout),
      };
    });
  };
  const kill = () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    }
  };
  const controller = new AbortController();
  const interrupt = () => {
    controller.abort();
    fail("training_interrupted");
    kill();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const features = [];
  try {
    await save(resolve(output, "journal.json"), journal);
    const ready = await next(120000);
    if (ready.type !== "ready" || ready.dimension !== 1152)
      throw new Error("invalid_worker_ready");
    validateProvenance(ready.provenance, expectedProvenance);
    journal.provenance = ready.provenance;
    for (let i = 0; i < plan.rows.length; i++) {
      controller.signal.throwIfAborted();
      const row = plan.rows[i];
      const start = performance.now();
      journal.featureCalls++;
      child.stdin.write(JSON.stringify({ id: row.id, text: row.text }) + "\n");
      const response = await next(i === 0 ? 120000 : 10000);
      if (
        response.id !== row.id ||
        response.error ||
        response.modelId !== MODEL ||
        response.revision !== REVISION ||
        !Array.isArray(response.features) ||
        response.features.length !== 1152 ||
        response.features.some(
          (x) => typeof x !== "number" || !Number.isFinite(x),
        ) ||
        !Number.isSafeInteger(response.inputTokens) ||
        response.inputTokens < 1 ||
        !Number.isFinite(response.elapsedMs) ||
        response.elapsedMs < 0
      )
        throw new Error("invalid_worker_response");
      validateProvenance(response.provenance, expectedProvenance);
      features.push({
        id: row.id,
        family: row.family,
        label: row.label,
        textSha256: digest(row.text),
        features: response.features,
        inputTokens: response.inputTokens,
        featureElapsedMs: response.elapsedMs,
        operationalElapsedMs: performance.now() - start,
      });
      journal.completed = features.length;
      journal.unrun = plan.rows.length - features.length;
      await save(resolve(output, "features.json"), {
        schemaVersion: 1,
        planSha256: digest(planBytes),
        provenance: ready.provenance,
        rows: features,
      });
      await save(resolve(output, "journal.json"), journal);
      if ((i + 1) % 20 === 0)
        process.stdout.write(`Extracted TRAIN ${i + 1}/${plan.rows.length}\n`);
    }
    journal.status = "fitting_cached_features";
    child.stdin.end();
    const fitStart = performance.now();
    const head = validateRoutingHeadArtifact(
      fitRoutingHead(
        features.map(({ id, label, features: values }) => ({
          id,
          label,
          features: values,
        })),
        plan.headOptions,
      ),
    );
    journal.fitElapsedMs = performance.now() - fitStart;
    await save(resolve(output, "head.json"), head);
    journal.headSha256 = digest(await readFile(resolve(output, "head.json")));
    journal.trainingDiagnostics = head.trainingDiagnostics;
    journal.status = head.trainingDiagnostics.stationary
      ? "completed_training_only"
      : "training_not_stationary";
  } catch (error) {
    journal.errors.push({
      afterCompleted: journal.completed,
      code: controller.signal.aborted
        ? "training_interrupted"
        : /^[a-z_]+$/.test(error?.message ?? "")
          ? error.message
          : "training_failed",
    });
    journal.status = "failed_training";
    kill();
  } finally {
    child.stdin.end();
    const closeTimeout = setTimeout(() => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
    }, 5000);
    let closeDeadline;
    const closeCompleted = await Promise.race([
      closed.then(() => true),
      new Promise((resolveDeadline) => {
        closeDeadline = setTimeout(() => resolveDeadline(false), 8000);
      }),
    ]);
    clearTimeout(closeTimeout);
    clearTimeout(closeDeadline);
    journal.child.waitCompleted = closeCompleted;
    if (!closeCompleted) {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      journal.status = "failed_training";
      journal.errors.push({
        afterCompleted: journal.completed,
        code: "worker_exit_unconfirmed",
      });
    }
    const groupAbsent = () => {
      if (!child.pid) return true;
      try {
        process.kill(-child.pid, 0);
        return false;
      } catch (error) {
        return error.code === "ESRCH";
      }
    };
    journal.child.processGroupAbsent = groupAbsent();
    if (!journal.child.processGroupAbsent) {
      kill();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
      if (!groupAbsent()) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      }
      journal.child.processGroupAbsent = groupAbsent();
    }
    if (
      journal.status === "completed_training_only" &&
      (fatal || buffer.length || lines.length || controller.signal.aborted)
    ) {
      journal.status = "failed_training";
      journal.errors.push({
        afterCompleted: journal.completed,
        code: "worker_terminal_protocol_invalid",
      });
    }
    if (
      journal.status === "completed_training_only" &&
      (journal.child.exitCode !== 0 ||
        !journal.child.stdoutClosed ||
        !journal.child.stderrClosed ||
        !journal.child.processGroupAbsent)
    ) {
      journal.status = "failed_training";
      journal.errors.push({
        afterCompleted: journal.completed,
        code: "worker_cleanup_not_clean",
      });
    }
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    journal.stderr = {
      bytes: stderrBytes,
      sha256: stderrHasher.digest("hex"),
      bodyRetained: false,
    };
    journal.finishedAt = new Date().toISOString();
    journal.approved = false;
    journal.promoted = false;
    await save(resolve(output, "journal.json"), journal);
  }
  return journal;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const { values } = parseArgs({
    options: {
      output: { type: "string" },
      fixture: { type: "string" },
      python: { type: "string" },
      prepare: { type: "boolean" },
      run: { type: "boolean" },
    },
  });
  if (!values.output || !!values.prepare === !!values.run)
    throw new Error(
      "Usage: --output DIRECTORY --prepare|--run [--fixture PATH]",
    );
  const result = values.prepare
    ? await prepareTraining({
        output: values.output,
        fixture: values.fixture,
        python: values.python,
      })
    : await runTraining(values.output);
  process.stdout.write(
    JSON.stringify(
      values.prepare
        ? {
            prepared: true,
            population: result.population,
            counts: result.counts,
            model: result.model,
          }
        : result,
      null,
      2,
    ) + "\n",
  );
  if (values.run && result.status !== "completed_training_only")
    process.exitCode = 1;
}
