import { afterEach, expect, it, vi } from "vitest";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  Classifier,
  DeadlineExceeded,
  NativeBackend,
  configFromEnv,
  type InferenceAdapter,
} from "../src/backend.js";
import { preparePrompt } from "../src/core.js";

const verification = vi.hoisted(() => ({
  wait: undefined as undefined | ((signal?: AbortSignal) => Promise<void>),
  directoryWait: undefined as undefined | (() => Promise<void>),
  lateDirectory: undefined as string | undefined,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdtemp: async (prefix: string, options?: any) => {
      const directory = await actual.mkdtemp(prefix, options);
      if (verification.directoryWait && prefix.includes("jev-gemma-")) {
        verification.lateDirectory = directory as string;
        await verification.directoryWait();
      }
      return directory;
    },
  };
});
vi.mock("../src/models.js", async (original) => {
  const actual = await original<typeof import("../src/models.js")>();
  return {
    ...actual,
    verifyArtifact: vi.fn(
      async (
        file: string,
        _role: string,
        _model: string,
        options: { signal?: AbortSignal } = {},
      ) => {
        await verification.wait?.(options.signal);
        options.signal?.throwIfAborted();
        return {
          id: "google/gemma-3-1b-it",
          revision: "fixture-google-gemma-revision",
          sha256: "a".repeat(64),
          size: 18,
          file,
          base_model: "google/gemma-3-1b-it",
          roles: ["classifier"],
          license: "gemma",
        };
      },
    ),
  };
});
const input = {
  model: "google/gemma-3-1b-it",
  state: "The bicycle is red.",
  questions: [
    {
      id: "color",
      type: "choice",
      instructions: "Which color?",
      criteria: [
        { id: "red", description: "red" },
        { id: "blue", description: "blue" },
      ],
    },
  ],
};
const directories: string[] = [];
const backends: NativeBackend[] = [];
const classifiers: Classifier[] = [];
afterEach(async () => {
  verification.wait = undefined;
  verification.directoryWait = undefined;
  verification.lateDirectory = undefined;
  await Promise.all(
    classifiers.splice(0).map((classifier) => classifier.dispose()),
  );
  await Promise.all(backends.splice(0).map((backend) => backend.dispose()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function runtime(mode = "basic") {
  const directory = await mkdtemp(join(tmpdir(), "jev-runtime-test-"));
  directories.push(directory);
  const script = join(directory, "gemma-fixture-runtime.mjs");
  const modeFile = join(directory, "mode");
  const operations = join(directory, "operations");
  await writeFile(modeFile, mode);
  await writeFile(
    script,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';
let active;
if(readFileSync(${JSON.stringify(modeFile)},'utf8')==='ignore-term')process.on('SIGTERM',()=>{});
const reply = (id, result) => console.log(JSON.stringify({v:1,id,result}));
createInterface({input:process.stdin}).on('line', line => {
  const request=JSON.parse(line), mode=readFileSync(${JSON.stringify(modeFile)},'utf8');
  appendFileSync(${JSON.stringify(operations)},request.op+'\\n');
  if(request.op==='cancel') { if(mode==='ignore-term')return; if(active===request.target) console.log(JSON.stringify({v:1,id:active,error:{kind:'cancelled',message:'Cancelled'}})); active=undefined; return; }
  if(request.op==='init') { if(mode==='stall-init')return; reply(request.id,{ready:true,template:'Gemma fixture template',device:'cpu',device_name:'CPU fixture',architecture:'gemma3',native_build:{commit:'fixture-native-commit',target:'fixture-target',number:1,compiler:'fixture'},limits:{max_model_len:32768,max_batch_size:32,max_batch_tokens:32768}}); }
  if(request.op==='compile') { if(mode==='malformed') { reply(request.id,{unexpected:true}); return; } reply(request.id,request.branches.map(branch=>({branch_id:branch.branch_id,tokens:[1,2],token_ids:Object.fromEntries(branch.output_labels.map((label,index)=>[label,index+3])),rendered:'Gemma fixture prompt'}))); }
  if(request.op==='evaluate') { if(mode==='stall-evaluate'||mode==='ignore-term'){active=request.id;return;} reply(request.id,{logits:Object.fromEntries(request.branches.map(branch=>[branch.branch_id,Object.fromEntries(Object.keys(branch.token_ids).map((label,index)=>[label,index===0?3:1]))])),input_tokens:2,metrics:{computed_prompt_tokens:2}}); }
});
`,
  );
  await chmod(script, 0o755);
  const modelFile = join(directory, "gemma-fixture.gguf");
  await writeFile(modelFile, "Gemma test artifact");
  const config = {
    ...configFromEnv({ JEV_MODEL_FILE: modelFile }),
    binary: script,
    initTimeoutMs: 5_000,
    requestTimeoutMs: 5_000,
  };
  const backend = new NativeBackend(config);
  backends.push(backend);
  return { directory, modeFile, operations, backend, config };
}
function adapter(): InferenceAdapter {
  return {
    warmup: vi.fn(async () => {}),
    compile: vi.fn(async (plan) => plan),
    evaluate: vi.fn(async () => ({
      logits: { "0": { A: 3, B: 1 } },
      input_tokens: 2,
      metrics: {},
    })),
    dispose: vi.fn(async () => {}),
  };
}
it("shares warmup and reports loaded identities without request contents", async () => {
  const { backend, operations } = await runtime();
  await Promise.all([backend.warmup(), backend.warmup(), backend.warmup()]);
  expect((await readFile(operations, "utf8")).trim().split("\n")).toEqual([
    "init",
  ]);
  expect(backend.status).toMatchObject({
    state: "ready",
    device: "cpu",
    artifact: {
      revision: "fixture-google-gemma-revision",
      sha256: "a".repeat(64),
    },
    native_build: { commit: "fixture-native-commit" },
  });
  expect(JSON.stringify(backend.status)).not.toContain("The bicycle");
});
it("awaits native termination and owned temporary cleanup during initialization", async () => {
  const { backend } = await runtime("stall-init");
  const warming = backend.warmup();
  const rejected = expect(warming).rejects.toThrow("disposed");
  await vi.waitFor(() =>
    expect(backend.status.process_id).toBeTypeOf("number"),
  );
  const pid = backend.status.process_id!;
  const directory = backend.status.temporary_directory!;
  await backend.dispose();
  await rejected;
  expect(backend.status.state).toBe("disposed");
  expect(() => process.kill(pid, 0)).toThrow();
  await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
});
it("aborts checksum work during explicit disposal without spawning a process", async () => {
  const { backend } = await runtime();
  let entered = false;
  verification.wait = (signal) =>
    new Promise((_, reject) => {
      entered = true;
      signal!.addEventListener("abort", () => reject(signal!.reason), {
        once: true,
      });
    });
  const warming = backend.warmup();
  const rejected = expect(warming).rejects.toThrow("disposed");
  await vi.waitFor(() => expect(entered).toBe(true));
  await backend.dispose();
  await rejected;
  expect(backend.status.process_id).toBeNull();
  expect(backend.status.state).toBe("disposed");
});
it("bounds stalled initialization and retries only on a later explicit request", async () => {
  const { backend, config, modeFile } = await runtime("stall-init");
  config.initTimeoutMs = 75;
  await expect(backend.warmup()).rejects.toBeInstanceOf(DeadlineExceeded);
  expect(backend.status).toMatchObject({
    state: "failed",
    ready: false,
    process_id: null,
    temporary_directory: null,
  });
  await writeFile(modeFile, "basic");
  config.initTimeoutMs = 5_000;
  await backend.warmup();
  expect(backend.status).toMatchObject({ state: "ready", generation: 2 });
});
it("rejects malformed native replies, cleans the generation, and recovers explicitly", async () => {
  const { backend, modeFile } = await runtime("malformed");
  await expect(backend.compile(preparePrompt(input))).rejects.toThrow(
    "Invalid native protocol",
  );
  expect(backend.status.ready).toBe(false);
  expect(backend.status.process_id).toBeNull();
  await writeFile(modeFile, "basic");
  const compiled = await backend.compile(preparePrompt(input));
  expect((await backend.evaluate(compiled)).logits).toEqual({
    "0": { A: 3, B: 1 },
  });
  expect(backend.status.generation).toBe(2);
});
it("returns cancellation after native acknowledges it and preserves the next request", async () => {
  const { backend, modeFile } = await runtime("stall-evaluate");
  const compiled = await backend.compile(preparePrompt(input));
  const controller = new AbortController();
  const evaluating = backend.evaluate(compiled, controller.signal);
  const rejected = expect(evaluating).rejects.toThrow("Cancelled");
  controller.abort();
  await rejected;
  expect(backend.isReady).toBe(true);
  await writeFile(modeFile, "basic");
  expect((await backend.evaluate(compiled)).input_tokens).toBe(2);
});
it("bounds stalled RPCs, never replays them, and cleans before returning", async () => {
  const { backend, config, operations, modeFile } =
    await runtime("stall-evaluate");
  const compiled = await backend.compile(preparePrompt(input));
  const pid = backend.status.process_id!;
  const directory = backend.status.temporary_directory!;
  // Allow the fixture process to receive the request under concurrent CPU load.
  config.requestTimeoutMs = 500;
  await expect(backend.evaluate(compiled)).rejects.toMatchObject({
    stage: "request",
  });
  expect(
    (await readFile(operations, "utf8"))
      .split("\n")
      .filter((op) => op === "evaluate"),
  ).toHaveLength(1);
  expect(backend.status.process_id).toBeNull();
  expect(() => process.kill(pid, 0)).toThrow();
  await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(modeFile, "basic");
  config.requestTimeoutMs = 5_000;
  expect(
    (await backend.evaluate(await backend.compile(preparePrompt(input))))
      .input_tokens,
  ).toBe(2);
});
it("times out a queued request before expansion or inference and preserves later order", async () => {
  const backend = adapter();
  let release!: () => void;
  vi.mocked(backend.evaluate).mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => (release = resolve));
    return { logits: { "0": { A: 3, B: 1 } }, input_tokens: 2, metrics: {} };
  });
  const classifier = new Classifier(
    { ...configFromEnv({}), queueTimeoutMs: 25 },
    backend,
  );
  classifiers.push(classifier);
  const first = classifier.classify(input);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await expect(classifier.classify(input)).rejects.toMatchObject({
    stage: "queue",
  });
  expect(backend.compile).toHaveBeenCalledTimes(1);
  const last = classifier.classify(input);
  release();
  await Promise.all([first, last]);
  expect(backend.compile).toHaveBeenCalledTimes(2);
  expect(classifier.status.queue_depth).toBe(0);
});
it("cancels one caller's shared warmup wait while allowing the next caller to finish", async () => {
  const backend = adapter();
  let finishWarmup!: () => void;
  const warming = new Promise<void>((resolve) => (finishWarmup = resolve));
  backend.warmup = vi.fn(() => warming);
  const classifier = new Classifier(configFromEnv({}), backend);
  classifiers.push(classifier);
  const controller = new AbortController();
  const first = classifier.classify(input, controller.signal);
  const rejected = expect(first).rejects.toThrow("Cancelled");
  await vi.waitFor(() => expect(backend.warmup).toHaveBeenCalledTimes(1));
  controller.abort();
  await rejected;
  const second = classifier.classify(input);
  finishWarmup();
  expect((await second).answers.color.type).toBe("choice");
  expect(backend.compile).toHaveBeenCalledTimes(1);
});
it("rejects invalid native configuration before verification or spawning", async () => {
  for (const maxModelLen of [0, -1, 32769, Infinity, NaN, 1.5])
    expect(
      () => new NativeBackend({ ...configFromEnv({}), maxModelLen }),
    ).toThrow("maxModelLen");
  expect(
    () => new NativeBackend({ ...configFromEnv({}), initTimeoutMs: 0 }),
  ).toThrow("initTimeoutMs");
});
it("enforces the active classification deadline through native cancellation", async () => {
  const { backend, config, modeFile } = await runtime("stall-evaluate");
  await backend.warmup();
  config.requestTimeoutMs = 40;
  const classifier = new Classifier(config, backend);
  classifiers.push(classifier);
  await expect(classifier.classify(input)).rejects.toMatchObject({
    stage: "request",
  });
  expect(classifier.status).toMatchObject({ active: false, queue_depth: 0 });
  await writeFile(modeFile, "basic");
  config.requestTimeoutMs = 5_000;
  const result = await classifier.classify(input);
  expect(result.answers.color).toMatchObject({ type: "choice", choice: "red" });
  expect(result.metadata).toMatchObject({
    template_version: "v2",
    model_revision: "fixture-google-gemma-revision",
    device: "cpu",
    native_build: { commit: "fixture-native-commit" },
  });
});
it("shutdown rejects waiting callers without sending their requests to inference", async () => {
  const backend = adapter();
  backend.warmup = vi.fn(() => new Promise(() => {}));
  const classifier = new Classifier(configFromEnv({}), backend);
  classifiers.push(classifier);
  const first = classifier.classify(input);
  const firstRejected = expect(first).rejects.toThrow("disposed");
  await vi.waitFor(() => expect(backend.warmup).toHaveBeenCalledOnce());
  const waiting = classifier.classify(input);
  const waitingRejected = expect(waiting).rejects.toThrow("disposed");
  await classifier.dispose();
  await Promise.all([firstRejected, waitingRejected]);
  expect(backend.compile).not.toHaveBeenCalled();
});
it("waits for late temporary-directory creation and removal before reporting disposal", async () => {
  const { backend } = await runtime();
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => (release = resolve));
  verification.directoryWait = () => delayed;
  const warming = backend.warmup();
  const rejected = expect(warming).rejects.toThrow("disposed");
  await vi.waitFor(() =>
    expect(verification.lateDirectory).toBeTypeOf("string"),
  );
  const directory = verification.lateDirectory!;
  const disposing = backend.dispose();
  let disposed = false;
  void disposing.then(() => (disposed = true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(disposed).toBe(false);
  release();
  await disposing;
  await rejected;
  expect(backend.status.state).toBe("disposed");
  await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
});
it("escalates TERM to KILL within the cleanup bound before returning a timeout", async () => {
  const { backend, config } = await runtime("ignore-term");
  const compiled = await backend.compile(preparePrompt(input));
  const pid = backend.status.process_id!;
  config.requestTimeoutMs = 30;
  const started = performance.now();
  await expect(backend.evaluate(compiled)).rejects.toMatchObject({
    stage: "request",
  });
  expect(performance.now() - started).toBeGreaterThanOrEqual(900);
  expect(performance.now() - started).toBeLessThan(4_000);
  expect(() => process.kill(pid, 0)).toThrow();
  expect(backend.status.temporary_directory).toBeNull();
});
