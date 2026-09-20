import { randomBytes, createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type {
  ContextEvent,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  COMPACT_TOOL_TEXT_FORMAT,
  CONTEXT_COMPRESSION_INSTRUCTIONS,
  compactToolText,
  type CompactToolTextOptions,
} from "./context-compact.js";

type ContextMessage = ContextEvent["messages"][number];
type ToolResultMessage = Extract<ContextMessage, { role: "toolResult" }>;

const MANIFEST_CUSTOM_TYPE = "jev-context-compression-manifest";
const MAX_CONTEXT_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_BLOCKS = 512;
// Retaining one prepared request also bounds literal fallback text retention.
const MAX_RECENT_MANIFESTS = 1;

export type ContextCompressionFallback =
  | "instructions_unavailable"
  | "cancelled"
  | "clone_failed"
  | "codec_rejected"
  | "context_limit"
  | "manifest_overhead"
  | "unsupported_provider"
  | "multipart_text"
  | "provider_boundary";

/** Host evidence; neither these hashes nor original text enter the manifest. */
export interface ContextCompressionBlock {
  messageIndex: number;
  contentIndex: number;
  /** One-based ordinal among toolResult messages, after Pi's LLM conversion too. */
  toolResultOrdinal: number;
  format: typeof COMPACT_TOOL_TEXT_FORMAT;
  originalSha256: string;
  compressedSha256: string;
  originalBytes: number;
  compressedBytes: number;
}

export interface ContextCompressionReceipt {
  compressedBlocks: number;
  originalBytes: number;
  /** Tool text bytes, excluding the separate host manifest. */
  compressedBytes: number;
  toolTextBytesSaved: number;
  /** Tool text savings minus manifest bytes; system instructions are separate. */
  bytesSaved: number;
  manifestBytes: number;
  instructionBytes: number;
  fallbackCount: number;
  lastFallback: ContextCompressionFallback | null;
  reused: boolean;
  transformElapsedMs: number;
  providerValidationElapsedMs: number;
  blocks: ContextCompressionBlock[];
}

export interface ContextCompressionStatus {
  enabled: boolean;
  readyForCurrentTurn: boolean;
  contextCalls: number;
  compressedBlocks: number;
  originalBytes: number;
  compressedBytes: number;
  toolTextBytesSaved: number;
  bytesSaved: number;
  manifestBytes: number;
  fallbackCount: number;
  lastFallback: ContextCompressionFallback | null;
  lastContext: ContextCompressionReceipt | null;
  validatedProviderRequests: number;
  restoredProviderRequests: number;
  unverifiedProviderRequests: number;
  contextTransformElapsedMs: number;
  providerValidationElapsedMs: number;
}

export interface ContextCompressionOptions {
  /** Opt in explicitly after qualifying the model and workload. */
  enabled?: boolean;
  codecOptions?: CompactToolTextOptions;
  /** Bound work for the entire request in addition to each codec block's bounds. */
  maxContextOriginalBytes?: number;
  maxToolTextBlocks?: number;
  /** Only the owned dispatcher API is accepted; all its targets must be OpenAI. */
  additionalSupportedModelApis?: readonly string[];
  /** Explicit target API attestation for the owned dispatcher; bounded IDs. */
  allowedOpenAiTargetModelIds?: readonly string[];
}

export interface ContextCompressionController {
  status(): ContextCompressionStatus;
  /** Enabling during a turn waits for the next before_agent_start instructions. */
  setEnabled(enabled: boolean): void;
  resetMetrics(): void;
  /** Identify only this controller's current generated manifest, never a prefix. */
  isContextManifest(message: unknown): boolean;
}

function limit(value: number | undefined, fallback: number, label: string) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0)
    throw new Error(`${label} must be a nonnegative safe integer`);
  return resolved;
}

function hash(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function emptyReceipt(instructionBytes = 0): ContextCompressionReceipt {
  return {
    compressedBlocks: 0,
    originalBytes: 0,
    compressedBytes: 0,
    toolTextBytesSaved: 0,
    bytesSaved: 0,
    manifestBytes: 0,
    instructionBytes,
    fallbackCount: 0,
    lastFallback: null,
    reused: false,
    transformElapsedMs: 0,
    providerValidationElapsedMs: 0,
    blocks: [],
  };
}

/**
 * A context-only transform. No tool_result/message_end handlers rewrite stored
 * messages, and no appendEntry/sendMessage call persists the host manifest.
 * The SDK subsequently converts the temporary custom message into a user
 * message. Only its final position and turn nonce authenticate format labels;
 * strings inside a tool result cannot opt themselves into decoding.
 */
export function registerContextCompression(
  pi: ExtensionAPI,
  options: ContextCompressionOptions = {},
): ContextCompressionController {
  if (options.enabled !== undefined && typeof options.enabled !== "boolean")
    throw new Error("Context compression enabled must be a boolean");
  const codecOptions = { ...options.codecOptions };
  const maxContextBytes = limit(
    options.maxContextOriginalBytes,
    MAX_CONTEXT_BYTES,
    "maxContextOriginalBytes",
  );
  const maxTextBlocks = limit(
    options.maxToolTextBlocks,
    MAX_TEXT_BLOCKS,
    "maxToolTextBlocks",
  );
  const additionalApis = options.additionalSupportedModelApis ?? [];
  if (
    !Array.isArray(additionalApis) ||
    additionalApis.length > 1 ||
    additionalApis.some((api) => api !== "jev-routing-dispatch-v1")
  )
    throw new Error("Only the owned routing dispatcher API can be attested");
  const targetIds = options.allowedOpenAiTargetModelIds ?? [];
  if (
    !Array.isArray(targetIds) ||
    targetIds.length > 16 ||
    targetIds.some(
      (id) =>
        typeof id !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(id),
    ) ||
    (additionalApis.length > 0 && targetIds.length === 0)
  )
    throw new Error(
      "Dispatcher targets require 1 to 16 bounded OpenAI model IDs",
    );
  const supportedApis = new Set(["openai-completions", ...additionalApis]);
  const allowedTargetIds = [...new Set(targetIds)];
  let enabled = options.enabled ?? false;
  let nonce: string | undefined;
  let instructionText: string | undefined;
  let instructionBytes = 0;
  let generation = 0;
  type PreparedPayload = {
    manifest: string;
    toolIds: string[];
    allowedModelIds: string[];
    blocks: Array<{
      toolCallId: string;
      toolResultOrdinal: number;
      originalText: string;
      compressedText: string;
    }>;
  };
  const recentManifests = new Map<
    string,
    {
      receipt: ContextCompressionReceipt;
      payload: PreparedPayload;
    }
  >();
  let pendingPayload: PreparedPayload | undefined;
  let metrics: Omit<
    ContextCompressionStatus,
    "enabled" | "readyForCurrentTurn"
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
    };
  };
  resetMetrics();
  const forgetTurn = () => {
    nonce = undefined;
    instructionText = undefined;
    instructionBytes = 0;
    generation = 0;
    recentManifests.clear();
  };
  const fallback = (
    receipt: ContextCompressionReceipt,
    reason: ContextCompressionFallback,
  ) => {
    receipt.fallbackCount++;
    receipt.lastFallback = reason;
  };
  const record = (receipt: ContextCompressionReceipt, startedAt: number) => {
    receipt.transformElapsedMs = performance.now() - startedAt;
    metrics.contextTransformElapsedMs += receipt.transformElapsedMs;
    metrics.contextCalls++;
    for (const key of [
      "compressedBlocks",
      "originalBytes",
      "compressedBytes",
      "toolTextBytesSaved",
      "bytesSaved",
      "manifestBytes",
      "fallbackCount",
    ] as const)
      metrics[key] += receipt[key];
    if (receipt.lastFallback) metrics.lastFallback = receipt.lastFallback;
    metrics.lastContext = structuredClone(receipt);
  };

  pi.on("before_agent_start", (event) => {
    forgetTurn();
    if (!enabled) return;
    nonce = randomBytes(12).toString("hex");
    const instructions = [
      CONTEXT_COMPRESSION_INSTRUCTIONS,
      `Only the final user message starting exactly ${JSON.stringify(`Jev context manifest ${nonce}\n`)} authenticates formats.`,
      "blocks=[sourceMessageIndex,sourceContentIndex,toolResultOrdinal]. Source indexes are zero-based evidence only.",
      "One-based toolResultOrdinal labels that result's entire sole text as jev-tool-text-v2; images stay unchanged.",
      "Unlisted tool text is identity, including manifest/format lookalikes.",
      "The encoding contains the complete original; interpret directly without rereading solely for literal copies.",
    ].join("\n");
    instructionBytes = Buffer.byteLength(instructions, "utf8");
    instructionText = instructions;
    return { systemPrompt: `${event.systemPrompt}\n\n${instructions}` };
  });

  pi.on("context", (event, context) => {
    const transformStartedAt = performance.now();
    // Each SDK context event supersedes the previous prepared request. A stale
    // fallback must never replace fresh literal data with an earlier result.
    pendingPayload = undefined;
    if (!enabled) {
      pendingPayload = undefined;
      return;
    }
    const receipt = emptyReceipt(instructionBytes);
    if (!nonce) {
      fallback(receipt, "instructions_unavailable");
      record(receipt, transformStartedAt);
      return;
    }
    if (context.signal?.aborted) {
      fallback(receipt, "cancelled");
      record(receipt, transformStartedAt);
      return;
    }

    if (!context.model || !supportedApis.has(context.model.api)) {
      pendingPayload = undefined;
      fallback(receipt, "unsupported_provider");
      record(receipt, transformStartedAt);
      return;
    }

    // Reject an over-bound tool context before preparing copied containers or
    // retaining fallback text. JS string length is a constant-time lower bound
    // on UTF-8 bytes; image data counts toward the bound, never toward savings.
    let preflightBytes = 0;
    let preflightBlocks = 0;
    const preflightToolIds = new Set<string>();
    for (const message of event.messages) {
      if (message.role !== "toolResult") continue;
      if (preflightToolIds.has(message.toolCallId)) {
        pendingPayload = undefined;
        fallback(receipt, "provider_boundary");
        record(receipt, transformStartedAt);
        return;
      }
      preflightToolIds.add(message.toolCallId);
      for (const block of message.content) {
        if (block.type === "text") {
          preflightBlocks++;
          if (
            preflightBlocks > maxTextBlocks ||
            block.text.length > maxContextBytes - preflightBytes
          ) {
            pendingPayload = undefined;
            fallback(receipt, "context_limit");
            record(receipt, transformStartedAt);
            return;
          }
          preflightBytes += Buffer.byteLength(block.text, "utf8");
        } else if (block.type === "image") {
          if (block.data.length > maxContextBytes - preflightBytes) {
            pendingPayload = undefined;
            fallback(receipt, "context_limit");
            record(receipt, transformStartedAt);
            return;
          }
          preflightBytes += Buffer.byteLength(block.data, "utf8");
        }
        if (preflightBytes > maxContextBytes) {
          pendingPayload = undefined;
          fallback(receipt, "context_limit");
          record(receipt, transformStartedAt);
          return;
        }
      }
    }

    let messages: ContextMessage[];
    try {
      // Clone the containers we expose and mutate; immutable strings/image
      // data and untouched details need no deep allocation. The SDK already
      // clones canonical session messages before calling extension handlers.
      messages = event.messages.map((message) =>
        "content" in message && Array.isArray(message.content)
          ? ({
              ...message,
              content: message.content.map((block) => ({ ...block })),
            } as ContextMessage)
          : { ...message },
      );
    } catch {
      fallback(receipt, "clone_failed");
      record(receipt, transformStartedAt);
      return;
    }

    // An SDK request normally starts from canonical originals. Still make a
    // second invocation on our own returned context idempotent, including after
    // structuredClone. Never infer encoding from a tool's content or details.
    const finalMessage = messages.at(-1);
    if (
      finalMessage?.role === "custom" &&
      finalMessage.customType === MANIFEST_CUSTOM_TYPE &&
      typeof finalMessage.content === "string"
    ) {
      const prior = recentManifests.get(finalMessage.content);
      if (
        prior &&
        prior.receipt.blocks.every((block) => {
          const message = messages[block.messageIndex];
          const content =
            message?.role === "toolResult"
              ? message.content[block.contentIndex]
              : undefined;
          return (
            content?.type === "text" &&
            hash(content.text) === block.compressedSha256 &&
            messages
              .slice(0, block.messageIndex + 1)
              .filter((entry) => entry.role === "toolResult").length ===
              block.toolResultOrdinal
          );
        })
      ) {
        const reused = structuredClone(prior.receipt);
        reused.reused = true;
        pendingPayload = prior.payload;
        record(reused, transformStartedAt);
        return { messages };
      }
    }

    let toolResultOrdinal = 0;
    let seenBlocks = 0;
    let contextBytes = 0;
    const toolIds: string[] = [];
    const providerBlocks: PreparedPayload["blocks"] = [];
    for (const [messageIndex, message] of messages.entries()) {
      if (message.role !== "toolResult") continue;
      toolResultOrdinal++;
      toolIds.push(message.toolCallId);
      const original = event.messages[messageIndex] as ToolResultMessage;
      const textBlocks = message.content.filter(
        (block) => block.type === "text",
      );
      for (const [contentIndex, block] of message.content.entries()) {
        if (block.type !== "text") continue;
        const originalBlock = original.content[contentIndex];
        if (originalBlock.type !== "text") continue;
        const originalBytes = Buffer.byteLength(originalBlock.text, "utf8");
        receipt.originalBytes += originalBytes;
        receipt.compressedBytes += originalBytes;
        seenBlocks++;
        contextBytes += originalBytes;
        // Chat Completions flattens text blocks with newlines and moves images
        // into a separate user message. One text block preserves an unambiguous
        // format boundary without altering images or inventing separators.
        if (textBlocks.length !== 1) {
          fallback(receipt, "multipart_text");
          continue;
        }
        // Restrict compression to IDs the installed provider replays verbatim;
        // pipe-separated or overlong IDs can be normalized by the SDK.
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(message.toolCallId)) {
          fallback(receipt, "provider_boundary");
          continue;
        }
        if (seenBlocks > maxTextBlocks || contextBytes > maxContextBytes) {
          fallback(receipt, "context_limit");
          continue;
        }
        try {
          const compact = compactToolText(originalBlock.text, codecOptions);
          if (!compact.applied) continue;
          // Preserve errors, images, signatures, references, metadata and order.
          // Only the copied text field changes.
          block.text = compact.modelVisibleText;
          receipt.compressedBytes -= originalBytes - compact.compressedBytes;
          receipt.blocks.push({
            messageIndex,
            contentIndex,
            toolResultOrdinal,
            format: COMPACT_TOOL_TEXT_FORMAT,
            originalSha256: compact.originalSha256,
            compressedSha256: compact.compressedSha256,
            originalBytes: compact.originalBytes,
            compressedBytes: compact.compressedBytes,
          });
          providerBlocks.push({
            toolCallId: message.toolCallId,
            toolResultOrdinal,
            originalText: originalBlock.text,
            compressedText: compact.modelVisibleText,
          });
        } catch {
          // Bounds/Unicode/options failures preserve the exact original string.
          fallback(receipt, "codec_rejected");
        }
      }
    }
    receipt.compressedBlocks = receipt.blocks.length;
    receipt.toolTextBytesSaved =
      receipt.originalBytes - receipt.compressedBytes;
    if (!receipt.compressedBlocks) {
      pendingPayload = undefined;
      record(receipt, transformStartedAt);
      return;
    }

    const manifest = `Jev context manifest ${nonce}\n${JSON.stringify({
      generation: ++generation,
      blocks: receipt.blocks.map((block) => [
        block.messageIndex,
        block.contentIndex,
        block.toolResultOrdinal,
      ]),
    })}`;
    receipt.manifestBytes = Buffer.byteLength(manifest, "utf8");
    receipt.bytesSaved = receipt.toolTextBytesSaved - receipt.manifestBytes;
    if (receipt.bytesSaved <= 0) {
      fallback(receipt, "manifest_overhead");
      receipt.compressedBlocks = 0;
      receipt.compressedBytes = receipt.originalBytes;
      receipt.toolTextBytesSaved = 0;
      receipt.bytesSaved = 0;
      receipt.manifestBytes = 0;
      receipt.blocks = [];
      record(receipt, transformStartedAt);
      return;
    }
    messages.push({
      role: "custom",
      customType: MANIFEST_CUSTOM_TYPE,
      content: manifest,
      display: false,
      // Deterministic metadata; the message exists only in this returned copy.
      timestamp: 0,
    });
    pendingPayload = {
      manifest,
      toolIds,
      blocks: providerBlocks,
      allowedModelIds:
        allowedTargetIds.length > 0 ? allowedTargetIds : [context.model.id],
    };
    recentManifests.set(manifest, {
      receipt: structuredClone(receipt),
      payload: pendingPayload,
    });
    while (recentManifests.size > MAX_RECENT_MANIFESTS)
      recentManifests.delete(recentManifests.keys().next().value!);
    record(receipt, transformStartedAt);
    return { messages };
  });

  pi.on("before_provider_request", (event) => {
    if (!pendingPayload) return;
    const startedAt = performance.now();
    const recordValidationElapsed = () => {
      const elapsed = performance.now() - startedAt;
      metrics.providerValidationElapsedMs += elapsed;
      if (metrics.lastContext)
        metrics.lastContext.providerValidationElapsedMs += elapsed;
    };
    const pending = pendingPayload;
    pendingPayload = undefined;
    const payload = event.payload as Record<string, unknown> | null;
    if (
      !payload ||
      typeof payload !== "object" ||
      !Array.isArray(payload.messages)
    ) {
      metrics.unverifiedProviderRequests++;
      metrics.fallbackCount++;
      metrics.lastFallback = "provider_boundary";
      recordValidationElapsed();
      // A malformed provider payload has no known place to put valid messages.
      // Leave its existing transport failure visible rather than fabricate one.
      return;
    }
    const messages = payload.messages as Array<Record<string, unknown>>;
    const wireText = (content: unknown): string | undefined => {
      if (typeof content === "string") return content;
      if (
        Array.isArray(content) &&
        content.length === 1 &&
        content[0]?.type === "text" &&
        typeof content[0].text === "string"
      )
        return content[0].text;
      return undefined;
    };
    const tools = messages.filter((message) => message?.role === "tool");
    const final = messages.at(-1);
    const valid =
      enabled &&
      nonce !== undefined &&
      instructionText !== undefined &&
      typeof payload.model === "string" &&
      pending.allowedModelIds.includes(payload.model) &&
      messages.every(
        (message) =>
          message !== null &&
          typeof message === "object" &&
          !Array.isArray(message) &&
          typeof message.role === "string" &&
          ["system", "developer", "user", "assistant", "tool"].includes(
            message.role,
          ),
      ) &&
      messages.some(
        (message) =>
          (message?.role === "system" || message?.role === "developer") &&
          wireText(message.content)?.includes(instructionText!),
      ) &&
      final?.role === "user" &&
      wireText(final.content) === pending.manifest &&
      tools.length === pending.toolIds.length &&
      tools.every(
        (message, index) => message.tool_call_id === pending.toolIds[index],
      ) &&
      pending.blocks.every(
        (block) =>
          wireText(tools[block.toolResultOrdinal - 1]?.content) ===
          block.compressedText,
      );
    if (valid) {
      metrics.validatedProviderRequests++;
      recordValidationElapsed();
      return;
    }

    // Later context hooks may append/reorder/remove messages. Restore each
    // surviving transformed result by its protocol ID and remove only our own
    // exact manifest. Other extensions' messages and payload fields remain.
    const restored = messages.flatMap((message) => {
      if (
        message?.role === "user" &&
        wireText(message.content) === pending.manifest
      )
        return [];
      const original =
        message?.role === "tool"
          ? pending.blocks.find(
              (block) => block.toolCallId === message.tool_call_id,
            )
          : undefined;
      if (!original) return [message];
      return [
        {
          ...message,
          content:
            Array.isArray(message.content) &&
            message.content.length === 1 &&
            message.content[0]?.type === "text"
              ? [{ ...message.content[0], text: original.originalText }]
              : original.originalText,
        },
      ];
    });
    metrics.restoredProviderRequests++;
    metrics.fallbackCount++;
    metrics.lastFallback = "provider_boundary";
    if (metrics.lastContext) {
      const latest = metrics.lastContext;
      metrics.compressedBlocks -= latest.compressedBlocks;
      metrics.compressedBytes += latest.toolTextBytesSaved;
      metrics.toolTextBytesSaved -= latest.toolTextBytesSaved;
      metrics.bytesSaved -= latest.bytesSaved;
      metrics.manifestBytes -= latest.manifestBytes;
      latest.compressedBlocks = 0;
      latest.compressedBytes = latest.originalBytes;
      latest.toolTextBytesSaved = 0;
      latest.bytesSaved = 0;
      latest.manifestBytes = 0;
      latest.blocks = [];
      latest.fallbackCount++;
      latest.lastFallback = "provider_boundary";
    }
    recordValidationElapsed();
    return { ...payload, messages: restored };
  });

  pi.on("session_start", forgetTurn);
  pi.on("session_before_switch", forgetTurn);
  pi.on("session_shutdown", forgetTurn);
  pi.on("agent_settled", forgetTurn);

  return {
    status: () => ({
      enabled,
      readyForCurrentTurn: enabled && nonce !== undefined,
      ...structuredClone(metrics),
    }),
    setEnabled: (value) => {
      if (typeof value !== "boolean")
        throw new Error("Context compression enabled must be a boolean");
      enabled = value;
      if (!enabled) forgetTurn();
    },
    resetMetrics,
    isContextManifest: (value) => {
      if (
        !enabled ||
        !nonce ||
        !value ||
        typeof value !== "object" ||
        Array.isArray(value)
      )
        return false;
      const role = Object.getOwnPropertyDescriptor(value, "role")?.value;
      if (role !== "user" && role !== "custom") return false;
      if (
        role === "custom" &&
        Object.getOwnPropertyDescriptor(value, "customType")?.value !==
          MANIFEST_CUSTOM_TYPE
      )
        return false;
      const content = Object.getOwnPropertyDescriptor(value, "content")?.value;
      let text: string | undefined;
      if (typeof content === "string") text = content;
      else if (Array.isArray(content) && content.length === 1) {
        const block = Object.getOwnPropertyDescriptor(content, "0")?.value;
        if (
          block &&
          typeof block === "object" &&
          Object.getOwnPropertyDescriptor(block, "type")?.value === "text"
        ) {
          const candidate = Object.getOwnPropertyDescriptor(
            block,
            "text",
          )?.value;
          if (typeof candidate === "string") text = candidate;
        }
      }
      return text !== undefined && recentManifests.has(text);
    },
  };
}
