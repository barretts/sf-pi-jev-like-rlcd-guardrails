import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ContextEvent,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type {
  ContextCompressionBlock,
  ContextCompressionController,
  ContextCompressionOptions,
  ContextCompressionReceipt,
  ContextCompressionStatus,
} from "./context-extension.js";
import {
  createContextOriginals,
  CONTEXT_ORIGINALS_READ_DESCRIPTION,
  CONTEXT_ORIGINALS_READ_PARAMETERS,
  type ContextOriginalSource,
  type ContextOriginalStatus,
} from "./context-originals.js";
import { planToolContext } from "./context-projection.js";

type Message = ContextEvent["messages"][number];
type ToolMessage = Extract<Message, { role: "toolResult" }>;
type WireMessage = Record<string, unknown>;

export const TASK_CONTEXT_READ_TOOL = "jev_context_read";
export const TASK_CONTEXT_DEFAULTS = Object.freeze({
  targetReduction: 0.5,
  maxContextOriginalBytes: 32 * 1024 * 1024,
  maxToolTextBlocks: 512,
  summarizerTimeoutMs: 180_000,
  maxSummarizedSources: 8,
});
export type TaskContextStrategy = "excerpts" | "caveman";

/** The caller supplies inference explicitly. This extension discovers no model. */
export interface TaskContextSummaryInput {
  task: string;
  reference: string;
  excerpt: string;
  maxOutputBytes: number;
  signal?: AbortSignal;
}
export interface TaskContextSummaryResult {
  text: string;
  /** False for truncated/incomplete generation; such output is never used. */
  complete: boolean;
}
export type TaskContextSummarizer = (
  input: TaskContextSummaryInput,
) => TaskContextSummaryResult | Promise<TaskContextSummaryResult>;

export interface TaskContextCompressionOptions extends Omit<
  ContextCompressionOptions,
  "codecOptions" | "strategy" | "summarize"
> {
  strategy?: TaskContextStrategy;
  targetReduction?: number;
  summarize?: TaskContextSummarizer;
  summarizerTimeoutMs?: number;
  maxSummarizedSources?: number;
}

export interface TaskContextBlock extends Omit<
  ContextCompressionBlock,
  "format"
> {
  format: "jev-tool-excerpts-v1" | "jev-caveman-v1";
  reference: string;
  toolCallId: string;
  selectedLineRanges: Array<{ startLine: number; endLine: number }>;
  omittedLineRanges: Array<{ startLine: number; endLine: number }>;
}
export interface TaskContextCandidate {
  strategy: TaskContextStrategy;
  applied: boolean;
  targetReached: boolean;
  estimatedTargetReached: boolean;
  targetReduction: number;
  originalSourceBytes: number;
  projectedSourceBytes: number;
  protectedBytes: number;
  estimatedFullOriginalBytes: number;
  estimatedFullProjectedBytes: number;
  wholePayloadOriginalBytes: number | null;
  wholePayloadProjectedBytes: number | null;
  actualByteReductionFraction: number | null;
  /** Actual provider token use must come from its response, never byte counts. */
  actualTokenMetrics: null;
  summarizerFallbacks: number;
  blocks: TaskContextBlock[];
}
export interface TaskContextCompressionReceipt extends Omit<
  ContextCompressionReceipt,
  "blocks"
> {
  blocks: TaskContextBlock[];
  candidate: TaskContextCandidate | null;
}
export interface TaskContextCompressionStatus extends Omit<
  ContextCompressionStatus,
  "lastContext"
> {
  lastContext: TaskContextCompressionReceipt | null;
  strategy: TaskContextStrategy;
  targetReduction: number;
  targetReached: boolean;
  estimatedOriginalPromptTokens: number | null;
  estimatedProjectedPromptTokens: number | null;
  estimatedPromptReductionFraction: number | null;
  projectionFallbackReason: string | null;
  originals: ContextOriginalStatus;
  candidate: TaskContextCandidate | null;
}
export interface TaskContextCompressionController extends Omit<
  ContextCompressionController,
  "status"
> {
  status(): TaskContextCompressionStatus;
  setStrategy(strategy: TaskContextStrategy): void;
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const clone = <T>(value: T): T => structuredClone(value);
const validUnicode = (text: string) => {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
};
function integer(value: number | undefined, fallback: number, label: string) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error(`${label} must be a nonnegative safe integer`);
  return result;
}
function wireText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (
    Array.isArray(content) &&
    content.length === 1 &&
    content[0]?.type === "text" &&
    typeof content[0].text === "string"
  )
    return content[0].text;
  return undefined;
}
function replaceWireText(message: WireMessage, text: string): WireMessage {
  return {
    ...message,
    content:
      Array.isArray(message.content) &&
      message.content.length === 1 &&
      message.content[0]?.type === "text"
        ? [{ ...message.content[0], text }]
        : text,
  };
}
function textWeight(value: unknown): number {
  if (typeof value === "string") return bytes(value);
  if (!Array.isArray(value)) return 0;
  return value.reduce((sum, block) => {
    if (!plain(block)) return sum;
    if (block.type === "text" && typeof block.text === "string")
      return sum + bytes(block.text);
    if (block.type === "thinking" && typeof block.thinking === "string")
      return sum + bytes(block.thinking);
    if (block.type === "image" && typeof block.data === "string")
      return sum + bytes(block.data);
    // Assistant tool call arguments are protected model-visible context too.
    if (block.type === "toolCall") return sum + bytes(JSON.stringify(block));
    return sum;
  }, 0);
}
function emptyReceipt(): TaskContextCompressionReceipt {
  return {
    compressedBlocks: 0,
    originalBytes: 0,
    compressedBytes: 0,
    toolTextBytesSaved: 0,
    bytesSaved: 0,
    manifestBytes: 0,
    instructionBytes: 0,
    fallbackCount: 0,
    lastFallback: null,
    reused: false,
    transformElapsedMs: 0,
    providerValidationElapsedMs: 0,
    blocks: [],
    candidate: null,
  };
}

async function installedOpenAiConverter() {
  // Resolve from the selected SDK rather than assuming npm nested or hoisted
  // dependency placement. Only local code is loaded, lazily on an enabled path.
  const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const resolver = createRequire(entry);
  for (const directory of resolver.resolve.paths("@earendil-works/pi-ai") ??
    []) {
    let path: string;
    try {
      path = resolver.resolve(
        join(directory, "@earendil-works/pi-ai/dist/api/openai-completions.js"),
      );
    } catch {
      continue;
    }
    const module = await import(pathToFileURL(path).href);
    if (typeof module.convertMessages !== "function")
      throw new Error("Installed OpenAI converter unavailable");
    return module.convertMessages as (
      model: unknown,
      context: unknown,
      compat: unknown,
      options: unknown,
    ) => unknown;
  }
  throw new Error("Installed OpenAI converter unavailable");
}

/**
 * Temporary task-aware projections. Stored messages are never rewritten.
 * The provider guard accounts for the actual OpenAI request envelope and adds
 * the fixed retrieval annotation only after verifying the projected sources.
 */
export function registerTaskContextCompression(
  pi: ExtensionAPI,
  options: TaskContextCompressionOptions = {},
): TaskContextCompressionController {
  if (options.enabled !== undefined && typeof options.enabled !== "boolean")
    throw new Error("Context compression enabled must be a boolean");
  let strategy = options.strategy ?? "excerpts";
  if (strategy !== "excerpts" && strategy !== "caveman")
    throw new Error("Unknown task context strategy");
  const targetReduction =
    options.targetReduction ?? TASK_CONTEXT_DEFAULTS.targetReduction;
  if (
    !Number.isFinite(targetReduction) ||
    targetReduction <= 0 ||
    targetReduction >= 1
  )
    throw new Error("targetReduction must be between zero and one");
  if (
    options.summarize !== undefined &&
    typeof options.summarize !== "function"
  )
    throw new Error("summarize must be a caller-supplied function");
  const maxBytes = integer(
    options.maxContextOriginalBytes,
    TASK_CONTEXT_DEFAULTS.maxContextOriginalBytes,
    "maxContextOriginalBytes",
  );
  const maxBlocks = integer(
    options.maxToolTextBlocks,
    TASK_CONTEXT_DEFAULTS.maxToolTextBlocks,
    "maxToolTextBlocks",
  );
  const summarizeMs = integer(
    options.summarizerTimeoutMs,
    TASK_CONTEXT_DEFAULTS.summarizerTimeoutMs,
    "summarizerTimeoutMs",
  );
  const maxSummaries = integer(
    options.maxSummarizedSources,
    TASK_CONTEXT_DEFAULTS.maxSummarizedSources,
    "maxSummarizedSources",
  );
  if (summarizeMs < 1 || summarizeMs > 600_000 || maxSummaries > 16)
    throw new Error("Summarizer bounds exceeded");
  const additionalApis = options.additionalSupportedModelApis ?? [];
  if (
    !Array.isArray(additionalApis) ||
    additionalApis.length > 1 ||
    additionalApis.some((api) => api !== "jev-routing-dispatch-v1")
  )
    throw new Error("Only the owned routing dispatcher API can be attested");
  const ids = options.allowedOpenAiTargetModelIds ?? [];
  if (
    !Array.isArray(ids) ||
    ids.length > 16 ||
    ids.some(
      (id) =>
        typeof id !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(id),
    ) ||
    (additionalApis.length > 0 && ids.length === 0)
  )
    throw new Error("Dispatcher targets require bounded OpenAI model IDs");
  const targetIds = [...new Set(ids)];
  const supportedApis = new Set(["openai-completions", ...additionalApis]);
  const store = createContextOriginals({ maxBytes, maxSources: maxBlocks });
  let scope = randomBytes(16).toString("hex");
  store.reset(scope);
  let enabled = options.enabled ?? false;
  let task: string | undefined;
  let systemPrompt = "";
  let turnGeneration = 0;
  let references = new Set<string>();
  const ownedMessages = new WeakMap<object, string>();
  const guardedPayloads = new WeakMap<object, Record<string, unknown>>();
  const retrievalFunction = Object.freeze({
    name: TASK_CONTEXT_READ_TOOL,
    description: CONTEXT_ORIGINALS_READ_DESCRIPTION,
    parameters: CONTEXT_ORIGINALS_READ_PARAMETERS,
  });
  const retrievalSchemaBytes = bytes(
    JSON.stringify({ type: "function", function: retrievalFunction }),
  );
  type Pending = {
    generation: number;
    scope: string;
    annotation: string;
    toolIds: string[];
    modelIds: string[];
    originalMessages: Message[];
    fallbackMessages: WireMessage[] | undefined;
    blocks: Array<
      TaskContextBlock & { originalText: string; projectedText: string }
    >;
  };
  let pending: Pending | undefined;
  let metrics: Omit<
    TaskContextCompressionStatus,
    | "enabled"
    | "readyForCurrentTurn"
    | "strategy"
    | "targetReduction"
    | "originals"
  >;
  const resetMetrics = () => {
    metrics = {
      contextCalls: 0,
      compressedBlocks: 0,
      originalBytes: 0,
      compressedBytes: 0,
      toolTextBytesSaved: 0,
      bytesSaved: 0,
      manifestBytes: 0,
      fallbackCount: 0,
      lastFallback: null,
      lastContext: null,
      validatedProviderRequests: 0,
      restoredProviderRequests: 0,
      unverifiedProviderRequests: 0,
      contextTransformElapsedMs: 0,
      providerValidationElapsedMs: 0,
      targetReached: false,
      estimatedOriginalPromptTokens: null,
      estimatedProjectedPromptTokens: null,
      estimatedPromptReductionFraction: null,
      projectionFallbackReason: null,
      candidate: null,
    };
  };
  resetMetrics();
  const activeRetrieval = (active: boolean) => {
    try {
      const current = pi.getActiveTools();
      const names = current.filter((name) => name !== TASK_CONTEXT_READ_TOOL);
      const next = active ? [...names, TASK_CONTEXT_READ_TOOL] : names;
      if (!isDeepStrictEqual(current, next)) pi.setActiveTools(next);
    } catch {
      // The context/transport guards still reject unavailable tool catalogs.
    }
  };
  const clearScope = () => {
    task = undefined;
    systemPrompt = "";
    turnGeneration++;
    references.clear();
    scope = randomBytes(16).toString("hex");
    store.reset(scope);
    metrics.targetReached = false;
    activeRetrieval(false);
  };
  const fallback = (
    receipt: TaskContextCompressionReceipt,
    reason: string,
    category: ContextCompressionReceipt["lastFallback"] = "codec_rejected",
  ) => {
    receipt.fallbackCount++;
    receipt.lastFallback = category;
    metrics.projectionFallbackReason = reason;
    metrics.targetReached = false;
  };
  const record = (
    receipt: TaskContextCompressionReceipt,
    startedAt: number,
  ) => {
    receipt.transformElapsedMs = performance.now() - startedAt;
    metrics.contextCalls++;
    metrics.compressedBlocks += receipt.compressedBlocks;
    metrics.originalBytes += receipt.originalBytes;
    metrics.compressedBytes += receipt.compressedBytes;
    metrics.toolTextBytesSaved += receipt.toolTextBytesSaved;
    metrics.bytesSaved += receipt.bytesSaved;
    metrics.fallbackCount += receipt.fallbackCount;
    metrics.contextTransformElapsedMs += receipt.transformElapsedMs;
    if (receipt.lastFallback) metrics.lastFallback = receipt.lastFallback;
    metrics.lastContext = clone(receipt);
    metrics.candidate = clone(receipt.candidate);
  };
  const stripRetrieval = (
    payload: Record<string, unknown>,
  ): Record<string, unknown> => {
    if (!Array.isArray(payload.tools)) return { ...payload };
    const tools = payload.tools.filter(
      (tool) =>
        !(
          plain(tool) &&
          plain(tool.function) &&
          tool.function.name === TASK_CONTEXT_READ_TOOL
        ),
    );
    const { tools: _previous, ...rest } = payload;
    return tools.length > 0 ? { ...rest, tools } : rest;
  };
  const restore = (payload: Record<string, unknown>, prepared: Pending) => {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    return {
      ...stripRetrieval(payload),
      messages: messages.map((message: unknown) => {
        if (!plain(message) || message.role !== "tool") return message;
        const block = prepared.blocks.find(
          (item) => item.toolCallId === message.tool_call_id,
        );
        return block ? replaceWireText(message, block.originalText) : message;
      }),
    };
  };
  const rejectPrepared = (reason: string) => {
    metrics.fallbackCount++;
    metrics.lastFallback = "provider_boundary";
    metrics.projectionFallbackReason = reason;
    metrics.targetReached = false;
    const latest = metrics.lastContext;
    if (latest) {
      metrics.compressedBlocks -= latest.compressedBlocks;
      metrics.compressedBytes += latest.toolTextBytesSaved;
      metrics.toolTextBytesSaved -= latest.toolTextBytesSaved;
      metrics.bytesSaved -= latest.bytesSaved;
      latest.compressedBlocks = 0;
      latest.compressedBytes = latest.originalBytes;
      latest.toolTextBytesSaved = 0;
      latest.bytesSaved = 0;
      latest.instructionBytes = 0;
      latest.blocks = [];
      latest.fallbackCount++;
      latest.lastFallback = "provider_boundary";
    }
    if (metrics.candidate) {
      metrics.candidate.applied = false;
      metrics.candidate.targetReached = false;
    }
    if (latest?.candidate) {
      latest.candidate.applied = false;
      latest.candidate.targetReached = false;
    }
  };

  pi.registerTool({
    name: TASK_CONTEXT_READ_TOOL,
    label: "Read original context",
    description: CONTEXT_ORIGINALS_READ_DESCRIPTION,
    parameters: CONTEXT_ORIGINALS_READ_PARAMETERS as TSchema,
    async execute(_id, input, signal) {
      if (!enabled || signal?.aborted)
        throw new Error("context-original-unavailable");
      const result = store.read(
        input as unknown as Parameters<typeof store.read>[0],
      );
      if ("error" in result || !references.has(result.source.reference))
        throw new Error("context-original-unavailable");
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });

  pi.on("before_agent_start", (event) => {
    turnGeneration++;
    task =
      enabled && typeof event.prompt === "string" ? event.prompt : undefined;
    systemPrompt = event.systemPrompt;
    metrics.targetReached = false;
    // This host catalog is snapshotted before context. The wire guard removes
    // retrieval from every literal request, including the first empty archive.
    activeRetrieval(enabled);
    // No decoder instructions, synthetic user message or persistent entry.
  });

  pi.on("context", async (event, context) => {
    const startedAt = performance.now();
    pending = undefined;
    references = new Set();
    if (!enabled) return;
    const receipt = emptyReceipt();
    const generation = turnGeneration;
    const currentScope = scope;
    if (!task?.trim()) {
      fallback(receipt, "empty-task", "instructions_unavailable");
      record(receipt, startedAt);
      return;
    }
    if (context.signal?.aborted) {
      fallback(receipt, "cancelled", "cancelled");
      record(receipt, startedAt);
      return;
    }
    const model = context.model;
    if (!model || !supportedApis.has(model.api)) {
      fallback(receipt, "unsupported-provider", "unsupported_provider");
      record(receipt, startedAt);
      return;
    }
    let retrievalConfigured = false;
    try {
      retrievalConfigured =
        pi.getActiveTools().includes(TASK_CONTEXT_READ_TOOL) &&
        pi.getAllTools().some((tool) => tool.name === TASK_CONTEXT_READ_TOOL);
    } catch {
      /* Never project when the host dispatcher cannot serve originals. */
    }
    if (!retrievalConfigured) {
      fallback(receipt, "retrieval-unavailable", "provider_boundary");
      record(receipt, startedAt);
      return;
    }
    const allowedModels =
      model.api === "openai-completions" ? [model.id] : targetIds;
    let measured = bytes(systemPrompt);
    let textBlocks = 0;
    const toolIds: string[] = [];
    const seenIds = new Set<string>();
    for (const message of event.messages) {
      if (message.role === "toolResult") {
        if (!message.toolCallId || seenIds.has(message.toolCallId)) {
          fallback(receipt, "ambiguous-tool-ids", "provider_boundary");
          record(receipt, startedAt);
          return;
        }
        seenIds.add(message.toolCallId);
        toolIds.push(message.toolCallId);
        textBlocks += message.content.filter(
          (block) => block.type === "text",
        ).length;
      }
      // Constant-time resident-length rejection before UTF-8 scans/retention.
      const content: unknown =
        "content" in message
          ? message.content
          : "output" in message
            ? message.output
            : undefined;
      if (typeof content === "string" && content.length > maxBytes - measured) {
        measured = maxBytes + 1;
        break;
      }
      if (
        Array.isArray(content) &&
        content.some(
          (block) =>
            plain(block) &&
            ((block.type === "text" &&
              typeof block.text === "string" &&
              block.text.length > maxBytes - measured) ||
              (block.type === "image" &&
                typeof block.data === "string" &&
                block.data.length > maxBytes - measured)),
        )
      ) {
        measured = maxBytes + 1;
        break;
      }
      measured += textWeight(content);
      if (measured > maxBytes || textBlocks > maxBlocks) break;
    }
    if (measured > maxBytes || textBlocks > maxBlocks) {
      fallback(receipt, "context-limit", "context_limit");
      record(receipt, startedAt);
      return;
    }
    const captured: Array<{
      messageIndex: number;
      contentIndex: number;
      toolResultOrdinal: number;
      message: ToolMessage;
      text: string;
      source: ContextOriginalSource;
    }> = [];
    let ordinal = 0;
    for (
      let messageIndex = 0;
      messageIndex < event.messages.length;
      messageIndex++
    ) {
      const message = event.messages[messageIndex];
      if (message.role !== "toolResult") continue;
      ordinal++;
      if (message.toolName === TASK_CONTEXT_READ_TOOL) continue;
      const texts = message.content.flatMap((block, contentIndex) =>
        block.type === "text" ? [{ block, contentIndex }] : [],
      );
      if (texts.length !== 1) continue;
      const { block, contentIndex } = texts[0];
      const text = ownedMessages.get(message) ?? block.text;
      const source = store.capture({
        toolCallId: message.toolCallId,
        contentIndex,
        text,
      });
      if (!source) continue;
      references.add(source.reference);
      captured.push({
        messageIndex,
        contentIndex,
        toolResultOrdinal: ordinal,
        message,
        text,
        source,
      });
    }
    const originalSourceBytes = captured.reduce(
      (sum, item) => sum + item.source.bytes,
      0,
    );
    let protectedBytes =
      Math.max(0, measured - originalSourceBytes) + retrievalSchemaBytes;
    try {
      const active = new Set(pi.getActiveTools());
      protectedBytes += bytes(
        JSON.stringify(
          pi
            .getAllTools()
            .filter(
              (tool) =>
                active.has(tool.name) && tool.name !== TASK_CONTEXT_READ_TOOL,
            )
            .map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            })),
        ),
      );
    } catch {
      /* Actual serialized schema is counted and checked below. */
    }
    let plan: ReturnType<typeof planToolContext>;
    try {
      plan = planToolContext({
        task,
        sources: captured.map((item) => ({
          reference: item.source.reference,
          text: item.text,
        })),
        targetReduction,
        protectedBytes,
        maxProjectionBytes: Math.min(
          4096,
          Math.floor(originalSourceBytes * 0.1),
        ),
      });
    } catch {
      fallback(receipt, "planner-rejected");
      record(receipt, startedAt);
      return;
    }
    const candidate: TaskContextCandidate = {
      strategy,
      applied: plan.applied,
      targetReached: false,
      estimatedTargetReached: plan.targetReached,
      targetReduction,
      originalSourceBytes,
      projectedSourceBytes: plan.projectionBytes,
      protectedBytes,
      estimatedFullOriginalBytes: plan.originalTotalBytes,
      estimatedFullProjectedBytes: plan.projectedTotalBytes,
      wholePayloadOriginalBytes: null,
      wholePayloadProjectedBytes: null,
      actualByteReductionFraction: null,
      actualTokenMetrics: null,
      summarizerFallbacks: 0,
      blocks: [],
    };
    receipt.candidate = candidate;
    metrics.estimatedOriginalPromptTokens = Math.ceil(
      plan.originalTotalBytes / 4,
    );
    metrics.estimatedProjectedPromptTokens = Math.ceil(
      plan.projectedTotalBytes / 4,
    );
    metrics.estimatedPromptReductionFraction = plan.reduction;
    if (!plan.applied) {
      fallback(receipt, `target-unreachable:${plan.skipReason ?? plan.reason}`);
      record(receipt, startedAt);
      return;
    }
    const projected = new Map<
      string,
      { text: string; format: TaskContextBlock["format"] }
    >();
    let summaries = 0;
    for (const source of plan.sources) {
      let text = source.renderedText;
      let format: TaskContextBlock["format"] = "jev-tool-excerpts-v1";
      if (
        strategy === "caveman" &&
        text !==
          captured.find((item) => item.source.reference === source.reference)
            ?.text
      ) {
        const header = `Task fragments (reference ${source.reference}; omitted details remain in the original):\n`;
        const maxOutputBytes = Math.max(0, bytes(text) - bytes(header));
        if (
          options.summarize &&
          summaries < maxSummaries &&
          maxOutputBytes > 0
        ) {
          summaries++;
          const timeout = new AbortController();
          const signal = context.signal
            ? AbortSignal.any([context.signal, timeout.signal])
            : timeout.signal;
          let timer: ReturnType<typeof setTimeout> | undefined;
          let removeAbort: (() => void) | undefined;
          try {
            const response = await Promise.race([
              Promise.resolve(
                options.summarize({
                  task,
                  reference: source.reference,
                  excerpt: text,
                  maxOutputBytes,
                  signal,
                }),
              ),
              new Promise<never>((_, reject) => {
                const abort = () => reject(new Error("summary-unavailable"));
                signal.addEventListener("abort", abort, { once: true });
                removeAbort = () => signal.removeEventListener("abort", abort);
                timer = setTimeout(() => timeout.abort(), summarizeMs);
                if (signal.aborted) abort();
              }),
            ]);
            if (
              !plain(response) ||
              response.complete !== true ||
              typeof response.text !== "string" ||
              !response.text.trim() ||
              response.text.length > maxOutputBytes ||
              !validUnicode(response.text) ||
              bytes(response.text) > maxOutputBytes
            )
              throw new Error("summary-unavailable");
            text = header + response.text;
            format = "jev-caveman-v1";
          } catch {
            candidate.summarizerFallbacks++;
          } finally {
            if (timer) clearTimeout(timer);
            removeAbort?.();
          }
        } else candidate.summarizerFallbacks++;
      }
      projected.set(source.reference, { text, format });
    }
    if (
      !enabled ||
      generation !== turnGeneration ||
      currentScope !== scope ||
      context.signal?.aborted
    ) {
      fallback(receipt, "cancelled", "cancelled");
      record(receipt, startedAt);
      return;
    }
    const messages = event.messages.slice();
    const originalMessages = event.messages.slice();
    const blocks: Pending["blocks"] = [];
    for (const item of captured) {
      const source = plan.sources.find(
        (row) => row.reference === item.source.reference,
      );
      const result = projected.get(item.source.reference);
      if (!source || !result || result.text === item.text) continue;
      const content = item.message.content.slice();
      const block = content[item.contentIndex];
      if (block.type !== "text") continue;
      content[item.contentIndex] = { ...block, text: result.text };
      const message = { ...item.message, content };
      ownedMessages.set(message, item.text);
      messages[item.messageIndex] = message;
      const originalContent = item.message.content.slice();
      originalContent[item.contentIndex] = { ...block, text: item.text };
      originalMessages[item.messageIndex] = {
        ...item.message,
        content: originalContent,
      };
      const evidence: TaskContextBlock = {
        messageIndex: item.messageIndex,
        contentIndex: item.contentIndex,
        toolResultOrdinal: item.toolResultOrdinal,
        toolCallId: item.message.toolCallId,
        reference: item.source.reference,
        format: result.format,
        originalSha256: item.source.sha256,
        compressedSha256: hash(result.text),
        originalBytes: item.source.bytes,
        compressedBytes: bytes(result.text),
        selectedLineRanges: clone(source.selectedLineRanges),
        omittedLineRanges: clone(source.omittedLineRanges),
      };
      receipt.blocks.push(evidence);
      blocks.push({
        ...evidence,
        originalText: item.text,
        projectedText: result.text,
      });
    }
    receipt.compressedBlocks = blocks.length;
    receipt.originalBytes = originalSourceBytes;
    receipt.compressedBytes = captured.reduce(
      (sum, item) =>
        sum + bytes(projected.get(item.source.reference)?.text ?? item.text),
      0,
    );
    receipt.toolTextBytesSaved =
      receipt.originalBytes - receipt.compressedBytes;
    receipt.bytesSaved = receipt.toolTextBytesSaved;
    candidate.blocks = clone(receipt.blocks);
    candidate.projectedSourceBytes = receipt.compressedBytes;
    candidate.estimatedFullProjectedBytes =
      protectedBytes + receipt.compressedBytes + bytes(plan.preamble);
    if (blocks.length === 0) {
      fallback(receipt, "no-projection");
      record(receipt, startedAt);
      return;
    }
    let fallbackMessages: WireMessage[] | undefined;
    try {
      const { convertToLlm } = await import("@earendil-works/pi-coding-agent");
      const convertMessages = await installedOpenAiConverter();
      const openAiModel = {
        ...model,
        api: "openai-completions" as const,
        id: allowedModels[0],
      };
      fallbackMessages = clone(
        convertMessages(
          openAiModel,
          { systemPrompt, messages: convertToLlm(originalMessages) },
          {} as never,
          {},
        ),
      ) as unknown as WireMessage[];
    } catch {
      // A projection is emitted only when its complete literal restoration is
      // available through this installed SDK's actual supported converter.
      receipt.compressedBlocks = 0;
      receipt.compressedBytes = receipt.originalBytes;
      receipt.toolTextBytesSaved = 0;
      receipt.bytesSaved = 0;
      receipt.blocks = [];
      candidate.applied = false;
      candidate.targetReached = false;
      candidate.blocks = [];
      fallback(receipt, "converter-unavailable", "provider_boundary");
      record(receipt, startedAt);
      return;
    }
    if (!enabled || generation !== turnGeneration || currentScope !== scope) {
      fallback(receipt, "cancelled", "cancelled");
      record(receipt, startedAt);
      return;
    }
    pending = {
      generation,
      scope: currentScope,
      annotation: plan.preamble,
      toolIds,
      modelIds: allowedModels,
      originalMessages,
      fallbackMessages,
      blocks,
    };
    metrics.projectionFallbackReason =
      candidate.summarizerFallbacks > 0
        ? "summarizer-fallback-to-excerpts"
        : null;
    record(receipt, startedAt);
    return { messages };
  });

  pi.on("before_provider_request", (event) => {
    const startedAt = performance.now();
    const prepared = pending;
    pending = undefined;
    const elapsed = () => {
      const ms = performance.now() - startedAt;
      metrics.providerValidationElapsedMs += ms;
      if (metrics.lastContext)
        metrics.lastContext.providerValidationElapsedMs += ms;
    };
    const payload = plain(event.payload) ? event.payload : {};
    const priorLiteral = guardedPayloads.get(payload);
    if (priorLiteral) {
      metrics.restoredProviderRequests++;
      rejectPrepared("repeated-provider-projection");
      elapsed();
      return clone(priorLiteral);
    }
    if (!prepared) {
      const literal = stripRetrieval(payload);
      elapsed();
      return literal;
    }
    const messages = Array.isArray(payload.messages)
      ? payload.messages
      : undefined;
    const shape = messages?.every(
      (message) =>
        plain(message) &&
        typeof message.role === "string" &&
        ["system", "developer", "user", "assistant", "tool"].includes(
          message.role,
        ),
    );
    if (!shape || !messages) {
      metrics.unverifiedProviderRequests++;
      metrics.restoredProviderRequests++;
      rejectPrepared("malformed-provider-payload");
      elapsed();
      return {
        ...stripRetrieval(payload),
        messages: prepared.fallbackMessages ?? [],
      };
    }
    const tools = messages.filter(
      (message: WireMessage) => message.role === "tool",
    );
    const activeTools = Array.isArray(payload.tools) ? payload.tools : [];
    const ownedTools = activeTools.filter(
      (tool) =>
        plain(tool) &&
        plain(tool.function) &&
        tool.function.name === TASK_CONTEXT_READ_TOOL,
    );
    let dispatchAvailable = false;
    try {
      dispatchAvailable = pi.getActiveTools().includes(TASK_CONTEXT_READ_TOOL);
    } catch {
      /* An unbound/removed dispatch catalog cannot advertise retrieval. */
    }
    const schemaValid =
      dispatchAvailable &&
      ownedTools.length === 1 &&
      ownedTools.every(
        (tool) =>
          plain(tool) &&
          tool.type === "function" &&
          plain(tool.function) &&
          tool.function.description === retrievalFunction.description &&
          isDeepStrictEqual(
            tool.function.parameters,
            retrievalFunction.parameters,
          ) &&
          !Object.keys(tool.function).some(
            (key) =>
              !["name", "description", "parameters", "strict"].includes(key),
          ),
      );
    const valid =
      enabled &&
      task !== undefined &&
      scope === prepared.scope &&
      turnGeneration === prepared.generation &&
      typeof payload.model === "string" &&
      prepared.modelIds.includes(payload.model) &&
      schemaValid &&
      tools.length === prepared.toolIds.length &&
      tools.every(
        (tool: WireMessage, index: number) =>
          tool.tool_call_id === prepared.toolIds[index],
      ) &&
      prepared.blocks.every(
        (block) =>
          references.has(block.reference) &&
          wireText(tools[block.toolResultOrdinal - 1]?.content) ===
            block.projectedText,
      );
    if (!valid) {
      metrics.restoredProviderRequests++;
      const identitiesIntact =
        prepared.blocks.every((block) =>
          tools.some(
            (tool: WireMessage) => tool.tool_call_id === block.toolCallId,
          ),
        ) &&
        !messages.some(
          (message: WireMessage) =>
            message.role !== "tool" &&
            prepared.blocks.some(
              (block) => wireText(message.content) === block.projectedText,
            ),
        );
      if (!identitiesIntact || tools.length !== prepared.toolIds.length)
        metrics.unverifiedProviderRequests++;
      rejectPrepared("provider-boundary");
      elapsed();
      if (!identitiesIntact)
        return {
          ...stripRetrieval(payload),
          messages: prepared.fallbackMessages ?? [],
        };
      return restore(payload, prepared);
    }
    const literal = restore(payload, prepared);
    let projected: Record<string, unknown> = {
      ...payload,
      messages: messages.slice(),
    };
    const projectedMessages = projected.messages as WireMessage[];
    const systemIndex = projectedMessages.findIndex(
      (message) =>
        ["system", "developer"].includes(String(message.role)) &&
        wireText(message.content) !== undefined,
    );
    if (systemIndex >= 0) {
      const system = projectedMessages[systemIndex];
      projectedMessages[systemIndex] = replaceWireText(
        system,
        `${wireText(system.content)}\n\n${prepared.annotation}`,
      );
    } else
      projectedMessages.unshift({
        role: "system",
        content: prepared.annotation,
      });
    let originalBytes: number;
    let projectedBytes: number;
    try {
      originalBytes = bytes(JSON.stringify(literal));
      projectedBytes = bytes(JSON.stringify(projected));
    } catch {
      metrics.restoredProviderRequests++;
      rejectPrepared("unserializable-provider-payload");
      elapsed();
      return literal;
    }
    const reduction =
      originalBytes > 0 ? 1 - projectedBytes / originalBytes : 0;
    const candidate = metrics.candidate;
    if (candidate) {
      candidate.wholePayloadOriginalBytes = originalBytes;
      candidate.wholePayloadProjectedBytes = projectedBytes;
      candidate.actualByteReductionFraction = reduction;
      candidate.targetReached = reduction >= targetReduction;
    }
    if (metrics.lastContext?.candidate && candidate)
      metrics.lastContext.candidate = clone(candidate);
    metrics.estimatedOriginalPromptTokens = Math.ceil(originalBytes / 4);
    metrics.estimatedProjectedPromptTokens = Math.ceil(projectedBytes / 4);
    metrics.estimatedPromptReductionFraction = reduction;
    if (reduction < targetReduction) {
      metrics.restoredProviderRequests++;
      rejectPrepared("target-unreachable:whole-request-overhead");
      elapsed();
      return literal;
    }
    let immutableLiteral: Record<string, unknown>;
    try {
      immutableLiteral = clone(literal);
    } catch {
      metrics.restoredProviderRequests++;
      rejectPrepared("unclonable-provider-payload");
      elapsed();
      return literal;
    }
    metrics.validatedProviderRequests++;
    metrics.targetReached = true;
    if (metrics.lastContext)
      metrics.lastContext.instructionBytes =
        bytes(prepared.annotation) + (systemIndex >= 0 ? 2 : 0);
    guardedPayloads.set(projected, immutableLiteral);
    elapsed();
    return projected;
  });

  pi.on("session_start", clearScope);
  pi.on("session_before_switch", clearScope);
  pi.on("session_before_fork", clearScope);
  pi.on("session_before_tree", clearScope);
  pi.on("session_shutdown", clearScope);
  pi.on("agent_settled", () => {
    task = undefined;
    turnGeneration++;
  });
  return {
    status: () => ({
      enabled,
      readyForCurrentTurn: enabled && task !== undefined,
      strategy,
      targetReduction,
      originals: clone(store.status()),
      ...clone(metrics),
    }),
    setEnabled(value) {
      if (typeof value !== "boolean")
        throw new Error("Context compression enabled must be a boolean");
      enabled = value;
      if (!value) {
        references.clear();
        task = undefined;
        turnGeneration++;
        activeRetrieval(false);
      }
    },
    setStrategy(value) {
      if (value !== "excerpts" && value !== "caveman")
        throw new Error("Unknown task context strategy");
      strategy = value;
      turnGeneration++;
    },
    resetMetrics,
    isContextManifest: () => false,
  };
}
