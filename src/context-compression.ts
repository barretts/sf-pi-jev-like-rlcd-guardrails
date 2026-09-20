import { createHash } from "node:crypto";

/** Experimental, lossless encoding of completed tool text; no runtime wiring. */
export const TOOL_RESULT_LINE_RLE_FORMAT = "tool-result-line-rle-v1" as const;

export interface ToolResultTextCompressionOptions {
  minOriginalBytes?: number;
  minSavingsBytes?: number;
  minSavingsRatio?: number;
  maxOriginalBytes?: number;
  maxOriginalLineCount?: number;
  maxSegments?: number;
}

export interface ToolResultTextCompressionResult {
  format: "identity" | typeof TOOL_RESULT_LINE_RLE_FORMAT;
  applied: boolean;
  /** SHA-256 of the original, valid Unicode text encoded as UTF-8. */
  originalSha256: string;
  /** SHA-256 of the exact model-visible text encoded as UTF-8. */
  compressedSha256: string;
  originalBytes: number;
  compressedBytes: number;
  /** Newline-preserving records; an ending newline adds no empty record. */
  originalLineCount: number;
  modelVisibleText: string;
}

export interface ToolResultTextDecompressionOptions {
  /** Retain this independently of the model-visible encoding. */
  expectedOriginalSha256: string;
  maxEncodedBytes?: number;
  maxOriginalBytes?: number;
  maxOriginalLineCount?: number;
  maxSegments?: number;
  maxRepeat?: number;
}

interface LineSegment {
  /** Exactly one line, retaining its LF, CRLF, or CR terminator if present. */
  text: string;
  repeat: number;
}

interface LineEncoding {
  format: typeof TOOL_RESULT_LINE_RLE_FORMAT;
  version: 1;
  originalSha256: string;
  originalBytes: number;
  originalLineCount: number;
  segments: LineSegment[];
}

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_LINES = 250_000;
const MAX_SEGMENTS = 100_000;
const RESULT_KEYS = [
  "format",
  "applied",
  "originalSha256",
  "compressedSha256",
  "originalBytes",
  "compressedBytes",
  "originalLineCount",
  "modelVisibleText",
];
const ENCODING_KEYS = [
  "format",
  "version",
  "originalSha256",
  "originalBytes",
  "originalLineCount",
  "segments",
];

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Tool text codec: ${message}`);
}

function integer(value: unknown, label: string, minimum = 0): number {
  check(
    typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= minimum,
    `${label} must be a safe integer >= ${minimum}`,
  );
  return value;
}

function digest(value: unknown, label: string): string {
  check(
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    `${label} must be a lowercase SHA-256 digest`,
  );
  return value;
}

function unicodeText(value: unknown, label: string): string {
  check(typeof value === "string", `${label} must be text`);
  // Node replaces unpaired surrogates during UTF-8 conversion. Rejecting them
  // prevents distinct JS strings from having identical byte evidence.
  for (const character of value) {
    const unit = character.charCodeAt(0);
    check(
      character.length === 2 || unit < 0xd800 || unit > 0xdfff,
      `${label} must contain valid Unicode`,
    );
  }
  return value;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function strictRecord(
  value: unknown,
  keys: string[],
  label: string,
): Record<string, unknown> {
  check(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null) &&
      Object.getOwnPropertySymbols(value).length === 0,
    `${label} must be a plain record`,
  );
  const fields = Object.getOwnPropertyDescriptors(value);
  check(
    Object.keys(fields).length === keys.length &&
      keys.every((key) => fields[key] && "value" in fields[key]),
    `${label} has missing, unexpected, or accessor fields`,
  );
  return Object.fromEntries(keys.map((key) => [key, fields[key].value]));
}

/** Yield lines without modifying terminators or inventing a final empty line. */
function* lines(text: string): Generator<string> {
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "\r" && text[index] !== "\n") continue;
    if (text[index] === "\r" && text[index + 1] === "\n") index++;
    yield text.slice(start, index + 1);
    start = index + 1;
  }
  if (start < text.length) yield text.slice(start);
}

function lineCount(text: string): number {
  let count = 0;
  for (const _line of lines(text)) count++;
  return count;
}

function terminated(text: string): boolean {
  return text.endsWith("\n") || text.endsWith("\r");
}

/**
 * Only adjacent, exactly identical complete lines receive a repeat count.
 * Text is always data: strings imitating this format or containing instructions
 * are neither parsed nor obeyed. The caller must retain the original text and
 * its digest; this result is an experimental model-visible representation.
 * Exceeding explicit input bounds throws rather than truncating or summarizing.
 */
export function compressToolResultText(
  originalText: string,
  options: ToolResultTextCompressionOptions = {},
): ToolResultTextCompressionResult {
  const text = unicodeText(originalText, "original text");
  const minBytes = integer(
    options.minOriginalBytes ?? 1024,
    "minOriginalBytes",
  );
  const minSavings = integer(options.minSavingsBytes ?? 256, "minSavingsBytes");
  const minRatio = options.minSavingsRatio ?? 0.1;
  check(
    typeof minRatio === "number" &&
      Number.isFinite(minRatio) &&
      minRatio >= 0 &&
      minRatio <= 1,
    "minSavingsRatio must be between 0 and 1",
  );
  const maxBytes = integer(
    options.maxOriginalBytes ?? MAX_BYTES,
    "maxOriginalBytes",
  );
  const maxLines = integer(
    options.maxOriginalLineCount ?? MAX_LINES,
    "maxOriginalLineCount",
  );
  const maxSegments = integer(
    options.maxSegments ?? MAX_SEGMENTS,
    "maxSegments",
  );
  const originalBytes = Buffer.byteLength(text, "utf8");
  check(originalBytes <= maxBytes, "original bytes exceed limit");
  const originalSha256 = sha256(text);
  const segments: LineSegment[] = [];
  let originalLineCount = 0;
  let tooManySegments = false;
  for (const line of lines(text)) {
    originalLineCount++;
    check(originalLineCount <= maxLines, "original line count exceeds limit");
    if (tooManySegments) continue;
    const previous = segments.at(-1);
    if (previous?.text === line) previous.repeat++;
    else if (segments.length >= maxSegments) tooManySegments = true;
    else segments.push({ text: line, repeat: 1 });
  }
  const unchanged: ToolResultTextCompressionResult = {
    format: "identity",
    applied: false,
    originalSha256,
    compressedSha256: originalSha256,
    originalBytes,
    compressedBytes: originalBytes,
    originalLineCount,
    modelVisibleText: text,
  };
  if (originalBytes < minBytes || tooManySegments) return unchanged;
  const encoding: LineEncoding = {
    format: TOOL_RESULT_LINE_RLE_FORMAT,
    version: 1,
    originalSha256,
    originalBytes,
    originalLineCount,
    segments,
  };
  const modelVisibleText = JSON.stringify(encoding);
  const compressedBytes = Buffer.byteLength(modelVisibleText, "utf8");
  const savings = originalBytes - compressedBytes;
  if (
    savings <= 0 ||
    savings < minSavings ||
    savings / originalBytes < minRatio
  )
    return unchanged;
  return {
    ...unchanged,
    format: TOOL_RESULT_LINE_RLE_FORMAT,
    applied: true,
    compressedSha256: sha256(modelVisibleText),
    compressedBytes,
    modelVisibleText,
  };
}

/**
 * Strictly decode only a caller-labelled result, with bounded expansion and an
 * independently retained original digest. Hashes establish content integrity,
 * not authenticity if the caller also replaces the independently retained hash.
 * Encoded JSON must match the codec's canonical representation exactly; this
 * rejects duplicate keys, unsupported fields/versions, and alternate parses.
 */
export function decompressToolResultText(
  result: ToolResultTextCompressionResult,
  options: ToolResultTextDecompressionOptions,
): string {
  const expectedOriginalSha256 = digest(
    options.expectedOriginalSha256,
    "expectedOriginalSha256",
  );
  const maxEncodedBytes = integer(
    options.maxEncodedBytes ?? MAX_BYTES,
    "maxEncodedBytes",
  );
  const maxBytes = integer(
    options.maxOriginalBytes ?? MAX_BYTES,
    "maxOriginalBytes",
  );
  const maxLines = integer(
    options.maxOriginalLineCount ?? MAX_LINES,
    "maxOriginalLineCount",
  );
  const maxSegments = integer(
    options.maxSegments ?? MAX_SEGMENTS,
    "maxSegments",
  );
  const maxRepeat = integer(options.maxRepeat ?? MAX_LINES, "maxRepeat", 1);
  const record = strictRecord(result, RESULT_KEYS, "compression result");
  const originalSha256 = digest(record.originalSha256, "originalSha256");
  const compressedSha256 = digest(record.compressedSha256, "compressedSha256");
  const originalBytes = integer(record.originalBytes, "originalBytes");
  const compressedBytes = integer(record.compressedBytes, "compressedBytes");
  const originalLineCount = integer(
    record.originalLineCount,
    "originalLineCount",
  );
  const modelVisibleText = unicodeText(
    record.modelVisibleText,
    "model-visible text",
  );
  check(
    originalSha256 === expectedOriginalSha256,
    "trusted original hash mismatch",
  );
  check(originalBytes <= maxBytes, "original bytes exceed expansion limit");
  check(
    originalLineCount <= maxLines,
    "original line count exceeds expansion limit",
  );
  check(compressedBytes <= maxEncodedBytes, "encoded bytes exceed limit");
  check(
    Buffer.byteLength(modelVisibleText, "utf8") === compressedBytes,
    "encoded byte length mismatch",
  );
  check(sha256(modelVisibleText) === compressedSha256, "encoded hash mismatch");
  if (record.format === "identity") {
    check(record.applied === false, "identity result cannot be applied");
    check(originalBytes === compressedBytes, "identity byte length mismatch");
    check(originalSha256 === compressedSha256, "identity hash mismatch");
    check(
      lineCount(modelVisibleText) === originalLineCount,
      "identity line count mismatch",
    );
    return modelVisibleText;
  }
  check(
    record.format === TOOL_RESULT_LINE_RLE_FORMAT && record.applied === true,
    "unsupported format or applied flag",
  );
  check(compressedBytes < originalBytes, "applied encoding must reduce bytes");
  let parsed: unknown;
  try {
    parsed = JSON.parse(modelVisibleText);
  } catch {
    throw new Error("Tool text codec: malformed encoded JSON");
  }
  const encoding = strictRecord(parsed, ENCODING_KEYS, "encoding");
  check(
    encoding.format === TOOL_RESULT_LINE_RLE_FORMAT && encoding.version === 1,
    "unsupported encoding format or version",
  );
  check(
    encoding.originalSha256 === originalSha256 &&
      encoding.originalBytes === originalBytes &&
      encoding.originalLineCount === originalLineCount,
    "encoding metadata mismatch",
  );
  check(Array.isArray(encoding.segments), "segments must be an array");
  check(
    encoding.segments.length > 0 && encoding.segments.length <= maxSegments,
    "segment count exceeds limit or is empty",
  );
  const segments: LineSegment[] = [];
  let expandedBytes = 0;
  let expandedLines = 0;
  for (let index = 0; index < encoding.segments.length; index++) {
    const segment = strictRecord(
      encoding.segments[index],
      ["text", "repeat"],
      "segment",
    );
    const text = unicodeText(segment.text, "segment text");
    const repeat = integer(segment.repeat, "segment repeat", 1);
    check(repeat <= maxRepeat, "repeat exceeds expansion limit");
    check(
      text.length > 0 && lineCount(text) === 1,
      "segment must contain exactly one line",
    );
    check(
      terminated(text) ||
        (index === encoding.segments.length - 1 && repeat === 1),
      "unterminated line must appear once at the end",
    );
    check(
      segments.at(-1)?.text !== text,
      "adjacent identical segments are noncanonical",
    );
    expandedBytes += Buffer.byteLength(text, "utf8") * repeat;
    expandedLines += repeat;
    check(
      Number.isSafeInteger(expandedBytes) && expandedBytes <= maxBytes,
      "expanded bytes exceed limit",
    );
    check(
      Number.isSafeInteger(expandedLines) && expandedLines <= maxLines,
      "expanded line count exceeds limit",
    );
    segments.push({ text, repeat });
  }
  check(expandedBytes === originalBytes, "expanded byte length mismatch");
  check(expandedLines === originalLineCount, "expanded line count mismatch");
  const canonical: LineEncoding = {
    format: TOOL_RESULT_LINE_RLE_FORMAT,
    version: 1,
    originalSha256,
    originalBytes,
    originalLineCount,
    segments,
  };
  check(
    JSON.stringify(canonical) === modelVisibleText,
    "noncanonical encoded JSON",
  );
  // Validate all counts before allocating the repeated text.
  const originalText = segments
    .map(({ text, repeat }) => text.repeat(repeat))
    .join("");
  check(
    lineCount(originalText) === originalLineCount,
    "decoded line count mismatch",
  );
  check(
    sha256(originalText) === originalSha256,
    "decoded original hash mismatch",
  );
  return originalText;
}
