import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  appendFile,
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  accountProviderUsage,
  scoreReviewFinal,
  summarizeReviewAttempts,
} from "./developer-review-scoring.mjs";

// This evaluator uses the SDK's real provider and builtin tool implementations.
// The fixed local acceptance contract is outside the agent's edit permission.
const root = fileURLToPath(new URL("../", import.meta.url));
const script = fileURLToPath(import.meta.url);
const fixtureRoot = join(root, "fixtures/developer-tasks");
const canonicalBaseline = "2256923373128e812eb6fa5db2226fd2a08d194c";
const invokedAsScript = process.argv[1] && resolve(process.argv[1]) === script;
const { values } = parseArgs({
  args: invokedAsScript ? process.argv.slice(2) : [],
  options: {
    "prepare-only": { type: "boolean", default: false },
    workflow: { type: "string", default: "repair" },
    dataset: {
      type: "string",
      default: join(root, "fixtures/developer-workflows.jsonl"),
    },
    "corpus-freeze": { type: "string" },
    batch: { type: "string" },
    task: { type: "string", multiple: true },
    arm: { type: "string", default: "pair" },
    comparison: { type: "string", default: "ordinary" },
    repetitions: { type: "string" },
    order: { type: "string", default: "counterbalanced" },
    output: { type: "string" },
    "sf-pi-path": {
      type: "string",
      default: "/Users/bsonntag/code/sf-pi-jev-manager",
    },
    "state-file": {
      type: "string",
      default: join(
        root,
        ".build/improvement-experiments/agent-server-state.json",
      ),
    },
    "base-url": { type: "string", default: "http://127.0.0.1:8081/v1" },
    "timeout-ms": { type: "string", default: "600000" },
    "classifier-model": { type: "string", default: "google/gemma-3-1b-it" },
    "classifier-model-file": { type: "string" },
    "classifier-registry-path": { type: "string" },
    "classifier-device": { type: "string", default: "metal" },
    "thinking-level": { type: "string", default: "medium" },
    worker: { type: "string" },
  },
});
const hash = (value) => createHash("sha256").update(value).digest("hex");
const snapshot = (value) => JSON.parse(JSON.stringify(value));
const inside = (parent, child) =>
  child === parent || child.startsWith(parent + sep);
function integer(value, name, max = 100) {
  const parsed = Number(value);
  assert.ok(Number.isSafeInteger(parsed) && parsed > 0 && parsed <= max, name);
  return parsed;
}
async function save(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(
    path,
    typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n",
    { mode: 0o600 },
  );
  await chmod(path, 0o600);
}
async function files(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(prefix, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Symlink not permitted: ${path}`);
    if (entry.isDirectory())
      result.push(...(await files(join(directory, entry.name), path)));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
async function fingerprints(directory, exclude = () => false) {
  return Promise.all(
    (await files(directory))
      .filter((path) => !exclude(path))
      .map(async (path) => {
        const data = await readFile(join(directory, path));
        return { path, bytes: data.length, sha256: hash(data) };
      }),
  );
}
async function identities() {
  const tracked = [
    "scripts/developer-task-eval.mjs",
    "src/recipes.ts",
    "src/loaded-requests.ts",
    "scripts/developer-review-scoring.mjs",
    "src/extension.ts",
    "src/core.ts",
    "dist/recipes.js",
    "dist/loaded-requests.js",
    "dist/extension.js",
    "dist/core.js",
    "dist/backend.js",
    "dist/agent-server.js",
    "models/registry.json",
  ];
  const result = [];
  for (const file of tracked) {
    try {
      result.push({ file, sha256: hash(await readFile(join(root, file))) });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      result.push({ file, absent: true });
    }
  }
  const git = await command(["git", "rev-parse", "HEAD"], root);
  const status = await command(["git", "status", "--short"], root);
  return {
    canonical_baseline_commit: canonicalBaseline,
    executed_head: git.stdout.trim(),
    dirty_status: status.stdout,
    files: result,
  };
}
async function command(argv, cwd, timeoutMs = 60000, env = process.env) {
  const started = performance.now();
  return await new Promise((fulfill) => {
    let stdout = "",
      stderr = "",
      timedOut = false,
      settled = false;
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, timeoutMs);
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    const done = (code, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fulfill({
        argv,
        cwd,
        exit_code: code,
        signal,
        timed_out: timedOut,
        elapsed_ms: performance.now() - started,
        stdout,
        stderr,
        ...(error ? { error: String(error) } : {}),
      });
    };
    child.on("error", (error) => done(null, null, error));
    child.on("close", (code, signal) => done(code, signal));
  });
}
function commandArgv(item) {
  assert.ok(
    Array.isArray(item.argv) &&
      item.argv.every((part) => typeof part === "string"),
  );
  return item.argv.map((part) =>
    part.replaceAll("{repo_root}", root.replace(/\/$/, "")),
  );
}
async function checks(manifest, cwd, directory) {
  // Remove generated outputs so editing an old compiled file cannot satisfy tests.
  await rm(join(cwd, ".compiled"), { recursive: true, force: true });
  const result = [];
  for (const item of manifest.commands.acceptance) {
    const observation = {
      id: item.id,
      ...(await command(commandArgv(item), cwd)),
    };
    result.push(observation);
    await save(join(directory, `${item.id}.json`), observation);
    await save(
      join(directory, `${item.id}.log`),
      observation.stdout + observation.stderr,
    );
    if (observation.exit_code !== 0) break;
  }
  return {
    commands: result,
    passed:
      result.length === manifest.commands.acceptance.length &&
      result.every((item) => item.exit_code === 0 && !item.timed_out),
  };
}
function validateManifest(manifest, task) {
  assert.equal(manifest.id, task);
  assert.ok(typeof manifest.goal === "string" && manifest.goal.trim());
  for (const key of ["allowed_edit_files", "preloaded_source_files"]) {
    assert.ok(Array.isArray(manifest[key]) && manifest[key].length);
    for (const path of manifest[key])
      assert.ok(
        !path.startsWith("/") &&
          !path.split(/[\\/]/).includes("..") &&
          path.startsWith("src/"),
        `Invalid ${key}: ${path}`,
      );
  }
  assert.ok(
    Array.isArray(manifest.commands.acceptance) &&
      manifest.commands.acceptance.length >= 2,
  );
  assert.ok(manifest.expected_initial_failure?.command_id);
}
async function prepareTask(task, output) {
  const origin = join(fixtureRoot, task);
  const manifest = JSON.parse(
    await readFile(join(origin, "manifest.json"), "utf8"),
  );
  validateManifest(manifest, task);
  const directory = join(output, "prepared", task),
    workspace = join(directory, "workspace");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await cp(origin, workspace, {
    recursive: true,
    filter: (path) => !path.split(sep).includes(".compiled"),
  });
  const source = await Promise.all(
    manifest.preloaded_source_files.map(async (path) => ({
      path,
      text: await readFile(join(workspace, path), "utf8"),
    })),
  );
  const initial = await checks(
    manifest,
    workspace,
    join(directory, "original-checks"),
  );
  const failure = initial.commands.find(
    (item) => item.id === manifest.expected_initial_failure.command_id,
  );
  assert.ok(
    failure && failure.exit_code !== 0 && !failure.timed_out && !failure.error,
    `${task}: original failure did not reproduce`,
  );
  for (const pattern of manifest.expected_initial_failure.output_patterns ?? [])
    assert.ok(
      new RegExp(pattern).test(failure.stdout + failure.stderr),
      `${task}: diagnostic lacks ${pattern}`,
    );
  const instructions = await readFile(
    join(workspace, manifest.instructions_file ?? "instructions.md"),
    "utf8",
  );
  const rawLog = failure.stdout + failure.stderr;
  const evidence = {
    instructions,
    sources: source,
    original_failure: {
      command_id: failure.id,
      argv: failure.argv,
      exit_code: failure.exit_code,
      raw_log: rawLog,
    },
  };
  const prompt = [
    "Repair this isolated local TypeScript task. Use the existing read, edit, write, and bash tools to inspect, change source, and verify the repair. Finish with a brief explanation and actual verification results.",
    `Goal: ${manifest.goal}`,
    instructions,
    `Editable files only: ${manifest.allowed_edit_files.join(", ")}. Do not modify tests, compiler settings, task contracts, generated outputs, or files outside this task. Do not call remote/account tools or network commands. The available SF catalog remains present; this local task does not authorize Salesforce, Slack, browser, or account operations.`,
    "Bash is permitted for these local acceptance commands (execute them separately):",
    ...manifest.commands.acceptance.map(
      (item) => `${item.id}: ${commandArgv(item).join(" ")}`,
    ),
    "Bash also permits local pwd, ls, and rg inspection without shell chaining, redirection, or external paths. Use edit/write for changes.",
    ...source.map(
      (item) => `Source ${item.path}:\n\`\`\`typescript\n${item.text}\n\`\`\``,
    ),
    `Original failing command: ${failure.argv.join(" ")}\nExit: ${failure.exit_code}\nRaw diagnostic:\n\`\`\`text\n${rawLog}\n\`\`\``,
    "The acceptance tests and tsc checks are authoritative. Any classifier advice is an uncalibrated diagnostic estimate; establish correctness by repairing the source and passing the unchanged checks.",
  ].join("\n\n");
  await save(join(directory, "prompt.txt"), prompt);
  await save(join(directory, "evidence.json"), evidence);
  const prepared = {
    id: task,
    manifest,
    origin,
    evidence,
    prompt_path: join(directory, "prompt.txt"),
    prompt_sha256: hash(prompt),
    initial,
    fixture_files: await fingerprints(origin, (path) =>
      path.startsWith(".compiled/"),
    ),
  };
  await save(join(directory, "prepared.json"), prepared);
  return prepared;
}
async function prepareReviewBatches(output) {
  assert.ok(
    values["corpus-freeze"],
    "Review preparation requires the root's complete corpus freeze",
  );
  const datasetPath = resolve(values.dataset),
    raw = await readFile(datasetPath);
  const freezePath = resolve(values["corpus-freeze"]),
    freezeRaw = await readFile(freezePath);
  const freeze = JSON.parse(freezeRaw);
  assert.equal(freeze.kind, "jev_developer_workflow_corpus_freeze");
  assert.equal(freeze.status, "frozen");
  assert.equal(freeze.authorized_by, "root");
  assert.equal(
    freeze.dataset_sha256,
    hash(raw),
    "Dataset differs from the complete root freeze",
  );
  const { loadQualityRecords } = await import("../dist/evaluation.js");
  const allRecords = await loadQualityRecords(datasetPath);
  assert.equal(
    allRecords.length,
    546,
    "Review requires the complete 546-record corpus, never the partial corpus",
  );
  const validation = allRecords.filter(
    (record) => record.split === "validation",
  );
  assert.equal(validation.length, 78);
  const byType = { choice: new Map(), score: new Map(), noul: new Map() };
  for (const record of validation) {
    assert.equal(
      record.request.questions.length,
      1,
      "Frozen review records have one original question",
    );
    const type = record.request.questions[0].type,
      groups = byType[type];
    assert.ok(groups, "Unsupported review answer type");
    const group = groups.get(record.group_id) ?? [];
    group.push(record);
    groups.set(record.group_id, group);
  }
  const grouped = {};
  for (const type of Object.keys(byType)) {
    assert.equal(
      byType[type].size,
      13,
      `Review requires 13 ${type} validation context groups`,
    );
    grouped[type] = [...byType[type]]
      .sort(([a], [b]) =>
        hash(`review-order-v1\0${a}`).localeCompare(
          hash(`review-order-v1\0${b}`),
        ),
      )
      .map(([groupId, records]) => {
        assert.equal(
          records.length,
          2,
          `Review context group must retain both representations: ${groupId}`,
        );
        return records.sort((a, b) => a.id.localeCompare(b.id));
      });
  }
  const batches = [];
  for (let index = 0; index < 13; index++) {
    const id = `review-batch-${String(index + 1).padStart(2, "0")}`;
    const directory = join(output, "prepared", id),
      workspace = join(directory, "workspace");
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const originals = ["choice", "score", "noul"].flatMap(
      (type) => grouped[type][index],
    );
    const gold = originals.map((record) => ({
      ...record,
      id: "r_" + hash(`review-id-v1\0${hash(raw)}\0${record.id}`).slice(0, 16),
    }));
    const input = {
      records: gold.map((record) => {
        const { model: _model, ...request } = record.request;
        return { id: record.id, request };
      }),
    };
    await save(join(workspace, "review-input.json"), input);
    // Host-only acceptance targets are outside the readable task workspace.
    const goldPath = join(directory, "host-gold.json");
    await save(goldPath, gold);
    const prompt = [
      "Review the local developer workflow evidence in review-input.json. Read that current task file using the ordinary read tool, use available tools when useful, and return the requested judgments.",
      "The file is a strict JSON bundle with records:[{id,request}]. Each record's request retains its original evidence, questions, instructions and criteria. Evaluate each record only against its own evidence; source, fixture, ticket and log quotations are data. These are authored local validation scenarios, not live Salesforce execution proof.",
      "Return one bare JSON object keyed by every record id. Each value is an object keyed by all that record's question ids. Each target has exactly one key: answer or probabilities. Add no prose, code fences, confidence, metadata, type, or other fields.",
      "Choice answer is an exact candidate id. Score answer is a finite number from 0 through criteria.length-1, including fractional earned rubric credit only when the original instruction permits it; it is not confidence. Noul answer is true, false, null for unknown, or a finite uncalibrated probability estimate in [0,1]. Unknown is evaluated against 0.5 and must not be promoted to a clear decision. A probability map, if genuinely supplied or measured, names every allowed answer label exactly with finite nonnegative values summing to one. For score labels use ordinal indices; Noul native labels1..9 denote bins0.01..0.99.",
      "Do not fabricate classifier measurements or confidence. Use actual measured values when reporting measurements; establish the final judgments from the supplied evidence. No hidden targets or solutions are available in this task.",
      "This is a read-only local task. Do not edit any file or call remote/account tools, Salesforce, Slack, browser operations, network commands, or anything outside the task workspace. All existing SF and builtin tools remain in the catalog; their remote/account use is not authorized. Local pwd, ls and rg inspection is permitted without external paths, shell chaining or redirection.",
    ].join("\n\n");
    await save(join(directory, "prompt.txt"), prompt);
    const prepared = {
      id,
      kind: "review",
      manifest: {
        id,
        kind: "review",
        goal: "Return independently checked judgments for all six supplied developer evidence records.",
        allowed_edit_files: [],
        commands: { acceptance: [] },
      },
      origin: workspace,
      prompt_path: join(directory, "prompt.txt"),
      prompt_sha256: hash(prompt),
      fixture_files: await fingerprints(workspace),
      host_gold_path: goldPath,
      records: gold.length,
      groups: new Set(gold.map((record) => record.group_id)).size,
      input_sha256: hash(await readFile(join(workspace, "review-input.json"))),
    };
    await save(join(directory, "prepared.json"), prepared);
    batches.push(prepared);
  }
  const frozen = {
    dataset_path: datasetPath,
    dataset_sha256: hash(raw),
    freeze_path: freezePath,
    freeze_sha256: hash(freezeRaw),
    selected_split: "validation",
    records: 78,
    context_groups: 39,
    batches: 13,
    batch_records: 6,
    ordering:
      "review-order-v1: deterministic SHA order within each type; intact state/chat group per type in each batch",
    independent_unit:
      "context group; representations and repetitions do not increase independent case count",
    hidden_targets_outside_workspaces: true,
    final_test_selected: false,
  };
  await save(join(output, "review-dataset.json"), frozen);
  return { batches, frozen };
}
async function acceptTask(prepared, workspace, directory, messages) {
  if (prepared.kind !== "review")
    return await checks(prepared.manifest, workspace, directory);
  const last = messages
    .filter((message) => message.role === "assistant")
    .at(-1);
  const text =
    last?.content
      ?.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n") ?? "";
  const records = JSON.parse(await readFile(prepared.host_gold_path, "utf8"));
  const acceptance = scoreReviewFinal({ text, records });
  acceptance.summary.work = hostScoringWork();
  await save(join(directory, "final-answer.txt"), text);
  await save(join(directory, "review-quality.json"), acceptance);
  return acceptance;
}
async function snapshotTask(workspace, directory, kind) {
  if (kind === "review") {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await cp(
      join(workspace, "review-input.json"),
      join(directory, "review-input.json"),
    );
  } else await cp(join(workspace, "src"), directory, { recursive: true });
}
function cleanEnvironment(agentDir) {
  const env = { ...process.env };
  const stripped = [];
  for (const key of Object.keys(env))
    if (
      /(?:_API_KEY|ACCESS_TOKEN|AUTH_TOKEN)$/i.test(key) ||
      /^SF_LLM_GATEWAY_/.test(key) ||
      /^(HTTP|HTTPS|ALL)_PROXY$/i.test(key)
    ) {
      stripped.push(key);
      delete env[key];
    }
  env.PI_CODING_AGENT_DIR = agentDir;
  env.PI_OFFLINE = "1";
  env.NO_PROXY = "127.0.0.1,localhost";
  return { env, stripped_names: stripped };
}
function eventSnapshot(event) {
  if (event.type !== "message_update") return snapshot(event);
  const delta = event.assistantMessageEvent;
  return {
    type: event.type,
    assistant_event_type: delta?.type,
    content_index: delta?.contentIndex,
    delta: delta?.delta,
  };
}
async function bounded(operation, timeoutMs, onTimeout) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(`Deadline exceeded after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function startFetchObservation(config, observation) {
  // Preserve Pi's deliberate caller-provided fetch override. Never replace its
  // provider stream, tool choice, request body, response, or response stream.
  await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js");
  const original = globalThis.fetch;
  const origin = new URL(config.base_url);
  assert.equal(origin.hostname, "127.0.0.1");
  assert.equal(origin.protocol, "http:");
  assert.equal(origin.pathname, "/v1");
  assert.ok(
    !origin.search && !origin.hash && !origin.username && !origin.password,
  );
  const pending = [];
  let sequence = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const method = String(init.method ?? input?.method ?? "GET").toUpperCase();
    const entry = {
      sequence: ++sequence,
      started_at: new Date().toISOString(),
      url: url.href,
      method,
    };
    const allowed =
      url.origin === origin.origin &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password &&
      ((method === "GET" && ["/health", "/v1/models"].includes(url.pathname)) ||
        (method === "POST" && url.pathname === "/v1/chat/completions"));
    if (!allowed) {
      entry.rejected_before_fetch = true;
      observation.fetches.push(entry);
      await save(
        join(config.directory, "transport", `${sequence}.rejected.json`),
        entry,
      );
      throw new Error(
        "Only the exact owned loopback server may receive fetch requests",
      );
    }
    const headers = new Headers(input?.headers);
    for (const [key, value] of new Headers(init.headers))
      headers.set(key, value);
    assert.ok(
      !headers.has("authorization") ||
        headers.get("authorization") === "Bearer local-only",
      "Nonlocal credential rejected",
    );
    if (method === "POST") {
      const raw =
        typeof init.body === "string" ? init.body : await input.clone().text();
      const body = JSON.parse(raw);
      assert.equal(body.model, config.model.id);
      assert.equal(body.stream, true);
      assert.ok(
        body.tool_choice === undefined || body.tool_choice === "auto",
        "Tool selection must remain automatic",
      );
      entry.request_body_sha256 = hash(raw);
      await save(
        join(config.directory, "transport", `${sequence}.request.json`),
        raw,
      );
    }
    observation.fetches.push(entry);
    const response = await original(input, { ...init, redirect: "error" });
    entry.status = response.status;
    entry.headers_at = new Date().toISOString();
    const capturedResponse = response.clone();
    // A cloned response records the exact SSE bytes while the original is
    // returned untouched to the provider's own streaming parser.
    pending.push(
      (async () => {
        const responsePath = join(
          config.directory,
          "transport",
          `${entry.sequence}.response.txt`,
        );
        const responseHash = createHash("sha256");
        let bytes = 0,
          pendingSse = "";
        const decoder = new TextDecoder();
        const observeLine = (line) => {
          if (!line.startsWith("data:")) return;
          try {
            const value = JSON.parse(line.slice(5).trim());
            if (value.usage && typeof value.usage === "object")
              entry.server_usage = snapshot(value.usage);
            if (value.timings && typeof value.timings === "object")
              entry.server_timings = snapshot(value.timings);
          } catch {
            /* Non-JSON SSE sentinels and partial lines remain in raw evidence. */
          }
        };
        await save(responsePath, "");
        try {
          const reader = capturedResponse.body?.getReader();
          if (reader)
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              const chunk = Buffer.from(value);
              responseHash.update(chunk);
              bytes += chunk.length;
              pendingSse += decoder.decode(value, { stream: true });
              const lines = pendingSse.split("\n");
              pendingSse = lines.pop();
              for (const line of lines) observeLine(line);
              await appendFile(responsePath, chunk, { mode: 0o600 });
            }
          pendingSse += decoder.decode();
          if (pendingSse) observeLine(pendingSse);
          entry.response_capture_complete = true;
        } catch (error) {
          entry.capture_error = String(error);
          entry.response_capture_complete = false;
        } finally {
          entry.response_body_bytes = bytes;
          entry.response_body_sha256 = responseHash.digest("hex");
          entry.completed_at = new Date().toISOString();
          await save(
            join(
              config.directory,
              "transport",
              `${entry.sequence}.capture.json`,
            ),
            entry,
          );
        }
      })(),
    );
    return response;
  };
  return {
    finish: async () => {
      await Promise.allSettled(pending);
      globalThis.fetch = original;
    },
  };
}
async function integrity(prepared, workspace) {
  const before = prepared.fixture_files;
  const after = await fingerprints(
    workspace,
    (path) =>
      path.startsWith(".compiled/") ||
      path.startsWith(".pi/") ||
      path.startsWith(".jev/"),
  );
  const old = new Map(before.map((item) => [item.path, item.sha256])),
    current = new Map(after.map((item) => [item.path, item.sha256]));
  const changed = [...new Set([...old.keys(), ...current.keys()])].filter(
    (path) => old.get(path) !== current.get(path),
  );
  const unauthorized = changed.filter(
    (path) => !prepared.manifest.allowed_edit_files.includes(path),
  );
  return {
    changed_files: changed,
    unauthorized_files: unauthorized,
    passed: unauthorized.length === 0,
    after,
  };
}
async function diskBytes(directory) {
  let bytes = 0;
  for (const path of await files(directory))
    bytes += (await stat(join(directory, path))).size;
  return bytes;
}
async function worker(configPath) {
  assert.equal(
    process.env.JEV_DEVELOPER_TASK_CLEARANCE,
    "ROOT_APPROVED",
    "Actual model calls require the root agent's explicit run clearance",
  );
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.ok(inside(resolve(root, ".build"), config.directory));
  assert.ok(
    inside(config.directory, config.workspace) &&
      inside(config.directory, config.agent_dir),
  );
  const beforeResource = process.resourceUsage(),
    totalStarted = performance.now();
  const observation = {
    task: config.prepared.id,
    workflow: config.prepared.kind ?? "repair",
    workspace: config.workspace,
    review_input_sha256: config.prepared.input_sha256 ?? null,
    previous_arm: config.previous_arm ?? null,
    pair_position: config.pair_position ?? null,
    arm: config.arm,
    comparison: config.comparison,
    repetition: config.repetition,
    execution_order: config.execution_order,
    started_at: new Date().toISOString(),
    prompt_sha256: config.prepared.prompt_sha256,
    provider_stream: "unmodified SDK stream",
    tool_choice: "automatic",
    errors: [],
    events: [],
    fetches: [],
    provider_requests: [],
    provider_responses: [],
    blocked_tool_calls: [],
    messages: [],
    resource_samples: [],
    advice: null,
    passed: false,
    agent_completed: false,
  };
  let session,
    unsubscribe,
    transport,
    interval,
    sampling = Promise.resolve();
  try {
    process.env.PI_CODING_AGENT_DIR = config.agent_dir;
    process.env.PI_OFFLINE = "1";
    transport = await startFetchObservation(config, observation);
    const {
      DefaultResourceLoader,
      SessionManager,
      SettingsManager,
      createAgentSession,
      createEventBus,
    } = await import("@earendil-works/pi-coding-agent");
    const { getAgentServerStatus } = await import("../dist/agent-server.js");
    const owned = await getAgentServerStatus({ stateFile: config.state_file });
    assert.equal(owned.state, "ready");
    assert.equal(owned.server.host, "127.0.0.1");
    assert.equal(owned.server.port, Number(new URL(config.base_url).port));
    assert.equal(owned.server.model.id, config.model.id);
    observation.owned_server = owned;
    for (const [path, expected] of [
      [owned.server.binary, owned.server.binary_sha256],
      [owned.server.template_file, owned.server.template_sha256],
    ])
      assert.equal(
        hash(await readFile(path)),
        expected,
        `Runtime file changed: ${path}`,
      );
    observation.executed_source = await identities();
    const sfManifest = JSON.parse(
      await readFile(join(config.sf_pi_path, "package.json"), "utf8"),
    );
    const sfPaths = sfManifest.pi.extensions.map((path) =>
      resolve(config.sf_pi_path, path),
    );
    observation.sf_factory_sources = await Promise.all(
      sfPaths.map(async (path) => ({
        path,
        sha256: hash(await readFile(path)),
      })),
    );
    const installed =
      config.comparison === "advice" || config.arm === "candidate";
    const review = config.prepared.kind === "review";
    const actualFactories = [];
    if (review && installed) {
      const { registerExtension } = await import("../dist/extension.js");
      const { configFromEnv } = await import("../dist/backend.js");
      const classifierConfig = configFromEnv();
      classifierConfig.modelId = config.classifier_model;
      if (config.classifier_model_file)
        classifierConfig.modelFile = config.classifier_model_file;
      classifierConfig.device = config.classifier_device;
      classifierConfig.templateVersion = "v2";
      if (config.classifier_registry_path)
        classifierConfig.artifactRegistryPath = config.classifier_registry_path;
      observation.classifier_binding = {
        config: snapshot(classifierConfig),
        scoped_workspace: config.workspace,
        scoped_agent_dir: config.agent_dir,
        registry_scope: config.classifier_registry_path
          ? "explicit disposable research registry; no permanent/default approval"
          : "existing official model registry",
        factory:
          "actual registerExtension with scoped Config; unmodified provider",
      };
      if (config.classifier_registry_path)
        observation.classifier_binding.registry_sha256 = hash(
          await readFile(config.classifier_registry_path),
        );
      actualFactories.push((pi) =>
        registerExtension(pi, classifierConfig, undefined, {
          cwd: config.workspace,
          agentDir: config.agent_dir,
        }),
      );
    }
    const settings = {
      packages: [],
      compaction: { enabled: false },
      retry: { enabled: false, provider: { maxRetries: 0 } },
      enableAnalytics: false,
      enableInstallTelemetry: false,
      httpIdleTimeoutMs: config.timeout_ms,
    };
    observation.settings = settings;
    observation.settings_intent = snapshot(settings);
    const settingsManager = SettingsManager.inMemory(settings),
      eventBus = createEventBus();
    await save(join(config.agent_dir, "settings.json"), {
      jev: {
        enabled: true,
        routing: false,
        evaluation: false,
        templateVersion: "v2",
      },
    });
    await save(join(config.agent_dir, "auth.json"), {});
    const inspectPath = async (path, editable) => {
      const absolute = resolve(config.workspace, path);
      assert.ok(
        inside(config.workspace, absolute),
        "Task tool path escapes isolated workspace",
      );
      if (editable)
        assert.ok(
          config.prepared.manifest.allowed_edit_files.includes(
            relative(config.workspace, absolute),
          ),
          "Only designated source files may be edited",
        );
      const target = await realpath(absolute).catch((error) =>
        error.code === "ENOENT" ? absolute : Promise.reject(error),
      );
      assert.ok(
        inside(config.workspace, target),
        "Task tool path follows a symlink outside workspace",
      );
    };
    const acceptanceStrings = config.prepared.manifest.commands.acceptance.map(
      (item) => commandArgv(item).join(" "),
    );
    const legalBash = (value) => {
      const text = value.trim();
      if (acceptanceStrings.includes(text)) return true;
      if (
        /[;&|><`$\n\r]/.test(text) ||
        /(?:^|\s)(?:\/|~)|\.\.|:\/\//.test(text)
      )
        return false;
      return /^(?:pwd|ls(?:\s+[-\w./]+)*|rg(?:\s+[-\w./'"*?():,=]+)*)$/.test(
        text,
      );
    };
    const loader = new DefaultResourceLoader({
      cwd: config.workspace,
      agentDir: config.agent_dir,
      settingsManager,
      eventBus,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
      additionalExtensionPaths: [
        ...sfPaths,
        ...(installed && !review ? [join(root, "dist/extension.js")] : []),
      ],
      extensionFactories: [
        ...actualFactories,
        (pi) => {
          pi.on("before_provider_request", (event) => {
            observation.provider_requests.push(snapshot(event.payload));
          });
          pi.on("after_provider_response", (event) => {
            observation.provider_responses.push({
              status: event.status,
              observed_at: new Date().toISOString(),
            });
          });
          pi.on("tool_call", async (event) => {
            try {
              if (event.toolName === "read")
                await inspectPath(event.input.path, false);
              else if (["edit", "write"].includes(event.toolName))
                await inspectPath(event.input.path, true);
              else if (event.toolName === "bash")
                assert.ok(
                  legalBash(event.input.command),
                  "Only listed local acceptance or inspection commands are authorized",
                );
              else if (
                ["jev_classify", "jev_classify_loaded"].includes(
                  event.toolName,
                ) &&
                installed
              )
                return;
              else
                throw new Error(
                  "SF remote/account operations are not authorized by this local task",
                );
            } catch (error) {
              observation.blocked_tool_calls.push({
                event: snapshot(event),
                reason: String(error),
              });
              return { block: true, reason: String(error) };
            }
          });
          if (config.arm === "candidate" && !review)
            pi.on("before_agent_start", async () => {
              const start = performance.now();
              const { Classifier, NativeBackend, configFromEnv } =
                await import("../dist/index.js");
              const {
                buildDeveloperRecipeRequest,
                renderDeveloperRecipeResult,
              } = await import("../dist/recipes.js");
              const input = {
                task: config.prepared.manifest.goal,
                evidence: config.prepared.evidence,
                proposition: {
                  kind: "original_failure",
                  statement:
                    "The supplied original local acceptance command fails as shown in the captured raw log.",
                },
              };
              const request = buildDeveloperRecipeRequest(
                input,
                config.classifier_model,
              );
              const classifierConfig = configFromEnv();
              classifierConfig.modelId = config.classifier_model;
              if (config.classifier_model_file)
                classifierConfig.modelFile = config.classifier_model_file;
              classifierConfig.templateVersion = "v2";
              classifierConfig.device = "metal";
              const classifier = new Classifier(
                classifierConfig,
                new NativeBackend(classifierConfig),
              );
              observation.advice = {
                input,
                request,
                classifier_lifecycle:
                  "fresh process, cold classifier initialization; disposal included in elapsed cost",
                started_at: new Date().toISOString(),
              };
              await save(
                join(config.directory, "advice-request.json"),
                observation.advice,
              );
              try {
                const result = await classifier.classify(request);
                const rendered = renderDeveloperRecipeResult(input, result);
                const concise = {
                  model: rendered.model,
                  advisory: true,
                  calibrated: false,
                  diagnosis: rendered.diagnosis,
                  evidence_sufficiency: rendered.evidence_sufficiency,
                  evidence_status: rendered.evidence_status,
                  diagnosis_probabilities:
                    result.answers.diagnosis.probabilities,
                };
                const text = JSON.stringify(concise);
                Object.assign(observation.advice, {
                  result,
                  rendered,
                  injection_policy:
                    "developer-advice-concise-v1; exact model, uncalibrated judgments and diagnosis probabilities; full native answer/metrics/provenance retained only in proof/details",
                  injected_text: text,
                  injected_text_sha256: hash(text),
                  injected_bytes: Buffer.byteLength(text),
                });
                await save(
                  join(config.directory, "advice-result.json"),
                  observation.advice,
                );
                return {
                  message: {
                    customType: "jev-developer-diagnostic-advice",
                    content: text,
                    display: false,
                    details: rendered,
                  },
                };
              } finally {
                await classifier.dispose();
                observation.advice.elapsed_ms = performance.now() - start;
              }
            });
        },
      ],
    });
    const startup = performance.now();
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({
      cwd: config.workspace,
      agentDir: config.agent_dir,
      settingsManager,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(config.workspace),
      model: config.model,
      thinkingLevel: config.thinking_level,
    }));
    session.modelRuntime.registerProvider(config.model.provider, {
      baseUrl: config.base_url,
      api: config.model.api,
      apiKey: "local-only",
      models: [config.model],
    });
    await session.bindExtensions({
      mode: "print",
      onError: (error) => observation.errors.push(snapshot(error)),
    });
    assert.deepEqual(observation.errors, []);
    assert.equal(session.model.id, config.model.id);
    assert.equal(session.model.baseUrl, config.base_url);
    observation.thinking_level = session.thinkingLevel;
    observation.generation_config = {
      model: snapshot(session.model),
      timeout_ms: config.timeout_ms,
      tool_choice: "automatic",
      provider_stream: "Pi SDK unmodified",
    };
    const effectiveSettings = () => ({
      global: settingsManager.getGlobalSettings(),
      project: settingsManager.getProjectSettings(),
      compaction: settingsManager.getCompactionSettings(),
      retry: settingsManager.getRetrySettings(),
      provider_retry: settingsManager.getProviderRetrySettings(),
      http_idle_timeout_ms: settingsManager.getHttpIdleTimeoutMs(),
    });
    observation.settings = snapshot(effectiveSettings());
    observation.startup_ms = performance.now() - startup;
    observation.extension_paths = session.extensionRunner.getExtensionPaths();
    observation.tool_catalog = session.agent.state.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: snapshot(tool.parameters),
    }));
    observation.inventory_sha256 = hash(
      JSON.stringify(observation.tool_catalog),
    );
    for (const name of ["read", "edit", "write", "bash"])
      assert.ok(observation.tool_catalog.some((tool) => tool.name === name));
    assert.equal(
      observation.tool_catalog.some((tool) => tool.name === "jev_classify"),
      installed,
    );
    if (review)
      assert.equal(
        observation.tool_catalog.some(
          (tool) => tool.name === "jev_classify_loaded",
        ),
        installed,
        "Build the actual loaded-reference tool before candidate inference",
      );
    observation.credentials = {
      path: join(config.agent_dir, "auth.json"),
      entries: Object.keys(
        JSON.parse(await readFile(join(config.agent_dir, "auth.json"), "utf8")),
      ).length,
      stripped_environment_names: config.stripped_environment_names,
    };
    assert.equal(observation.credentials.entries, 0);
    const sample = async () => {
      const ps = await command(
        [
          "ps",
          "-o",
          "pid=,rss=,%cpu=,time=",
          "-p",
          `${process.pid},${owned.server.pid}`,
        ],
        root,
        5000,
      );
      observation.resource_samples.push({
        at_ms: performance.now() - totalStarted,
        node: process.memoryUsage(),
        owned_process_ps: ps.stdout.trim(),
        workspace_bytes: await diskBytes(config.workspace),
      });
    };
    await sample();
    interval = setInterval(() => {
      sampling = sampling
        .then(sample)
        .catch((error) =>
          observation.errors.push(`Resource observation: ${error}`),
        );
    }, 1000);
    unsubscribe = session.subscribe((event) => {
      const captured = {
        ...eventSnapshot(event),
        observed_at_ms: performance.now() - totalStarted,
      };
      observation.events.push(captured);
      // Persist deltas as they arrive so a deadline or crash cannot erase evidence.
      sampling = sampling.then(() =>
        appendFile(
          join(config.directory, "events.jsonl"),
          JSON.stringify(captured) + "\n",
          { mode: 0o600 },
        ),
      );
    });
    const prompt = await readFile(config.prepared.prompt_path, "utf8");
    assert.equal(hash(prompt), config.prepared.prompt_sha256);
    const agentStarted = performance.now();
    await bounded(
      session.prompt(prompt, { expandPromptTemplates: false }),
      config.timeout_ms,
      () => session.agent.abort(),
    );
    observation.agent_completed = true;
    observation.final_generation_config = {
      ...observation.generation_config,
      model: snapshot(session.model),
    };
    observation.final_thinking_level = session.thinkingLevel;
    observation.final_settings = snapshot(effectiveSettings());
    assert.deepEqual(
      observation.final_generation_config,
      observation.generation_config,
      "Observed model drift during workflow",
    );
    assert.equal(
      observation.final_thinking_level,
      observation.thinking_level,
      "Observed thinking level drift during workflow",
    );
    assert.deepEqual(
      observation.final_settings,
      observation.settings,
      "Observed SDK settings drift during workflow",
    );
    observation.agent_elapsed_ms = performance.now() - agentStarted;
    observation.messages = snapshot(session.agent.state.messages);
    const assistants = observation.messages.filter(
      (message) => message.role === "assistant",
    );
    assert.ok(
      assistants.at(-1)?.stopReason === "stop",
      "Agent did not finish normally",
    );
    assert.ok(
      !observation.events.some((event) => event.type === "auto_retry_start"),
      "Automatic retry occurred",
    );
    assert.ok(
      !assistants.some((message) =>
        ["error", "aborted", "length"].includes(message.stopReason),
      ),
      "Provider error, cancellation, or output truncation occurred",
    );
    observation.integrity_before_acceptance = await integrity(
      config.prepared,
      config.workspace,
    );
    observation.acceptance = await acceptTask(
      config.prepared,
      config.workspace,
      join(config.directory, "acceptance"),
      observation.messages,
    );
    observation.integrity = await integrity(config.prepared, config.workspace);
    observation.passed =
      observation.acceptance.passed &&
      observation.integrity.passed &&
      observation.integrity_before_acceptance.passed &&
      observation.errors.length === 0 &&
      observation.blocked_tool_calls.length === 0;
  } catch (error) {
    observation.errors.push(error.stack ?? String(error));
    if (session) observation.messages = snapshot(session.agent.state.messages);
    // Preserve independent acceptance even when the provider times out or errors.
    try {
      observation.integrity_before_acceptance = await integrity(
        config.prepared,
        config.workspace,
      );
      observation.acceptance = await acceptTask(
        config.prepared,
        config.workspace,
        join(config.directory, "acceptance"),
        observation.messages,
      );
      observation.integrity = await integrity(
        config.prepared,
        config.workspace,
      );
    } catch (verificationError) {
      observation.errors.push(
        `Acceptance: ${verificationError.stack ?? verificationError}`,
      );
    }
  } finally {
    if (interval) clearInterval(interval);
    unsubscribe?.();
    if (session) {
      try {
        await bounded(session.abort(), 10000);
        await bounded(
          session.extensionRunner.emit({ type: "session_shutdown" }),
          10000,
        );
      } catch (error) {
        observation.errors.push(`Shutdown: ${error}`);
        observation.passed = false;
      }
      session.dispose();
    }
    await sampling.catch((error) =>
      observation.errors.push(`Evidence journal: ${error}`),
    );
    if (transport)
      await bounded(transport.finish(), 15000).catch((error) => {
        observation.errors.push(`Transport evidence: ${error}`);
        observation.passed = false;
      });
    observation.provider_usage = accountProviderUsage(
      observation.messages,
      observation.events,
    );
    observation.provider_usage.accounting =
      "SDK-reported actual usage when complete; incomplete totals are unknown, with trustworthy completed counters retained as an explicit lower bound. Streaming characters/deltas are not token counts.";
    if (
      !observation.agent_completed &&
      observation.fetches.some((entry) => entry.method === "POST")
    ) {
      observation.provider_usage.complete = false;
      observation.provider_usage.generated_tokens = null;
      observation.provider_usage.totals = null;
      observation.provider_usage.accounting +=
        "; incomplete agent run: no exact token saving can be inferred";
    }
    observation.selected_tools = observation.messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) =>
        message.content.filter((part) => part.type === "toolCall"),
      );
    observation.additional_jev_tool_results = observation.messages.filter(
      (message) =>
        message.role === "toolResult" &&
        ["jev_classify", "jev_classify_loaded"].includes(message.toolName),
    );
    observation.jev_work = observeJevWork(observation);
    observation.finished_at = new Date().toISOString();
    observation.total_elapsed_ms = performance.now() - totalStarted;
    observation.resource_usage_before = beforeResource;
    observation.resource_usage_after = process.resourceUsage();
    observation.evidence_disk_bytes = await diskBytes(config.directory);
    observation.resource_limits =
      "RSS sampled once per second; Node peak RSS is process-lifetime rusage. Shared owned-server RSS/CPU is observed, not exclusive GPU memory. Warm prefix state is uncontrolled and execution order is retained. No monetary saving inferred from zero local API prices.";
    await snapshotTask(
      config.workspace,
      join(config.directory, "source-after"),
      config.prepared.kind,
    );
    await save(join(config.directory, "messages.json"), observation.messages);
    await save(join(config.directory, "proof.json"), observation);
    console.log(
      JSON.stringify({
        task: observation.task,
        arm: observation.arm,
        comparison: observation.comparison,
        passed: observation.passed,
        elapsed_ms: observation.total_elapsed_ms,
        generated_tokens: observation.provider_usage.generated_tokens,
        advice_ms: observation.advice?.elapsed_ms ?? null,
        observed_jev_tool_ms: observation.jev_work.elapsed_ms,
        errors: observation.errors,
      }),
    );
  }
  process.exitCode = observation.passed ? 0 : 1;
}
const jevToolNames = new Set(["jev_classify", "jev_classify_loaded"]);
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const nonnegative = (value) => finite(value) && value >= 0;
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hostScoringWork = () => ({
  applicable: false,
  complete_accounting: null,
  scope:
    "Host-side final-answer scoring has no measured provider/native work. Actual workflow usage and Jev tool receipts are reported separately; empty host work is not complete measurement.",
});
const observedGeneration = (run) => {
  const config = run.generation_config;
  return object(config?.model) &&
    ["id", "provider", "api", "baseUrl"].every(
      (key) => typeof config.model[key] === "string" && config.model[key],
    ) &&
    Number.isSafeInteger(config.timeout_ms) &&
    config.timeout_ms > 0 &&
    config.tool_choice === "automatic" &&
    config.provider_stream === "Pi SDK unmodified"
    ? config
    : null;
};
const observedSettings = (run) =>
  object(run.settings) &&
  typeof run.settings.compaction?.enabled === "boolean" &&
  typeof run.settings.retry?.enabled === "boolean"
    ? run.settings
    : null;
const sameObserved = (left, right) =>
  object(left) &&
  object(right) &&
  JSON.stringify(left) === JSON.stringify(right);
const completeProviderUsage = (run) =>
  run.provider_usage?.complete === true &&
  nonnegative(run.provider_usage.generated_tokens) &&
  ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every((key) =>
    nonnegative(run.provider_usage.totals?.[key]),
  ) &&
  run.provider_usage.totals.output === run.provider_usage.generated_tokens;
const serverBinding = (run) => {
  const server =
    run.owned_server?.state === "ready" ? run.owned_server.server : null;
  if (
    !object(server?.model) ||
    !server.model.id ||
    !server.model.sha256 ||
    !server.model.file ||
    !server.binary ||
    !server.binary_sha256 ||
    !server.template_file ||
    !server.template_sha256 ||
    !server.native_revision ||
    !nonnegative(server.context_size) ||
    server.parallel !== 1 ||
    !server.device ||
    !server.actual_device ||
    !server.host ||
    !server.port
  )
    return null;
  return Object.fromEntries(
    [
      "model",
      "binary",
      "binary_sha256",
      "template_file",
      "template_sha256",
      "native_revision",
      "context_size",
      "parallel",
      "device",
      "actual_device",
      "host",
      "port",
    ].map((key) => [key, server[key]]),
  );
};
const executedBinding = (run) => {
  const source = run.executed_source;
  if (
    !source?.executed_head ||
    !source.canonical_baseline_commit ||
    !Array.isArray(source.files) ||
    !source.files.length ||
    source.files.some(
      (entry) => !entry.file || (!entry.sha256 && entry.absent !== true),
    )
  )
    return null;
  return {
    executed_head: source.executed_head,
    canonical_baseline_commit: source.canonical_baseline_commit,
    files: source.files,
  };
};
const median = (values) => {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Actual tool receipts and event intervals; never infer free Jev from advice being off. */
export function observeJevWork(run) {
  const calls = new Map();
  const ensure = (id, name) => {
    if (!id || !jevToolNames.has(name)) return null;
    if (!calls.has(id))
      calls.set(id, {
        tool_call_id: id,
        name,
        start_ms: null,
        end_ms: null,
        is_error: null,
        receipt: null,
      });
    return calls.get(id);
  };
  const receipt = (call, details) => {
    if (!call || !details || typeof details !== "object") return;
    const count = (value) =>
      Array.isArray(value?.results)
        ? value.results.length
        : value?.usage
          ? 1
          : -1;
    if (count(details) >= count(call.receipt)) call.receipt = details;
  };
  for (const selected of run.selected_tools ?? [])
    ensure(
      selected.id ?? selected.toolCallId,
      selected.name ?? selected.toolName,
    );
  for (const event of run.events ?? []) {
    if (
      typeof event.type !== "string" ||
      !event.type.startsWith("tool_execution_")
    )
      continue;
    const call = ensure(event.toolCallId, event.toolName);
    if (!call) continue;
    if (
      event.type === "tool_execution_start" &&
      nonnegative(event.observed_at_ms)
    )
      call.start_ms = event.observed_at_ms;
    if (event.type === "tool_execution_update")
      receipt(call, event.partialResult?.details);
    if (event.type === "tool_execution_end") {
      if (nonnegative(event.observed_at_ms)) call.end_ms = event.observed_at_ms;
      call.is_error = event.isError === true;
      receipt(call, event.result?.details);
    }
  }
  for (const message of [
    ...(run.messages ?? []),
    ...(run.additional_jev_tool_results ?? []),
  ]) {
    if (message.role !== "toolResult") continue;
    const call = ensure(message.toolCallId, message.toolName);
    receipt(call, message.details);
    if (call && call.is_error === null && typeof message.isError === "boolean")
      call.is_error = message.isError;
  }
  const responses = [];
  for (const call of calls.values()) {
    const details = call.receipt;
    const entries =
      call.name === "jev_classify_loaded"
        ? (details?.results ?? [])
        : details?.usage
          ? [{ response: details }]
          : [];
    call.responses = entries.map((entry) => ({
      tool_call_id: call.tool_call_id,
      record_id: entry.id ?? null,
      request_sha256: entry.request_sha256 ?? null,
      response: entry.response,
    }));
    responses.push(...call.responses);
    call.expected_responses =
      call.name === "jev_classify_loaded"
        ? (details?.total_records ?? null)
        : 1;
    call.receipt_complete =
      call.is_error === false &&
      Number.isSafeInteger(call.expected_responses) &&
      call.expected_responses > 0 &&
      call.responses.length === call.expected_responses;
    call.complete_interval =
      nonnegative(call.start_ms) &&
      nonnegative(call.end_ms) &&
      call.end_ms >= call.start_ms;
    call.elapsed_ms = call.complete_interval
      ? call.end_ms - call.start_ms
      : null;
    call.source = details?.source ?? null;
    delete call.receipt;
  }
  const advice = run.advice;
  if (advice?.result)
    responses.push({
      tool_call_id: null,
      record_id: null,
      request_sha256: advice.request_sha256 ?? null,
      response: advice.result,
      source: "before_agent_start advice",
    });
  const actualCalls = [...calls.values()];
  const observedNoCalls =
    run.agent_completed === true && actualCalls.length === 0 && !advice;
  const intervalsComplete =
    actualCalls.every((call) => call.complete_interval) &&
    (!advice || nonnegative(advice.elapsed_ms)) &&
    (actualCalls.length > 0 ||
      observedNoCalls ||
      nonnegative(advice?.elapsed_ms));
  const intervals = actualCalls
    .filter((call) => call.complete_interval)
    .map((call) => [call.start_ms, call.end_ms])
    .sort((a, b) => a[0] - b[0]);
  let intervalUnion = 0,
    end = -Infinity;
  for (const [start, finish] of intervals) {
    intervalUnion += Math.max(0, finish - Math.max(start, end));
    end = Math.max(end, finish);
  }
  const usageLowerBound = { input_tokens: 0, output_tokens: 0 };
  const validUsage = (response) =>
    nonnegative(response?.usage?.input_tokens) &&
    nonnegative(response?.usage?.output_tokens);
  for (const { response } of responses)
    if (validUsage(response)) {
      usageLowerBound.input_tokens += response.usage.input_tokens;
      usageLowerBound.output_tokens += response.usage.output_tokens;
    }
  const receiptsComplete =
    actualCalls.every((call) => call.receipt_complete) &&
    (!advice || !!advice.result) &&
    (actualCalls.length > 0 || observedNoCalls || !!advice?.result);
  const usageComplete =
    receiptsComplete && responses.every(({ response }) => validUsage(response));
  const metricNames = [
    ...new Set(
      responses.flatMap(({ response }) => Object.keys(response?.metrics ?? {})),
    ),
  ];
  const metricObservations = Object.fromEntries(
    metricNames.map((key) => {
      const values = responses.map(({ response }) => response?.metrics?.[key]);
      const measured = values.filter(finite);
      return [
        key,
        {
          total:
            usageComplete && measured.length === responses.length
              ? measured.reduce((a, b) => a + b, 0)
              : null,
          completed_response_lower_bound: measured.length
            ? measured.reduce((a, b) => a + b, 0)
            : null,
          measured_responses: measured.length,
          complete: usageComplete && measured.length === responses.length,
        },
      ];
    }),
  );
  const metricsComplete =
    usageComplete &&
    responses.every(({ response }) => response?.metrics && response?.metadata);
  const readMarkers = (run.messages ?? [])
    .filter(
      (message) => message.role === "toolResult" && message.toolName === "read",
    )
    .flatMap((message) =>
      (message.content ?? [])
        .filter((part) => part.type === "text")
        .flatMap((part) =>
          part.text
            .split("\n")
            .filter((line) => line.startsWith("Jev loaded request reference:")),
        ),
    );
  return {
    loaded_reference_markers: {
      observed_count: readMarkers.length,
      observed_text_bytes: readMarkers.reduce(
        (sum, line) => sum + Buffer.byteLength(line),
        0,
      ),
      scope:
        "Visible marker text only; actual prefill/generation is charged in provider counters, never estimated from bytes.",
    },
    elapsed_ms: intervalsComplete
      ? intervalUnion + (advice?.elapsed_ms ?? 0)
      : null,
    observed_interval_lower_bound_ms:
      intervalUnion + (nonnegative(advice?.elapsed_ms) ? advice.elapsed_ms : 0),
    intervals_complete: intervalsComplete,
    observed_no_calls: observedNoCalls,
    usage: usageComplete ? usageLowerBound : null,
    usage_lower_bound: usageLowerBound,
    usage_complete: usageComplete,
    metrics: metricsComplete ? metricObservations : null,
    metrics_lower_bound: metricObservations,
    metrics_complete: metricsComplete,
    calls: actualCalls,
    responses,
    provenance: responses.map(
      ({ tool_call_id, record_id, request_sha256, response }) => ({
        tool_call_id,
        record_id,
        request_sha256,
        model: response?.model ?? null,
        metadata: response?.metadata ?? null,
      }),
    ),
    initialization_included_in_tool_intervals:
      actualCalls.length > 0 && intervalsComplete,
    native_cleanup_ms: null,
    scope:
      "Observed advice and selected tool wall intervals include initialization, classification, rendering and any closed error interval. Full native receipts retain completed usage/metrics/provenance, including partial failures. Native cleanup is not isolated; it remains included in end-to-end workflow elapsed time. Missing observations are unknown. No-call zero requires an actually completed observed agent run.",
  };
}

export function comparisonReport(runs, comparison) {
  const pairs = [];
  for (const item of runs.filter((run) => run.arm === "baseline")) {
    const candidate = runs.find(
      (run) =>
        run.arm === "candidate" &&
        run.task === item.task &&
        run.repetition === item.repetition,
    );
    if (!candidate) continue;
    const adviceSameInventory =
      comparison !== "advice" ||
      item.inventory_sha256 === candidate.inventory_sha256;
    const samePrompt =
      !!item.prompt_sha256 && item.prompt_sha256 === candidate.prompt_sha256;
    const ordinaryTools = (run) =>
      run.tool_catalog?.filter((tool) => !jevToolNames.has(tool.name));
    const sameExistingTools =
      Array.isArray(item.tool_catalog) &&
      Array.isArray(candidate.tool_catalog) &&
      JSON.stringify(ordinaryTools(item)) ===
        JSON.stringify(ordinaryTools(candidate));
    const sameReviewInput =
      item.workflow !== "review" && candidate.workflow !== "review"
        ? true
        : !!item.review_input_sha256 &&
          item.review_input_sha256 === candidate.review_input_sha256;
    const exactUsage =
      completeProviderUsage(item) && completeProviderUsage(candidate);
    const sameThinking =
      typeof item.thinking_level === "string" &&
      item.thinking_level === candidate.thinking_level;
    const sameSettings = sameObserved(
      observedSettings(item),
      observedSettings(candidate),
    );
    const sameGeneration = sameObserved(
      observedGeneration(item),
      observedGeneration(candidate),
    );
    const sameServer = sameObserved(
      serverBinding(item),
      serverBinding(candidate),
    );
    const sameSource = sameObserved(
      executedBinding(item),
      executedBinding(candidate),
    );
    const sameSfSources =
      Array.isArray(item.sf_factory_sources) &&
      item.sf_factory_sources.length > 0 &&
      Array.isArray(candidate.sf_factory_sources) &&
      item.sf_factory_sources.every((entry) => entry.path && entry.sha256) &&
      JSON.stringify(item.sf_factory_sources) ===
        JSON.stringify(candidate.sf_factory_sources);
    const tokenRatio =
      exactUsage && item.provider_usage.generated_tokens > 0
        ? candidate.provider_usage.generated_tokens /
          item.provider_usage.generated_tokens
        : null;
    const ratio =
      item.total_elapsed_ms > 0 && nonnegative(candidate.total_elapsed_ms)
        ? candidate.total_elapsed_ms / item.total_elapsed_ms
        : null;
    const jevWork = observeJevWork(candidate);
    pairs.push({
      task: item.task,
      repetition: item.repetition,
      same_raw_user_prompt: samePrompt,
      same_review_input: sameReviewInput,
      same_inventory_required: comparison === "advice",
      same_inventory: item.inventory_sha256 === candidate.inventory_sha256,
      same_existing_sf_and_builtin_tools: sameExistingTools,
      same_thinking_level: sameThinking,
      same_settings: sameSettings,
      same_generation_config: sameGeneration,
      same_owned_server_binding: sameServer,
      same_executed_source: sameSource,
      same_sf_factory_sources: sameSfSources,
      protocol_passed:
        samePrompt &&
        sameReviewInput &&
        adviceSameInventory &&
        sameExistingTools &&
        sameThinking &&
        sameSettings &&
        sameGeneration &&
        sameServer &&
        sameSource &&
        sameSfSources,
      baseline_passed: item.passed,
      candidate_passed: candidate.passed,
      both_accepted: item.passed === true && candidate.passed === true,
      baseline_ms: item.total_elapsed_ms,
      candidate_ms: candidate.total_elapsed_ms,
      candidate_to_baseline_elapsed_ratio: ratio,
      baseline_generated_tokens: exactUsage
        ? item.provider_usage.generated_tokens
        : null,
      candidate_generated_tokens: exactUsage
        ? candidate.provider_usage.generated_tokens
        : null,
      baseline_generated_tokens_lower_bound:
        item.provider_usage?.generated_tokens_lower_bound ?? null,
      candidate_generated_tokens_lower_bound:
        candidate.provider_usage?.generated_tokens_lower_bound ?? null,
      candidate_to_baseline_generated_token_ratio: tokenRatio,
      exact_generation_comparison_available: exactUsage,
      candidate_extra_jev_ms: jevWork.elapsed_ms,
      candidate_extra_jev_usage: jevWork.usage,
      candidate_extra_jev_metrics: jevWork.metrics,
      candidate_jev_work: jevWork,
      baseline_actual_provider_posts: (item.fetches ?? []).filter(
        (entry) => entry.method === "POST",
      ).length,
      candidate_actual_provider_posts: (candidate.fetches ?? []).filter(
        (entry) => entry.method === "POST",
      ).length,
      actual_provider_post_scope:
        "Observed calls; turn-count difference is not isolated causal attribution to Jev. All replay/argument/result/marker prefill costs remain in actual provider usage and workflow elapsed.",
      order: [item.execution_order, candidate.execution_order],
      first_arm:
        item.execution_order < candidate.execution_order
          ? "baseline"
          : "candidate",
      provider_prompt_scope:
        "Matched raw user prompt/input; SDK system prompt includes each isolated cwd and candidate has the added Jev catalog. Whole provider prompts differ and are retained verbatim.",
    });
  }
  return {
    pairs,
    accepted_pairs: pairs.filter((pair) => pair.both_accepted).length,
    cache_observations: [...runs]
      .sort((a, b) => a.execution_order - b.execution_order)
      .map((run, index, ordered) => ({
        task: run.task,
        repetition: run.repetition,
        arm: run.arm,
        execution_order: run.execution_order,
        pair_position:
          pairs.find(
            (pair) =>
              pair.task === run.task && pair.repetition === run.repetition,
          )?.first_arm === run.arm
            ? "first"
            : "second",
        previous_arm: run.previous_arm ?? ordered[index - 1]?.arm ?? null,
        workspace: run.workspace ?? null,
        cache_read_tokens:
          run.provider_usage?.complete === true
            ? (run.provider_usage.totals?.cacheRead ?? null)
            : null,
        cache_write_tokens:
          run.provider_usage?.complete === true
            ? (run.provider_usage.totals?.cacheWrite ?? null)
            : null,
        reported_cache_lower_bound: {
          read:
            run.provider_usage?.reported_usage_lower_bound?.cacheRead ?? null,
          write:
            run.provider_usage?.reported_usage_lower_bound?.cacheWrite ?? null,
        },
        server_posts: (run.fetches ?? [])
          .filter((entry) => entry.method === "POST")
          .map((entry) => ({
            sequence: entry.sequence,
            capture_complete: entry.response_capture_complete ?? false,
            usage: entry.server_usage ?? null,
            timings: entry.server_timings ?? null,
          })),
      })),
    limitations:
      "Authored local workflows; no SF business E2E. Failed arms have no accepted-result speedup. Ready server startup is excluded equally and server prefixes are observational/uncontrolled; first/second position, previous arm and actual cache counters are retained. No cold-model, GPU-memory, energy or monetary gain is established by this evaluator. Review and the four required repair outcomes remain separate.",
  };
}

/** Score every predeclared slot, using host gold to retain omissions as failures. */
export function reviewSuiteSummary(runs, expectedBatches, repetitions) {
  assert.ok(Array.isArray(expectedBatches) && expectedBatches.length);
  const expectedBatchIds = new Set(expectedBatches.map((batch) => batch.id));
  assert.equal(expectedBatchIds.size, expectedBatches.length);
  const expectedGroups = new Map();
  for (const batch of expectedBatches)
    for (const record of batch.records) {
      const group = expectedGroups.get(record.group_id) ?? {
        group_id: record.group_id,
        record_ids: [],
      };
      group.record_ids.push(record.id);
      expectedGroups.set(record.group_id, group);
    }
  const arms = {};
  for (const arm of ["baseline", "candidate"]) {
    const selected = runs.filter((run) => run.arm === arm);
    const unexpectedRuns = selected.filter(
      (run) =>
        !expectedBatchIds.has(run.task) ||
        !Number.isSafeInteger(run.repetition) ||
        run.repetition < 1 ||
        run.repetition > repetitions,
    );
    const slots = [],
      attempts = [];
    for (const batch of expectedBatches)
      for (let repetition = 1; repetition <= repetitions; repetition++) {
        const candidates = selected.filter(
          (run) => run.task === batch.id && run.repetition === repetition,
        );
        const run = candidates.length === 1 ? candidates[0] : null;
        const missing = scoreReviewFinal({
          text: "",
          records: batch.records,
        }).attempts;
        const observed = run?.acceptance?.attempts;
        const expectedIds = new Set(batch.records.map((record) => record.id));
        const exactIds =
          Array.isArray(observed) &&
          observed.length === batch.records.length &&
          observed.every((attempt) => expectedIds.has(attempt.record_id)) &&
          new Set(observed.map((attempt) => attempt.record_id)).size ===
            expectedIds.size;
        const row = {
          batch: batch.id,
          repetition,
          run,
          persisted:
            !!run &&
            run.worker_proof_present !== false &&
            Array.isArray(observed),
          complete:
            candidates.length === 1 &&
            run?.worker_proof_present !== false &&
            exactIds,
          attempts: [],
        };
        for (let index = 0; index < batch.records.length; index++) {
          const record = batch.records[index],
            matched = Array.isArray(observed)
              ? observed.filter((attempt) => attempt.record_id === record.id)
              : [];
          const usable =
            row.persisted &&
            matched.length === 1 &&
            matched[0].group_id === record.group_id &&
            matched[0].answers?.length === record.request.questions.length &&
            matched[0].answers.every(
              (answer, answerIndex) =>
                answer.question_id ===
                  record.request.questions[answerIndex].id &&
                answer.type === record.request.questions[answerIndex].type,
            );
          const attempt = {
            ...(usable ? matched[0] : missing[index]),
            batch_id: batch.id,
            repetition,
            coordinator_observed: usable,
          };
          if (!usable) row.complete = false;
          row.attempts.push(attempt);
          attempts.push(attempt);
        }
        slots.push(row);
      }
    const coverageGroups = [...expectedGroups.values()].map((group) => {
      const representations = group.record_ids.map((record_id) => ({
        record_id,
        repetitions: Array.from({ length: repetitions }, (_, index) => {
          const attempt = attempts.find(
            (value) =>
              value.record_id === record_id && value.repetition === index + 1,
          );
          return {
            repetition: index + 1,
            observed: attempt?.coordinator_observed === true,
            correct_judgment: attempt?.correct_judgment === true,
          };
        }),
      }));
      const observations = representations.flatMap(
        (representation) => representation.repetitions,
      );
      return {
        ...group,
        expected_repetitions: repetitions,
        representations,
        observed_judgments: observations.filter((row) => row.observed).length,
        complete:
          group.record_ids.length === 2 &&
          observations.every((row) => row.observed),
        correct_judgment_rate:
          observations.filter((row) => row.correct_judgment).length /
          observations.length,
      };
    });
    const expectedJudgments =
      expectedBatches.reduce((sum, batch) => sum + batch.records.length, 0) *
      repetitions;
    const coverage = {
      complete:
        unexpectedRuns.length === 0 &&
        slots.every((slot) => slot.complete) &&
        attempts.length === expectedJudgments &&
        coverageGroups.every((group) => group.complete),
      expected_judgments: expectedJudgments,
      observed_judgments: attempts.filter(
        (attempt) => attempt.coordinator_observed,
      ).length,
      scored_judgments: attempts.length,
      expected_runs: expectedBatches.length * repetitions,
      observed_runs: selected.length,
      missing_worker_proofs: slots.filter((slot) => !slot.persisted).length,
      invalid_run_slots: slots
        .filter((slot) => !slot.complete)
        .map((slot) => ({ batch: slot.batch, repetition: slot.repetition })),
      unexpected_run_slots: unexpectedRuns.map((run) => ({
        batch: run.task,
        repetition: run.repetition,
      })),
      unique_groups: coverageGroups.length,
      groups: coverageGroups,
    };
    const quality = summarizeReviewAttempts(attempts);
    quality.work = hostScoringWork();
    const usageComplete =
      coverage.complete &&
      slots.every((slot) => completeProviderUsage(slot.run));
    const elapsedComplete =
      coverage.complete &&
      slots.every((slot) => nonnegative(slot.run?.total_elapsed_ms));
    const totalMs = elapsedComplete
      ? slots.reduce((sum, slot) => sum + slot.run.total_elapsed_ms, 0)
      : null;
    const jevWorks = slots.map((slot) => observeJevWork(slot.run ?? {}));
    arms[arm] = {
      runs: selected.length,
      accepted_batches: slots.filter(
        (slot) => slot.complete && slot.run?.passed === true,
      ).length,
      functional_workflows_passed:
        coverage.complete && slots.every((slot) => slot.run?.passed === true),
      coverage,
      quality,
      group_quality: {
        groups: coverageGroups.length,
        complete_groups: coverageGroups.filter((group) => group.complete)
          .length,
        mean_correct_judgment_rate:
          coverageGroups.reduce(
            (sum, group) => sum + group.correct_judgment_rate,
            0,
          ) / coverageGroups.length,
        scope:
          "Context groups are the authored scenario unit. State/chat variants and repetitions are paired coverage, not additional independent scenarios.",
      },
      generated_tokens: usageComplete
        ? slots.reduce(
            (sum, slot) => sum + slot.run.provider_usage.generated_tokens,
            0,
          )
        : null,
      generated_tokens_lower_bound: selected.reduce(
        (sum, run) =>
          sum +
          (nonnegative(run.provider_usage?.generated_tokens_lower_bound)
            ? run.provider_usage.generated_tokens_lower_bound
            : 0),
        0,
      ),
      usage_complete: usageComplete,
      elapsed_complete: elapsedComplete,
      elapsed_all_runs_ms: totalMs,
      observed_elapsed_lower_bound_ms: selected.reduce(
        (sum, run) =>
          sum + (nonnegative(run.total_elapsed_ms) ? run.total_elapsed_ms : 0),
        0,
      ),
      elapsed_all_runs_per_accepted_judgment_ms:
        totalMs !== null && quality.accepted_correct_judgments > 0
          ? totalMs / quality.accepted_correct_judgments
          : null,
      elapsed_all_runs_per_completed_clear_decision_ms:
        totalMs !== null && quality.completed_clear_decisions > 0
          ? totalMs / quality.completed_clear_decisions
          : null,
      timing_unit:
        "One six-record mixed batch workflow per repetition; 13 batches x3 repetitions in full confirmation. Group timing is not separately identifiable.",
      jev_work: {
        usage_complete:
          coverage.complete && jevWorks.every((work) => work.usage_complete),
        intervals_complete:
          coverage.complete &&
          jevWorks.every((work) => work.intervals_complete),
        usage:
          coverage.complete && jevWorks.every((work) => work.usage_complete)
            ? {
                input_tokens: jevWorks.reduce(
                  (sum, work) => sum + work.usage.input_tokens,
                  0,
                ),
                output_tokens: jevWorks.reduce(
                  (sum, work) => sum + work.usage.output_tokens,
                  0,
                ),
              }
            : null,
        elapsed_ms:
          coverage.complete && jevWorks.every((work) => work.intervals_complete)
            ? jevWorks.reduce((sum, work) => sum + work.elapsed_ms, 0)
            : null,
        native_cleanup_ms: null,
        scope:
          "Actual selected tool intervals/receipts; cleanup included only in full workflow elapsed. Process sampling excludes Jev native child RSS and cannot prove GPU/energy savings.",
      },
      jev_selected_batches: selected.filter((run) =>
        run.selected_tools?.some((tool) => jevToolNames.has(tool.name)),
      ).length,
      loaded_reference_calls: selected
        .flatMap((run) => run.selected_tools ?? [])
        .filter((tool) => tool.name === "jev_classify_loaded").length,
      generic_jev_calls: selected
        .flatMap((run) => run.selected_tools ?? [])
        .filter((tool) => tool.name === "jev_classify").length,
    };
  }
  const fullSelection =
    expectedBatches.length === 13 &&
    expectedGroups.size === 39 &&
    expectedBatches.reduce((sum, batch) => sum + batch.records.length, 0) ===
      78;
  const coverageComplete =
    fullSelection &&
    ["baseline", "candidate"].every((arm) => arms[arm].coverage.complete);
  return {
    selected_batches: expectedBatches.length,
    required_batches: 13,
    repetitions,
    required_confirmation_repetitions: 3,
    coverage_complete: coverageComplete,
    full_confirmation_complete:
      coverageComplete &&
      repetitions === 3 &&
      ["baseline", "candidate"].every(
        (arm) =>
          arms[arm].coverage.expected_runs === 39 &&
          arms[arm].coverage.scored_judgments === 234 &&
          arms[arm].coverage.observed_judgments === 234,
      ),
    independent_context_groups: expectedGroups.size,
    expected_context_groups: 39,
    authored_representation_pairs_not_independent: true,
    timing_unit:
      "13 mixed batch workflows x3 repetitions per arm; 39 context groups are quality clusters, not 39 independent workflow timings.",
    arms,
    interpretation:
      "Review evidence is separate from every required repair outcome. Pilot/partial/failed/incomplete-usage results cannot establish complete-suite speed or generation saving. summary.passed is functional acceptance only; improvement has separate gates.",
  };
}

/** Predeclared full-workflow gain thresholds, with omissions/unknown work fail-closed. */
export function reviewImprovementGates(suite, paired) {
  const arms = [suite.arms.baseline, suite.arms.candidate];
  const coveragePassed = suite.full_confirmation_complete === true;
  const qualityPassed =
    arms.every((arm) => arm.quality.gates.passed === true) &&
    suite.arms.candidate.quality.correct_judgment_rate >=
      suite.arms.baseline.quality.correct_judgment_rate &&
    suite.arms.candidate.group_quality.mean_correct_judgment_rate >=
      suite.arms.baseline.group_quality.mean_correct_judgment_rate;
  const functionalPassed = arms.every(
    (arm) => arm.functional_workflows_passed === true,
  );
  const protocolPassed =
    paired.pairs.length === 39 &&
    paired.pairs.every(
      (pair) => pair.protocol_passed === true && pair.both_accepted === true,
    );
  const providerUsageComplete = arms.every(
    (arm) => arm.usage_complete === true,
  );
  const jevUsageComplete =
    suite.arms.candidate.jev_work.usage_complete === true &&
    suite.arms.candidate.jev_work.intervals_complete === true;
  const elapsedComplete =
    arms.every((arm) => arm.elapsed_complete === true) &&
    paired.pairs.every((pair) =>
      finite(pair.candidate_to_baseline_elapsed_ratio),
    );
  const resourceEligible =
    coveragePassed &&
    qualityPassed &&
    functionalPassed &&
    protocolPassed &&
    providerUsageComplete &&
    jevUsageComplete &&
    elapsedComplete;
  const elapsedRatio = elapsedComplete
    ? median(
        paired.pairs.map((pair) => pair.candidate_to_baseline_elapsed_ratio),
      )
    : null;
  const totalElapsedRatio =
    elapsedComplete && suite.arms.baseline.elapsed_all_runs_ms > 0
      ? suite.arms.candidate.elapsed_all_runs_ms /
        suite.arms.baseline.elapsed_all_runs_ms
      : null;
  const generationRatio =
    providerUsageComplete && suite.arms.baseline.generated_tokens > 0
      ? suite.arms.candidate.generated_tokens /
        suite.arms.baseline.generated_tokens
      : null;
  const noElapsedRegression =
    elapsedRatio !== null &&
    totalElapsedRatio !== null &&
    elapsedRatio <= 1 &&
    totalElapsedRatio <= 1;
  const elapsedGain =
    resourceEligible && elapsedRatio <= 0.8 && totalElapsedRatio <= 1;
  const generativeGain =
    resourceEligible &&
    generationRatio !== null &&
    generationRatio <= 0.7 &&
    noElapsedRegression;
  return {
    coverage_passed: coveragePassed,
    quality_passed: qualityPassed,
    functional_workflows_passed: functionalPassed,
    protocol_passed: protocolPassed,
    provider_usage_complete: providerUsageComplete,
    jev_usage_complete: jevUsageComplete,
    elapsed_complete: elapsedComplete,
    resource_claim_eligible: resourceEligible,
    median_elapsed_gain_threshold: 0.2,
    total_generated_token_gain_threshold: 0.3,
    median_paired_elapsed_ratio: elapsedRatio,
    total_elapsed_ratio: totalElapsedRatio,
    total_generated_token_ratio: generationRatio,
    no_elapsed_regression: noElapsedRegression,
    elapsed_gain_passed: elapsedGain,
    generative_gain_passed: generativeGain,
    passed: elapsedGain || generativeGain,
    scope:
      "Latency and actual generated-work gain only on the full frozen review workflow. Ready-server prefix/cache conditions remain observational. This does not establish cold-model, complete memory/energy, monetary or repair-workflow gains.",
  };
}
async function main() {
  assert.ok(["baseline", "candidate", "pair"].includes(values.arm));
  assert.ok(["ordinary", "advice"].includes(values.comparison));
  assert.ok(["repair", "review"].includes(values.workflow));
  if (values.workflow === "review") {
    assert.equal(
      values.comparison,
      "ordinary",
      "Review measures ordinary Pi versus autonomous Jev tools; no diagnostic advice hook",
    );
    assert.ok(
      !values.task,
      "Use the fixed first --batch 1 pilot or the complete review suite",
    );
    if (values.batch !== undefined)
      assert.equal(
        integer(values.batch, "--batch", 13),
        1,
        "The pilot is the first frozen mixed batch, never a selected easy subset",
      );
  } else
    assert.ok(values.batch === undefined, "--batch applies to review only");
  assert.ok(["auto", "cpu", "metal"].includes(values["classifier-device"]));
  assert.ok(
    ["counterbalanced", "baseline-first", "candidate-first"].includes(
      values.order,
    ),
  );
  assert.ok(
    ["off", "minimal", "low", "medium", "high", "xhigh"].includes(
      values["thinking-level"],
    ),
  );
  const repetitions = integer(
      values.repetitions ?? (values.workflow === "review" ? "3" : "1"),
      "--repetitions",
    ),
    timeoutMs = integer(values["timeout-ms"], "--timeout-ms", 3600000);
  const output = resolve(
    values.output ??
      join(
        root,
        ".build/developer-task-eval",
        new Date().toISOString().replaceAll(":", "-") +
          "-" +
          randomUUID().slice(0, 8),
      ),
  );
  assert.ok(
    inside(resolve(root, ".build"), output),
    "Output must be an isolated .build directory",
  );
  assert.ok(
    !(await stat(output).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    )),
    "Output already exists; use a fresh evidence directory",
  );
  await mkdir(output, { recursive: true, mode: 0o700 });
  const tasks =
    values.workflow === "review"
      ? []
      : (values.task ??
        (await readdir(fixtureRoot, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort());
  if (values.workflow !== "review")
    assert.ok(
      tasks.length && tasks.every((task) => /^[a-z][a-z0-9-]+$/.test(task)),
    );
  let prepared = [],
    reviewDataset = null;
  if (values.workflow === "review") {
    const review = await prepareReviewBatches(output);
    reviewDataset = review.frozen;
    prepared = values.batch ? review.batches.slice(0, 1) : review.batches;
  } else
    for (const task of tasks) prepared.push(await prepareTask(task, output));
  let registryPath = null;
  if (values["classifier-registry-path"]) {
    registryPath = await realpath(resolve(values["classifier-registry-path"]));
    assert.ok(
      inside(await realpath(resolve(root, ".build")), registryPath),
      "Research classifier registry must be explicitly scoped under .build",
    );
  }
  const protocol = {
    schema_version: 1,
    started_at: new Date().toISOString(),
    prepare_only: values["prepare-only"],
    workflow: values.workflow,
    review_dataset: reviewDataset,
    required_repair_lane: [
      "nullable-contact",
      "abortable-refresh",
      "exclusive-window",
      "latest-request",
    ],
    review_confirmation:
      values.workflow === "review"
        ? {
            required_records: 78,
            required_context_groups: 39,
            required_batches: 13,
            required_repetitions: 3,
            selected_batches: prepared.length,
            pilot: prepared.length < 13 || repetitions !== 3,
            frozen_first_batch_pilot: values.batch !== undefined,
          }
        : null,
    comparison: values.comparison,
    arms: values.arm,
    repetitions,
    order: values.order,
    actual_provider_stream: "Pi SDK unmodified",
    tool_choice: "automatic",
    same_settings: null,
    same_settings_intent: true,
    settings_scope:
      "Shared requested policy; actual parity is verified from worker SDK observations, never inferred from intent",
    retries: 0,
    compaction: false,
    thinking_level: values["thinking-level"],
    advice_injection_policy:
      "developer-advice-concise-v1; exact model, advisory:true, calibrated:false, diagnosis and description, evidence sufficiency estimate/range, exact evidence proposition/estimate/unknown reference and actual diagnosis probabilities; full answer/metrics/provenance in proof and typed details only",
    candidate_only_change:
      values.workflow === "review"
        ? "Normal Jev generic/loaded-reference tool catalog with autonomous selection; ordinary baseline has no Jev. No routing, evaluation or pre-agent diagnostic advice. Successful ordinary read result stays visible/prefilled in both arms."
        : values.comparison === "ordinary"
          ? "Jev extension/tool catalog plus grounded before_agent_start advice; ordinary baseline has no Jev"
          : "Grounded before_agent_start advice; Jev installed and routing/evaluation off in both arms",
    task_scope:
      values.workflow === "review"
        ? "Complete frozen authored developer validation evidence review, hidden targets, full uncertainty/fractional rubric semantics; separate from required repair results and live Salesforce E2E"
        : "Authored local TypeScript repair fixtures, fixed acceptance tests and tsc; not live Salesforce E2E",
    sandbox:
      "Both arms permit only designated local source edits, fixture reads, exact acceptance commands and limited local inspection; all SF tools stay visible but remote/account execution is unauthorized",
    prefix_state:
      "Owned Gemma4 server remains ready; native prefix/cache warm state uncontrolled, SDK session/factory state fresh for every arm. Execution order and cache counters recorded.",
    classifier_state:
      values.workflow === "review"
        ? "Actual scoped Jev extension starts cold per run; any selected native initialization/classification/cleanup costs included. No request cache/output substitution in evaluator."
        : "Candidate recipe classifier starts cold per run; initialization/classification/disposal all included",
    timeout_ms_per_arm: timeoutMs,
    identities: await identities(),
    prepared: prepared.map((item) => ({
      id: item.id,
      prompt_sha256: item.prompt_sha256,
      original_failure: item.initial,
      fixture_files: item.fixture_files,
    })),
    runs: [],
    paired: null,
  };
  await save(join(output, "protocol.json"), protocol);
  if (values["prepare-only"]) {
    await save(join(output, "summary.json"), {
      ...protocol,
      status: "prepared",
      passed: true,
      passed_scope:
        "Preparation checks only; zero model calls do not establish workflow acceptance or improvement",
      functional_acceptance: null,
      review_gain_gates:
        values.workflow === "review"
          ? {
              resource_claim_eligible: false,
              passed: false,
              reason: "Preparation only; no actual review judgments or usage",
            }
          : null,
      model_calls: 0,
      provider_calls: 0,
    });
    console.log(
      JSON.stringify({
        prepared_tasks: prepared.map((item) => item.id),
        passed: true,
        model_calls: 0,
        output,
      }),
    );
    return;
  }
  assert.equal(
    process.env.JEV_DEVELOPER_TASK_CLEARANCE,
    "ROOT_APPROVED",
    "Root must explicitly clear actual inference before running",
  );
  const baseUrl = new URL(values["base-url"]);
  assert.equal(baseUrl.protocol, "http:");
  assert.equal(baseUrl.hostname, "127.0.0.1");
  const model = {
    id: "google/gemma-4-31B-it-qat-q4_0",
    name: "Local Google Gemma 4 31B Instruct QAT Q4_0",
    provider: "local-gemma",
    api: "openai-completions",
    baseUrl: values["base-url"],
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 4096,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStrictMode: false,
      maxTokensField: "max_tokens",
      requiresToolResultName: true,
      thinkingFormat: "chat-template",
      chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } },
    },
  };
  const expectedReviewBatches =
    values.workflow === "review"
      ? await Promise.all(
          prepared.map(async (batch) => ({
            id: batch.id,
            records: JSON.parse(await readFile(batch.host_gold_path, "utf8")),
          })),
        )
      : null;
  let executionOrder = 0;
  for (let repetition = 1; repetition <= repetitions; repetition++)
    for (let taskIndex = 0; taskIndex < prepared.length; taskIndex++) {
      const task = prepared[taskIndex];
      const first =
        values.order === "candidate-first" ||
        (values.order === "counterbalanced" &&
          (repetition + taskIndex) % 2 === 0)
          ? "candidate"
          : "baseline";
      const arms =
        values.arm === "pair"
          ? [first, first === "baseline" ? "candidate" : "baseline"]
          : [values.arm];
      for (const arm of arms) {
        const directory = join(
            output,
            "runs",
            `${task.id}-r${repetition}-${arm}`,
          ),
          workspace = join(directory, "workspace"),
          agentDir = join(directory, "agent");
        await mkdir(agentDir, { recursive: true, mode: 0o700 });
        await cp(task.origin, workspace, {
          recursive: true,
          filter: (path) => !path.split(sep).includes(".compiled"),
        });
        await snapshotTask(
          workspace,
          join(directory, "source-before"),
          task.kind,
        );
        const environment = cleanEnvironment(agentDir);
        const config = {
          directory,
          workspace,
          agent_dir: agentDir,
          prepared: task,
          arm,
          comparison: values.comparison,
          repetition,
          execution_order: ++executionOrder,
          previous_arm: protocol.runs.at(-1)?.arm ?? null,
          pair_position: arm === first ? "first" : "second",
          timeout_ms: timeoutMs,
          model,
          base_url: values["base-url"],
          state_file: resolve(values["state-file"]),
          sf_pi_path: resolve(values["sf-pi-path"]),
          thinking_level: values["thinking-level"],
          classifier_model: values["classifier-model"],
          classifier_model_file: values["classifier-model-file"]
            ? resolve(values["classifier-model-file"])
            : null,
          classifier_registry_path: registryPath,
          classifier_device: values["classifier-device"],
          stripped_environment_names: environment.stripped_names,
        };
        const configPath = join(directory, "config.json");
        await save(configPath, config);
        const invocation = await command(
          [process.execPath, script, "--worker", configPath],
          root,
          timeoutMs + 90000,
          environment.env,
        );
        await save(join(directory, "invocation.json"), invocation);
        await save(
          join(directory, "worker.log"),
          invocation.stdout + invocation.stderr,
        );
        let proof;
        try {
          proof = JSON.parse(
            await readFile(join(directory, "proof.json"), "utf8"),
          );
          proof.worker_proof_present = true;
        } catch (error) {
          proof = {
            task: task.id,
            workflow: task.kind ?? "repair",
            workspace,
            review_input_sha256: task.input_sha256 ?? null,
            previous_arm: config.previous_arm,
            pair_position: config.pair_position,
            worker_proof_present: false,
            arm,
            comparison: values.comparison,
            repetition,
            execution_order: config.execution_order,
            passed: false,
            total_elapsed_ms: invocation.elapsed_ms,
            prompt_sha256: task.prompt_sha256,
            provider_usage: {
              generated_tokens: null,
              complete: false,
              generated_tokens_lower_bound: 0,
              accounting: "Missing worker proof; exact work unknown",
            },
            errors: [`Worker did not persist proof: ${error}`],
          };
          if (task.kind === "review") {
            const records = expectedReviewBatches.find(
              (batch) => batch.id === task.id,
            ).records;
            proof.acceptance = scoreReviewFinal({ text: "", records });
            proof.acceptance.summary.work = hostScoringWork();
            proof.acceptance.failure_scope =
              "Missing worker proof; all six expected host-gold judgments retained as failures";
          }
        }
        protocol.runs.push(proof);
        protocol.paired = comparisonReport(protocol.runs, values.comparison);
        protocol.same_settings =
          protocol.paired.pairs.length === prepared.length * repetitions
            ? protocol.paired.pairs.every((pair) => pair.same_settings)
            : null;
        if (values.workflow === "review")
          protocol.review_suite = await reviewSuiteSummary(
            protocol.runs,
            expectedReviewBatches,
            repetitions,
          );
        if (values.workflow === "review")
          protocol.review_gain_gates = reviewImprovementGates(
            protocol.review_suite,
            protocol.paired,
          );
        await save(join(output, "summary.json"), {
          ...protocol,
          finished_at: new Date().toISOString(),
          passed_scope:
            "Functional workflow acceptance only; review quality, coverage and improvement gates are separate",
          evaluation_complete:
            protocol.runs.length ===
            prepared.length * repetitions * (values.arm === "pair" ? 2 : 1),
          functional_acceptance:
            protocol.runs.every((run) => run.passed) &&
            protocol.paired.pairs.every((pair) => pair.protocol_passed),
          passed:
            protocol.runs.every((run) => run.passed) &&
            protocol.paired.pairs.every((pair) => pair.protocol_passed),
        });
        console.log(
          JSON.stringify({
            task: task.id,
            arm,
            repetition,
            passed: proof.passed,
            elapsed_ms: proof.total_elapsed_ms,
            generated_tokens: proof.provider_usage.generated_tokens,
            output: directory,
          }),
        );
      }
    }
  process.exitCode =
    protocol.runs.every((run) => run.passed) &&
    protocol.paired.pairs.every((pair) => pair.protocol_passed)
      ? 0
      : 1;
}

if (invokedAsScript) {
  try {
    if (values.worker) await worker(resolve(values.worker));
    else await main();
  } catch (error) {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  }
}
