import { createHash, randomBytes } from "node:crypto";
import { types } from "node:util";

export const CONTEXT_ORIGINALS_DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
export const CONTEXT_ORIGINALS_MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
export const CONTEXT_ORIGINALS_DEFAULT_MAX_SOURCES = 128;
export const CONTEXT_ORIGINALS_DEFAULT_READ_LINES = 100;
export const CONTEXT_ORIGINALS_MAX_READ_LINES = 200;
export const CONTEXT_ORIGINALS_MAX_READ_BYTES = 16 * 1024;

const REFERENCE_PATTERN = /^ctxorig_[0-9a-f]{48}$/;
const MAX_TOOL_CALL_ID_BYTES = 1024;

export interface ContextOriginalsOptions {
  maxBytes?: number;
  maxSources?: number;
}

export interface ContextOriginalCapture {
  toolCallId: string;
  contentIndex: number;
  text: string;
}

export interface ContextOriginalSource {
  readonly reference: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly lineCount: number;
}

export interface ContextOriginalReadRequest {
  reference: string;
  offset?: number;
  limit?: number;
  byteOffset?: number;
}

export interface ContextOriginalReadResult {
  readonly text: string;
  readonly source: ContextOriginalSource;
  /** Present for a line-mode read; line offsets are one based. */
  readonly offset?: number;
  readonly nextOffset?: number;
  /** Present for byte mode, including a first oversized line's prefix. */
  readonly byteOffset?: number;
  readonly nextByteOffset?: number;
  readonly truncated: boolean;
}

export interface ContextOriginalReadError {
  readonly error: "context-original-unavailable";
}

export interface ContextOriginalStatus {
  readonly maxBytes: number;
  readonly maxSources: number;
  readonly sourceCount: number;
  readonly bytes: number;
  readonly captures: number;
  readonly deduplicatedCaptures: number;
  readonly skippedCaptures: number;
  readonly reads: number;
  readonly readErrors: number;
}

export interface ContextOriginalStore {
  capture(input: ContextOriginalCapture): ContextOriginalSource | undefined;
  read(
    input: ContextOriginalReadRequest,
  ): ContextOriginalReadResult | ContextOriginalReadError;
  /** Every reset invalidates references, even when the scope label is equal. */
  reset(scope: string): void;
  status(): ContextOriginalStatus;
}

export const CONTEXT_ORIGINALS_READ_ERROR: ContextOriginalReadError =
  Object.freeze({ error: "context-original-unavailable" });

export const CONTEXT_ORIGINALS_READ_DESCRIPTION =
  "Read original tool text using a host-issued context reference. " +
  "Line mode uses 1-based offset (default 1) and limit (default 100, maximum 200). " +
  "Byte mode uses a 0-based UTF-8 byteOffset and cannot be combined with offset or limit. " +
  "Each page contains at most 16384 UTF-8 bytes of original text and preserves original line endings. " +
  "JSON escaping and metadata add response overhead. " +
  "Follow nextOffset for further complete lines or nextByteOffset for byte continuation; " +
  "a first oversized line returns its exact UTF-8 prefix with byte continuation. " +
  "References expire on session or branch reset. Arbitrary paths are not accepted.";

export const CONTEXT_ORIGINALS_READ_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["reference"]),
  properties: Object.freeze({
    reference: Object.freeze({
      type: "string",
      pattern: "^ctxorig_[0-9a-f]{48}$",
      minLength: 56,
      maxLength: 56,
    }),
    offset: Object.freeze({
      type: "integer",
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    }),
    limit: Object.freeze({
      type: "integer",
      minimum: 1,
      maximum: CONTEXT_ORIGINALS_MAX_READ_LINES,
    }),
    byteOffset: Object.freeze({
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    }),
  }),
});

interface StoredOriginal {
  readonly text: string;
  readonly identity: string;
  readonly source: ContextOriginalSource;
}

/** Inspect data descriptors only: no property getter or inherited argument runs. */
function dataRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> | undefined {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      types.isProxy(value)
    ) {
      return undefined;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string" || !allowed.includes(key)) return undefined;
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
        return undefined;
      }
      result[key] = descriptor.value;
    }
    if (required.some((key) => !Object.hasOwn(result, key))) return undefined;
    return result;
  } catch {
    return undefined;
  }
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Reject malformed UTF-16 so encoded bytes round-trip to the original string. */
function lineCount(text: string): number | undefined {
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return undefined;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return undefined;
    } else if (code === 13) {
      count++;
      if (text.charCodeAt(index + 1) === 10) index++;
    } else if (code === 10) {
      count++;
    }
  }
  const last = text.charCodeAt(text.length - 1);
  if (text.length > 0 && last !== 13 && last !== 10) count++;
  return count;
}

function endOfLine(text: string, start: number): number {
  for (let index = start; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 13) {
      return index + (text.charCodeAt(index + 1) === 10 ? 2 : 1);
    }
    if (code === 10) return index + 1;
  }
  return text.length;
}

function byteRead(
  bytes: Buffer,
  start: number,
  source: ContextOriginalSource,
  offset?: number,
): ContextOriginalReadResult {
  let end = Math.min(start + CONTEXT_ORIGINALS_MAX_READ_BYTES, bytes.length);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return Object.freeze({
    text: bytes.subarray(start, end).toString("utf8"),
    source,
    ...(offset === undefined ? {} : { offset }),
    byteOffset: start,
    ...(end < bytes.length ? { nextByteOffset: end } : {}),
    truncated: end < bytes.length,
  });
}

/**
 * Memory-only originals. The host owns the session/branch lifecycle and must
 * reset before accepting a different scope. Strings and source descriptors are
 * immutable; canonical Pi messages are never changed by this store.
 */
export function createContextOriginals(
  options: ContextOriginalsOptions = {},
): ContextOriginalStore {
  const config = dataRecord(options, ["maxBytes", "maxSources"], []);
  if (!config) throw new TypeError("Invalid context-originals options");
  const maxBytes = Object.hasOwn(config, "maxBytes")
    ? config.maxBytes
    : CONTEXT_ORIGINALS_DEFAULT_MAX_BYTES;
  const maxSources = Object.hasOwn(config, "maxSources")
    ? config.maxSources
    : CONTEXT_ORIGINALS_DEFAULT_MAX_SOURCES;
  if (!nonnegativeInteger(maxBytes) || !nonnegativeInteger(maxSources)) {
    throw new TypeError("Invalid context-originals options");
  }

  const originals = new Map<string, StoredOriginal>();
  let bytesStored = 0;
  let captures = 0;
  let deduplicatedCaptures = 0;
  let skippedCaptures = 0;
  let reads = 0;
  let readErrors = 0;

  const skip = (): undefined => {
    skippedCaptures++;
    return undefined;
  };
  const unavailable = (): ContextOriginalReadError => {
    readErrors++;
    return CONTEXT_ORIGINALS_READ_ERROR;
  };

  return Object.freeze({
    capture(input: ContextOriginalCapture): ContextOriginalSource | undefined {
      captures++;
      const record = dataRecord(
        input,
        ["toolCallId", "contentIndex", "text"],
        ["toolCallId", "contentIndex", "text"],
      );
      if (!record) return skip();
      const { toolCallId, contentIndex, text } = record;
      if (
        typeof toolCallId !== "string" ||
        toolCallId.length === 0 ||
        toolCallId.length > MAX_TOOL_CALL_ID_BYTES ||
        Buffer.byteLength(toolCallId, "utf8") > MAX_TOOL_CALL_ID_BYTES ||
        !nonnegativeInteger(contentIndex) ||
        typeof text !== "string"
      ) {
        return skip();
      }
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > maxBytes || bytes > CONTEXT_ORIGINALS_MAX_CAPTURE_BYTES) {
        return skip();
      }
      const count = lineCount(text);
      if (count === undefined) return skip();
      try {
        const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
        const identity = JSON.stringify([toolCallId, contentIndex]);
        for (const original of originals.values()) {
          if (
            original.identity === identity &&
            original.source.sha256 === sha256 &&
            original.text === text
          ) {
            deduplicatedCaptures++;
            return original.source;
          }
        }
        if (originals.size >= maxSources || bytes > maxBytes - bytesStored) {
          return skip();
        }
        let reference: string | undefined;
        for (let attempt = 0; attempt < 8; attempt++) {
          const candidate = `ctxorig_${randomBytes(24).toString("hex")}`;
          if (!originals.has(candidate)) {
            reference = candidate;
            break;
          }
        }
        if (reference === undefined) return skip();
        const source = Object.freeze({
          reference,
          sha256,
          bytes,
          lineCount: count,
        });
        originals.set(reference, Object.freeze({ text, identity, source }));
        bytesStored += bytes;
        return source;
      } catch {
        return skip();
      }
    },

    read(
      input: ContextOriginalReadRequest,
    ): ContextOriginalReadResult | ContextOriginalReadError {
      reads++;
      const record = dataRecord(
        input,
        ["reference", "offset", "limit", "byteOffset"],
        ["reference"],
      );
      if (
        !record ||
        typeof record.reference !== "string" ||
        record.reference.length !== 56 ||
        !REFERENCE_PATTERN.test(record.reference)
      ) {
        return unavailable();
      }
      const byteMode = Object.hasOwn(record, "byteOffset");
      const offset = Object.hasOwn(record, "offset") ? record.offset : 1;
      const limit = Object.hasOwn(record, "limit")
        ? record.limit
        : CONTEXT_ORIGINALS_DEFAULT_READ_LINES;
      if (
        byteMode
          ? Object.hasOwn(record, "offset") ||
            Object.hasOwn(record, "limit") ||
            !nonnegativeInteger(record.byteOffset)
          : !nonnegativeInteger(offset) ||
            offset < 1 ||
            !nonnegativeInteger(limit) ||
            limit < 1 ||
            limit > CONTEXT_ORIGINALS_MAX_READ_LINES
      ) {
        return unavailable();
      }
      const original = originals.get(record.reference);
      if (!original) return unavailable();
      try {
        const bytes = Buffer.from(original.text, "utf8");
        if (
          bytes.length !== original.source.bytes ||
          createHash("sha256").update(bytes).digest("hex") !==
            original.source.sha256
        ) {
          return unavailable();
        }
        if (byteMode) {
          const start = record.byteOffset as number;
          if (
            start > bytes.length ||
            (start < bytes.length && (bytes[start] & 0xc0) === 0x80)
          ) {
            return unavailable();
          }
          return byteRead(bytes, start, original.source);
        }
        const startLine = offset as number;
        const maxLines = limit as number;
        if (
          startLine > original.source.lineCount &&
          !(startLine === 1 && original.source.lineCount === 0)
        ) {
          return unavailable();
        }
        let start = 0;
        for (let line = 1; line < startLine; line++) {
          start = endOfLine(original.text, start);
        }
        let end = start;
        let returnedLines = 0;
        let returnedBytes = 0;
        while (end < original.text.length && returnedLines < maxLines) {
          const next = endOfLine(original.text, end);
          const lineBytes = Buffer.byteLength(
            original.text.slice(end, next),
            "utf8",
          );
          if (returnedBytes + lineBytes > CONTEXT_ORIGINALS_MAX_READ_BYTES) {
            if (returnedLines === 0) {
              const byteStart = Buffer.byteLength(
                original.text.slice(0, start),
                "utf8",
              );
              return byteRead(bytes, byteStart, original.source, startLine);
            }
            break;
          }
          end = next;
          returnedBytes += lineBytes;
          returnedLines++;
        }
        return Object.freeze({
          text: original.text.slice(start, end),
          source: original.source,
          offset: startLine,
          ...(end < original.text.length
            ? { nextOffset: startLine + returnedLines }
            : {}),
          truncated: end < original.text.length,
        });
      } catch {
        return unavailable();
      }
    },

    reset(scope: string): void {
      if (typeof scope !== "string") {
        throw new TypeError("Invalid context-originals scope");
      }
      originals.clear();
      bytesStored = 0;
      captures = 0;
      deduplicatedCaptures = 0;
      skippedCaptures = 0;
      reads = 0;
      readErrors = 0;
    },

    status(): ContextOriginalStatus {
      return Object.freeze({
        maxBytes,
        maxSources,
        sourceCount: originals.size,
        bytes: bytesStored,
        captures,
        deduplicatedCaptures,
        skippedCaptures,
        reads,
        readErrors,
      });
    },
  });
}
