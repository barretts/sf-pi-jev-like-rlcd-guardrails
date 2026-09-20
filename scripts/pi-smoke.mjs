import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  createEventBus,
  DefaultResourceLoader,
  SettingsManager,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js";
async function main() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const { values } = parseArgs({
    options: {
      "with-sf-pi": { type: "boolean", default: false },
      "sf-pi-path": { type: "string" },
      workspace: { type: "string", default: root + ".build/pi-workspace" },
      "agent-dir": { type: "string", default: root + ".build/pi-agent" },
      output: { type: "string", default: root + ".build/pi-proof.json" },
      "load-only": { type: "boolean", default: false },
      automation: { type: "boolean", default: false },
    },
  });
  const cwd = resolve(values.workspace),
    agentDir = resolve(values["agent-dir"]);
  assert.ok(
    cwd.startsWith(resolve(root, ".build") + "/"),
    "Smoke workspace must be isolated under .build",
  );
  assert.ok(
    agentDir.startsWith(resolve(root, ".build") + "/"),
    "Smoke agent settings must be isolated under .build",
  );
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await writeFile(
    agentDir + "/settings.json",
    JSON.stringify({ packages: [root] }, null, 2),
  );
  const { writePreferences } = await import("../dist/preferences.js");
  writePreferences(
    cwd,
    "project",
    {
      enabled: true,
      routing: false,
      evaluation: false,
      templateVersion: "v2",
    },
    agentDir,
  );
  const sfRoot = values["sf-pi-path"]
    ? resolve(values["sf-pi-path"])
    : root + ".build/sf-pi";
  const sfPaths =
    values["with-sf-pi"] || values["sf-pi-path"]
      ? JSON.parse(
          await readFile(join(sfRoot, "package.json"), "utf8"),
        ).pi.extensions.map((p) => resolve(sfRoot, p))
      : [];
  const eventBus = createEventBus();
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
    eventBus,
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
  const extensionErrors = [];
  session.extensionRunner.onError((error) => extensionErrors.push(error));
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_end") executions.push(event);
  });
  try {
    const runner = session.extensionRunner;
    const checks = [];
    let toolsAtStartup = session.agent.state.tools.map((tool) => tool.name);
    assert.equal(runner.getExtensionPaths().length, sfPaths.length + 1);
    const descriptor = () => {
      const contribution = {
        version: 1,
        cwd,
        scope: "project",
        extensions: [],
      };
      eventBus.emit("sf-pi-manager:external-extensions", contribution);
      assert.equal(
        contribution.extensions.filter((extension) => extension.id === "jev")
          .length,
        1,
      );
      return contribution.extensions.find(
        (extension) => extension.id === "jev",
      );
    };
    const initialDescriptor = descriptor();
    assert.equal(initialDescriptor.enabled, true);
    assert.ok(initialDescriptor.statusLines.includes("Runtime: cold"));
    assert.ok(initialDescriptor.statusLines.includes("Template: v2"));
    checks.push(
      "All requested real factories loaded; Jev Manager discovery is cached and native runtime remains cold.",
    );
    const managerProof = {
      descriptor: {
        ...initialDescriptor,
        getConfigPanel: undefined,
        setEnabled: undefined,
      },
      rendered: [],
    };
    const theme = { fg: (_color, text) => text, bold: (text) => text };
    const notifications = [];
    await session.bindExtensions({
      mode: "tui",
      uiContext: {
        theme,
        notify: (message, level) => notifications.push({ message, level }),
        setWorkingVisible() {},
        setWorkingMessage() {},
        setWorkingIndicator() {},
        setStatus() {},
        setWidget() {},
        setTitle() {},
        setEditorText() {},
        getEditorText: () => "",
        setToolsExpanded() {},
        setFooter() {},
        setHeader() {},
        custom: async (factory) => {
          const panel = factory(
            { terminal: { rows: 50 }, requestRender() {} },
            theme,
            {},
            () => {},
          );
          await Promise.resolve();
          managerProof.rendered.push(panel.render(120).join("\n"));
          return undefined;
        },
      },
    });
    toolsAtStartup = session.agent.state.tools.map((tool) => tool.name);
    assert.ok(descriptor().statusLines.includes("Runtime: cold"));
    const isolatedGlobalBaseline = await readFile(
      join(agentDir, "settings.json"),
      "utf8",
    );
    const ctx = runner.createCommandContext();
    const actionsRequest = { extensionId: "jev", actions: [] };
    eventBus.emit("sf-pi-manager:actions", actionsRequest);
    managerProof.actions = actionsRequest.actions.map(
      ({ id, label, acceptsScope }) => ({ id, label, acceptsScope }),
    );
    assert.equal(actionsRequest.actions.length, 7);
    if (sfPaths.length) {
      const managerCommand = runner.getCommand("sf-pi");
      assert.ok(managerCommand);
      await managerCommand.handler("open jev", ctx);
      await managerCommand.handler("open jev settings project", ctx);
      assert.ok(
        managerProof.rendered.some(
          (render) =>
            render.includes("Runtime: cold") &&
            render.includes("Latest evaluation"),
        ),
        managerProof.rendered.join("\n---\n"),
      );
      assert.ok(
        managerProof.rendered.some((render) => render.includes("Jev Settings")),
        managerProof.rendered.join("\n---\n"),
      );
      await managerCommand.handler("disable jev project", ctx);
      assert.equal(descriptor().enabled, false);
      await managerCommand.handler("enable jev project", ctx);
      assert.equal(descriptor().enabled, true);
      const settings = JSON.parse(
        await readFile(join(cwd, ".pi/settings.json"), "utf8"),
      );
      assert.equal(settings.jev.enabled, true);
      assert.equal(settings.packages, undefined);
      assert.equal(
        await readFile(join(agentDir, "settings.json"), "utf8"),
        isolatedGlobalBaseline,
      );
      await runner.getCommand("jev").handler("", ctx);
      assert.ok(managerProof.rendered.at(-1).includes("Jev"));
      checks.push(
        "Public SF Pi Manager opened external detail/settings and scoped enablement dispatched to Jev-owned preferences without bundled package-filter changes.",
      );
    }
    const configPanelFactory = await descriptor().getConfigPanel();
    const configPanel = configPanelFactory(theme, cwd, "project", () => {});
    configPanel.handleInput("j");
    configPanel.handleInput(" ");
    configPanel.handleInput("s");
    for (
      let attempt = 0;
      attempt < 100 &&
      !descriptor().statusLines.includes("Advisory routing: on");
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(descriptor().statusLines.includes("Advisory routing: on"));
    await actionsRequest.actions
      .find((action) => action.id === "routing-toggle")
      .run(ctx, "project");
    assert.ok(descriptor().statusLines.includes("Advisory routing: off"));
    assert.ok(descriptor().statusLines.includes("Runtime: cold"));
    checks.push(
      "Real settings panel saved and scoped Manager action toggled advisory routing without model initialization.",
    );
    await actionsRequest.actions
      .find((action) => action.id === "status")
      .run(ctx, "project");
    managerProof.cached_status = JSON.parse(notifications.at(-1).message);
    assert.equal(managerProof.cached_status.state, "cold");
    assert.equal(managerProof.cached_status.ready, false);
    const proof = {
      pi_version: "0.85.1",
      extensions: runner.getExtensionPaths(),
      registered_tools: toolsAtStartup,
      load_only: values["load-only"],
      manager: managerProof,
      checks,
      isolated_workspace: cwd,
      isolated_agent_dir: agentDir,
      orchestrating_model:
        "non-generating deterministic Pi harness; no provider request",
    };
    proof.executed_files = await Promise.all(
      [
        "scripts/pi-smoke.mjs",
        "dist/core.js",
        "dist/backend.js",
        "dist/extension.js",
        "dist/automation.js",
        "dist/manager.js",
      ].map(async (file) => ({
        file,
        sha256: createHash("sha256")
          .update(await readFile(join(root, file)))
          .digest("hex"),
      })),
    );
    if (values["load-only"]) {
      assert.deepEqual(extensionErrors, []);
      proof.passed = true;
      console.log(JSON.stringify(proof, null, 2));
      await writeFile(
        resolve(values.output),
        JSON.stringify(proof, null, 2) + "\n",
      );
      return;
    }
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
    assert.equal(result.details.metadata.backend, "llama.cpp");
    assert.equal(result.details.metadata.template_version, "v2");
    assert.equal(result.details.metadata.artifact.id, "google/gemma-3-1b-it");
    assert.equal(
      result.details.metadata.artifact.sha256,
      "05bd381a5f45611ce53f4fdcc6641cf6cec68c3091d74e8a32ea591f062d3fc5",
    );
    assert.match(result.details.metadata.native_build.commit, /^[a-f0-9]{40}$/);
    if (process.env.JEV_DEVICE === "metal")
      assert.equal(result.details.metadata.device, "metal");
    Object.assign(proof, {
      path: "pi prompt -> argument validation -> tool dispatch -> actual local Gemma -> tool result -> assistant",
      orchestration_turns: turns,
      tool_error: executions[0].isError,
      result: result.details,
    });
    if (values.automation) {
      const customEntries = (kind) =>
        session.sessionManager
          .getEntries()
          .filter(
            (entry) =>
              entry.type === "custom" && entry.customType === `jev-${kind}`,
          );
      await actionsRequest.actions
        .find((action) => action.id === "routing-toggle")
        .run(ctx, "project");
      await actionsRequest.actions
        .find((action) => action.id === "evaluation-toggle")
        .run(ctx, "project");
      session.agent.streamFunction = (currentModel) => {
        const message = {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Apex is the relevant Salesforce capability for this request. I have not run tests or changed the org; no execution evidence was supplied.",
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
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: "stop", message });
        return stream;
      };
      const evaluationsBefore = customEntries("evaluation").length;
      const routingBefore = customEntries("routing").length;
      const assistantRepliesBefore = session.agent.state.messages.filter(
        (message) => message.role === "assistant",
      ).length;
      await session.prompt(
        "Which available Salesforce capability should I use to run Apex tests? Give advice only.",
        { expandPromptTemplates: false },
      );
      assert.equal(customEntries("evaluation").length, evaluationsBefore + 1);
      assert.equal(customEntries("routing").length, routingBefore + 1);
      const firstEvaluation = customEntries("evaluation").at(-1).data;
      assert.deepEqual(Object.keys(firstEvaluation.answers), [
        "coverage",
        "evidence",
        "clarity",
      ]);
      assert.ok(
        Object.values(firstEvaluation.answers).every(
          (answer) => answer.type === "score",
        ),
      );
      await runner.emit({ type: "agent_settled" });
      await runner.emit({
        type: "agent_end",
        messages: session.agent.state.messages,
      });
      await runner.emit({ type: "agent_settled" });
      assert.equal(customEntries("evaluation").length, evaluationsBefore + 1);
      await session.prompt(
        "For a second request, explain which Salesforce capability can diagnose Apex test failures. Give advice only.",
        { expandPromptTemplates: false },
      );
      assert.equal(customEntries("evaluation").length, evaluationsBefore + 2);
      assert.equal(customEntries("routing").length, routingBefore + 2);
      const secondEvaluation = customEntries("evaluation").at(-1).data;
      assert.notEqual(
        firstEvaluation.userEntryId,
        secondEvaluation.userEntryId,
      );
      assert.notEqual(
        firstEvaluation.finalEntryId,
        secondEvaluation.finalEntryId,
      );
      assert.deepEqual(
        session.agent.state.tools.map((tool) => tool.name),
        toolsAtStartup,
      );
      assert.equal(
        executions.length,
        1,
        "Advisory automation must not dispatch tools or create tool retries",
      );
      assert.equal(
        session.agent.state.messages.filter(
          (message) => message.role === "assistant",
        ).length,
        assistantRepliesBefore + 2,
        "Advisory evaluation must not create assistant turns",
      );
      proof.automation = {
        routing: customEntries("routing")
          .slice(routingBefore)
          .map((entry) => entry.data),
        evaluation: customEntries("evaluation")
          .slice(evaluationsBefore)
          .map((entry) => entry.data),
        repeated_settled_duplicate_reports: 0,
        tool_authority_unchanged: true,
      };
      proof.saved_reports = await Promise.all(
        (await readdir(join(cwd, ".jev/reports"))).map(async (file) => ({
          file,
          mode: (await stat(join(cwd, ".jev/reports", file))).mode & 0o777,
        })),
      );
      assert.ok(proof.saved_reports.every((report) => report.mode === 0o600));
      checks.push(
        "Actual native advisory routing and all-three rubric evaluation ran for each of two settled user/final pairs; repeated settled/end events added no duplicate report or assistant turn, and active tools stayed unchanged.",
      );
    }
    proof.roles = session.agent.state.messages.map((message) => message.role);
    await actionsRequest.actions
      .find((action) => action.id === "status")
      .run(ctx, "project");
    proof.final_cached_status = JSON.parse(notifications.at(-1).message);
    proof.extension_errors = extensionErrors;
    assert.deepEqual(extensionErrors, []);
    proof.passed = true;
    console.log(JSON.stringify(proof, null, 2));
    await writeFile(resolve(values.output), JSON.stringify(proof, null, 2));
  } finally {
    unsubscribe();
    await session.extensionRunner.emit({ type: "session_shutdown" });
    session.dispose();
  }
}
await main();
