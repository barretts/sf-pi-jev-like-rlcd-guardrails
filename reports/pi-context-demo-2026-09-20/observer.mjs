import { appendFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

// Recording metadata only. This extension registers no tools or commands and
// returns no hook results, so it cannot change messages or provider requests.
export default function recordingObserver(pi) {
  const journal = process.env.JEV_DEMO_JOURNAL;
  const suppliedStart = Number(process.env.JEV_DEMO_START);
  const startedAt = Number.isFinite(suppliedStart) && suppliedStart > 0
    ? suppliedStart
    : Date.now() / 1000;
  const workspace = canonical(process.env.JEV_DEMO_WORKSPACE || process.cwd());
  const runningTools = new Map();
  let request = 0;
  let syntheticTurn = false;

  function canonical(path) {
    try {
      return realpathSync(resolve(path));
    } catch {
      return resolve(path);
    }
  }

  function scopeMatches(context) {
    return Boolean(context?.cwd) && canonical(context.cwd) === workspace;
  }

  function name(value) {
    return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
      ? value
      : "unknown";
  }

  function names(values) {
    return Array.isArray(values) ? values.map(name) : [];
  }

  function record(type, metadata = {}) {
    if (!journal) return;
    try {
      appendFileSync(journal, JSON.stringify({
        type,
        time: Number((Date.now() / 1000 - startedAt).toFixed(3)),
        ...metadata,
      }) + "\n", { encoding: "utf8", mode: 0o600 });
    } catch {
      // Recording must never interrupt Pi or its normal teardown.
    }
  }

  function readFixtureName(path) {
    if (typeof path !== "string") return null;
    const destination = canonical(resolve(workspace, path));
    const location = relative(workspace, destination);
    if (!location || location === ".." || location.startsWith(`..${sep}`) || isAbsolute(location))
      return null;
    const fixture = basename(destination);
    return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.(?:txt|log|json|jsonl)$/.test(fixture)
      ? fixture
      : null;
  }

  function textBlocks(content) {
    if (typeof content === "string") return [content];
    if (!Array.isArray(content)) return [];
    return content.flatMap((block) =>
      block?.type === "text" && typeof block.text === "string" ? [block.text] : [],
    );
  }

  function textMetrics(content) {
    const blocks = textBlocks(content);
    const hash = createHash("sha256");
    for (const block of blocks) hash.update(block);
    return {
      textBlocks: blocks.length,
      textLength: blocks.reduce((sum, block) => sum + block.length, 0),
      textBytes: blocks.reduce((sum, block) => sum + Buffer.byteLength(block), 0),
      textSha256: hash.digest("hex"),
    };
  }

  function safeAssistantText(message) {
    if (message?.role !== "assistant" || !syntheticTurn) return null;
    if (Array.isArray(message.content) && message.content.some((block) => block?.type === "toolCall"))
      return null;
    const text = textBlocks(message.content).join("\n");
    if (!text || text.length > 4096) return null;
    // The recording uses invented fixture observations. This is an additional
    // guard against accidentally copying authentication strings or URLs.
    return text
      .replace(/\b(?:hf_|sk-|xox[baprs]-|gh[pousr]_)[A-Za-z0-9_-]+\b/g, "[redacted]")
      .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [redacted]")
      .replace(/https?:\/\/[^\s<>"']+/gi, "[redacted URL]");
  }

  pi.on("session_start", (_event, context) => {
    const allTools = pi.getAllTools();
    const activeTools = pi.getActiveTools();
    record("session_start", {
      scopedWorkspace: scopeMatches(context),
      registeredToolCount: allTools.length,
      registeredTools: names(allTools.map((tool) => tool.name)),
      activeToolCount: activeTools.length,
      activeTools: names(activeTools),
    });
  });

  pi.on("before_agent_start", (event, context) => {
    syntheticTurn = scopeMatches(context);
    record("before_agent_start", {
      scopedWorkspace: syntheticTurn,
      promptBytes: typeof event.prompt === "string" ? Buffer.byteLength(event.prompt) : 0,
      systemPromptBytes: typeof event.systemPrompt === "string" ? Buffer.byteLength(event.systemPrompt) : 0,
      activeTools: names(pi.getActiveTools()),
    });
  });

  pi.on("before_provider_request", (event) => {
    request += 1;
    let payloadBytes = null;
    try {
      const serialized = JSON.stringify(event.payload);
      if (typeof serialized === "string") payloadBytes = Buffer.byteLength(serialized);
    } catch {
      // A serialization failure is recorded as null, never as payload content.
    }
    const messages = Array.isArray(event.payload?.messages) ? event.payload.messages : [];
    const completed = messages.filter((message) => message?.role === "tool");
    const contents = completed.flatMap((message) => textBlocks(message.content));
    record("before_provider_request", {
      request,
      payloadBytes,
      completedToolMessageCount: completed.length,
      completedToolTextBlockCount: contents.length,
      completedToolTextBytes: contents.reduce((sum, text) => sum + Buffer.byteLength(text), 0),
      providerToolCount: Array.isArray(event.payload?.tools) ? event.payload.tools.length : null,
    });
  });

  pi.on("after_provider_response", (event) => {
    record("after_provider_response", { request, status: event.status });
  });

  pi.on("tool_execution_start", (event) => {
    const toolName = name(event.toolName);
    const fixture = toolName === "read" ? readFixtureName(event.args?.path) : null;
    runningTools.set(event.toolCallId, { toolName, fixture });
    record("tool_execution_start", {
      toolCallId: name(event.toolCallId),
      toolName,
      ...(toolName === "read" ? { fixture } : {}),
    });
  });

  pi.on("tool_execution_end", (event) => {
    const metadata = runningTools.get(event.toolCallId);
    runningTools.delete(event.toolCallId);
    const toolName = name(event.toolName);
    record("tool_execution_end", {
      toolCallId: name(event.toolCallId),
      toolName,
      ...(toolName === "read" ? { fixture: metadata?.fixture ?? null } : {}),
      ...textMetrics(event.result?.content),
      isError: Boolean(event.isError),
    });
  });

  pi.on("message_end", (event, context) => {
    if (!scopeMatches(context)) return;
    const text = safeAssistantText(event.message);
    if (text === null) return;
    record("message_end", {
      role: "assistant",
      stopReason: name(event.message.stopReason),
      text,
    });
  });

  pi.on("agent_settled", (_event, context) => {
    record("agent_settled", {
      scopedWorkspace: scopeMatches(context),
      isIdle: context.isIdle(),
      sessionFile: context.sessionManager.getSessionFile() ?? null,
    });
    syntheticTurn = false;
  });

  for (const type of ["ui_prompt_start", "ui_prompt_end"]) {
    pi.on(type, (event) => record(type, { kind: name(event.kind), reason: name(event.reason) }));
  }

  pi.on("session_shutdown", (event) => {
    record("session_shutdown", { reason: name(event.reason) });
    runningTools.clear();
    syntheticTurn = false;
  });
}
