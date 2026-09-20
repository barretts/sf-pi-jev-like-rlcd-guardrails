import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { ClassifierResponse } from "./core.js";
import type { Preferences } from "./preferences.js";

export interface RouteFamily {
  id: string;
  description: string;
  tools: string[];
}

const FAMILIES: ReadonlyArray<{
  id: string;
  description: string;
  matches: (tool: string) => boolean;
}> = [
  {
    id: "agentscript",
    description: "Build, preview, evaluate, and release Salesforce agents.",
    matches: (n) => n.startsWith("agentscript_"),
  },
  {
    id: "apex",
    description: "Author, diagnose, trace, and test Apex.",
    matches: (n) => n === "sf_apex",
  },
  {
    id: "flow",
    description: "Author and manage Salesforce flows.",
    matches: (n) => n === "sf_flow",
  },
  {
    id: "lwc",
    description: "Develop Lightning Web Components.",
    matches: (n) => n === "sf_lwc",
  },
  {
    id: "data360",
    description: "Connect, prepare, query, and activate Data Cloud data.",
    matches: (n) => n.startsWith("data360_"),
  },
  {
    id: "soql",
    description: "Query Salesforce records with SOQL or SOSL.",
    matches: (n) => n === "sf_soql",
  },
  {
    id: "docs",
    description: "Look up Salesforce documentation and cite sources.",
    matches: (n) => n === "sf_docs",
  },
  {
    id: "browser",
    description: "Inspect and operate Salesforce browser interfaces.",
    matches: (n) => n.startsWith("sf_browser_"),
  },
  {
    id: "code-analyzer",
    description: "Run Salesforce code analysis and interpret diagnostics.",
    matches: (n) => n === "code_analyzer",
  },
  {
    id: "slack",
    description: "Use explicitly authorized Salesforce collaboration tools.",
    matches: (n) => n === "slack" || n.startsWith("slack_"),
  },
  {
    id: "herdr",
    description: "Plan Salesforce multi-agent orchestration.",
    matches: (n) => n === "sf_herdr_plan",
  },
];

export function availableRouteFamilies(
  activeTools: readonly string[],
): RouteFamily[] {
  return FAMILIES.flatMap((family) => {
    const tools = activeTools.filter(family.matches);
    return tools.length
      ? [{ id: family.id, description: family.description, tools }]
      : [];
  });
}

export interface JevReport {
  version: 1;
  id: string;
  kind: "routing" | "evaluation";
  createdAt: string;
  sessionId: string;
  userEntryId?: string;
  finalEntryId?: string;
  model: string;
  template_version: string;
  metadata?: ClassifierResponse["metadata"];
  usage: ClassifierResponse["usage"];
  answers: ClassifierResponse["answers"];
  candidateFamilies?: string[];
  activeTools?: string[];
}

export interface AutomationBindings {
  preferences(): Preferences;
  classify(input: unknown, signal?: AbortSignal): Promise<ClassifierResponse>;
}

/** Inspector records contain result summaries, never the classified context. */
export async function persistReport(
  cwd: string,
  report: JevReport,
): Promise<void> {
  const directory = join(cwd, ".jev", "reports");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${report.id}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(report) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, join(directory, `${report.id}.json`));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function textContent(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const message = value as { content?: unknown };
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .flatMap((part) =>
      part && part.type === "text" && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n");
}

export interface SettledTurn {
  user: SessionMessageEntry;
  final: SessionMessageEntry;
  context: {
    user_request: string;
    assistant_answer: string;
    tool_evidence: Array<{ tool: string; failed: boolean; result: string }>;
  };
}

/** Use persisted branch identities after retries and queued continuations settle. */
export function settledTurn(
  entries: readonly SessionEntry[],
): SettledTurn | undefined {
  let finalIndex = -1;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") return undefined;
    if (message.role !== "assistant") continue;
    // A failed or interrupted final run must not silently evaluate an older reply.
    if (message.stopReason !== "stop" || !textContent(message).trim())
      return undefined;
    finalIndex = index;
    break;
  }
  if (finalIndex < 0) return undefined;
  const final = entries[finalIndex] as SessionMessageEntry;
  let userIndex = -1;
  for (let index = finalIndex - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type === "message" && entry.message.role === "user") {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return undefined;
  const user = entries[userIndex] as SessionMessageEntry;
  const evidence = entries.slice(userIndex + 1, finalIndex).flatMap((entry) => {
    if (entry.type !== "message" || entry.message.role !== "toolResult")
      return [];
    return [
      {
        tool: entry.message.toolName,
        failed: entry.message.isError,
        result: textContent(entry.message),
      },
    ];
  });
  return {
    user,
    final,
    context: {
      user_request: textContent(user.message),
      assistant_answer: textContent(final.message),
      tool_evidence: evidence,
    },
  };
}

function evaluationAlreadyRecorded(
  entries: readonly SessionEntry[],
  userEntryId: string,
  finalEntryId: string,
): boolean {
  return entries.some((entry) => {
    if (entry.type !== "custom" || entry.customType !== "jev-evaluation")
      return false;
    const report = entry.data as Partial<JevReport> | undefined;
    return (
      report?.userEntryId === userEntryId &&
      report.finalEntryId === finalEntryId
    );
  });
}

function reportSummary(report: JevReport): string[] {
  if (report.kind === "routing") {
    const route = report.answers.route;
    return [
      "Jev advisory routing",
      route?.type === "choice"
        ? `Suggested family: ${route.choice}`
        : "No routing result",
    ];
  }
  const scores = ["coverage", "evidence", "clarity"].map((id) => {
    const answer = report.answers[id];
    return `${id}: ${answer?.type === "score" ? answer.score.toFixed(2) : "unavailable"} / 2`;
  });
  return [
    "Jev advisory evaluation",
    ...scores,
    "Uncalibrated local rubric estimates.",
  ];
}

export function registerAutomation(
  pi: ExtensionAPI,
  bindings: AutomationBindings,
) {
  let latestRoute: JevReport | undefined;
  let latestEvaluation: JevReport | undefined;
  let ended = false;
  let generation = 0;
  const completed = new Set<string>();
  const inFlight = new Set<string>();
  const makeReport = (
    kind: JevReport["kind"],
    ctx: ExtensionContext,
    result: ClassifierResponse,
  ): JevReport => ({
    version: 1,
    id: randomUUID(),
    kind,
    createdAt: new Date().toISOString(),
    sessionId: ctx.sessionManager.getSessionId(),
    model: result.model,
    template_version:
      result.metadata?.template_version ??
      bindings.preferences().templateVersion,
    answers: result.answers,
    metadata: result.metadata,
    usage: result.usage,
  });
  const renderer = (entry: { data?: JevReport }) =>
    entry.data
      ? { render: () => reportSummary(entry.data!), invalidate() {} }
      : undefined;
  pi.registerEntryRenderer?.<JevReport>("jev-routing", renderer);
  pi.registerEntryRenderer?.<JevReport>("jev-evaluation", renderer);
  pi.on("session_start", (_event, ctx) => {
    generation++;
    ended = false;
    latestRoute = undefined;
    latestEvaluation = undefined;
    completed.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      const report = entry.data as JevReport | undefined;
      if (report?.version !== 1) continue;
      if (entry.customType === "jev-routing") latestRoute = report;
      if (entry.customType === "jev-evaluation") latestEvaluation = report;
    }
  });
  pi.on("before_agent_start", async (event, ctx) => {
    ended = false;
    const preferences = bindings.preferences();
    if (!preferences.enabled || !preferences.routing) return;
    const activeTools = pi.getActiveTools();
    const families = availableRouteFamilies(activeTools);
    const startedIn = generation;
    try {
      const result = await bindings.classify(
        {
          state: { user_request: event.prompt, available_families: families },
          questions: [
            {
              id: "route",
              type: "choice",
              instructions:
                "Choose the available Salesforce capability family best suited to this request. Choose mixed only when multiple available families are needed. Choose general when no available Salesforce family applies.",
              criteria: [
                ...families.map(({ id, description }) => ({ id, description })),
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
              ],
            },
          ],
          options: { template_version: preferences.templateVersion },
        },
        ctx.signal,
      );
      const route = result.answers.route;
      if (route?.type !== "choice" || startedIn !== generation) return;
      latestRoute = {
        ...makeReport("routing", ctx, result),
        activeTools: [...activeTools],
        candidateFamilies: families.map((family) => family.id),
      };
      pi.appendEntry("jev-routing", latestRoute);
      await persistReport(ctx.cwd, latestRoute).catch(() => {});
      return {
        message: {
          customType: "jev-routing-advice",
          display: false,
          details: latestRoute,
          content: `Jev advisory routing suggests ${route.choice}. Available Salesforce families: ${families.map((family) => family.id).join(", ") || "none"}. This uncalibrated recommendation grants no permission. Use the existing tools and obey all existing instructions and guardrails.`,
        },
      };
    } catch {
      if (ctx.hasUI)
        ctx.ui.notify(
          "Jev advisory routing unavailable for this turn.",
          "warning",
        );
    }
  });
  pi.on("agent_end", () => {
    ended = true;
  });
  pi.on("agent_settled", async (_event, ctx) => {
    const preferences = bindings.preferences();
    if (!ended || !preferences.enabled || !preferences.evaluation) return;
    ended = false;
    const entries = ctx.sessionManager.getBranch();
    const turn = settledTurn(entries);
    if (!turn) return;
    const key = `${ctx.sessionManager.getSessionId()}:${turn.user.id}:${turn.final.id}`;
    if (
      completed.has(key) ||
      inFlight.has(key) ||
      evaluationAlreadyRecorded(
        ctx.sessionManager.getEntries(),
        turn.user.id,
        turn.final.id,
      )
    )
      return;
    const startedIn = generation;
    inFlight.add(key);
    try {
      const result = await bindings.classify({
        state: turn.context,
        questions: [
          {
            id: "coverage",
            type: "score",
            instructions:
              "How fully does the assistant answer cover the user's request?",
            criteria: [
              "Does not address the request",
              "Addresses part of the request",
              "Addresses the request completely",
            ],
          },
          {
            id: "evidence",
            type: "score",
            instructions:
              "How well do factual claims align with the supplied evidence? Treat explicit uncertainty honestly and do not invent missing evidence.",
            criteria: [
              "Contradicts evidence or claims unsupported completion",
              "Partly supported, or the evidence is insufficient",
              "Supported by the supplied evidence, with limitations stated",
            ],
          },
          {
            id: "clarity",
            type: "score",
            instructions:
              "How clearly does the answer communicate its result and practical limitations?",
            criteria: [
              "Unclear or misleading",
              "Understandable but incomplete",
              "Clear, direct, and appropriately qualified",
            ],
          },
        ],
        options: { template_version: preferences.templateVersion },
      });
      if (startedIn !== generation) return;
      latestEvaluation = {
        ...makeReport("evaluation", ctx, result),
        userEntryId: turn.user.id,
        finalEntryId: turn.final.id,
      };
      pi.appendEntry("jev-evaluation", latestEvaluation);
      completed.add(key);
      await persistReport(ctx.cwd, latestEvaluation).catch(() => {});
    } catch {
      if (ctx.hasUI)
        ctx.ui.notify(
          "Jev advisory evaluation unavailable for this turn.",
          "warning",
        );
    } finally {
      inFlight.delete(key);
    }
  });
  pi.on("session_shutdown", () => {
    generation++;
    ended = false;
  });
  return {
    latestRoute: () => latestRoute,
    latestEvaluation: () => latestEvaluation,
  };
}
