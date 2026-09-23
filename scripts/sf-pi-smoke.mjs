#!/usr/bin/env node
/** Disposable Pi SDK checks. Proposed operations execute counter-only stubs. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const requireSdk = createRequire(
  import.meta.resolve("@earendil-works/pi-coding-agent"),
);
const piAiEntry = requireSdk.resolve
  .paths("@earendil-works/pi-ai")
  .map((directory) => join(directory, "@earendil-works/pi-ai/dist/index.js"))
  .find(existsSync);
assert.ok(piAiEntry, "Pi SDK's pi-ai dependency is unavailable");
const {
  Type,
  createAssistantMessageEventStream,
  createProvider,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} = await import(pathToFileURL(piAiEntry));
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST_BASELINE = "4f901db9c3f5076ea0305dea33ad6e8856e467da";
const HOST_PATCH_SHA256 =
  "3d156d653566f10335f269aa1e9381e75e633516b69365a10bb97043bb6e9c0d";
const PROVIDERS = "sf-guardrail:risk-providers";
const COMPARISONS = "sf-guardrail-risk-comparison";
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
          .join(",")}}`
      : JSON.stringify(value);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const model = {
  id: "counter-only-smoke",
  name: "Local scripted SDK smoke",
  provider: "jev-sdk-smoke",
  api: "openai-completions",
  baseUrl: "https://smoke.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32768,
  maxTokens: 1024,
};

function scriptedMessage(operations) {
  return {
    role: "assistant",
    content: operations
      ? operations.map(({ toolName, input }, index) => ({
          type: "toolCall",
          id: `smoke-${index}`,
          name: toolName,
          arguments: input,
        }))
      : [{ type: "text", text: "Counter-only smoke complete." }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: operations ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

async function trial({
  temporary,
  packageRoot,
  host,
  identityExtension,
  mode,
  operations = [],
  fixture,
  requireCurrentProvider = false,
  hardBlockForceignore = false,
}) {
  const cwd = await mkdtemp(join(temporary, `${mode}-`));
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  if (hardBlockForceignore) {
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        sfPi: {
          guardrail: {
            ruleBehaviors: { policies: { "sf-forceignore": "block" } },
          },
        },
      }),
    );
  }
  // SF Pi's global configuration helpers must see this isolated profile too.
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.SF_GUARDRAIL_JEV_MODE = mode;
  const executions = [];
  const picks = [];
  const extensionErrors = [];
  let streams = 0;
  const nextStream = () => {
    assert.ok(++streams <= 2, "Unexpected orchestration retry");
    const message = scriptedMessage(streams === 1 ? operations : undefined);
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
    });
    return stream;
  };
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(
    createProvider({
      id: model.provider,
      name: model.name,
      auth: {
        apiKey: {
          name: "Unused local smoke key",
          async resolve() {
            return { auth: { apiKey: "unused-local-smoke" }, source: "test" };
          },
        },
      },
      models: [model],
      api: {
        "openai-completions": {
          stream: nextStream,
          streamSimple: nextStream,
        },
      },
    }),
  );
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
  });
  const eventBus = createEventBus();
  const paths = host
    ? [join(host, "extensions/sf-guardrail/index.ts"), identityExtension]
    : [];
  if (!fixture) paths.push(join(packageRoot, "dist/extension.js"));
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    eventBus,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: paths,
    extensionFactories: fixture
      ? [
          (pi) => {
            pi.events.on(PROVIDERS, (request) => {
              request.providers.push(fixture);
            });
          },
        ]
      : [],
    systemPrompt: "Execute only the supplied counter-only fixture tools.",
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const tools = [...new Set(operations.map(({ toolName }) => toolName))];
  const customTools = tools.map((name) => ({
    name,
    label: `Counter-only ${name}`,
    description: "Count a proposed operation without performing it.",
    parameters: Type.Record(Type.String(), Type.Unknown()),
    executionMode: "sequential",
    async execute(_id, input) {
      executions.push({ toolName: name, input });
      return {
        content: [{ type: "text", text: "Stub counted." }],
        details: {},
      };
    },
  }));
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime,
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    tools,
    customTools,
    noTools: "builtin",
  });
  session.extensionRunner.onError((error) => extensionErrors.push(error));
  try {
    const notifications = [];
    const ui = {
      ...session.extensionRunner.getUIContext(),
      notify: (message, level) => notifications.push({ message, level }),
      select: async (_title, choices) => {
        picks.push(choices);
        return choices.includes("Allow for this session")
          ? "Allow for this session"
          : "Allow once";
      },
    };
    await session.bindExtensions({ mode: "tui", uiContext: ui });
    assert.deepEqual(session.getActiveToolNames().sort(), tools.sort());
    const request = { version: 1, providers: [] };
    eventBus.emit(PROVIDERS, request);
    assert.equal(request.providers.length, 1);
    const provider = request.providers[0];
    assert.equal(provider.id, "jev");
    assert.equal(provider.version, 2);
    assert.equal(provider.qualified, false);
    if (requireCurrentProvider) {
      const command = session.extensionRunner.getCommand("jev-risk");
      assert.ok(command);
      assert.deepEqual(
        session.extensionRunner.getAllRegisteredTools(),
        [],
        "Guardrail package must not add agent tools",
      );
      await command.handler(
        "status",
        session.extensionRunner.createCommandContext(),
      );
      assert.ok(
        notifications.some(({ message }) =>
          message.includes("sf-pi-jev-guardrails C11:"),
        ),
      );
      if (mode === "off") assert.equal(provider.modelSha256, null);
      else assert.equal(typeof provider.modelSha256, "string");
    }
    const identity = {};
    if (host) eventBus.emit("jev-smoke:host-identity", identity);
    if (operations.length) {
      await session.prompt("Run the supplied counter-only smoke operations.", {
        expandPromptTemplates: false,
      });
      assert.equal(streams, 2);
    }
    const entries = session.sessionManager.getEntries();
    const data = (kind) =>
      entries
        .filter((entry) => entry.type === "custom" && entry.customType === kind)
        .map(({ data }) => data);
    const results = session.agent.state.messages.filter(
      ({ role }) => role === "toolResult",
    );
    assert.deepEqual(extensionErrors, []);
    assert.equal(results.length, operations.length);
    return {
      mode,
      identity,
      executions,
      picks,
      grants: data("sf-guardrail-allow").length,
      decisions: data("sf-guardrail-decision").map(({ outcome }) => outcome),
      errors: results.map(({ isError }) => Boolean(isError)),
      comparisons: data(COMPARISONS),
      provider: {
        modelSha256: provider.modelSha256,
        protocolSha256: provider.protocolSha256,
        qualified: provider.qualified,
      },
    };
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown" });
    session.dispose();
  }
}

function outcome(result) {
  return {
    executions: result.executions,
    picks: result.picks,
    grants: result.grants,
    decisions: result.decisions,
    errors: result.errors,
  };
}

export async function runSmoke({
  packageRoot = root,
  sfPi,
  native = false,
} = {}) {
  if (native && !sfPi)
    throw new Error("--native requires --sf-pi /path/to/sf-pi");
  packageRoot = resolve(packageRoot);
  const temporary = await mkdtemp(join(tmpdir(), "jev-sf-pi-smoke-"));
  const saved = Object.fromEntries(
    [
      "PI_CODING_AGENT_DIR",
      "SF_GUARDRAIL_JEV_MODE",
      "SF_GUARDRAIL_ALLOW_HEADLESS",
      "SF_GUARDRAIL_OPERATOR_AUTO_APPROVE",
    ].map((key) => [key, process.env[key]]),
  );
  delete process.env.SF_GUARDRAIL_ALLOW_HEADLESS;
  delete process.env.SF_GUARDRAIL_OPERATOR_AUTO_APPROVE;
  try {
    const selection = await import(
      pathToFileURL(join(packageRoot, "dist/guardrail-selection.js"))
    );
    await selection.readC11Selection();
    const { C11, C11_SCORING_PROTOCOL_SHA256 } = selection;
    const offPackage = await trial({
      temporary,
      packageRoot,
      mode: "off",
      requireCurrentProvider: true,
    });
    const proof = {
      passed: true,
      sdkVersion: JSON.parse(
        await readFile(requireSdk.resolve("../package.json"), "utf8"),
      ).version,
      currentSelectionVerified: true,
      packageDiscoveryOff: offPackage.provider,
      hostChecks: "skipped; pass --sf-pi to test the pinned host source",
      nativeInference: false,
      externalOperationsExecuted: 0,
      qualified: false,
      enforcementEligible: false,
    };
    if (!sfPi) return proof;
    const host = join(temporary, "sf-pi");
    await mkdir(host);
    const patch = join(
      root,
      "integrations/sf-pi-guardrail/current-sf-pi.patch",
    );
    assert.equal(sha(await readFile(patch)), HOST_PATCH_SHA256);
    const archive = execFileSync(
      "git",
      ["-C", resolve(sfPi), "archive", HOST_BASELINE],
      {
        maxBuffer: 128 * 1048576,
      },
    );
    execFileSync("tar", ["-xf", "-", "-C", host], { input: archive });
    execFileSync("git", ["-C", host, "apply", "--check", patch]);
    execFileSync("git", ["-C", host, "apply", patch]);
    const identityExtension = join(temporary, "host-identity.ts");
    await writeFile(
      identityExtension,
      `import { readBundledConfig } from "./sf-pi/extensions/sf-guardrail/lib/config.ts";
import { getJevRiskPolicySha256 } from "./sf-pi/extensions/sf-guardrail/lib/jev-risk.ts";
import { getJevRiskBaselineSha256 } from "./sf-pi/extensions/sf-guardrail/lib/risk-baseline-identity.ts";
export default function (pi) {
  pi.events.on("jev-smoke:host-identity", request => Object.assign(request, {
    baselineSha256: getJevRiskBaselineSha256(),
    policySha256: getJevRiskPolicySha256(readBundledConfig()),
  }));
}
`,
    );
    let evaluationCount = 0;
    const fixture = {
      version: 2,
      id: "jev",
      modelSha256: C11.modelSha256,
      protocolSha256: C11_SCORING_PROTOCOL_SHA256,
      qualified: false,
      qualificationBaselineSha256: null,
      qualificationSha256: null,
      minimumAllowScore: C11.minimumAllowScore,
      calibrationSha256: C11.calibrationSha256,
      calibrationPolicySha256: C11.policySha256,
      calibrationBaselineSha256: C11.hostBaselineSha256,
      async evaluate(input, signal) {
        signal?.throwIfAborted();
        evaluationCount++;
        // An intentionally restrictive judgment proves shadow cannot add approval.
        return {
          action: "confirm",
          reason: "risk_detected",
          allowScore: 0.1,
          elapsedMs: 1,
          inputSha256: sha(canonical(input)),
          inputTokens: 10,
          calibration: "uncalibrated",
        };
      },
    };
    const safe = { toolName: "bash", input: { command: "git status" } };
    const confirm = { toolName: "bash", input: { command: "rm -rf scratch" } };
    const blocked = {
      toolName: "write",
      input: { path: ".forceignore", content: "Counter-only fixture" },
    };
    const operations = [safe, confirm, confirm];
    const common = { temporary, packageRoot, host, identityExtension };
    const off = await trial({
      ...common,
      mode: "off",
      operations,
      requireCurrentProvider: true,
    });
    assert.deepEqual(off.identity, {
      baselineSha256: C11.hostBaselineSha256,
      policySha256: C11.policySha256,
    });
    const shadow = await trial({
      ...common,
      mode: "shadow",
      operations,
      fixture,
    });
    assert.deepEqual(outcome(shadow), outcome(off));
    assert.equal(shadow.comparisons[0].source, "jev");
    assert.equal(shadow.comparisons[0].actual, "confirm");
    assert.equal(shadow.comparisons[0].baseline, "allow");
    assert.deepEqual(shadow.executions, [safe, confirm, confirm]);
    assert.equal(shadow.picks.length, 1);
    assert.equal(shadow.grants, 1);
    assert.deepEqual(shadow.errors, [false, false, false]);
    const blockedOutcomes = [];
    for (const mode of ["off", "shadow"]) {
      blockedOutcomes.push(
        await trial({
          ...common,
          mode,
          operations: [blocked],
          hardBlockForceignore: true,
          fixture,
        }),
      );
    }
    assert.deepEqual(outcome(blockedOutcomes[1]), outcome(blockedOutcomes[0]));
    assert.deepEqual(blockedOutcomes[1].executions, []);
    assert.deepEqual(blockedOutcomes[1].picks, []);
    assert.deepEqual(blockedOutcomes[1].errors, [true]);
    assert.equal(blockedOutcomes[1].comparisons[0].source, "exact_policy");
    const fallbackChecks = [];
    for (const [name, mode, change, reason] of [
      ["unqualified-enforcement", "enforce", {}, /qualification|qualified/i],
      [
        "wrong-baseline",
        "shadow",
        { calibrationBaselineSha256: "a".repeat(64) },
        /calibration/i,
      ],
      [
        "wrong-policy",
        "shadow",
        { calibrationPolicySha256: "a".repeat(64) },
        /calibration/i,
      ],
    ]) {
      const before = evaluationCount;
      const result = await trial({
        ...common,
        mode,
        operations: [safe],
        fixture: { ...fixture, ...change },
      });
      assert.equal(
        evaluationCount,
        before,
        "Rejected identity reached scoring",
      );
      assert.equal(result.comparisons[0].source, "rules_fallback");
      assert.match(result.comparisons[0].reason, reason);
      assert.deepEqual(result.executions, [safe]);
      assert.deepEqual(result.picks, []);
      fallbackChecks.push(name);
    }
    proof.hostChecks = {
      baselineCommit: HOST_BASELINE,
      patchSha256: HOST_PATCH_SHA256,
      identity: off.identity,
      sdkStubOffShadowOutcomesEqual: true,
      safeCallSource: shadow.comparisons[0].source,
      stubExecutions: shadow.executions.length,
      confirmations: shadow.picks.length,
      sessionGrants: shadow.grants,
      exactBlockPreserved: true,
      fallbackChecks,
    };
    if (native) {
      const result = await trial({
        ...common,
        mode: "shadow",
        operations: [safe],
        requireCurrentProvider: true,
      });
      assert.equal(result.provider.modelSha256, C11.modelSha256);
      assert.equal(result.provider.protocolSha256, C11_SCORING_PROTOCOL_SHA256);
      assert.equal(result.comparisons[0].source, "jev");
      assert.deepEqual(result.executions, [safe]);
      assert.deepEqual(result.picks, []);
      proof.nativeInference = {
        mode: "shadow",
        proposedOperation: safe,
        executedOperation: "counter-only stub",
        provider: result.provider,
        prediction: result.comparisons[0].prediction,
        elapsedMs: result.comparisons[0].elapsedMs,
        source: result.comparisons[0].source,
      };
    }
    return proof;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      package: { type: "string", default: root },
      "sf-pi": { type: "string" },
      native: { type: "boolean", default: false },
    },
  });
  console.log(
    JSON.stringify(
      await runSmoke({
        packageRoot: values.package,
        sfPi: values["sf-pi"],
        native: values.native,
      }),
      null,
      2,
    ),
  );
}
