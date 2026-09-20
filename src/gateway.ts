import { createHash } from "node:crypto";

export const DEFAULT_GATEWAY_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_GATEWAY_TIMEOUT_MS = 120_000;

export interface GatewayMessage {
  role: "system" | "developer" | "user" | "assistant";
  content: string;
}

export interface GatewayUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cachedPromptTokens: number | null;
}

export interface GatewayChatRequest {
  messages: readonly GatewayMessage[];
  maxTokens: number;
  signal?: AbortSignal;
}

export interface GatewayChatResult {
  assistantText: string;
  finishReason: "stop";
  usage: GatewayUsage;
  /** Monotonic elapsed time through response reading and protocol validation. */
  elapsedMs: number;
  /** SHA-256 of the exact received response bytes, before UTF-8 decoding. */
  responseSha256: string;
}

export interface GatewayTransportOptions {
  /** Configured HTTPS API base, such as https://gateway.example/v1. */
  baseUrl: string;
  model: string;
  apiKey: string;
  maxResponseBytes?: number;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export interface GatewayTransport {
  chat(request: GatewayChatRequest): Promise<GatewayChatResult>;
}

export type GatewayErrorCode =
  | "invalid_configuration"
  | "invalid_request"
  | "aborted"
  | "timeout"
  | "network_error"
  | "http_error"
  | "response_too_large"
  | "protocol_error"
  | "incomplete_completion"
  | "invalid_json_object"
  | "duplicate_json_key";

const ERROR_MESSAGES: Record<GatewayErrorCode, string> = {
  invalid_configuration: "Gateway configuration is invalid",
  invalid_request: "Gateway request is invalid",
  aborted: "Gateway request was aborted; usage is unknown",
  timeout: "Gateway request timed out; usage is unknown",
  network_error: "Gateway transport failed; usage is unknown",
  http_error: "Gateway HTTP request failed; usage is unknown",
  response_too_large:
    "Gateway response exceeded its byte bound; usage is unknown",
  protocol_error: "Gateway response protocol is invalid; usage is unknown",
  incomplete_completion: "Gateway completion did not finish successfully",
  invalid_json_object: "Gateway JSON object is invalid",
  duplicate_json_key: "Gateway JSON object has duplicate keys",
};

/** Safe error metadata only: never retains a cause, options, body, or key. */
export class GatewayTransportError extends Error {
  readonly code: GatewayErrorCode;
  readonly httpStatus: number | null;
  readonly usage: GatewayUsage | null;
  readonly elapsedMs: number | null;

  constructor(
    code: GatewayErrorCode,
    details: {
      httpStatus?: number | null;
      usage?: GatewayUsage | null;
      elapsedMs?: number | null;
    } = {},
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = "GatewayTransportError";
    this.code = code;
    this.httpStatus = details.httpStatus ?? null;
    this.usage = details.usage ?? null;
    this.elapsedMs = details.elapsedMs ?? null;
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
const text = (value: unknown): value is string =>
  typeof value === "string" && wellFormed(value);

/**
 * Parse a bare JSON object without silent duplicate-key overwrites. Errors use
 * fixed messages and contain no source excerpts. Escaped keys are compared by
 * their decoded spelling, independently in each nested object.
 */
export function parseStrictJsonObject(value: string): Record<string, unknown> {
  const invalid = () => new GatewayTransportError("invalid_json_object");
  if (!text(value)) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalid();
  }
  if (!record(parsed)) throw invalid();
  const scopes: (Set<string> | null)[] = [];
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === "{") scopes.push(new Set());
    else if (character === "[") scopes.push(null);
    else if (character === "}" || character === "]") scopes.pop();
    else if (character === '"') {
      const start = index++;
      while (value[index] !== '"') {
        if (value[index] === "\\") index++;
        index++;
      }
      let next = index + 1;
      while (next < value.length && /\s/.test(value[next])) next++;
      if (value[next] === ":") {
        const key: string = JSON.parse(value.slice(start, index + 1));
        const keys = scopes.at(-1);
        if (!keys) throw invalid();
        if (keys.has(key))
          throw new GatewayTransportError("duplicate_json_key");
        keys.add(key);
      }
    }
    if (scopes.length > 128) throw invalid();
  }
  const pending: unknown[] = [parsed];
  let nodes = 0;
  while (pending.length) {
    if (++nodes > 1_000_000) throw invalid();
    const item = pending.pop();
    if (typeof item === "number" && !Number.isFinite(item)) throw invalid();
    if (typeof item === "string" && !wellFormed(item)) throw invalid();
    if (Array.isArray(item)) {
      if (nodes + pending.length + item.length > 1_000_000) throw invalid();
      for (const child of item) pending.push(child);
    } else if (record(item)) {
      const entries = Object.entries(item);
      if (nodes + pending.length + entries.length > 1_000_000) throw invalid();
      for (const [key, child] of entries) {
        if (!wellFormed(key)) throw invalid();
        pending.push(child);
      }
    }
  }
  return parsed;
}

function parseUsage(value: unknown): GatewayUsage {
  const invalid = () => new GatewayTransportError("protocol_error");
  if (value !== undefined && value !== null && !record(value)) throw invalid();
  const source = record(value) ? value : {};
  const counter = (item: unknown) => {
    if (item === undefined || item === null) return null;
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0)
      throw invalid();
    return item;
  };
  const details = source.prompt_tokens_details;
  if (details !== undefined && details !== null && !record(details))
    throw invalid();
  const usage = {
    promptTokens: counter(source.prompt_tokens),
    completionTokens: counter(source.completion_tokens),
    totalTokens: counter(source.total_tokens),
    cachedPromptTokens: counter(
      record(details) ? details.cached_tokens : undefined,
    ),
  };
  const {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    cachedPromptTokens: cached,
  } = usage;
  if (
    (prompt !== null && total !== null && prompt > total) ||
    (completion !== null && total !== null && completion > total) ||
    (cached !== null && prompt !== null && cached > prompt) ||
    (cached !== null && total !== null && cached > total) ||
    (prompt !== null &&
      completion !== null &&
      total !== null &&
      prompt + completion !== total)
  )
    throw invalid();
  return Object.freeze(usage);
}

function cancelBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // Cancellation cannot replace a safe transport error or expose its cause.
  }
}

/**
 * Text-only Grok chat transport. Configuration is captured privately; the
 * returned object serializes to {}, without credentials or request options.
 * This transport makes no temperature/determinism or billing claim.
 */
export function createGatewayTransport(
  options: GatewayTransportOptions,
): GatewayTransport {
  const invalid = () => new GatewayTransportError("invalid_configuration");
  let endpoint: URL;
  let model: string;
  let apiKey: string;
  let maxResponseBytes: number;
  let timeoutMs: number;
  let fetchRequest: typeof globalThis.fetch;
  try {
    const baseUrl = options.baseUrl;
    if (
      !text(baseUrl) ||
      baseUrl !== baseUrl.trim() ||
      !baseUrl.startsWith("https://") ||
      baseUrl.includes("\\") ||
      baseUrl.includes("?") ||
      baseUrl.includes("#")
    )
      throw invalid();
    const base = new URL(baseUrl);
    if (
      base.protocol !== "https:" ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw invalid();
    endpoint = new URL(`${base.href.replace(/\/$/, "")}/chat/completions`);
    if (endpoint.origin !== base.origin) throw invalid();
    model = options.model;
    apiKey = options.apiKey;
    maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_GATEWAY_MAX_RESPONSE_BYTES;
    timeoutMs = options.timeoutMs ?? DEFAULT_GATEWAY_TIMEOUT_MS;
    fetchRequest = options.fetch ?? globalThis.fetch;
    if (
      !text(model) ||
      !model ||
      /\s/.test(model) ||
      !text(apiKey) ||
      !apiKey ||
      /\s/.test(apiKey) ||
      !positiveInteger(maxResponseBytes) ||
      !positiveInteger(timeoutMs) ||
      timeoutMs > 2_147_483_647 ||
      typeof fetchRequest !== "function"
    )
      throw invalid();
  } catch {
    throw invalid();
  }

  async function chat(request: GatewayChatRequest): Promise<GatewayChatResult> {
    let messages: GatewayMessage[];
    let maxTokens: number;
    let signal: AbortSignal | undefined;
    try {
      const sourceMessages = request.messages;
      maxTokens = request.maxTokens;
      signal = request.signal;
      if (
        !Array.isArray(sourceMessages) ||
        !sourceMessages.length ||
        !positiveInteger(maxTokens) ||
        (signal !== undefined && !(signal instanceof AbortSignal))
      )
        throw new GatewayTransportError("invalid_request");
      messages = Array.from(sourceMessages, (message) => {
        const role = message?.role,
          content = message?.content;
        if (
          !role ||
          !["system", "developer", "user", "assistant"].includes(role) ||
          !text(content)
        )
          throw new GatewayTransportError("invalid_request");
        return { role, content };
      });
    } catch {
      throw new GatewayTransportError("invalid_request");
    }
    const started = performance.now();
    let httpStatus: number | null = null;
    const failure = (
      code: GatewayErrorCode,
      usage: GatewayUsage | null = null,
    ) =>
      new GatewayTransportError(code, {
        httpStatus,
        usage,
        elapsedMs: performance.now() - started,
      });
    if (signal?.aborted) throw failure("aborted");
    const controller = new AbortController();
    let abortCode: "aborted" | "timeout" | null = null;
    let rejectAbort!: (error: GatewayTransportError) => void;
    const interrupted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    // A synchronous injected fetch can abort before Promise.race is attached.
    void interrupted.catch(() => undefined);
    const abort = (code: "aborted" | "timeout") => {
      if (abortCode) return;
      abortCode = code;
      controller.abort();
      rejectAbort(failure(code));
    };
    const externalAbort = () => abort("aborted");
    signal?.addEventListener("abort", externalAbort, { once: true });
    const timer = setTimeout(() => abort("timeout"), timeoutMs);
    const wait = <T>(work: Promise<T>) => Promise.race([work, interrupted]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let bodyComplete = false;
    let phase: "fetch" | "body" | "protocol" = "fetch";
    try {
      const pendingResponse = Promise.resolve(
        fetchRequest(endpoint.href, {
          method: "POST",
          redirect: "error",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages,
            max_tokens: maxTokens,
            stream: false,
          }),
          signal: controller.signal,
        }),
      );
      void pendingResponse.then(
        (response) => {
          if (controller.signal.aborted) cancelBody(response);
        },
        () => undefined,
      );
      const response = await wait(pendingResponse);
      phase = "protocol";
      if (
        !Number.isInteger(response.status) ||
        response.status < 100 ||
        response.status > 599
      )
        throw failure("protocol_error");
      httpStatus = response.status;
      if (
        response.redirected ||
        (response.url && response.url !== endpoint.href)
      ) {
        cancelBody(response);
        throw failure("protocol_error");
      }
      if (!response.ok) {
        cancelBody(response);
        throw failure("http_error");
      }
      if (!response.body) throw failure("protocol_error");
      reader = response.body.getReader();
      phase = "body";
      const chunks: Buffer[] = [];
      const responseHash = createHash("sha256");
      let bytes = 0;
      while (true) {
        const { done, value } = await wait(reader.read());
        if (done) {
          bodyComplete = true;
          break;
        }
        if (!(value instanceof Uint8Array)) throw failure("protocol_error");
        if (value.byteLength > maxResponseBytes - bytes)
          throw failure("response_too_large");
        const chunk = Buffer.from(value);
        bytes += chunk.byteLength;
        chunks.push(chunk);
        responseHash.update(chunk);
      }
      phase = "protocol";
      let data: Record<string, unknown>;
      try {
        data = parseStrictJsonObject(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks, bytes),
          ),
        );
      } catch {
        throw failure("protocol_error");
      }
      const choices = data.choices;
      if (
        !Array.isArray(choices) ||
        choices.length !== 1 ||
        !record(choices[0])
      )
        throw failure("protocol_error");
      const choice = choices[0],
        message = choice.message;
      if (
        !record(message) ||
        message.role !== "assistant" ||
        !text(message.content) ||
        !message.content.trim() ||
        (choice.index !== undefined && choice.index !== 0) ||
        (message.refusal !== undefined && message.refusal !== null) ||
        (message.tool_calls !== undefined &&
          message.tool_calls !== null &&
          (!Array.isArray(message.tool_calls) ||
            message.tool_calls.length !== 0)) ||
        (data.model !== undefined && data.model !== model)
      )
        throw failure("protocol_error");
      let usage: GatewayUsage;
      try {
        usage = parseUsage(data.usage);
      } catch {
        throw failure("protocol_error");
      }
      if (choice.finish_reason !== "stop") {
        if (
          ["length", "content_filter", "tool_calls", "function_call"].includes(
            String(choice.finish_reason),
          )
        )
          throw failure("incomplete_completion", usage);
        throw failure("protocol_error");
      }
      if (performance.now() - started >= timeoutMs) {
        abort("timeout");
        throw failure("timeout");
      }
      return {
        assistantText: message.content,
        finishReason: "stop",
        usage,
        elapsedMs: performance.now() - started,
        responseSha256: responseHash.digest("hex"),
      };
    } catch (error) {
      controller.abort();
      if (abortCode) throw failure(abortCode);
      if (error instanceof GatewayTransportError) throw error;
      throw failure(phase === "protocol" ? "protocol_error" : "network_error");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", externalAbort);
      if (reader) {
        if (!bodyComplete) {
          try {
            void reader.cancel().catch(() => undefined);
          } catch {
            /* Safe cleanup only. */
          }
        }
        try {
          reader.releaseLock();
        } catch {
          /* Pending reads are already rejected safely. */
        }
      }
    }
  }
  return Object.freeze({ chat });
}
