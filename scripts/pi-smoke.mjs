import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  DefaultResourceLoader,
  SettingsManager,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js";
const root = fileURLToPath(new URL("../", import.meta.url));
const cwd = root + ".build/pi-workspace",
  agentDir = root + ".build/pi-agent";
await mkdir(cwd, { recursive: true });
await mkdir(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
await writeFile(
  agentDir + "/settings.json",
  JSON.stringify({ packages: [root] }, null, 2),
);
const sfPaths = process.argv.includes("--with-sf-pi")
  ? JSON.parse(
      await readFile(root + ".build/sf-pi/package.json", "utf8"),
    ).pi.extensions.map((p) => root + ".build/sf-pi/" + p)
  : [];
const settingsManager = SettingsManager.create(cwd, agentDir);
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager,
  noSkills: true,
  noThemes: true,
  noPromptTemplates: true,
  noContextFiles: true,
  additionalExtensionPaths: sfPaths,
});
await loader.reload();
const loaded = loader.getExtensions();
assert.deepEqual(loaded.errors, [], JSON.stringify(loaded.errors));
const model = {
  id: "integration-harness",
  name: "Non-generating integration harness",
  provider: "local-test",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 1024,
};
const { session } = await createAgentSession({
  cwd,
  agentDir,
  settingsManager,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(cwd),
  model,
  noTools: "builtin",
});
const executions = [];
const unsubscribe = session.subscribe((event) => {
  if (event.type === "tool_execution_end") executions.push(event);
});
try {
  const runner = session.extensionRunner;
  const request = {
    state:
      "The customer says: I was charged twice for my subscription. Please refund the duplicate charge.",
    questions: [
      {
        id: "route",
        type: "choice",
        instructions: "Which team should handle this message?",
        criteria: [
          { id: "billing", description: "Payments, invoices, refunds" },
          { id: "technical", description: "Technical product problems" },
        ],
      },
      {
        id: "support",
        type: "score",
        instructions:
          "How strongly does the context support a duplicate charge?",
        criteria: ["Unsupported", "Partially supported", "Fully supported"],
      },
      {
        id: "refund",
        type: "noul",
        instructions: "Does the customer explicitly ask for a refund?",
      },
    ],
  };
  session.modelRuntime.registerProvider(model.provider, {
    baseUrl: model.baseUrl,
    api: model.api,
    apiKey: "unused-harness",
    models: [model],
  });
  let turns = 0;
  session.agent.streamFunction = (currentModel, context) => {
    assert.ok(++turns <= 2, "Unexpected additional orchestration turn");
    const returned = context.messages.findLast(
      (message) =>
        message.role === "toolResult" && message.toolName === "jev_classify",
    );
    assert.ok(!returned?.isError, JSON.stringify(returned?.content));
    const reason = returned ? "stop" : "toolUse";
    const message = {
      role: "assistant",
      content: returned
        ? [{ type: "text", text: JSON.stringify(returned.details) }]
        : [
            {
              type: "toolCall",
              id: "jev-dispatch",
              name: "jev_classify",
              arguments: request,
            },
          ],
      api: currentModel.api,
      provider: currentModel.provider,
      model: currentModel.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: reason,
      timestamp: Date.now(),
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason, message });
    return stream;
  };
  await session.prompt("Execute the supplied Jev classification.", {
    expandPromptTemplates: false,
  });
  const result = session.agent.state.messages.findLast(
    (message) =>
      message.role === "toolResult" && message.toolName === "jev_classify",
  );
  assert.equal(turns, 2);
  assert.equal(executions.length, 1);
  assert.equal(executions[0].isError, false);
  assert.ok(result && !result.isError);
  assert.equal(result.details.usage.output_tokens, 0);
  assert.equal(result.details.answers.route.type, "choice");
  assert.equal(result.details.answers.support.type, "score");
  assert.equal(result.details.answers.refund.type, "noul");
  const proof = {
    pi_version: "0.85.1",
    extensions: runner.getExtensionPaths().map((p) => p.replace(root, "")),
    registered_tools: session.agent.state.tools.map((tool) => tool.name),
    path: "pi prompt -> argument validation -> tool dispatch -> local Gemma -> tool result -> assistant",
    roles: session.agent.state.messages.map((message) => message.role),
    orchestration_turns: turns,
    tool_error: executions[0].isError,
    result: result.details,
    orchestrating_model: "non-generating harness; no provider request",
  };
  console.log(JSON.stringify(proof, null, 2));
  await writeFile(
    root + ".build/pi-proof.json",
    JSON.stringify(proof, null, 2),
  );
} finally {
  unsubscribe();
  await session.extensionRunner.emit({ type: "session_shutdown" });
  session.dispose();
}
