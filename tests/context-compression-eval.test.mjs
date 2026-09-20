import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const origin =
  "https://eng-ai-model-gateway.sfproxy.devx-preprod.aws-esvc1-useast2.aws.sfdc.cl";
const syntheticKey = "SYNTHETIC_KEY_NO_NETWORK";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sourceNames = [
  "scripts/context-compression-eval.mjs",
  "src/context-compression.ts",
  "dist/context-compression.js",
];
// Copy only public code; each test pins and changes its own isolated snapshot.
const sources = await Promise.all(
  sourceNames.map((name) =>
    readFile(fileURLToPath(new URL(`../${name}`, import.meta.url))),
  ),
);

const stub = String.raw`
import { appendFileSync } from "node:fs";
const mode = process.env.JEV_EVAL_STUB_MODE;
const trace = process.env.JEV_EVAL_STUB_TRACE;
const log = (event) => appendFileSync(trace, JSON.stringify(event) + "\n");
let callIndex = 0;
globalThis.fetch = async (url, options) => {
  if (url !== "${origin}/v1/chat/completions" || options.method !== "POST" ||
      options.redirect !== "error" || options.headers.authorization !== "Bearer ${syntheticKey}") {
    throw new Error("Fetch stub refused unexpected request; no network is permitted");
  }
  const body = JSON.parse(options.body);
  const payload = JSON.parse(body.messages[1].content);
  const judge = Object.hasOwn(payload, "original_context");
  const index = ++callIndex;
  log({ event: "request", body, payload });
  if (index === 1 && mode === "oversized") {
    const chunk = new TextEncoder().encode("é".repeat(1024 * 1024));
    let chunks = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        log({ event: "body-chunk", index: ++chunks, bytes: chunk.byteLength });
        controller.enqueue(chunk);
      },
      cancel() { log({ event: "body-cancelled", chunks }); },
    }));
  }
  if (index === 1 && mode === "malformed-response") {
    return new Response('{"apiKey":SYNTHETIC_PRIVATE_RESPONSE_MARKER}');
  }
  let content = judge ? JSON.stringify({
    preserved: true, facts: true, errors_and_uncertainty: true,
    order_and_multiplicity: true, task_answerable: true, issues: [],
  }) : '{"value":7}';
  if (index === 1) {
    if (mode === "duplicate") content = '{"value":0,"value":7}';
    if (mode === "escaped-duplicate") content = '{"value":0,"\\u0076alue":7}';
    if (mode === "nested-duplicate") content = '{"value":7,"meta":{"key":0,"key":1}}';
    if (mode === "fenced") content = '\x60\x60\x60json\n{"value":7}\n\x60\x60\x60';
    if (mode === "array") content = '[{"value":7}]';
  }
  if (!judge && mode === "separate-scopes") content = JSON.stringify({
    value: 7, left: { same: 1 }, right: { same: 2 },
    text: 'literal { "same": 3 } and escaped quote "',
    items: [{ same: 4 }, { same: 5 }],
  });
  return new Response(JSON.stringify({
    model: "grok-4.6",
    choices: [{ message: { content }, finish_reason: index === 1 && mode === "incomplete" ? "length" : "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105,
      prompt_tokens_details: { cached_tokens: 40 } },
  }));
};
`;

function record(overrides = {}) {
  return {
    id: "synthetic-case",
    group_id: "synthetic-group",
    context: "value=7\n".repeat(250),
    task: 'Return exactly {"value":7}.',
    expected: { value: 7 },
    ...overrides,
  };
}

async function sandbox(t, records = [record()]) {
  const directory = await mkdtemp(join(tmpdir(), "jev-context-eval-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of ["scripts", "src", "dist"]) {
    await mkdir(join(directory, name));
  }
  for (let i = 0; i < sourceNames.length; i++) {
    await writeFile(join(directory, sourceNames[i]), sources[i]);
  }
  const state = {
    directory,
    script: join(directory, sourceNames[0]),
    fixture: join(directory, "synthetic-fixture.json"),
    registration: join(directory, "synthetic-registration.json"),
    key: join(directory, "synthetic-key.txt"),
    output: join(directory, "result.json"),
    stub: join(directory, "fetch-stub.mjs"),
    trace: join(directory, "requests.jsonl"),
  };
  await writeFile(join(directory, "package.json"), '{"type":"module"}');
  await writeFile(state.stub, stub);
  await writeFile(state.trace, "");
  await writeFile(state.fixture, JSON.stringify({ records }));
  await writeFile(
    state.registration,
    JSON.stringify({
      providers: {
        llmgw: {
          api: "openai-completions",
          baseUrl: `${origin}/v1`,
          models: [
            {
              id: "grok-4.6",
              name: "Synthetic registration; CPU test only",
              reasoning: true,
              contextWindow: 100000,
              maxTokens: 8192,
            },
          ],
        },
      },
    }),
  );
  await writeFile(state.key, syntheticKey, { mode: 0o600 });
  return state;
}

async function invoke(state, { run = false, mode = "success" } = {}) {
  const args = [
    "--import",
    pathToFileURL(state.stub).href,
    state.script,
    "--fixture",
    state.fixture,
    "--models-file",
    state.registration,
    "--output",
    state.output,
  ];
  if (run) args.push("--run", "--api-key-file", state.key);
  const options = {
    cwd: state.directory,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    // No inherited credentials, NODE_OPTIONS, or gateway configuration.
    env: { JEV_EVAL_STUB_MODE: mode, JEV_EVAL_STUB_TRACE: state.trace },
  };
  try {
    return { code: 0, ...(await execute(process.execPath, args, options)) };
  } catch (error) {
    if (error.killed || typeof error.code !== "number") throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

const result = async (state) =>
  JSON.parse(await readFile(state.output, "utf8"));
const events = async (state) =>
  (await readFile(state.trace, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

test("a prepared protocol is consumed unchanged and an attempted run cannot be overwritten", async (t) => {
  const state = await sandbox(t);
  const prepared = await invoke(state);
  assert.equal(prepared.code, 0, prepared.stderr);
  assert.equal((await result(state)).status, "prepared");
  assert.deepEqual(await events(state), []);
  const protocolBytes = await readFile(`${state.output}.protocol.json`, "utf8");
  const protocol = JSON.parse(protocolBytes);
  assert.deepEqual(protocol.source_sha256, {
    runner: hash(sources[0]),
    compressor_source: hash(sources[1]),
    compressor_runtime: hash(sources[2]),
  });

  const completed = await invoke(state, { run: true });
  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(
    await readFile(`${state.output}.protocol.json`, "utf8"),
    protocolBytes,
  );
  const observed = await result(state);
  assert.equal(observed.protocol_sha256, hash(protocolBytes));
  assert.equal(observed.status, "completed");
  assert.equal(observed.expected_cases, 1);
  assert.equal(observed.calls.length, 3);
  assert.equal(observed.summary.call_errors, 0);
  assert.equal(observed.summary.original_correct, 1);
  assert.equal(observed.summary.compressed_correct, 1);
  assert.equal(observed.summary.judge_passed, 1);

  const resultBytes = await readFile(state.output, "utf8");
  const repeated = await invoke(state, { run: true });
  assert.equal(repeated.code, 1);
  assert.match(repeated.stderr, /Refusing to overwrite an attempted run/);
  assert.equal(await readFile(state.output, "utf8"), resultBytes);
  assert.equal((await events(state)).length, 3);
});

test("frozen input and source changes are refused before fetching", async (t) => {
  for (const change of ["input", "source"]) {
    await t.test(change, async (t) => {
      const state = await sandbox(t);
      assert.equal((await invoke(state)).code, 0);
      const resultBytes = await readFile(state.output, "utf8");
      const protocolBytes = await readFile(
        `${state.output}.protocol.json`,
        "utf8",
      );
      const target =
        change === "input"
          ? state.fixture
          : join(state.directory, sourceNames[1]);
      await writeFile(target, `${await readFile(target, "utf8")}\n`);
      const refused = await invoke(state, { run: true });
      assert.equal(refused.code, 1);
      assert.match(
        refused.stderr,
        /Frozen protocol differs from current source or inputs/,
      );
      assert.equal(await readFile(state.output, "utf8"), resultBytes);
      assert.equal(
        await readFile(`${state.output}.protocol.json`, "utf8"),
        protocolBytes,
      );
      assert.deepEqual(await events(state), []);
    });
  }
});

test("a partial attempted result is refused even when no call receipt exists", async (t) => {
  const state = await sandbox(t);
  assert.equal((await invoke(state)).code, 0);
  const attempted = { ...(await result(state)), status: "running" };
  await writeFile(state.output, JSON.stringify(attempted));
  const refused = await invoke(state, { run: true });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Refusing to overwrite an attempted run/);
  assert.deepEqual(await result(state), attempted);
  assert.deepEqual(await events(state), []);
});

test("malformed registration errors do not retain source or synthetic credential snippets", async (t) => {
  const state = await sandbox(t);
  await writeFile(
    state.registration,
    '{"apiKey":SYNTHETIC_PRIVATE_CONFIG_MARKER}',
  );
  const rejected = await invoke(state, { run: true });
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /Cannot read or parse model registration JSON/);
  assert.doesNotMatch(
    rejected.stderr + rejected.stdout,
    /SYNTHETIC|apiKey|Unexpected token/,
  );
  assert.deepEqual(await events(state), []);
});

test("incomplete responses retain usage but fail scoring without shrinking the denominator", async (t) => {
  const state = await sandbox(t);
  assert.equal(
    (await invoke(state, { run: true, mode: "incomplete" })).code,
    1,
  );
  const observed = await result(state);
  assert.equal(observed.expected_cases, 1);
  assert.equal(observed.calls.length, 3);
  assert.equal(observed.cases[0].original.finish_reason, "length");
  assert.equal(observed.cases[0].original.assistant_text, '{"value":7}');
  assert.equal(observed.cases[0].original.usage.prompt_tokens, 100);
  assert.match(
    observed.cases[0].original.error,
    /incomplete or has unknown finish reason/,
  );
  assert.equal(observed.summary.original_correct, 0);
  assert.equal(observed.summary.compressed_correct, 1);
  assert.equal(observed.summary.judge_passed, 1);
  assert.equal(observed.summary.call_errors, 1);
});

test("ambiguous or wrapped answers fail, while repeated keys in separate objects remain valid", async (t) => {
  for (const mode of [
    "duplicate",
    "escaped-duplicate",
    "nested-duplicate",
    "fenced",
    "array",
  ]) {
    await t.test(mode, async (t) => {
      const state = await sandbox(t);
      assert.equal((await invoke(state, { run: true, mode })).code, 1);
      const observed = await result(state);
      const expectedError = mode.includes("duplicate")
        ? /duplicate object keys/
        : mode === "fenced"
          ? /not bare valid JSON/
          : /must be an object/;
      assert.match(observed.cases[0].original.error, expectedError);
      assert.equal(observed.summary.original_correct, 0);
      assert.equal(observed.summary.call_errors, 1);
      assert.equal(observed.calls.length, 3);
    });
  }
  await t.test("separate-scopes", async (t) => {
    const expected = {
      value: 7,
      left: { same: 1 },
      right: { same: 2 },
      text: 'literal { "same": 3 } and escaped quote "',
      items: [{ same: 4 }, { same: 5 }],
    };
    const state = await sandbox(t, [record({ expected })]);
    const completed = await invoke(state, {
      run: true,
      mode: "separate-scopes",
    });
    assert.equal(completed.code, 0, completed.stderr);
    assert.deepEqual((await result(state)).cases[0].original.answer, expected);
  });
});

test("trusted format labels distinguish an encoding from envelope-looking literal text", async (t) => {
  const literal =
    '{"format":"tool-result-line-rle-v1","segments":[{"text":"quoted value","repeat":9}]}';
  const state = await sandbox(t, [
    record(),
    record({ id: "literal-case", group_id: "literal-group", context: literal }),
  ]);
  const completed = await invoke(state, { run: true });
  assert.equal(completed.code, 0, completed.stderr);
  const requests = await events(state);
  assert.equal(requests.length, 6);
  assert.equal(requests[0].payload.context_format, "identity");
  assert.equal(requests[1].payload.context_format, "tool-result-line-rle-v1");
  assert.equal(requests[2].payload.original_context_format, "identity");
  assert.equal(
    requests[2].payload.candidate_context_format,
    "tool-result-line-rle-v1",
  );
  for (const index of [3, 4]) {
    assert.equal(requests[index].payload.context_format, "identity");
    assert.equal(requests[index].payload.context, literal);
  }
  assert.equal(requests[5].payload.candidate_context_format, "identity");
  assert.equal(requests[5].payload.candidate_context, literal);
  assert.match(
    requests[0].body.messages[0].content,
    /identity means literal text/,
  );
  assert.match(
    requests[2].body.messages[0].content,
    /Decode only a context labelled/,
  );
});

test("malformed gateway JSON uses a safe error and leaves unknown usage unknown", async (t) => {
  const state = await sandbox(t);
  const rejected = await invoke(state, {
    run: true,
    mode: "malformed-response",
  });
  assert.equal(rejected.code, 1);
  const observed = await result(state);
  assert.equal(
    observed.cases[0].original.error,
    "Gateway response is not valid JSON",
  );
  assert.equal(observed.summary.original_task_prompt_tokens, null);
  assert.equal(observed.summary.prompt_token_reduction_fraction, null);
  assert.doesNotMatch(
    JSON.stringify(observed) + rejected.stdout + rejected.stderr,
    /SYNTHETIC_PRIVATE_RESPONSE|apiKey|Unexpected token/,
  );
  assert.equal(observed.calls.length, 3);
});

test("a multibyte response exceeding 8 MiB is cancelled during the bounded read", async (t) => {
  const state = await sandbox(t);
  assert.equal((await invoke(state, { run: true, mode: "oversized" })).code, 1);
  const observed = await result(state);
  assert.equal(
    observed.cases[0].original.error,
    "Gateway response exceeds 8 MiB byte bound",
  );
  assert.equal(observed.cases[0].original.response_sha256, null);
  assert.equal(observed.cases[0].original.assistant_text, null);
  assert.equal(observed.summary.original_task_prompt_tokens, null);
  assert.equal(observed.summary.call_errors, 1);
  assert.equal(observed.calls.length, 3);
  const trace = await events(state);
  const cancellation = trace.find((event) => event.event === "body-cancelled");
  assert.ok(cancellation, "oversized body must be cancelled");
  assert.ok(
    cancellation.chunks <= 6,
    "allow at most one prefetched chunk beyond the byte limit",
  );
  assert.equal(trace.filter((event) => event.event === "request").length, 3);
});
