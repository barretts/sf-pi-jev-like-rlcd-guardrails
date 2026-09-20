import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Classifier, NativeBackend, configFromEnv } from "../dist/index.js";
import { availableRouteFamilies } from "../dist/automation.js";
import { canonical, validateRequest } from "../dist/core.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    model: { type: "string" },
    "model-file": { type: "string" },
    device: { type: "string" },
    "prepare-only": { type: "boolean", default: false },
  },
});
const config = configFromEnv();
if (values.model) config.modelId = values.model;
if (values["model-file"]) config.modelFile = resolve(values["model-file"]);
if (values.device) config.device = values.device;
if (!["auto", "cpu", "metal"].includes(config.device))
  throw new Error("--device must be auto, cpu, or metal");
config.templateVersion = "v2";
config.advanced = true;

// These are developer-authored TRAIN/dev examples, never the old held-out suite.
// Full availability deliberately exercises all eleven production route families.
const tools = [
  "agentscript_authoring",
  "agentscript_preview",
  "agentscript_eval",
  "agentscript_lifecycle",
  "sf_apex",
  "sf_flow",
  "sf_lwc",
  "data360_query",
  "data360_activate",
  "sf_soql",
  "sf_docs",
  "sf_browser_snapshot",
  "code_analyzer",
  "slack",
  "sf_herdr_plan",
];
const cases = [
  {
    id: "apex-tests-advice",
    prompt:
      "Which available Salesforce capability should I use to run Apex tests? Give advice only.",
    expected_route: "apex",
    origin: "Existing authored pi smoke prompt; known training/dev failure.",
  },
  {
    id: "apex-failure-advice",
    prompt:
      "For a second request, explain which Salesforce capability can diagnose Apex test failures. Give advice only.",
    expected_route: "apex",
    origin: "Existing authored pi smoke prompt; known training/dev failure.",
  },
  {
    id: "static-security-scan",
    prompt:
      "Run Salesforce Code Analyzer's PMD security rules against the local Apex source and summarize its static findings. Do not run Apex tests or fetch runtime logs.",
    expected_route: "code-analyzer",
  },
  {
    id: "flow-authoring",
    prompt:
      "Help author a record-triggered Salesforce Flow that updates a case priority when its escalation flag changes. Validate the Flow source; no Apex implementation or browser work is requested.",
    expected_route: "flow",
  },
  {
    id: "lwc-source-edit",
    prompt:
      "Modify the local Lightning Web Component source so its loading spinner disappears after records arrive, then validate the component. Do not inspect a running org browser.",
    expected_route: "lwc",
  },
  {
    id: "browser-visual-check",
    prompt:
      "Open the Salesforce org browser, inspect the deployed record page, and capture visual evidence that its chart fits within the page. Do not edit component source.",
    expected_route: "browser",
  },
  {
    id: "salesforce-record-query",
    prompt:
      "Use SOQL to query Salesforce Contact records whose email is missing and return their IDs. These are ordinary CRM records, not Data Cloud data.",
    expected_route: "soql",
  },
  {
    id: "data-cloud-activation",
    prompt:
      "Activate the existing Data Cloud customer segment to its configured activation target and report the activation status. No SOQL query of CRM records is requested.",
    expected_route: "data360",
  },
  {
    id: "documentation-citation",
    prompt:
      "Find the official Salesforce documentation for record-triggered Flow execution order and cite the relevant source. Explain the documented behavior without authoring or running a Flow.",
    expected_route: "docs",
  },
  {
    id: "agentscript-preview",
    prompt:
      "Preview the local AgentScript agent in its simulator and inspect the conversation. Do not release the agent or plan a multi-agent workflow.",
    expected_route: "agentscript",
  },
  {
    id: "two-required-operations",
    prompt:
      "Run the Apex tests for CaseService, and separately use SOQL to count the current open Salesforce cases. Return both results. These are two required operations.",
    expected_route: "mixed",
  },
  {
    id: "general-typescript-explanation",
    prompt:
      "Explain why TypeScript rejects assigning a string to a number variable, with a small generic example. The quoted word 'Salesforce' is only sample text; do not use any Salesforce or Slack capabilities.",
    expected_route: "general",
  },
  {
    id: "inactive-apex-family",
    prompt:
      "Run the Apex runtime tests for CaseService. Static analysis is not a substitute, and no documentation lookup is requested.",
    expected_route: "general",
    active_tools: tools.filter((name) => name !== "sf_apex"),
    note: "No active family can run Apex runtime tests. General is the existing choice schema's no-applicable-family fallback; it does not imply execution or permission.",
  },
];

const meanings = {
  agentscript:
    "Author, preview or simulate, evaluate, or release a Salesforce AgentScript agent. A single agent preview belongs here; planning a team of agents belongs to herdr.",
  apex: "Author Apex code, run Apex runtime tests, investigate failing Apex tests, retrieve or interpret Apex execution logs, or trace an Apex runtime failure. Explicit static PMD scans belong to code-analyzer.",
  flow: "Author, validate, diagnose, or test Salesforce Flow source and its Flow behavior. Merely finding documentation about Flows belongs to docs. Runtime Apex tests belong to apex.",
  lwc: "Author, modify, diagnose, validate, or test Lightning Web Component source. Inspecting how an already deployed page looks without editing source belongs to browser.",
  data360:
    "Discover, connect, prepare, harmonize, query, segment, or activate Data Cloud data. Ordinary Salesforce CRM record queries using SOQL or SOSL belong to soql.",
  soql: "Query or search ordinary Salesforce CRM records using SOQL or SOSL. Data Cloud preparation, segmentation, and activation belong to data360. Running Apex tests belongs to apex.",
  docs: "Find authoritative Salesforce documentation, fetch a documentation page, or cite a Salesforce source. A request to perform a Salesforce operation is not a documentation request merely because documentation could help.",
  browser:
    "Open, inspect, navigate, or interact with a Salesforce org browser interface, including screenshots and visual evidence. Local source edits belong to the source capability.",
  "code-analyzer":
    "Explicitly run a Salesforce Code Analyzer static scan, discover its rules, generate its scan configuration, or interpret its static findings. Do not substitute a static scan for Apex runtime tests or logs.",
  slack:
    "Read, search, or post Slack collaboration messages when that operation is explicitly requested and authorized. Quoted or excluded Slack work does not require this family.",
  herdr:
    "Plan Salesforce work across multiple coordinated agents. A request to preview a single AgentScript agent is not a request to plan multi-agent orchestration.",
};

// Fixed before any inference. Both policies are exploratory; neither is selected
// after looking at this pilot. No probability is claimed to be calibrated.
const policies = [
  { id: "conservative", minimum_top_score: 1.8, minimum_margin: 0.5 },
  { id: "balanced", minimum_top_score: 1.5, minimum_margin: 0.25 },
];
const instructions =
  "Rate whether the current request directly requires the selected capability. Classify requested operations, not quoted examples or expressly excluded work. A request asking which capability performs an operation still concerns that capability. Apply availability: an absent capability cannot perform an operation. A related topic alone is not a direct match.";
const levels = [
  "Not required: no requested operation uses this capability, or the operation is explicitly excluded.",
  "Indirectly relevant: this capability might help explain or investigate the topic but does not directly perform a requested operation.",
  "Directly required: this capability performs an operation explicitly requested, including advice about which capability performs that operation.",
];

function requests(example) {
  const activeTools = example.active_tools ?? tools;
  const families = availableRouteFamilies(activeTools);
  const fallback = [
    {
      id: "mixed",
      description:
        "The request needs multiple available Salesforce capability families.",
    },
    {
      id: "general",
      description:
        "General development or conversation; no available Salesforce family applies.",
    },
  ];
  const currentChoice = {
    model: config.modelId,
    state: { user_request: example.prompt, available_families: families },
    questions: [
      {
        id: "route",
        type: "choice",
        instructions:
          "Choose the available Salesforce capability family best suited to this request. Choose mixed only when multiple available families are needed. Choose general when no available Salesforce family applies.",
        criteria: [
          ...families.map(({ id, description }) => ({ id, description })),
          ...fallback,
        ],
      },
    ],
    options: { template_version: "v2", raw_logits: true },
  };
  const semanticRelevance = {
    model: config.modelId,
    state: {
      user_request: example.prompt,
      available_family_ids: families.map((family) => family.id),
    },
    questions: [
      ...families.map(({ id }) => ({
        id,
        type: "score",
        instructions: `${instructions}\nSelected capability ${id}: ${meanings[id]}`,
        criteria: levels,
      })),
      {
        id: "mixed",
        type: "score",
        instructions: `${instructions}\nSelected classification mixed: The request explicitly requires two or more distinct operations performed by different available families. Do not count optional help, overlapping descriptions, or operations expressly excluded by the user.`,
        criteria: levels,
      },
      {
        id: "general",
        type: "score",
        instructions: `${instructions}\nSelected classification general: General development or conversation that needs no available Salesforce or Slack operation, or no available capability can perform the requested operation. Mentioning a Salesforce topic is insufficient. A request for authoritative Salesforce documentation belongs to docs when available.`,
        criteria: levels,
      },
    ],
    options: { template_version: "v2", raw_logits: true },
  };
  validateRequest(currentChoice);
  validateRequest(semanticRelevance);
  return {
    active_tools: activeTools,
    available_families: families,
    current_choice: currentChoice,
    semantic_relevance: semanticRelevance,
  };
}

function derive(scores, activeFamilyIds, policy) {
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [top, next] = ranked;
  const margin = top[1] - next[1];
  const strongFamilies = activeFamilyIds.filter(
    (id) => scores[id] >= policy.minimum_top_score,
  );
  let reason = "unique strong direct match";
  let route = top[0];
  if (margin <= 1e-12) {
    route = "abstain";
    reason = "tied highest score";
  } else if (top[1] < policy.minimum_top_score) {
    route = "abstain";
    reason = "highest score below predeclared threshold";
  } else if (margin < policy.minimum_margin) {
    route = "abstain";
    reason = "margin below predeclared threshold";
  } else if (route === "mixed" && strongFamilies.length < 2) {
    route = "abstain";
    reason = "mixed lacks two independently strong active families";
  }
  return {
    route,
    reason,
    top_family: top[0],
    top_score: top[1],
    margin,
    strong_active_families: strongFamilies,
  };
}

const sha256 = (value) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const prepared = cases.map((example) => ({
  ...example,
  split: "train",
  ...requests(example),
}));
const report = {
  schema_version: 1,
  purpose: "Exploratory authored developer routing TRAIN/dev pilot",
  created_at: new Date().toISOString(),
  prepare_only: values["prepare-only"],
  heldout_evaluated: false,
  old_quality_fixture_read: false,
  protocol: {
    cases: prepared.length,
    policy_selection:
      "All predeclared policies reported; no post-hoc selection.",
    calibrated: false,
    comparison:
      "Current production choice prompt versus numeric semantic relevance with explicit operation boundaries.",
    execution_order:
      "Warmup recorded separately; method order alternates across cases. No calls are retried.",
    expected_labels_used_for:
      "Post-inference scoring only; never sent to a classifier or used by derived routing.",
    policies,
  },
  model: config.modelId,
  requested_device: config.device,
  source_sha256: createHash("sha256")
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest("hex"),
  prepared_cases_sha256: sha256(prepared),
  cases: [],
};

async function save() {
  if (values.output) {
    const output = resolve(values.output);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
  }
}

if (values["prepare-only"]) {
  report.cases = prepared;
  await save();
  console.log(JSON.stringify(report, null, 2));
} else {
  const backend = new NativeBackend(config);
  const classifier = new Classifier(config, backend);
  const controller = new AbortController();
  const interrupt = () =>
    controller.abort(new Error("Routing pilot interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const warmupStart = performance.now();
    await backend.warmup();
    report.warmup = {
      elapsed_ms: performance.now() - warmupStart,
      runtime: backend.status,
    };
    for (let index = 0; index < prepared.length; index++) {
      controller.signal.throwIfAborted();
      const example = prepared[index];
      const result = {
        id: example.id,
        split: "train",
        prompt: example.prompt,
        expected_route: example.expected_route,
        origin: example.origin ?? "New developer-authored TRAIN/dev example.",
        ...(example.note ? { note: example.note } : {}),
        active_tools: example.active_tools,
        candidate_families: example.available_families.map(({ id }) => id),
        execution_order:
          index % 2 === 0
            ? ["current_choice", "semantic_relevance"]
            : ["semantic_relevance", "current_choice"],
      };
      for (const method of result.execution_order) {
        const start = performance.now();
        try {
          const response = await classifier.classify(
            example[method],
            controller.signal,
          );
          result[method] = {
            request: example[method],
            request_sha256: sha256(example[method]),
            elapsed_ms: performance.now() - start,
            computed_prompt_tokens:
              response.metrics?.computed_prompt_tokens ?? null,
            engine_forwards: response.metrics?.engine_forwards ?? null,
            response,
          };
        } catch (error) {
          result[method] = {
            request: example[method],
            request_sha256: sha256(example[method]),
            elapsed_ms: performance.now() - start,
            error: error instanceof Error ? error.message : String(error),
          };
          if (controller.signal.aborted) throw error;
        }
      }
      const choice = result.current_choice.response?.answers.route;
      if (choice?.type === "choice") {
        result.current_choice.route = choice.choice;
        result.current_choice.correct =
          choice.choice === example.expected_route;
      }
      const semantic = result.semantic_relevance.response?.answers;
      if (semantic) {
        const scores = Object.fromEntries(
          Object.entries(semantic).map(([id, answer]) => {
            if (answer.type !== "score" || !Number.isFinite(answer.score))
              throw new Error(`Invalid semantic score for ${id}`);
            return [id, answer.score];
          }),
        );
        result.semantic_relevance.raw_scores = scores;
        result.semantic_relevance.derived_routes = policies.map((policy) => {
          const decision = derive(scores, result.candidate_families, policy);
          return {
            policy: policy.id,
            ...decision,
            correct: decision.route === example.expected_route,
          };
        });
      }
      report.cases.push(result);
      await save();
      console.error(
        `Recorded ${result.id}: ${report.cases.length}/${prepared.length}`,
      );
    }
    const summarize = (decisions) => {
      const completed = decisions.filter((decision) => decision !== undefined);
      const covered = completed.filter(
        (decision) => decision.route !== "abstain",
      );
      const correct = covered.filter((decision) => decision.correct).length;
      return {
        cases: prepared.length,
        completed: completed.length,
        errors: prepared.length - completed.length,
        covered: covered.length,
        abstained: completed.length - covered.length,
        correct,
        accuracy_all_cases: correct / prepared.length,
        accuracy_covered: covered.length ? correct / covered.length : null,
      };
    };
    report.summary = {
      current_choice: summarize(
        report.cases.map((example) =>
          example.current_choice.route
            ? {
                route: example.current_choice.route,
                correct: example.current_choice.correct,
              }
            : undefined,
        ),
      ),
      semantic_relevance: policies.map((policy) => ({
        policy: policy.id,
        ...summarize(
          report.cases.map((example) =>
            example.semantic_relevance.derived_routes?.find(
              (decision) => decision.policy === policy.id,
            ),
          ),
        ),
      })),
    };
    report.measurements = Object.fromEntries(
      ["current_choice", "semantic_relevance"].map((method) => {
        const successful = report.cases
          .map((example) => example[method])
          .filter((measurement) => measurement.response);
        return [
          method,
          {
            successful_calls: successful.length,
            elapsed_ms: successful.reduce(
              (sum, measurement) => sum + measurement.elapsed_ms,
              0,
            ),
            reported_input_tokens: successful.reduce(
              (sum, measurement) =>
                sum + measurement.response.usage.input_tokens,
              0,
            ),
            generated_output_tokens: successful.reduce(
              (sum, measurement) =>
                sum + measurement.response.usage.output_tokens,
              0,
            ),
            computed_prompt_tokens: successful.every((measurement) =>
              Number.isFinite(measurement.computed_prompt_tokens),
            )
              ? successful.reduce(
                  (sum, measurement) =>
                    sum + measurement.computed_prompt_tokens,
                  0,
                )
              : null,
            engine_forwards: successful.every((measurement) =>
              Number.isFinite(measurement.engine_forwards),
            )
              ? successful.reduce(
                  (sum, measurement) => sum + measurement.engine_forwards,
                  0,
                )
              : null,
          },
        ];
      }),
    );
    if (
      report.cases.some((example) =>
        ["current_choice", "semantic_relevance"].some(
          (method) => example[method].error,
        ),
      )
    )
      process.exitCode = 1;
    report.completed = true;
  } catch (error) {
    report.completed = false;
    report.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    await classifier.dispose();
    report.cleanup_status = classifier.status;
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await save();
  }
  console.log(JSON.stringify(report, null, 2));
}
