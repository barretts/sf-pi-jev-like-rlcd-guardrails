import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import {
  availableRouteFamilies,
  registerAutomation,
  settledTurn,
} from "../src/automation.js";
import { DEFAULT_PREFERENCES } from "../src/preferences.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function harness() {
  const cwd = await mkdtemp(join(tmpdir(), "jev-automation-"));
  directories.push(cwd);
  let entries: any[] = [];
  const handlers = new Map<string, any>();
  const pi: any = {
    on: (name: string, handler: any) => handlers.set(name, handler),
    getActiveTools: vi.fn(() => [
      "read",
      "jev_classify",
      "sf_apex",
      "data360_query",
    ]),
    setActiveTools: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    appendEntry: vi.fn((customType, data) =>
      entries.push({ type: "custom", customType, data }),
    ),
    registerEntryRenderer: vi.fn(),
  };
  const ctx: any = {
    cwd,
    hasUI: true,
    ui: { notify: vi.fn() },
    sessionManager: {
      getSessionId: () => "session",
      getBranch: () => entries,
      getEntries: () => entries,
    },
  };
  const preferences = { ...DEFAULT_PREFERENCES };
  const classify = vi.fn(async () => ({
    model: "google/gemma-3-1b-it",
    answers: {
      route: {
        type: "choice",
        choice: "apex",
        confidence: 0.8,
        probabilities: { apex: 0.8, general: 0.2 },
      },
    },
    usage: { input_tokens: 1, output_tokens: 0 },
    metadata: {
      backend: "test",
      model_revision: "fixture",
      template_version: "v2",
      calibration: "not_calibrated",
      usage_accounting: "fixture",
    },
  }));
  const reports = registerAutomation(pi, {
    preferences: () => preferences,
    classify,
  } as any);
  return {
    cwd,
    ctx,
    pi,
    preferences,
    classify,
    reports,
    setEntries(value: any[]) {
      entries = value;
    },
    getEntries: () => entries,
    emit: (name: string, event: unknown = {}) => handlers.get(name)(event, ctx),
  };
}
function user(id = "user") {
  return {
    type: "message",
    id,
    message: { role: "user", content: "Please run Apex tests." },
  };
}
function assistant(id = "final", stopReason = "stop") {
  return {
    type: "message",
    id,
    message: {
      role: "assistant",
      stopReason,
      content: [
        {
          type: "text",
          text: "The requested tests passed in the supplied evidence.",
        },
      ],
    },
  };
}
function evaluationResult() {
  return {
    model: "google/gemma-3-1b-it",
    answers: Object.fromEntries(
      ["coverage", "evidence", "clarity"].map((id) => [
        id,
        {
          type: "score",
          score: 2,
          confidence: 1,
          probabilities: { "2": 1 },
          legend: {},
        },
      ]),
    ),
    usage: { input_tokens: 42, output_tokens: 0 },
    metadata: { template_version: "v2" },
  };
}

it("derives Salesforce families from active tools only", () => {
  expect(
    availableRouteFamilies([
      "read",
      "sf_apex",
      "sf_browser_snapshot",
      "data360_query",
    ]).map((family) => family.id),
  ).toEqual(["apex", "data360", "browser"]);
  expect(availableRouteFamilies(["read", "jev_classify"])).toEqual([]);
});

it("injects routing advice without modifying tools, permissions, or agent turns", async () => {
  const h = await harness();
  h.preferences.routing = true;
  const result = await h.emit("before_agent_start", {
    prompt: "private routing context",
  });
  expect(result.message).toMatchObject({
    customType: "jev-routing-advice",
    display: false,
  });
  expect(result.message.content).toContain("apex");
  const request: any = h.classify.mock.calls[0][0];
  expect(
    request.questions[0].criteria.map((criterion: any) => criterion.id),
  ).toEqual(["apex", "data360", "mixed", "general"]);
  expect(request.state.user_request).toBe("private routing context");
  expect(h.pi.setActiveTools).not.toHaveBeenCalled();
  expect(h.pi.sendMessage).not.toHaveBeenCalled();
  expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
  const files = await readdir(join(h.cwd, ".jev", "reports"));
  expect(files).toHaveLength(1);
  const path = join(h.cwd, ".jev", "reports", files[0]);
  expect(await readFile(path, "utf8")).not.toContain("private routing context");
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it("skips disabled hooks and preserves the agent run when inference fails", async () => {
  const h = await harness();
  h.preferences.routing = true;
  h.preferences.enabled = false;
  expect(
    await h.emit("before_agent_start", { prompt: "Run tests" }),
  ).toBeUndefined();
  expect(h.classify).not.toHaveBeenCalled();
  h.preferences.enabled = true;
  h.classify.mockRejectedValueOnce(new Error("private diagnostic context"));
  expect(
    await h.emit("before_agent_start", { prompt: "Run tests" }),
  ).toBeUndefined();
  expect(h.ctx.ui.notify).toHaveBeenCalledWith(
    "Jev advisory routing unavailable for this turn.",
    "warning",
  );
  expect(JSON.stringify(h.ctx.ui.notify.mock.calls)).not.toContain(
    "private diagnostic context",
  );
});

it("waits for settled completion, evaluates all three rubrics once, and consumes persisted evidence", async () => {
  const h = await harness();
  h.preferences.evaluation = true;
  h.setEntries([
    user(),
    {
      type: "message",
      id: "tool",
      message: {
        role: "toolResult",
        toolName: "sf_apex",
        isError: false,
        content: [{ type: "text", text: "private tool evidence" }],
      },
    },
    assistant(),
  ]);
  h.classify.mockResolvedValue(evaluationResult() as any);
  await h.emit("agent_end");
  await h.emit("agent_end");
  expect(h.classify).not.toHaveBeenCalled();
  await h.emit("agent_settled");
  await h.emit("agent_settled");
  await h.emit("agent_end");
  await h.emit("agent_settled");
  expect(h.classify).toHaveBeenCalledOnce();
  const request: any = h.classify.mock.calls[0][0];
  expect(request.questions.map((question: any) => question.id)).toEqual([
    "coverage",
    "evidence",
    "clarity",
  ]);
  expect(request.state.tool_evidence).toEqual([
    { tool: "sf_apex", failed: false, result: "private tool evidence" },
  ]);
  expect(h.pi.appendEntry).toHaveBeenCalledWith(
    "jev-evaluation",
    expect.objectContaining({ userEntryId: "user", finalEntryId: "final" }),
  );
  expect(h.pi.sendMessage).not.toHaveBeenCalled();
  expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
  const files = await readdir(join(h.cwd, ".jev", "reports"));
  expect(
    await readFile(join(h.cwd, ".jev", "reports", files[0]), "utf8"),
  ).not.toContain("private tool evidence");
});

it("deduplicates across reload using persisted turn identities and evaluates the next user", async () => {
  const h = await harness();
  h.preferences.evaluation = true;
  h.classify.mockResolvedValue(evaluationResult() as any);
  h.setEntries([
    user(),
    assistant(),
    {
      type: "custom",
      customType: "jev-evaluation",
      data: {
        version: 1,
        userEntryId: "user",
        finalEntryId: "final",
        kind: "evaluation",
        answers: {},
      },
    },
  ]);
  await h.emit("session_start");
  await h.emit("agent_end");
  await h.emit("agent_settled");
  expect(h.classify).not.toHaveBeenCalled();
  h.setEntries([...h.getEntries(), user("next-user"), assistant("next-final")]);
  await h.emit("agent_end");
  await h.emit("agent_settled");
  expect(h.classify).toHaveBeenCalledOnce();
  expect(h.reports.latestEvaluation()).toMatchObject({
    userEntryId: "next-user",
    finalEntryId: "next-final",
  });
});

it("does not evaluate failed, interrupted, tool-only, or pending final turns", () => {
  expect(
    settledTurn([user(), assistant("final", "error")] as any),
  ).toBeUndefined();
  expect(
    settledTurn([user(), assistant("final", "aborted")] as any),
  ).toBeUndefined();
  expect(
    settledTurn([user(), assistant("final", "toolUse")] as any),
  ).toBeUndefined();
  expect(
    settledTurn([user(), assistant(), user("pending")] as any),
  ).toBeUndefined();
});

it("evaluates a distinct persisted final reply after an explicit continuation or fork", async () => {
  const h = await harness();
  h.preferences.evaluation = true;
  h.classify.mockResolvedValue(evaluationResult() as any);
  h.setEntries([
    user(),
    assistant(),
    {
      type: "custom",
      customType: "jev-evaluation",
      data: {
        version: 1,
        userEntryId: "user",
        finalEntryId: "final",
        kind: "evaluation",
        answers: {},
      },
    },
    assistant("continued-final"),
  ]);
  await h.emit("agent_end");
  await h.emit("agent_settled");
  expect(h.classify).toHaveBeenCalledOnce();
  expect(h.reports.latestEvaluation()).toMatchObject({
    userEntryId: "user",
    finalEntryId: "continued-final",
  });
});
