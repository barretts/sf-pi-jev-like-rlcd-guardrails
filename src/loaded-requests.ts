import { createHash } from "node:crypto";
import type {
  SourceInfo,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
  assert,
  InvalidRequest,
  validateRequest,
  INPUT_DEPTH_LIMIT,
  type ClassifierResponse,
  type Entry,
  type Request,
} from "./core.js";

export interface LoadedRequestRecord {
  id: string;
  request: Request;
}
export interface LoadedRequestSource {
  read_tool_call_id: string;
  source_path: string;
  content_sha256: string;
  content_bytes: number;
  record_ids: string[];
}
export interface ResolvedLoadedRequests {
  source: LoadedRequestSource;
  raw_content: string;
  records: LoadedRequestRecord[];
  session_generation: number;
}
export type LoadedReadCapture =
  | { captured: true; source: LoadedRequestSource }
  | { captured: false; reason: string };
export interface LoadedRequestReceipt {
  version: 1;
  source: LoadedRequestSource;
  model: string;
  session_generation: number;
  total_records: number;
  results: {
    id: string;
    request_sha256: string;
    response: ClassifierResponse;
  }[];
}
export type LoadedRequestClassifier = (
  request: Request,
  signal?: AbortSignal,
) => Promise<ClassifierResponse>;

/** Completed actual responses remain available when a later record fails. */
export class LoadedRequestExecutionError extends Error {
  constructor(
    message: string,
    public readonly receipt: LoadedRequestReceipt,
    public readonly kind:
      "aborted" | "classification_failed" | "session_cleared",
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "LoadedRequestExecutionError";
  }
}

interface LoadedRequestCacheLimits {
  maxEntries: number;
  maxBytes: number;
  maxReadBytes: number;
  maxRecords: number;
}
const DEFAULTS: Readonly<LoadedRequestCacheLimits> = Object.freeze({
  maxEntries: 8,
  maxBytes: 256 * 1024,
  maxReadBytes: 50 * 1024,
  maxRecords: 256,
});
export type LoadedRequestCacheOptions = Partial<LoadedRequestCacheLimits>;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function id(value: unknown, label: string): asserts value is string {
  assert(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 256 &&
      !/[\u0000-\u001f\u007f]/.test(value),
    `Invalid ${label}`,
  );
}
function only(value: Record<string, unknown>, keys: string[], label: string) {
  for (const key of Object.keys(value))
    assert(keys.includes(key), `Unknown ${label} field: ${key}`);
}
function own(value: unknown, key: string): unknown {
  assert(object(value), "Expected a plain event object");
  const prototype = Object.getPrototypeOf(value);
  assert(
    prototype === Object.prototype || prototype === null,
    "Expected a plain event object",
  );
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  assert(
    !descriptor || "value" in descriptor,
    "Event accessors are unsupported",
  );
  return descriptor?.value;
}
function positive(value: number, key: string, maximum: number) {
  assert(
    Number.isSafeInteger(value) && value >= 1 && value <= maximum,
    `${key} must be an integer from 1 to ${maximum}`,
  );
}

/** No supervision, model selector, or additional wrapper fields are accepted. */
export function validateLoadedRequestBundle(
  value: unknown,
  modelId: string,
  maxRecords = DEFAULTS.maxRecords,
): LoadedRequestRecord[] {
  positive(maxRecords, "maxRecords", 256);
  // The public boundary validates plain JSON before cloning or property access.
  const bundle = validateRequest({
    model: modelId,
    state: value as Entry,
    questions: [
      { id: "loaded-request-boundary", type: "noul", instructions: null },
    ],
  }).state;
  assert(object(bundle), "Expected a request bundle object");
  only(bundle, ["records"], "bundle");
  assert(
    Array.isArray(bundle.records) &&
      bundle.records.length >= 1 &&
      bundle.records.length <= maxRecords,
    `Expected 1–${maxRecords} request records`,
  );
  const seen = new Set<string>();
  return bundle.records.map((record: unknown) => {
    assert(object(record), "Expected a request record object");
    only(record, ["id", "request"], "record");
    id(record.id, "record ID");
    assert(record.id.trim().length > 0, "Expected a nonblank record ID");
    assert(!seen.has(record.id), "Duplicate record ID");
    seen.add(record.id);
    assert(object(record.request), "Expected a request object");
    only(
      record.request,
      ["state", "messages", "questions", "options"],
      "request",
    );
    return {
      id: record.id,
      request: validateRequest({ ...record.request, model: modelId }),
    };
  });
}

/** JSON.parse owns scalar syntax; this scan additionally rejects duplicate keys. */
function parseBundle(source: string): unknown {
  let cursor = 0;
  const whitespace = () => {
    while (/[ \t\r\n]/.test(source[cursor] ?? "") && cursor < source.length)
      cursor++;
  };
  const string = (): string => {
    const start = cursor++;
    while (cursor < source.length) {
      if (source[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (source[cursor++] === '"')
        return JSON.parse(source.slice(start, cursor)) as string;
    }
    throw new InvalidRequest("Unterminated JSON string");
  };
  const scan = (depth: number) => {
    assert(
      depth <= INPUT_DEPTH_LIMIT,
      "Request bundle exceeds nesting depth limit",
    );
    whitespace();
    const token = source[cursor];
    if (token === '"') {
      string();
      return;
    }
    if (token === "{" || token === "[") {
      cursor++;
      const closing = token === "{" ? "}" : "]";
      const keys = new Set<string>();
      whitespace();
      if (source[cursor] === closing) {
        cursor++;
        return;
      }
      while (true) {
        whitespace();
        if (token === "{") {
          assert(source[cursor] === '"', "Expected JSON object key");
          const key = string();
          assert(!keys.has(key), "Duplicate JSON key");
          keys.add(key);
          whitespace();
          assert(source[cursor++] === ":", "Expected JSON colon");
        }
        scan(depth + 1);
        whitespace();
        const separator = source[cursor++];
        if (separator === closing) return;
        assert(separator === ",", "Expected JSON comma");
      }
    }
    const start = cursor;
    while (cursor < source.length && !/[\s,}\]]/.test(source[cursor])) cursor++;
    assert(cursor > start, "Invalid JSON value");
    JSON.parse(source.slice(start, cursor));
  };
  try {
    scan(0);
    whitespace();
    assert(
      cursor === source.length,
      "Expected one complete JSON request bundle",
    );
    return JSON.parse(source);
  } catch (error) {
    if (error instanceof InvalidRequest) throw error;
    throw new InvalidRequest("Invalid complete request bundle JSON");
  }
}

interface CachedRead {
  source: LoadedRequestSource;
  raw: string;
}

/**
 * Only the host's trusted tool_result handler may capture; tool arguments cannot.
 * Source metadata rejects named read overrides. SDK ReadOperations remain trusted.
 * This class never resolves paths or accesses the filesystem.
 */
export class LoadedRequestCache {
  private readonly entries = new Map<string, CachedRead>();
  private bytes = 0;
  private generation = 0;
  private session = new AbortController();
  readonly limits: typeof DEFAULTS;
  constructor(options: LoadedRequestCacheOptions = {}) {
    this.limits = Object.freeze({ ...DEFAULTS, ...options });
    positive(this.limits.maxEntries, "maxEntries", 256);
    positive(this.limits.maxBytes, "maxBytes", 16 * 1024 * 1024);
    positive(this.limits.maxReadBytes, "maxReadBytes", 50 * 1024);
    positive(this.limits.maxRecords, "maxRecords", 256);
  }
  get status() {
    return {
      entries: this.entries.size,
      bytes: this.bytes,
      session_generation: this.generation,
    };
  }
  private remove(reference: string) {
    const entry = this.entries.get(reference);
    if (entry) this.bytes -= entry.source.content_bytes;
    this.entries.delete(reference);
  }
  clear() {
    this.session.abort(new Error("Loaded request session cleared"));
    this.session = new AbortController();
    this.generation++;
    this.entries.clear();
    this.bytes = 0;
  }
  capture(
    event: ToolResultEvent,
    readSourceInfo?: Pick<SourceInfo, "source" | "path">,
  ): LoadedReadCapture {
    let invalidationReference: string | undefined;
    try {
      if (
        own(event, "type") !== "tool_result" ||
        own(event, "toolName") !== "read"
      )
        return { captured: false, reason: "not_builtin_read_result" };
      if (
        !readSourceInfo ||
        own(readSourceInfo, "source") !== "builtin" ||
        own(readSourceInfo, "path") !== "<builtin:read>"
      )
        return { captured: false, reason: "builtin_read_provenance_required" };
      const reference = own(event, "toolCallId");
      id(reference, "read tool-call ID");
      invalidationReference = reference;
      if (own(event, "isError") !== false) {
        this.remove(reference);
        return { captured: false, reason: "read_failed" };
      }
      const input = own(event, "input");
      const path = own(input, "path");
      assert(
        typeof path === "string" &&
          path.length >= 1 &&
          path.length <= 4096 &&
          !/[\u0000-\u001f\u007f]/.test(path),
        "Invalid read source path",
      );
      assert(object(input), "Expected read input");
      only(input, ["path", "offset", "limit"], "read input");
      // Even an unusable later read of this path supersedes earlier snapshots.
      for (const [key, entry] of this.entries)
        if (key !== reference && entry.source.source_path === path)
          this.remove(key);
      assert(
        own(input, "limit") === undefined,
        "Limited reads cannot be cached",
      );
      const offset = own(input, "offset");
      assert(
        offset === undefined || offset === 1,
        "Partial reads cannot be cached",
      );
      assert(
        own(event, "details") === undefined,
        "Read details cannot establish complete original content",
      );
      const content = own(event, "content");
      assert(
        Array.isArray(content) && content.length === 1,
        "Expected one complete read text block",
      );
      const descriptor = Object.getOwnPropertyDescriptor(content, "0");
      assert(
        descriptor && "value" in descriptor,
        "Read content accessors are unsupported",
      );
      const block = descriptor.value;
      assert(own(block, "type") === "text", "Expected a read text block");
      assert(object(block), "Expected a read text block");
      only(block, ["type", "text"], "read content");
      const raw = own(block, "text");
      assert(typeof raw === "string", "Expected read text");
      const existing = this.entries.get(reference);
      if (
        existing &&
        (existing.source.source_path !== path || existing.raw !== raw)
      ) {
        this.remove(reference);
        return { captured: false, reason: "read_tool_call_id_collision" };
      }
      const size = Buffer.byteLength(raw);
      assert(
        size <= this.limits.maxReadBytes && size <= this.limits.maxBytes,
        "Read bundle exceeds cache byte limit",
      );
      const parsed = parseBundle(raw);
      const records = validateLoadedRequestBundle(
        parsed,
        "loaded-request-validation",
        this.limits.maxRecords,
      );
      const source: LoadedRequestSource = {
        read_tool_call_id: reference,
        source_path: path,
        content_sha256: sha(raw),
        content_bytes: size,
        record_ids: records.map((record) => record.id),
      };
      if (existing) {
        return { captured: true, source: structuredClone(existing.source) };
      }
      while (
        this.entries.size >= this.limits.maxEntries ||
        this.bytes + size > this.limits.maxBytes
      )
        this.remove(this.entries.keys().next().value!);
      this.entries.set(reference, { source, raw });
      this.bytes += size;
      return { captured: true, source: structuredClone(source) };
    } catch (error) {
      if (invalidationReference) this.remove(invalidationReference);
      return {
        captured: false,
        reason: error instanceof Error ? error.message : "Invalid read event",
      };
    }
  }
  resolve(readToolCallId: string, modelId: string): ResolvedLoadedRequests {
    id(readToolCallId, "read tool-call ID");
    const entry = this.entries.get(readToolCallId);
    assert(
      entry,
      "Loaded read reference is absent, evicted, or superseded; read the complete bundle again",
    );
    return {
      source: structuredClone(entry.source),
      raw_content: entry.raw,
      records: validateLoadedRequestBundle(
        parseBundle(entry.raw),
        modelId,
        this.limits.maxRecords,
      ),
      session_generation: this.generation,
    };
  }
  async classify(
    readToolCallId: string,
    modelId: string,
    classify: LoadedRequestClassifier,
    signal?: AbortSignal,
  ): Promise<LoadedRequestReceipt> {
    const loaded = this.resolve(readToolCallId, modelId);
    const session = this.session.signal;
    const combined = signal ? AbortSignal.any([session, signal]) : session;
    const receipt: LoadedRequestReceipt = {
      version: 1,
      source: loaded.source,
      model: modelId,
      session_generation: loaded.session_generation,
      total_records: loaded.records.length,
      results: [],
    };
    try {
      for (const record of loaded.records) {
        combined.throwIfAborted();
        assert(
          this.generation === loaded.session_generation,
          "Loaded request session cleared",
        );
        // A callback receives its own clone and cannot change later requests or hashes.
        const request = structuredClone(record.request);
        const requestSha = sha(JSON.stringify(request));
        const response = await classify(request, combined);
        combined.throwIfAborted();
        assert(
          this.generation === loaded.session_generation,
          "Loaded request session cleared",
        );
        receipt.results.push({
          id: record.id,
          request_sha256: requestSha,
          response: structuredClone(response),
        });
      }
      return receipt;
    } catch (error) {
      const kind =
        session.aborted || this.generation !== loaded.session_generation
          ? "session_cleared"
          : combined.aborted
            ? "aborted"
            : "classification_failed";
      throw new LoadedRequestExecutionError(
        error instanceof Error
          ? error.message
          : "Loaded request classification failed",
        receipt,
        kind,
        error,
      );
    }
  }
}
