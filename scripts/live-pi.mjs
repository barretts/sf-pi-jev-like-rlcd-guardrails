import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createEventBus,
} from "@earendil-works/pi-coding-agent";
import { getAgentServerStatus } from "../dist/agent-server.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({
  options: {
    "with-sf-pi": { type: "boolean", default: false },
    "sf-pi-path": { type: "string" },
    workspace: { type: "string", default: root + ".build/live-pi-workspace" },
    "agent-dir": { type: "string", default: root + ".build/live-pi-agent" },
    output: { type: "string", default: root + ".build/live-pi-proof.json" },
    "timeout-ms": { type: "string", default: "180000" },
    "base-url": { type: "string", default: "http://127.0.0.1:8081/v1" },
    "agent-state-file": {
      type: "string",
      default: root + ".build/agent-server-state.json",
    },
  },
});
const cwd = resolve(values.workspace),
  agentDir = resolve(values["agent-dir"]),
  proofPath = resolve(values.output);
assert.ok(
  cwd.startsWith(resolve(root, ".build") + "/"),
  "Live proof workspace must be isolated under .build",
);
assert.ok(
  agentDir.startsWith(resolve(root, ".build") + "/"),
  "Live proof agent settings must be isolated under .build",
);
const providerAddress = new URL(values["base-url"]);
assert.equal(providerAddress.protocol, "http:");
assert.equal(providerAddress.hostname, "127.0.0.1");
const timeoutMs = Number(values["timeout-ms"]);
assert.ok(
  Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
  "--timeout-ms must be a positive integer",
);
await mkdir(cwd, { recursive: true });
await mkdir(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

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

const cases = [
  {
    id: "classification-needed",
    prompt:
      'Use Jev to measure this customer message: "I was charged twice for my subscription. Please refund the duplicate charge." Classify the handling team with candidates billing (payments, invoices, refunds) and technical (technical product problems), score the evidence for a duplicate charge using Unsupported, Partially supported, and Fully supported, and judge whether the customer explicitly requests a refund. Report Jev\'s measured choice probabilities, evidence score, and refund truth score. Do not invent probabilities or replace the classifier measurement with your own estimate.',
  },
  {
    id: "direct-answer-control",
    prompt: "What is 17 + 25? Answer with the number only.",
  },
];
const sfRoot = values["sf-pi-path"]
  ? resolve(values["sf-pi-path"])
  : root + ".build/sf-pi";
const sfPaths =
  values["with-sf-pi"] || values["sf-pi-path"]
    ? JSON.parse(
        await readFile(join(sfRoot, "package.json"), "utf8"),
      ).pi.extensions.map((path) => resolve(sfRoot, path))
    : [];
const piPackage = JSON.parse(
  await readFile(
    root + "node_modules/@earendil-works/pi-coding-agent/package.json",
    "utf8",
  ),
);
const proof = {
  pi_version: piPackage.version,
  orchestrating_model: model,
  provider_stream: "unmodified pi SDK provider stream",
  tool_choice: "automatic; no tool_choice request override",
  retries: "disabled at session and provider levels",
  deadline_ms_per_case: timeoutMs,
  with_sf_pi: sfPaths.length > 0,
  started_at: new Date().toISOString(),
  server_models: null,
  server_health: null,
  owned_agent_server: null,
  cases: [],
  passed: false,
};

function textOf(message) {
  return message?.content
    ?.filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function snapshot(value) {
  return JSON.parse(JSON.stringify(value));
}

function eventSnapshot(event) {
  if (event.type !== "message_update") return snapshot(event);
  const delta = event.assistantMessageEvent;
  // Final messages are retained in full; streaming events retain each delta
  // without duplicating a growing partial message on every token.
  return {
    type: event.type,
    assistant_event_type: delta?.type,
    content_index: delta?.contentIndex,
    delta: delta?.delta,
  };
}

async function bounded(operation, ms, onTimeout) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(`Deadline exceeded after ${ms} ms`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function exercise(testCase) {
  const observation = {
    id: testCase.id,
    prompt: testCase.prompt,
    passed: false,
    provider_requests: [],
    provider_responses: [],
    events: [],
    messages: [],
    errors: [],
  };
  const settingsManager = SettingsManager.inMemory({
    packages: [],
    compaction: { enabled: false },
    retry: { enabled: false, provider: { maxRetries: 0 } },
    enableAnalytics: false,
    enableInstallTelemetry: false,
    httpIdleTimeoutMs: timeoutMs,
  });
  const eventBus = createEventBus();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    eventBus,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    additionalExtensionPaths: [root + "dist/extension.js", ...sfPaths],
    extensionFactories: [
      (pi) => {
        pi.on("before_provider_request", (event) => {
          observation.provider_requests.push(snapshot(event.payload));
        });
        pi.on("after_provider_response", (event) => {
          observation.provider_responses.push({
            status: event.status,
            received_at: new Date().toISOString(),
          });
        });
      },
    ],
  });
  let session;
  let unsubscribe;
  let timedOut = false;
  const started = performance.now();
  try {
    await loader.reload();
    assert.deepEqual(
      loader.getExtensions().errors,
      [],
      JSON.stringify(loader.getExtensions().errors),
    );
    ({ session } = await createAgentSession({
      cwd,
      agentDir,
      settingsManager,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      model,
      thinkingLevel: "medium",
      noTools: "builtin",
    }));
    session.modelRuntime.registerProvider(model.provider, {
      baseUrl: model.baseUrl,
      api: model.api,
      apiKey: "local-only",
      models: [model],
    });
    await session.bindExtensions({
      mode: "print",
      onError: (error) => observation.errors.push(snapshot(error)),
    });
    assert.deepEqual(observation.errors, [], "Extension startup failed");
    const cacheRequest = { version: 1, cwd, scope: "project", extensions: [] };
    eventBus.emit("sf-pi-manager:external-extensions", cacheRequest);
    const jevDescriptor = cacheRequest.extensions.find(
      (extension) => extension.id === "jev",
    );
    assert.ok(jevDescriptor);
    assert.ok(jevDescriptor.statusLines.includes("Runtime: cold"));
    observation.classifier_startup_status = jevDescriptor.statusLines;
    observation.extensions = session.extensionRunner
      .getExtensionPaths()
      .map((path) => path.replace(root, ""));
    observation.available_tools = session.agent.state.tools.map(
      (tool) => tool.name,
    );
    assert.ok(observation.available_tools.includes("jev_classify"));
    unsubscribe = session.subscribe((event) => {
      observation.events.push(eventSnapshot(event));
    });
    // This is a real provider request. Do not replace streamFunction or submit
    // tool calls directly: both cases must leave selection to the model.
    await bounded(
      session.prompt(testCase.prompt, {
        expandPromptTemplates: false,
      }),
      timeoutMs,
      () => {
        timedOut = true;
        session.agent.abort();
      },
    );
    observation.messages = snapshot(session.agent.state.messages);
    const assistants = observation.messages.filter(
      (message) => message.role === "assistant",
    );
    const calls = assistants.flatMap((message) =>
      message.content.filter((part) => part.type === "toolCall"),
    );
    const results = observation.messages.filter(
      (message) => message.role === "toolResult",
    );
    const final = assistants.at(-1);
    observation.first_model_selection = assistants[0] ?? null;
    observation.selected_tools = calls;
    observation.tool_results = results;
    observation.final_response = textOf(final) ?? "";
    assert.ok(observation.provider_requests.length > 0, "No provider request");
    for (const request of observation.provider_requests) {
      assert.ok(
        request.tool_choice === undefined || request.tool_choice === "auto",
        "Tool selection was forced by a provider request",
      );
      assert.equal(request.model, model.id);
      assert.equal(request.max_tokens, model.maxTokens);
    }
    assert.ok(
      !observation.events.some((event) => event.type === "auto_retry_start"),
    );
    assert.ok(
      !assistants.some((message) =>
        ["error", "aborted", "length"].includes(message.stopReason),
      ),
      "Provider did not finish normally",
    );
    assert.ok(final?.stopReason === "stop", "Missing final assistant response");
    assert.ok(observation.final_response.trim(), "Final response is empty");
    if (testCase.id === "classification-needed") {
      const jevCalls = calls.filter((call) => call.name === "jev_classify");
      assert.ok(jevCalls.length > 0, "Model did not select jev_classify");
      const successful = results.filter(
        (result) => result.toolName === "jev_classify" && !result.isError,
      );
      assert.ok(successful.length > 0, "Jev did not execute successfully");
      const answerTypes = new Set(
        successful.flatMap((result) =>
          Object.values(result.details?.answers ?? {}).map(
            (answer) => answer.type,
          ),
        ),
      );
      assert.ok(
        ["choice", "score", "noul"].every((type) => answerTypes.has(type)),
        "The model did not obtain all three requested classifier measurements",
      );
      const result = successful.at(-1);
      const replayed = observation.provider_requests.find((request) =>
        request.messages?.some(
          (message) =>
            message.role === "tool" &&
            message.tool_call_id === result.toolCallId &&
            (typeof message.content === "string"
              ? message.content.includes("answers")
              : JSON.stringify(message.content).includes("answers")),
        ),
      );
      observation.result_consumed = {
        tool_call_id: result.toolCallId,
        result_replayed_to_provider: Boolean(replayed),
        assistant_response_after_result:
          observation.messages.indexOf(final) >
          observation.messages.indexOf(result),
        result: result.details,
      };
      assert.ok(
        replayed,
        "Successful tool result was not sent back to the model",
      );
      assert.ok(observation.result_consumed.assistant_response_after_result);
    } else {
      observation.no_tool_control = calls.length === 0 && results.length === 0;
      assert.ok(
        observation.no_tool_control,
        "Arithmetic control called a tool",
      );
      assert.equal(observation.final_response.trim(), "42");
    }
    assert.deepEqual(observation.errors, [], "Extension lifecycle failed");
    observation.passed = true;
  } catch (error) {
    observation.errors.push(error.stack ?? String(error));
    if (session) {
      observation.messages = snapshot(session.agent.state.messages);
      const assistants = observation.messages.filter(
        (message) => message.role === "assistant",
      );
      observation.first_model_selection = assistants[0] ?? null;
      observation.selected_tools = assistants.flatMap((message) =>
        message.content.filter((part) => part.type === "toolCall"),
      );
      observation.tool_results = observation.messages.filter(
        (message) => message.role === "toolResult",
      );
      observation.final_response = textOf(assistants.at(-1)) ?? "";
    }
  } finally {
    observation.elapsed_ms = Math.round(performance.now() - started);
    observation.timed_out = timedOut;
    unsubscribe?.();
    if (session) {
      try {
        await bounded(session.abort(), 10_000);
        await bounded(
          session.extensionRunner.emit({ type: "session_shutdown" }),
          10_000,
        );
      } catch (error) {
        observation.errors.push(`Shutdown: ${error.stack ?? String(error)}`);
        observation.passed = false;
      } finally {
        session.dispose();
      }
    }
  }
  console.log(
    JSON.stringify(
      {
        case: observation.id,
        passed: observation.passed,
        selected_tools: observation.selected_tools?.map((call) => call.name),
        final_response: observation.final_response,
        elapsed_ms: observation.elapsed_ms,
        errors: observation.errors,
      },
      null,
      2,
    ),
  );
  return observation;
}

try {
  proof.executed_files = await Promise.all(
    [
      "scripts/live-pi.mjs",
      "dist/core.js",
      "dist/backend.js",
      "dist/extension.js",
      "dist/automation.js",
      "dist/agent-server.js",
    ].map(async (file) => ({
      file,
      sha256: createHash("sha256")
        .update(await readFile(join(root, file)))
        .digest("hex"),
    })),
  );
  const owned = await getAgentServerStatus({
    stateFile: resolve(values["agent-state-file"]),
  });
  assert.equal(
    owned.state,
    "ready",
    "Explicitly start the owned local agent server before running this proof",
  );
  assert.equal(owned.server.port, Number(providerAddress.port || "80"));
  assert.equal(owned.server.model.id, model.id);
  proof.owned_agent_server = owned;
  for (const [file, expected] of [
    [owned.server.binary, owned.server.binary_sha256],
    [owned.server.template_file, owned.server.template_sha256],
  ])
    assert.equal(
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex"),
      expected,
      `Owned runtime file changed: ${file}`,
    );
  const healthResponse = await fetch(providerAddress.origin + "/health", {
    signal: AbortSignal.timeout(10_000),
  });
  assert.ok(
    healthResponse.ok,
    `Owned local server /health returned ${healthResponse.status}`,
  );
  proof.server_health = {
    status: healthResponse.status,
    body: await healthResponse.json(),
  };
  const response = await fetch(model.baseUrl + "/models", {
    signal: AbortSignal.timeout(10_000),
  });
  assert.ok(response.ok, `Local server /models returned ${response.status}`);
  proof.server_models = await response.json();
  assert.ok(
    proof.server_models.data?.some((entry) => entry.id === model.id),
    `Local server must advertise alias ${model.id}`,
  );
  for (const testCase of cases) proof.cases.push(await exercise(testCase));
  proof.passed = proof.cases.every((testCase) => testCase.passed);
} catch (error) {
  proof.error = error.stack ?? String(error);
  console.error(proof.error);
} finally {
  proof.finished_at = new Date().toISOString();
  await writeFile(proofPath, JSON.stringify(proof, null, 2) + "\n");
  console.log(JSON.stringify({ passed: proof.passed, proof: proofPath }));
  if (!proof.passed) process.exitCode = 1;
}
